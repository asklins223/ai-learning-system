/**
 * SEC-01 / SEC-02: `isWorkspaceOwner` 纯函数单测（Owner vs Member）
 *
 * 只覆盖判定函数的全组合与 OR 语义。路由级的守卫**不在这里测**：原先本文件有
 * 四组「读路由文件、断言 `content.includes("requireOwner")` / 正则数 preHandler
 * 出现次数」的测试，把某个路由的 guard 摘掉、只要同文件别处还有 requireOwner
 * 就照样全绿，等于没有守卫。它们已由
 * `integration-tests/workspace-collab-postgres.integration.ts` 的守卫矩阵取代：
 * 走真实 invite 产出 member，对每条 owner-only 路由实发请求断 403、匿名断 401，
 * 并对成员应可用的用户级路由断「不得 403」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWorkspaceOwner } from "../modules/identity/middleware.ts";

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


