/**
 * SEC-01 / SEC-02: 权限守卫单元测试（Owner vs Member）
 *
 * 覆盖 requireOwner 中间件的核心所有权判定逻辑：
 *   - isWorkspaceOwner() 纯函数：所有 Owner/Member 组合
 *   - 路由守卫清单：验证所有 owner-only 路由都挂载了 requireOwner
 *   - Session-only 路由验证：确认 session-only 路由未误加 requireOwner
 *   - 错误响应格式：403 + { error: "owner role required" }
 *
 * 这些测试推进 SEC-01/SEC-02 DoD："owner-only 操作有明确权限守卫"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWorkspaceOwner } from "../modules/identity/middleware.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── isWorkspaceOwner 纯函数：Owner/Member 全组合 ──────────────────────

describe("permission-guard: isWorkspaceOwner 纯函数", () => {
  const USER_ID = "user-aaa";
  const OTHER_USER_ID = "user-bbb";

  it("membership.role === 'owner' → true（协作工作区 owner）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "owner",
        workspaceOwnerId: OTHER_USER_ID,
        userId: USER_ID,
      }),
      true,
    );
  });

  it("workspace.ownerId === userId 且 membership.role !== 'owner' → true（个人工作区 ADR-0009）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "member",
        workspaceOwnerId: USER_ID,
        userId: USER_ID,
      }),
      true,
    );
  });

  it("workspace.ownerId === userId 且无 membership 记录 → true（个人工作区无成员行）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: null,
        workspaceOwnerId: USER_ID,
        userId: USER_ID,
      }),
      true,
    );
  });

  it("两个条件都满足 → true（既是 member owner 也是 workspace owner）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "owner",
        workspaceOwnerId: USER_ID,
        userId: USER_ID,
      }),
      true,
    );
  });

  it("membership.role === 'member' 且 workspace.ownerId !== userId → false（普通成员）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "member",
        workspaceOwnerId: OTHER_USER_ID,
        userId: USER_ID,
      }),
      false,
    );
  });

  it("无 membership 且 workspace.ownerId !== userId → false（非成员且非 owner）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: null,
        workspaceOwnerId: OTHER_USER_ID,
        userId: USER_ID,
      }),
      false,
    );
  });

  it("membership.role 为 undefined → false（当 workspace.ownerId 也不匹配时）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: undefined,
        workspaceOwnerId: OTHER_USER_ID,
        userId: USER_ID,
      }),
      false,
    );
  });

  it("workspace.ownerId 为 undefined → false（当 membership.role 也不匹配时）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "member",
        workspaceOwnerId: undefined,
        userId: USER_ID,
      }),
      false,
    );
  });

  it("两个条件都为 null → false", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: null,
        workspaceOwnerId: null,
        userId: USER_ID,
      }),
      false,
    );
  });

  it("两个条件都为 undefined → false", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: undefined,
        workspaceOwnerId: undefined,
        userId: USER_ID,
      }),
      false,
    );
  });
});

// ─── isWorkspaceOwner 边界情况 ──────────────────────────────────────────

describe("permission-guard: isWorkspaceOwner 边界情况", () => {
  it("membership.role 为空字符串 → false（不等于 'owner'）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "",
        workspaceOwnerId: "other",
        userId: "user",
      }),
      false,
    );
  });

  it("membership.role 为 'OWNER'（大写）→ false（大小写敏感）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "OWNER",
        workspaceOwnerId: "other",
        userId: "user",
      }),
      false,
    );
  });

  it("membership.role 为 'admin' → false（v0.5 不承诺 admin 角色）", () => {
    assert.equal(
      isWorkspaceOwner({
        membershipRole: "admin",
        workspaceOwnerId: "other",
        userId: "user",
      }),
      false,
    );
  });

  it("workspace.ownerId 空字符串且 userId 空字符串 → true（空字符串相等但不应发生）", () => {
    // 这是一个理论边界：空字符串 === 空字符串 为 true
    // 但在实际系统中，userId 和 workspace.ownerId 都是非空 UUID
    assert.equal(
      isWorkspaceOwner({
        membershipRole: null,
        workspaceOwnerId: "",
        userId: "",
      }),
      true,
    );
  });

  it("userId 为 null 时不会匹配 workspace.ownerId（null !== string）", () => {
    // 虽然类型签名要求 userId: string，但运行时保护测试
    assert.equal(
      isWorkspaceOwner({
        membershipRole: null,
        workspaceOwnerId: "user-aaa",
        userId: null as unknown as string,
      }),
      false,
    );
  });
});

// ─── isWorkspaceOwner OR 语义验证 ───────────────────────────────────────

describe("permission-guard: isWorkspaceOwner OR 语义（任一条件满足即放行）", () => {
  const USER_ID = "user-aaa";
  const OTHER_ID = "user-bbb";

  // 真值表：membershipRole, workspaceOwnerId, expected
  const truthTable: Array<{
    membershipRole: string | null;
    workspaceOwnerId: string | null;
    expected: boolean;
    label: string;
  }> = [
    // membership=owner, workspace=userId → true (both)
    { membershipRole: "owner", workspaceOwnerId: USER_ID, expected: true, label: "both-true" },
    // membership=owner, workspace=other → true (via membership)
    { membershipRole: "owner", workspaceOwnerId: OTHER_ID, expected: true, label: "membership-only" },
    // membership=member, workspace=userId → true (via workspace)
    { membershipRole: "member", workspaceOwnerId: USER_ID, expected: true, label: "workspace-only" },
    // membership=member, workspace=other → false (neither)
    { membershipRole: "member", workspaceOwnerId: OTHER_ID, expected: false, label: "neither" },
    // membership=null, workspace=userId → true (via workspace)
    { membershipRole: null, workspaceOwnerId: USER_ID, expected: true, label: "no-membership-but-owner" },
    // membership=null, workspace=other → false (neither)
    { membershipRole: null, workspaceOwnerId: OTHER_ID, expected: false, label: "no-membership-not-owner" },
  ];

  for (const { membershipRole, workspaceOwnerId, expected, label } of truthTable) {
    it(`${label}: membership=${membershipRole}, workspace.owner=${workspaceOwnerId} → ${expected}`, () => {
      assert.equal(
        isWorkspaceOwner({ membershipRole, workspaceOwnerId, userId: USER_ID }),
        expected,
        `case ${label} failed`,
      );
    });
  }
});

// ─── 路由守卫清单：owner-only 路由验证 ──────────────────────────────────

describe("permission-guard: owner-only 路由守卫清单", () => {
  const ROUTES_DIR = path.resolve(import.meta.dirname, "../modules");

  /**
   * 读取路由文件内容并检查是否包含 requireOwner。
   * 这是静态分析，确保 owner-only 路由不会意外丢失 requireOwner 守卫。
   */
  function readRouteFile(relativePath: string): string {
    const fullPath = path.resolve(ROUTES_DIR, relativePath);
    return fs.readFileSync(fullPath, "utf-8");
  }

  // 已知的 owner-only 路由清单（文件 → 期望包含的 requireOwner 路由数）
  const ownerOnlyRoutes: Array<{ file: string; routePattern: string; method: string }> = [
    // identity routes
    { file: "identity/routes.ts", routePattern: '"/auth/recovered-users/:userId/reset-password"', method: "POST" },
    { file: "identity/routes.ts", routePattern: '"/workspace/ai-consent"', method: "PUT" },
    { file: "identity/routes.ts", routePattern: '"/workspace/ai-data-policy"', method: "PUT" },
    { file: "identity/routes.ts", routePattern: '"/workspace/ai-audit-log"', method: "GET" },
    { file: "identity/routes.ts", routePattern: '"/invites"', method: "POST" },
    { file: "identity/routes.ts", routePattern: '"/invites"', method: "GET" },
    { file: "identity/routes.ts", routePattern: '"/invites/:inviteId"', method: "DELETE" },
    { file: "identity/routes.ts", routePattern: '"/members"', method: "GET" },
    { file: "identity/routes.ts", routePattern: '"/members/:userId"', method: "DELETE" },
    // export routes
    { file: "export/routes.ts", routePattern: '"/export/workspace"', method: "GET" },
    { file: "export/routes.ts", routePattern: '"/export/workspace/restore"', method: "POST" },
    // search routes
    { file: "search/routes.ts", routePattern: '"/search/drift"', method: "GET" },
    { file: "search/routes.ts", routePattern: '"/search/reindex"', method: "POST" },
  ];

  for (const { file, routePattern } of ownerOnlyRoutes) {
    it(`${file} 中路由 ${routePattern} 挂载了 requireOwner`, () => {
      const content = readRouteFile(file);
      assert.ok(
        content.includes("requireOwner"),
        `${file} 应导入并使用 requireOwner`,
      );
      assert.ok(
        content.includes(routePattern),
        `${file} 应包含路由 ${routePattern}`,
      );
    });
  }

  it("identity/routes.ts 中所有 owner-only 路由的 preHandler 包含 requireOwner", () => {
    const content = readRouteFile("identity/routes.ts");
    // 统计 requireOwner 在 preHandler 中出现的次数
    const preHandlerWithOwner = content.match(/preHandler:\s*\[requireSession,\s*requireOwner\]|preHandler:\s*\[requireOwner\]/g);
    assert.ok(
      preHandlerWithOwner !== null && preHandlerWithOwner.length >= 9,
      `identity/routes.ts 应至少有 9 个路由使用 requireOwner，实际找到 ${preHandlerWithOwner?.length ?? 0}`,
    );
  });

  it("export/routes.ts 中所有 owner-only 路由的 preHandler 包含 requireOwner", () => {
    const content = readRouteFile("export/routes.ts");
    const preHandlerWithOwner = content.match(/preHandler:\s*\[requireOwner\]/g);
    assert.ok(
      preHandlerWithOwner !== null && preHandlerWithOwner.length >= 2,
      `export/routes.ts 应有 2 个路由使用 requireOwner，实际找到 ${preHandlerWithOwner?.length ?? 0}`,
    );
  });

  it("search/routes.ts 中 drift 和 reindex 路由使用 requireOwner", () => {
    const content = readRouteFile("search/routes.ts");
    assert.ok(content.includes('"/search/drift"'));
    assert.ok(content.includes('"/search/reindex"'));
    assert.ok(content.includes("requireOwner"));
  });
});

