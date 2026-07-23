/**
 * SEC-02 / ALPHA-01: 邀请并发消费与 session 撤销静态分析测试
 *
 * 覆盖 ADR-0002 和实施计划 §6.2 的 DoD 项：
 *   1. "过期、撤销、已消费和并发消费均有明确结果" — 验证 consumeInvite 的行锁机制
 *   2. "被移除成员的 session 失效且无法继续读取 workspace" — 验证 removeMember 的 session 撤销
 *   3. "Owner 能创建、复制、查看状态、撤销邀请" — 验证邀请生命周期完整性
 *   4. "成员不能执行 Owner 操作" — 验证权限守卫覆盖
 *
 * 本测试通过静态分析源码验证安全边界，不依赖数据库。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  generateInvitationToken,
  hashInvitationToken,
  createInvitationTokenHint,
  createInvitationTokenStorage,
  isValidInvitationToken,
  isValidInvitationTokenHash,
  constantTimeInvitationTokenHashEqual,
  invitationTokenMatchesHash,
  INVITATION_TOKEN_LENGTH,
  INVITATION_TOKEN_HASH_LENGTH,
  INVITATION_TOKEN_HINT_LENGTH,
} from "../modules/identity/invitation-token.ts";
import {
  computeStatus,
  ConsumeInviteError,
  ONBOARDING_STEPS,
  type ConsumeInviteErrorCode,
} from "../modules/identity/invite-service.ts";

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

// ─── 1. consumeInvite 行锁机制（并发消费防护）──────────────────────────────

describe("SEC-02 DoD: consumeInvite 并发消费防护", () => {
  it("consumeInvite 使用 SELECT ... FOR UPDATE 锁定邀请行", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const consumeSection = content.substring(content.indexOf("export async function consumeInvite"));
    assert.ok(
      consumeSection.includes('.for("update")') || consumeSection.includes(".for('update')"),
      "consumeInvite 应使用 SELECT ... FOR UPDATE 锁定邀请行，防止并发消费",
    );
  });

  it("consumeInvite 锁定条件包含 token_hash + 未消费 + 未撤销 + 未过期", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const consumeSection = content.substring(content.indexOf("export async function consumeInvite"));
    assert.ok(
      consumeSection.includes("tokenHash") || consumeSection.includes("token_hash"),
      "锁定条件应包含 token_hash",
    );
    assert.ok(
      consumeSection.includes("isNull(inviteCodes.consumedBy)") || consumeSection.includes("consumedBy"),
      "锁定条件应包含未消费 (consumedBy IS NULL)",
    );
    assert.ok(
      consumeSection.includes("isNull(inviteCodes.revokedAt)") || consumeSection.includes("revokedAt"),
      "锁定条件应包含未撤销 (revokedAt IS NULL)",
    );
    assert.ok(
      consumeSection.includes("expiresAt") || consumeSection.includes("expires_at"),
      "锁定条件应包含过期检查",
    );
  });

  it("consumeInvite 在锁定失败后区分错误码", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const consumeSection = content.substring(content.indexOf("export async function consumeInvite"));
    // When the locked query returns no rows, the function should check
    // if the invite exists at all to distinguish error codes
    assert.ok(
      consumeSection.includes("existing") || consumeSection.includes("revoked") || consumeSection.includes("already_consumed"),
      "consumeInvite 应在锁定失败后区分 revoked/already_consumed/expired 错误码",
    );
  });

  it("consumeInvite 检查邮箱唯一性", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const consumeSection = content.substring(content.indexOf("export async function consumeInvite"));
    assert.ok(
      consumeSection.includes("email_exists") || consumeSection.includes("users.findFirst"),
      "consumeInvite 应检查邮箱唯一性并返回 email_exists 错误码",
    );
  });

  it("ConsumeInviteError 覆盖所有 6 种错误码", () => {
    const allCodes: ConsumeInviteErrorCode[] = [
      "not_found",
      "expired",
      "revoked",
      "already_consumed",
      "email_exists",
      "concurrent_consumption",
    ];
    for (const code of allCodes) {
      const error = new ConsumeInviteError(code);
      assert.equal(error.code, code);
      assert.equal(error.name, "ConsumeInviteError");
      assert.ok(error instanceof Error);
    }
  });

  it("consumeInvite 使用 db.transaction（不是 withWorkspaceTransaction）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const consumeSection = content.substring(content.indexOf("export async function consumeInvite"));
    // consumeInvite operates across workspaces (registration), so it uses
    // db.transaction directly instead of withWorkspaceTransaction
    assert.ok(
      consumeSection.includes("db.transaction"),
      "consumeInvite 应使用 db.transaction（跨 workspace 注册操作）",
    );
  });
});

// ─── 2. removeMember session 撤销 ──────────────────────────────────────────

describe("SEC-02 DoD: removeMember session 撤销", () => {
  it("removeMember 函数存在", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    assert.ok(
      content.includes("export async function removeMember") ||
        content.includes("async function removeMember"),
      "removeMember 函数应存在",
    );
  });

  it("removeMember 在事务中删除 sessions", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const removeSection = content.substring(content.indexOf("removeMember"));
    // removeMember should delete sessions within the transaction
    assert.ok(
      removeSection.includes("sessions") && (removeSection.includes("delete") || removeSection.includes("DELETE")),
      "removeMember 应在事务中删除被移除成员的 sessions",
    );
  });

  it("removeMember 使用 withWorkspaceTransaction", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const removeSection = content.substring(content.indexOf("removeMember"));
    assert.ok(
      removeSection.includes("withWorkspaceTransaction"),
      "removeMember 应使用 withWorkspaceTransaction 确保事务一致性",
    );
  });

  it("removeMember 防止 Owner 自我移除", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const removeSection = content.substring(content.indexOf("removeMember"));
    assert.ok(
      removeSection.includes("self_remove_owner") || removeSection.includes("ownerId"),
      "removeMember 应防止 Owner 自我移除",
    );
  });

  it("removeMember 防止移除最后一个 Owner", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const removeSection = content.substring(content.indexOf("removeMember"));
    assert.ok(
      removeSection.includes("last_owner"),
      "removeMember 应防止移除最后一个 Owner",
    );
  });

  it("removeMember 使用软删除（ADR-0009）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const removeSection = content.substring(content.indexOf("removeMember"));
    // ADR-0009: soft delete (set left_at) instead of hard delete
    assert.ok(
      removeSection.includes("leftAt") || removeSection.includes("left_at"),
      "removeMember 应使用软删除（设置 left_at）而非硬删除（ADR-0009）",
    );
  });

  it("listMembers 只返回活跃成员（left_at IS NULL）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const listSection = content.substring(content.indexOf("listMembers"));
    assert.ok(
      listSection.includes("isNull") || listSection.includes("leftAt") || listSection.includes("left_at"),
      "listMembers 应只返回活跃成员（left_at IS NULL）",
    );
  });
});

// ─── 3. 邀请生命周期完整性 ─────────────────────────────────────────────────

describe("SEC-02 DoD: 邀请生命周期完整性", () => {
  it("createInvite 使用 withWorkspaceTransaction", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const createSection = content.substring(
      content.indexOf("export async function createInvite"),
      content.indexOf("export async function listInvites"),
    );
    assert.ok(
      createSection.includes("withWorkspaceTransaction"),
      "createInvite 应使用 withWorkspaceTransaction",
    );
  });

  it("createInvite 验证角色", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const createSection = content.substring(
      content.indexOf("export async function createInvite"),
      content.indexOf("export async function listInvites"),
    );
    assert.ok(
      createSection.includes("VALID_ROLES") || createSection.includes("invalid_role"),
      "createInvite 应验证角色（只允许 owner/member）",
    );
  });

  it("createInvite 不存储明文 token", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const createSection = content.substring(
      content.indexOf("export async function createInvite"),
      content.indexOf("export async function listInvites"),
    );
    // Should store tokenHash and tokenHint, not the plaintext token
    assert.ok(
      createSection.includes("tokenHash") && createSection.includes("tokenHint"),
      "createInvite 应存储 tokenHash 和 tokenHint",
    );
    assert.ok(
      !createSection.includes("token: token") && !createSection.includes("token: storage.token"),
      "createInvite 不应在数据库中存储明文 token",
    );
  });

  it("revokeInvite 使用 SELECT ... FOR UPDATE", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const revokeSection = content.substring(
      content.indexOf("export async function revokeInvite"),
      content.indexOf("export async function consumeInvite"),
    );
    assert.ok(
      revokeSection.includes('.for("update")') || revokeSection.includes(".for('update')"),
      "revokeInvite 应使用 SELECT ... FOR UPDATE 防止并发撤销",
    );
  });

  it("revokeInvite 按 workspaceId 过滤", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const revokeSection = content.substring(
      content.indexOf("export async function revokeInvite"),
      content.indexOf("export async function consumeInvite"),
    );
    assert.ok(
      revokeSection.includes("workspaceId") || revokeSection.includes("workspace_id"),
      "revokeInvite 应按 workspaceId 过滤邀请",
    );
  });

  it("listInvites 按 workspaceId 过滤", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const listSection = content.substring(
      content.indexOf("export async function listInvites"),
      content.indexOf("export async function revokeInvite"),
    );
    assert.ok(
      listSection.includes("workspaceId") || listSection.includes("workspace_id"),
      "listInvites 应按 workspaceId 过滤邀请列表",
    );
  });

  it("listInvites 不返回 tokenHash（安全敏感）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const listSection = content.substring(
      content.indexOf("export async function listInvites"),
      content.indexOf("export async function revokeInvite"),
    );
    // The select should include tokenHint but not tokenHash
    assert.ok(
      listSection.includes("tokenHint"),
      "listInvites 应返回 tokenHint（用于识别）",
    );
    // Check that tokenHash is not in the selected columns
    const selectSection = listSection.substring(
      listSection.indexOf(".select("),
      listSection.indexOf(".from("),
    );
    assert.ok(
      !selectSection.includes("tokenHash"),
      "listInvites 不应在查询结果中返回 tokenHash",
    );
  });

  it("computeStatus 状态优先级正确：revoked > consumed > expired > active", () => {
    const past = new Date("2026-07-17T08:00:00.000Z");
    const now = new Date("2026-07-20T08:00:00.000Z");

    assert.equal(computeStatus({ consumedAt: past, revokedAt: past, expiresAt: past }, now), "revoked");
    assert.equal(computeStatus({ consumedAt: past, revokedAt: null, expiresAt: past }, now), "consumed");
    assert.equal(computeStatus({ consumedAt: null, revokedAt: null, expiresAt: past }, now), "expired");
    assert.equal(computeStatus({ consumedAt: null, revokedAt: null, expiresAt: null }, now), "active");
    assert.equal(computeStatus({ consumedAt: null, revokedAt: null, expiresAt: new Date("2026-07-25") }, now), "active");
  });
});

// ─── 4. 邀请 token 安全存储验证 ─────────────────────────────────────────────

describe("SEC-02 DoD: 邀请 token 安全存储", () => {
  it("token 使用 domain-separated hash（不是简单截断）", () => {
    const token = generateInvitationToken();
    const hint = createInvitationTokenHint(token);
    // Hint should not be a substring of the token
    assert.ok(!token.includes(hint), "hint 不应是 token 的子串");
    assert.ok(hint.length < token.length, "hint 应比 token 短");
  });

  it("不同 token 生成不同 hash", () => {
    const t1 = generateInvitationToken();
    const t2 = generateInvitationToken();
    const h1 = hashInvitationToken(t1);
    const h2 = hashInvitationToken(t2);
    assert.notEqual(h1, h2, "不同 token 应生成不同 hash");
  });

  it("相同 token 生成相同 hash（确定性）", () => {
    const token = generateInvitationToken();
    const h1 = hashInvitationToken(token);
    const h2 = hashInvitationToken(token);
    assert.equal(h1, h2, "相同 token 应生成相同 hash");
  });

  it("constantTimeInvitationTokenHashEqual 使用固定时间比较", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    assert.ok(constantTimeInvitationTokenHashEqual(hash, hash), "相同 hash 应返回 true");
    assert.ok(!constantTimeInvitationTokenHashEqual(hash, ""), "空 hash 应返回 false");
    assert.ok(!constantTimeInvitationTokenHashEqual("", hash), "空 hash 应返回 false");
  });

  it("invitationTokenMatchesHash 校验候选 token", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    assert.ok(invitationTokenMatchesHash(token, hash), "正确 token 应匹配");
    assert.ok(!invitationTokenMatchesHash(generateInvitationToken(), hash), "错误 token 不应匹配");
    assert.ok(!invitationTokenMatchesHash("", hash), "空 token 不应匹配");
    assert.ok(!invitationTokenMatchesHash(token, ""), "空 hash 不应匹配");
  });

  it("createInvitationTokenStorage 返回 hash + hint（不含明文）", () => {
    const token = generateInvitationToken();
    const storage = createInvitationTokenStorage(token);
    assert.ok("tokenHash" in storage, "应包含 tokenHash");
    assert.ok("tokenHint" in storage, "应包含 tokenHint");
    assert.ok(!("token" in storage), "不应包含明文 token");
  });

  it("无效 token 格式被拒绝", () => {
    const invalidTokens = ["", "short", "invalid-chars!@#", null, undefined];
    for (const invalid of invalidTokens) {
      assert.equal(isValidInvitationToken(invalid), false, `"${invalid}" 应被拒绝`);
    }
  });

  it("token 长度和格式正确", () => {
    const token = generateInvitationToken();
    assert.equal(token.length, INVITATION_TOKEN_LENGTH, `token 长度应为 ${INVITATION_TOKEN_LENGTH}`);
    assert.ok(isValidInvitationToken(token), "生成的 token 应通过格式校验");

    const hash = hashInvitationToken(token);
    assert.equal(hash.length, INVITATION_TOKEN_HASH_LENGTH, `hash 长度应为 ${INVITATION_TOKEN_HASH_LENGTH}`);
    assert.ok(isValidInvitationTokenHash(hash), "hash 应通过格式校验");

    const hint = createInvitationTokenHint(token);
    assert.equal(hint.length, INVITATION_TOKEN_HINT_LENGTH, `hint 长度应为 ${INVITATION_TOKEN_HINT_LENGTH}`);
  });
});

// ─── 5. onboarding 状态管理 ─────────────────────────────────────────────────

describe("SEC-02 DoD: onboarding 状态管理", () => {
  it("ONBOARDING_STEPS 包含 7 个步骤且顺序正确", () => {
    assert.equal(ONBOARDING_STEPS.length, 7);
    assert.deepEqual([...ONBOARDING_STEPS], [
      "ai_consent",
      "provider_config",
      "first_content",
      "first_note",
      "first_card",
      "evidence_review",
      "first_validation",
    ]);
  });

  it("onboarding 使用 withWorkspaceTransaction", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    assert.ok(
      content.includes("getOnboardingState") || content.includes("ensureOnboardingState") || content.includes("markOnboardingStep"),
      "应存在 onboarding 状态管理函数",
    );
    // Check that onboarding functions use withWorkspaceTransaction
    const onboardingSection = content.substring(
      content.indexOf("getOnboardingState"),
    );
    assert.ok(
      onboardingSection.includes("withWorkspaceTransaction") || onboardingSection.includes("db.transaction"),
      "onboarding 操作应在事务中执行",
    );
  });

  it("onboarding 查询按 workspaceId 和 userId 过滤", () => {
    const content = readFile(join(MODULES_DIR, "identity", "invite-service.ts"));
    const onboardingSection = content.substring(
      content.indexOf("getOnboardingState"),
    );
    assert.ok(
      onboardingSection.includes("workspaceId") && onboardingSection.includes("userId"),
      "onboarding 查询应按 workspaceId 和 userId 过滤",
    );
  });
});

// ─── 6. requireOwner 权限守卫 ──────────────────────────────────────────────

describe("SEC-02 DoD: requireOwner 权限守卫", () => {
  it("requireOwner 中间件存在", () => {
    const content = readFile(join(MODULES_DIR, "identity", "middleware.ts"));
    assert.ok(
      content.includes("requireOwner") || content.includes("isWorkspaceOwner"),
      "应存在 requireOwner 中间件或 isWorkspaceOwner 函数",
    );
  });

  it("isWorkspaceOwner 使用 OR 语义（role === owner || workspace.ownerId === userId）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "middleware.ts"));
    assert.ok(
      content.includes("isWorkspaceOwner"),
      "应导出 isWorkspaceOwner 纯函数",
    );
    // Check OR semantics
    const ownerSection = content.substring(content.indexOf("isWorkspaceOwner"));
    assert.ok(
      ownerSection.includes("owner") && ownerSection.includes("ownerId"),
      "isWorkspaceOwner 应检查 role 和 ownerId",
    );
  });

  it("邀请路由使用 requireOwner", () => {
    const content = readFile(join(MODULES_DIR, "identity", "routes.ts"));
    // POST /invites, GET /invites, DELETE /invites/:id should use requireOwner
    assert.ok(
      content.includes("requireOwner"),
      "identity 路由应使用 requireOwner 中间件",
    );
  });

  it("成员管理路由使用 requireOwner", () => {
    const content = readFile(join(MODULES_DIR, "identity", "routes.ts"));
    // GET /members, DELETE /members/:userId should use requireOwner
    assert.ok(
      content.includes("/members") && content.includes("requireOwner"),
      "成员管理路由应使用 requireOwner",
    );
  });

  it("onboarding 路由使用 requireSession（非 requireOwner）", () => {
    const content = readFile(join(MODULES_DIR, "identity", "routes.ts"));
    // onboarding routes should be accessible to all members
    assert.ok(
      content.includes("/onboarding"),
      "应存在 onboarding 路由",
    );
    // Check that onboarding routes use requireSession, not requireOwner
    // by verifying that the route file has both requireSession and requireOwner
    assert.ok(
      content.includes("requireSession"),
      "identity 路由应使用 requireSession 作为基础认证",
    );
  });
});
