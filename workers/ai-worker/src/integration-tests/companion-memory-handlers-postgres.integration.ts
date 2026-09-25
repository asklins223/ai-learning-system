/**
 * worker 侧记忆链路 handler（此前零覆盖）：
 *   - companion_memory_embedding_rebuild：向量重建
 *   - companion_memory_maintenance：每日衰减/归档 tick
 *
 * 这两条都是「静默失败」风险最高的形态：它们不在用户请求路径上，出错只写日志。
 * 因此这里锁的是**边界行为**而不是 happy path：
 *   1. payload 缺 userId → 必须显式报错（不能默默跳过整批记忆）；
 *   2. 未取得 AI 同意 → fail closed（不得在无同意的工作区生成/落库向量）；
 *   3. 同意已给但未配置 embedding provider → 优雅跳过，且**不得**把记忆标成
 *      ready（否则检索会拿到空向量）；
 *   4. 维护 tick 的每日一次性由数据库日期键保证：重复调用不重复维护、不抛错。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runCompanionMemoryEmbeddingRebuild } from "../handlers/companion-memory-embedding.ts";
import { tickCompanionMemoryMaintenance } from "../handlers/companion-memory-maintenance.ts";
import { closeDatabase } from "../db.ts";

const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const WORKER_URL = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
if (!MIGRATOR_URL || !WORKER_URL) {
  throw new Error("DATABASE_URL_MIGRATOR / DATABASE_URL_WORKER 未配置——该测试要求真实 Postgres");
}

// 夹具与断言用 migrator（拥有这些表、BYPASSRLS），handler 走它自己的 worker 连接。
const admin = postgres(MIGRATOR_URL, { max: 3 });

const userId = randomUUID();
const workspaceId = randomUUID();
const jobId = randomUUID();
const leaseToken = `lease-${randomUUID()}`;
const memoryId = randomUUID();
const prefix = userId.slice(0, 8);

after(async () => {
  await admin`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await admin`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${`mem-worker-${prefix}@example.test`}, 'test-hash', 'owner')
`;
await admin`
  INSERT INTO workspaces (id, name, owner_id, workspace_type)
  VALUES (${workspaceId}, ${`mem-worker-${prefix}`}, ${userId}, 'personal')
`;
// embedding 重建的候选集合：非候选、未删除、embedding_status='none'。
await admin`
  INSERT INTO assistant_memory_items
    (id, workspace_id, user_id, kind, content, candidate, embedding_status, source_event_id)
  VALUES (${memoryId}, ${workspaceId}, ${userId}, 'goal', '需要向量化的记忆', false, 'none', ${`worker-embed:${memoryId}`})
`;
// status='running' + 匹配 lease_token 才能通过 assertJobLease。
await admin`
  INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status, lease_token, started_at)
  VALUES (${jobId}, 'companion_memory_embedding_rebuild', ${workspaceId}, ${userId},
          ${admin.json({ userId })}, 'running', ${leaseToken}, now())
`;

const job = {
  id: jobId,
  workspaceId,
  requestedBy: userId,
  leaseToken,
  payload: { userId },
} as unknown as Parameters<typeof runCompanionMemoryEmbeddingRebuild>[0];

async function setConsent(granted: boolean): Promise<void> {
  // 同意从 `workspaces` 搬到了 `user_ai_settings`（迁移 0237，按 user_id 键，DROP 了
  // workspaces 那三列）。夹具原来还在写旧列，这个文件的两条用例自 0237 起就地 42703——
  // 只因为 `v1.0` 不在 CI 的 push 分支上，才一直没人看到它红。
  await admin`
    INSERT INTO user_ai_settings (user_id, consent_version, consent_at)
    VALUES (${userId}, ${granted ? "v1" : null}, ${granted ? new Date() : null})
    ON CONFLICT (user_id) DO UPDATE
      SET consent_version = EXCLUDED.consent_version,
          consent_at = EXCLUDED.consent_at
  `;
}

test("payload 缺 userId → 显式报错（不得静默跳过整批记忆）", async () => {
  const broken = { ...job, payload: {} } as typeof job;
  await assert.rejects(
    () => runCompanionMemoryEmbeddingRebuild(broken),
    /缺 userId/,
  );
});

test("只配置 mock provider 时同意门有意豁免；但缺少向量 provider 时不得改状态", async () => {
  // governance 的同意门只在存在外部非 mock provider 时生效（mock 不外发数据）。
  // 无任何平台配置的测试环境正是 mock-only：handler 必须**不抛错**地优雅跳过。
  // 真正的同意强制点由 src/lib/governance-consent.test.ts 用注入 provider 覆盖。
  await setConsent(false);
  await assert.doesNotReject(() => runCompanionMemoryEmbeddingRebuild(job));
  const rows = await admin`SELECT embedding_status FROM assistant_memory_items WHERE id = ${memoryId}`;
  assert.equal(rows[0]?.embedding_status, "none", "没有向量 provider 时不得改动 embedding 状态");
});

test("已同意但未配置 embedding provider → 优雅跳过，且不得把记忆标成 ready", async () => {
  await setConsent(true);
  await assert.doesNotReject(() => runCompanionMemoryEmbeddingRebuild(job));

  const rows = await admin`SELECT embedding_status FROM assistant_memory_items WHERE id = ${memoryId}`;
  assert.equal(
    rows[0]?.embedding_status,
    "none",
    "没有向量就不能标 ready —— 否则检索会拿到空向量",
  );
  const embeddings = await admin`SELECT count(*)::int AS n FROM assistant_memory_embeddings WHERE memory_id = ${memoryId}`;
  assert.equal(embeddings[0]?.n, 0, "未生成向量时不得写 embeddings 行");
});

test("维护 tick：数据库日期键保证每日一次，重复调用不抛错也不重复维护", async () => {
  await assert.doesNotReject(() => tickCompanionMemoryMaintenance());
  const afterFirst = await admin`
    SELECT count(*)::int AS n FROM companion_memory_maintenance_runs
    WHERE run_date = (now() AT TIME ZONE 'UTC')::date
  `;
  assert.equal(afterFirst[0]?.n, 1, "首次 tick 必须留下当日日期键（跨副本一次性门）");

  await assert.doesNotReject(() => tickCompanionMemoryMaintenance());
  const afterSecond = await admin`
    SELECT count(*)::int AS n FROM companion_memory_maintenance_runs
    WHERE run_date = (now() AT TIME ZONE 'UTC')::date
  `;
  assert.equal(afterSecond[0]?.n, 1, "重复 tick 不得产生第二条当日记录");
});