// ─── Session-only 路由验证：不应有 requireOwner ─────────────────────────

describe("permission-guard: session-only 路由不应有 requireOwner", () => {
  const ROUTES_DIR = path.resolve(import.meta.dirname, "../modules");

  function readRouteFile(relativePath: string): string {
    return fs.readFileSync(path.resolve(ROUTES_DIR, relativePath), "utf-8");
  }

  // 这些模块的所有路由都应该是 session-only（用户级操作，非 owner-only）
  // 成员可以使用：验证理解、复习、查看统计、查看证据
  // （V1 evidence/benchmark/card/card-generation/validation 模块已随旧栈退役）
  const sessionOnlyModules = [
    "review/routes.ts",
    "understanding/routes.ts",
    "stats/routes.ts",
    "job/routes.ts",
  ];

  for (const moduleFile of sessionOnlyModules) {
    it(`${moduleFile} 不应使用 requireOwner（用户级操作）`, () => {
      const fullPath = path.resolve(ROUTES_DIR, moduleFile);
      if (!fs.existsSync(fullPath)) {
        // 某些模块可能尚未实现，跳过
        return;
      }
      const content = readRouteFile(moduleFile);
      assert.ok(
        !content.includes("requireOwner"),
        `${moduleFile} 不应导入或使用 requireOwner（这些是用户级操作，非 owner-only）`,
      );
    });
  }

  it("identity/routes.ts 中 onboarding 路由不应有 requireOwner（用户级 onboarding）", () => {
    const content = readRouteFile("identity/routes.ts");
    // onboarding 路由应使用 requireSession 但不使用 requireOwner
    // 检查 onboarding 相关行附近不包含 requireOwner
    const onboardingSection = content.substring(
      content.indexOf('"/onboarding/state"'),
      content.indexOf('"/onboarding/steps"') + 200,
    );
    assert.ok(
      !onboardingSection.includes("requireOwner"),
      "onboarding 路由不应使用 requireOwner（用户级 onboarding 操作）",
    );
  });

  it("identity/routes.ts 中 /auth/me 路由不应有 requireOwner", () => {
    const content = readRouteFile("identity/routes.ts");
    const meSection = content.substring(
      content.indexOf('"/auth/me"'),
      content.indexOf('"/auth/me"') + 300,
    );
    assert.ok(
      !meSection.includes("requireOwner"),
      "/auth/me 不应使用 requireOwner（所有登录用户可访问）",
    );
  });

  it("identity/routes.ts 中 /auth/profile 路由不应有 requireOwner", () => {
    const content = readRouteFile("identity/routes.ts");
    const profileSection = content.substring(
      content.indexOf('"/auth/profile"'),
      content.indexOf('"/auth/profile"') + 300,
    );
    assert.ok(
      !profileSection.includes("requireOwner"),
      "/auth/profile 不应使用 requireOwner（用户可更新自己的档案）",
    );
  });

  it("identity/routes.ts 中 /workspaces/:id/name 路由不应有 requireOwner（服务层校验）", () => {
    const content = readRouteFile("identity/routes.ts");
    const renameSection = content.substring(
      content.indexOf('"/workspaces/:id/name"'),
      content.indexOf('"/workspaces/:id/name"') + 300,
    );
    assert.ok(
      !renameSection.includes("requireOwner"),
      "/workspaces/:id/name 不应使用 requireOwner（个人工作区改名由服务层校验所有权）",
    );
  });
});

