/**
 * 伴星审计的导出 / 删除（用户数据权利路径，此前零覆盖）。
 *
 * `GET /me/companion/audit/export` 与 `DELETE /me/companion/audit` 是用户对自己的
 * 伴星行为留痕行使「可携带 + 可删除」的唯一入口。这类路径的失败模式不是报错，
 * 而是**越界**：把别人的行导出，或删除时多删/少删。因此本文件的核心断言是
 * 跨用户与跨 workspace 的隔离，而不是返回体形状。
 *
 * 另外锁住「导出只含 opaque 引用」这条 §12.2 约束：审计行里不得出现页面内容、
 * DOM 或未提交输入。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  COMPANION_AUDIT_POLICY_VERSION,
  deleteCompanionUserData,
  exportCompanionUserData,
  logCompanionAudit,
} from "../modules/companion-shell/audit-service.ts";
import { closeDatabase } from "../db/client.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——companion audit 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userA = randomUUID();
const userB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const prefix = userA.slice(0, 8);

after(async () => {
  await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES
    (${userA}, ${`audit-a-${prefix}@example.test`}, 'test-hash', 'owner'),
    (${userB}, ${`audit-b-${prefix}@example.test`}, 'test-hash', 'owner')
`;

async function seedLedger(userId: string, workspaceId: string, label: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`
      INSERT INTO companion_invitation_ledger
        (workspace_id, user_id, stable_page_context_key, context_budget_key, reason_budget_key, reason_budget_remaining)
      VALUES (${workspaceId}, ${userId}, ${`page:${label}`}, ${`ctx:${label}`}, ${`reason:${label}`}, 1)
    `;
  });
}

test("导出只返回当前用户在当前 workspace 的 audit + ledger，且只含 opaque 引用", async () => {
  await logCompanionAudit({
    userId: userA, workspaceId: workspaceA, pageActionType: "invitation_shown",
    pageOpaqueId: "page-opaque-1", actionOpaqueId: "action-opaque-1",
    entityOpaqueIds: ["entity-opaque-1"],
  });
  await logCompanionAudit({
    userId: userA, workspaceId: workspaceA, pageActionType: "invitation_dismissed",
    pageOpaqueId: "page-opaque-2", result: "dismissed",
  });
  await logCompanionAudit({
    userId: userB, workspaceId: workspaceA, pageActionType: "invitation_shown",
    pageOpaqueId: "page-opaque-b",
  });
  await logCompanionAudit({
    userId: userA, workspaceId: workspaceB, pageActionType: "invitation_shown",
    pageOpaqueId: "page-opaque-other-ws",
  });
  await seedLedger(userA, workspaceA, "a-ws-a");
  await seedLedger(userB, workspaceA, "b-ws-a");

  const exported = await exportCompanionUserData(userA, workspaceA);
  assert.equal(exported.userId, userA);
  assert.equal(exported.audit.length, 2, "只导出本用户在本 workspace 的 audit 行");
  assert.equal(exported.invitationLedger.length, 1, "只导出本用户在本 workspace 的 ledger 行");
  assert.ok(exported.audit.every((row) => row.userId === userA));
  assert.ok(exported.audit.every((row) => row.workspaceId === workspaceA));
  assert.ok(exported.invitationLedger.every((row) => row.userId === userA));

  // §12.2：审计不存内容。用**精确列集合**断言，比子串黑名单更强也不会误报
  // （"contextPermissionHashes" 里恰好含 "text" 子串）。
  const AUDIT_COLUMNS = [
    "actionOpaqueId",
    "contextPermissionHashes",
    "createdAt",
    "entityOpaqueIds",
    "id",
    "pageActionType",
    "pageOpaqueId",
    "policyVersion",
    "result",
    "tombstonedAt",
    "userId",
    "workspaceId",
  ];
  for (const row of exported.audit) {
    assert.deepEqual(
      Object.keys(row).sort(),
      AUDIT_COLUMNS,
      "审计行的列集合必须恰好是 opaque 引用/版本/结果，不得新增内容型列",
    );
  }

  const first = exported.audit[0];
  assert.equal(first?.policyVersion, COMPANION_AUDIT_POLICY_VERSION);
  assert.equal(first?.pageOpaqueId, "page-opaque-1");

  // 导出按 createdAt 有序（keyset 分页拼接的对外契约）。
  const times = exported.audit.map((row) => new Date(row.createdAt).getTime());
  assert.deepEqual(times, [...times].sort((left, right) => left - right));
});

test("删除只清除当前用户在当前 workspace 的行，跨用户与跨 workspace 均不受影响", async () => {
  const before = await exportCompanionUserData(userB, workspaceA);
  assert.equal(before.audit.length, 1, "前置条件：另一用户在本 workspace 有 1 行");
  assert.equal(before.invitationLedger.length, 1);

  const deleted = await deleteCompanionUserData(userA, workspaceA);
  assert.equal(deleted.deletedAudit, 2, "删除本用户在本 workspace 的 2 条 audit");
  assert.equal(deleted.deletedLedger, 1);

  const afterDelete = await exportCompanionUserData(userA, workspaceA);
  assert.equal(afterDelete.audit.length, 0);
  assert.equal(afterDelete.invitationLedger.length, 0);

  // 别人的行必须完好
  const otherUser = await exportCompanionUserData(userB, workspaceA);
  assert.equal(otherUser.audit.length, 1, "不得删除其他用户的行");
  assert.equal(otherUser.invitationLedger.length, 1, "不得删除其他用户的 ledger 行");

  // 本用户在另一个 workspace 的行也必须完好
  const otherWorkspace = await exportCompanionUserData(userA, workspaceB);
  assert.equal(otherWorkspace.audit.length, 1, "不得跨 workspace 删除本用户的行");
});

test("重复删除是幂等的（第二次 0 行，不报错）", async () => {
  const again = await deleteCompanionUserData(userA, workspaceA);
  assert.deepEqual(again, { deletedAudit: 0, deletedLedger: 0 });
});
