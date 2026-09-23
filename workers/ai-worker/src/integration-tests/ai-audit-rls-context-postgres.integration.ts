/**
 * F07 回归 —— AI 外发审计行必须带着工作区与 actor 上下文写入。
 *
 * 为什么需要这条测试：`ai_audit_log` 上挂着两条 RESTRICTIVE 守卫
 * （`sec01_v1_ai_audit_tenant_guard` 要求 `workspace_id = app.workspace_id`，
 * `sec01_v1_ai_audit_insert_actor_guard` 要求 `user_id = app.user_id`）。worker 的独立
 * 连接这两项默认都是 NULL，裸 `db.insert` 会被拒。而**超级用户绕过 RLS**，所以本地
 * 拿超管库跑什么都绿——2026-09-23 审计现场：近 1 小时 35 次
 * `failed to write AI audit log`、库侧当天 0 行，而真实模型调用发生过。
 *
 * 三条断言是一组，缺一条就分不清"守卫坏了"还是"夹具不对"：
 * 1. **正控**：受限角色、不设上下文裸插一行，必须被拒。它证明这条测试连的是受限角色，
 *    也证明守卫真的在拦。
 * 2. 走 `logAICall` 必须落库一行，且字段与参数一致——这才是用户能感知的那件事
 *    （设置 → AI 数据同意里"哪一天、把哪类内容发给了哪家模型、成没成"）。
 * 3. **跨空间写入必须被拒**：在 A 空间的上下文里插一行 B 空间的审计，租户守卫要拦。
 *
 * 运行（真 Postgres、零 AI 调用、不出网）：
 *   node --import tsx --test --test-timeout=120000 \
 *     workers/ai-worker/src/integration-tests/ai-audit-rls-context-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATOR ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const USER_ID = randomUUID();
const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`ai-audit-rls-${USER_ID}@example.invalid`}, 'unused')`;
    await tx`INSERT INTO workspaces (id, name, workspace_type, owner_id)
      VALUES (${WORKSPACE_ID}, ${`ws-ai-audit-${WORKSPACE_ID.slice(0, 8)}`}, 'personal', ${USER_ID})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner', now())`;
    await tx`INSERT INTO workspaces (id, name, workspace_type, owner_id)
      VALUES (${OTHER_WORKSPACE_ID}, ${`ws-ai-audit-other-${OTHER_WORKSPACE_ID.slice(0, 8)}`}, 'personal', ${USER_ID})`;
  });
});

after(async () => {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM ai_audit_log WHERE workspace_id IN (${WORKSPACE_ID}, ${OTHER_WORKSPACE_ID})`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`;
    await tx`DELETE FROM workspaces WHERE id IN (${WORKSPACE_ID}, ${OTHER_WORKSPACE_ID})`;
    await tx`DELETE FROM users WHERE id = ${USER_ID}`;
  });
  await admin.end({ timeout: 5 });
  // worker 连接池不关掉，进程会挂到超时；那时读到的失败是 "test timed out"，
  // 与被测行为无关（F27 那条同款坑）。
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
});

function auditValues(workspaceId: string) {
  return {
    workspaceId,
    userId: USER_ID,
    jobId: null,
    provider: "openai_compatible",
    modelId: "test-model",
    operation: "f07_regression:chatCompletion",
    dataCategories: ["prompt"],
    dataSizeBytes: 12,
    costTokens: 3,
    durationMs: 7,
    status: "success",
    errorMessage: null,
  };
}

test("正控：受限角色不设上下文时，审计行写不进去", async () => {
  const { db } = await import("../db.ts");
  const schema = await import("@ailearn/shared/db-schema");

  await assert.rejects(
    async () => {
      await db.insert(schema.aiAuditLog).values(auditValues(WORKSPACE_ID));
    },
    "裸 db.insert 必须被守卫拒掉（没拒说明这条测试连的是会绕过 RLS 的角色）",
  );
});

test("logAICall 带着上下文落库：字段与参数一致", async () => {
  const { logAICall } = await import("../lib/governance.ts");

  const written = await logAICall(
    {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      jobId: null,
      provider: "openai_compatible",
      modelId: "test-model",
      operation: "f07_regression:chatCompletion",
      dataCategories: ["prompt"],
      dataSizeBytes: 12,
      costTokens: 3,
      durationMs: 7,
      status: "success",
    },
    // 策略走注入，避免这条用例去读账号级同意（那是另一条链）。
    { policy: { auditLogging: true } as never },
  );

  assert.equal(written, true, "logAICall 必须报告写成功（false = 又被守卫拒了）");

  const rows = await admin`
    SELECT workspace_id, user_id, provider, model_id, operation, status
    FROM ai_audit_log
    WHERE workspace_id = ${WORKSPACE_ID} AND operation = 'f07_regression:chatCompletion'`;
  assert.equal(rows.length, 1, "审计行必须落库");
  assert.equal(rows[0].user_id, USER_ID);
  assert.equal(rows[0].status, "success");
  assert.equal(rows[0].provider, "openai_compatible");
});

test("跨空间写入被租户守卫拒掉", async () => {
  const { withWorkerWorkspaceTransaction } = await import("../db.ts");
  const schema = await import("@ailearn/shared/db-schema");

  await assert.rejects(
    withWorkerWorkspaceTransaction(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      async (tx) => {
        // 上下文是 A 空间，行写的是 B 空间：租户守卫必须拦。
        await tx.insert(schema.aiAuditLog).values(auditValues(OTHER_WORKSPACE_ID));
      },
    ),
    "另一个空间的审计行不许借 A 空间的上下文写进去",
  );

  const [count] = await admin`
    SELECT count(*)::int AS n FROM ai_audit_log WHERE workspace_id = ${OTHER_WORKSPACE_ID}`;
  assert.equal(count.n, 0, "被拒的那一行不能真的落库");
});