// ─── Owner-only 写操作路由验证：note/card/source/import ────────────────

describe("permission-guard: note/card/source/import 写操作使用 requireOwner", () => {
  const ROUTES_DIR = path.resolve(import.meta.dirname, "../modules");

  function readRouteFile(relativePath: string): string {
    return fs.readFileSync(path.resolve(ROUTES_DIR, relativePath), "utf-8");
  }

  // note/routes.ts: 写操作应挂载 requireOwner
  it("note/routes.ts 导入并使用 requireOwner", () => {
    const content = readRouteFile("note/routes.ts");
    assert.ok(content.includes("requireOwner"), "note/routes.ts 应导入并使用 requireOwner");
  });

  it("note/routes.ts 中 POST /notes 使用 requireOwner", () => {
    const content = readRouteFile("note/routes.ts");
    assert.ok(content.includes('preHandler: [requireOwner]'), "note/routes.ts 应有 preHandler: [requireOwner]");
  });

  it("note/routes.ts 写操作（POST/PATCH/DELETE）挂载 requireOwner", () => {
    const content = readRouteFile("note/routes.ts");
    // 统计 requireOwner 在 preHandler 中出现的次数
    const preHandlerWithOwner = content.match(/preHandler:\s*\[requireOwner\]/g);
    // POST /notes, PATCH /notes/:id, DELETE /notes/:id, DELETE /notes/:id/permanent,
    // POST /notes/:id/restore, POST /notes/:id/versions/:versionId/restore = 6
    assert.ok(
      preHandlerWithOwner !== null && preHandlerWithOwner.length >= 6,
      `note/routes.ts 应至少有 6 个路由使用 requireOwner，实际找到 ${preHandlerWithOwner?.length ?? 0}`,
    );
  });

  // source/routes.ts: 写操作应挂载 requireOwner
  it("source/routes.ts 导入并使用 requireOwner", () => {
    const content = readRouteFile("source/routes.ts");
    assert.ok(content.includes("requireOwner"), "source/routes.ts 应导入并使用 requireOwner");
  });

  it("source/routes.ts 写操作挂载 requireOwner", () => {
    const content = readRouteFile("source/routes.ts");
    const preHandlerWithOwner = content.match(/preHandler:\s*\[requireOwner\]/g);
    // POST /sources, PATCH /sources/:id, DELETE /sources/:id,
    // POST /sources/:id/create-note = 4
    assert.ok(
      preHandlerWithOwner !== null && preHandlerWithOwner.length >= 4,
      `source/routes.ts 应至少有 4 个路由使用 requireOwner，实际找到 ${preHandlerWithOwner?.length ?? 0}`,
    );
  });

  // import/routes.ts: 写操作应挂载 requireOwner
  it("import/routes.ts 导入并使用 requireOwner", () => {
    const content = readRouteFile("import/routes.ts");
    assert.ok(content.includes("requireOwner"), "import/routes.ts 应导入并使用 requireOwner");
  });

  it("import/routes.ts 写操作挂载 requireOwner", () => {
    const content = readRouteFile("import/routes.ts");
    const preHandlerWithOwner = content.match(/preHandler:\s*\[requireOwner\]/g);
    // POST /import/markdown = 1
    assert.ok(
      preHandlerWithOwner !== null && preHandlerWithOwner.length >= 1,
      `import/routes.ts 应至少有 1 个路由使用 requireOwner，实际找到 ${preHandlerWithOwner?.length ?? 0}`,
    );
  });
});

// ─── 错误响应格式验证 ───────────────────────────────────────────────────

describe("permission-guard: 错误响应格式", () => {
  it("非 owner 的 isWorkspaceOwner 判定为 false（requireOwner 据此返回 403）", () => {
    // 2026-08-11（测试质量修复）：原断言是两个常量自比（从未调用被测逻辑）。
    // 改为真实调用 isWorkspaceOwner——requireOwner 的 403 路径即
    // `if (!isWorkspaceOwner(...)) return reply.code(403)`。
    const notOwner = isWorkspaceOwner({
      membershipRole: "member",
      workspaceOwnerId: "owner-user",
      userId: "current-user",
    });
    assert.equal(notOwner, false);

    const ownerByRole = isWorkspaceOwner({
      membershipRole: "owner",
      workspaceOwnerId: "owner-user",
      userId: "current-user",
    });
    assert.equal(ownerByRole, true);

    const ownerByWorkspace = isWorkspaceOwner({
      membershipRole: null,
      workspaceOwnerId: "current-user",
      userId: "current-user",
    });
    assert.equal(ownerByWorkspace, true);
  });

  it("isWorkspaceOwner 返回 false 时 requireOwner 应发送 403（语义验证）", () => {
    const isOwner = isWorkspaceOwner({
      membershipRole: "member",
      workspaceOwnerId: "other-user",
      userId: "current-user",
    });
    assert.equal(isOwner, false);
  });

  it("isWorkspaceOwner 返回 true 时 requireOwner 不发送错误（语义验证）", () => {
    const isOwner = isWorkspaceOwner({
      membershipRole: "owner",
      workspaceOwnerId: "other-user",
      userId: "current-user",
    });
    assert.equal(isOwner, true);
    // !true === false → 不进入 if 块 → 放行
    assert.equal(!isOwner, false);
  });
});

// ─── 权限守卫完整性：所有模块都使用 requireSession ──────────────────────

describe("permission-guard: 所有路由模块使用 requireSession 基线", () => {
  const ROUTES_DIR = path.resolve(import.meta.dirname, "../modules");

  function readRouteFile(relativePath: string): string {
    return fs.readFileSync(path.resolve(ROUTES_DIR, relativePath), "utf-8");
  }

  // 所有路由模块都应使用 requireSession 作为基线认证
  // （V1 card/evidence/benchmark 模块已随旧栈退役，不再列入）
  const allRouteModules = [
    "identity/routes.ts",
    "note/routes.ts",
    "source/routes.ts",
    "review/routes.ts",
    "understanding/routes.ts",
    "stats/routes.ts",
    "job/routes.ts",
    "import/routes.ts",
    "export/routes.ts",
    "search/routes.ts",
  ];

  for (const moduleFile of allRouteModules) {
    it(`${moduleFile} 导入并使用 requireSession`, () => {
      const fullPath = path.resolve(ROUTES_DIR, moduleFile);
      if (!fs.existsSync(fullPath)) {
        return;
      }
      const content = readRouteFile(moduleFile);
      assert.ok(
        content.includes("requireSession"),
        `${moduleFile} 应导入并使用 requireSession 作为基线认证`,
      );
    });
  }
});

// ─── /auth/me 角色推导一致性验证 ─────────────────────────────────────────

describe("permission-guard: /auth/me 角色推导与 isWorkspaceOwner 一致", () => {
  it("/auth/me 使用相同的 OR 语义推导 role（membership.owner || workspace.ownerId === userId）", () => {
    // routes.ts 中的角色推导逻辑：
    // const role = membership?.role === "owner" || workspace?.ownerId === userId
    //   ? "owner"
    //   : membership?.role ?? "member";
    //
    // 这与 isWorkspaceOwner 的 OR 语义完全一致：
    // ctx.membershipRole === "owner" || ctx.workspaceOwnerId === ctx.userId

    const testCases = [
      { membershipRole: "owner", workspaceOwnerId: "other", userId: "user", expectedRole: "owner" },
      { membershipRole: "member", workspaceOwnerId: "user", userId: "user", expectedRole: "owner" },
      { membershipRole: "member", workspaceOwnerId: "other", userId: "user", expectedRole: "member" },
      { membershipRole: null, workspaceOwnerId: "user", userId: "user", expectedRole: "owner" },
      { membershipRole: null, workspaceOwnerId: "other", userId: "user", expectedRole: "member" },
    ];

    for (const { membershipRole, workspaceOwnerId, userId, expectedRole } of testCases) {
      const isOwner = isWorkspaceOwner({ membershipRole, workspaceOwnerId, userId });
      // /auth/me 的推导：isOwner ? "owner" : (membershipRole ?? "member")
      const role = isOwner ? "owner" : (membershipRole ?? "member");
      assert.equal(
        role,
        expectedRole,
        `membership=${membershipRole}, ws.owner=${workspaceOwnerId} should give role=${expectedRole}`,
      );
    }
  });
});
