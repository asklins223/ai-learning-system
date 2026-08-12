/**
 * P2 companion conversation foundation migration 集成测试（runbook 6.5）。
 *
 * 验证 0088 migration 在真实 Postgres 上：
 * 1. 六张表全部存在；
 * 2. 六张表全部 ENABLE + FORCE RLS，且 policy 匹配 app.workspace_id + app.user_id；
 * 3. 关键索引/唯一约束存在（activity idx、inbox active partial unique、
 *    messages conversation+seq unique、turn runs active partial unique）；
 * 4. RLS 生效：无 session context 时 API/worker 查询零行（FORCE RLS 兜底）。
 *
 * 环境：DATABASE_URL_API / DATABASE_URL（compose postgres）。无 DB 时 fail closed
 * （runbook 6.5：缺少数据库/角色凭据退出非零，不把 skip 当通过）——本文件在
 * 无 DB 时抛错；CI 无 DB 时由 test:companion:postgres 脚本单独控制运行时机。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;

const COMPANION_TABLES = [
  "companion_conversations",
  "companion_messages",
  "companion_turn_runs",
  "companion_stream_events",
  "companion_voice_artifacts",
  "companion_proactive_deliveries",
];

function mustConnect(): Pool {
  if (!CONN) {
    throw new Error("DATABASE_URL_API 未配置——companion:postgres 集成测试要求真实 Postgres");
  }
  return new Pool({ connectionString: CONN, connectionTimeoutMillis: 8_000 });
}

test("0088：六张 companion 表存在且 RLS ENABLE+FORCE，policy 为 workspace+user 双条件", async () => {
  const pool = mustConnect();
  try {
    const { rows } = await pool.query(
      `SELECT t.table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM information_schema.tables t
       JOIN pg_class c ON c.oid = ('public.' || t.table_name)::regclass
       WHERE t.table_schema = 'public' AND t.table_name = ANY($1::text[])`,
      [COMPANION_TABLES],
    );
    assert.equal(rows.length, COMPANION_TABLES.length, `缺表：${COMPANION_TABLES.filter((n) => !rows.some((r) => r.table_name === n)).join(", ")}`);
    for (const row of rows) {
      assert.equal(row.rls, true, `${row.table_name} 未 ENABLE RLS`);
      assert.equal(row.force_rls, true, `${row.table_name} 未 FORCE RLS`);
    }
    // policy 存在且同时匹配 workspace_id + user_id
    const { rows: policies } = await pool.query(
      `SELECT tablename, policyname, cmd
       FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [COMPANION_TABLES],
    );
    assert.equal(policies.length >= COMPANION_TABLES.length, true, "每张表至少一个 policy");
    const { rows: policyExprs } = await pool.query(
      `SELECT c.relname AS tablename, pg_get_expr(p.polqual, p.polrelid) AS qual
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       WHERE p.polrelid = ANY(ARRAY(SELECT ('public.' || unnest($1::text[]))::regclass))`,
      [COMPANION_TABLES],
    );
    for (const p of policyExprs as Array<Record<string, string | null>>) {
      assert.match(p.qual ?? "", /app\.workspace_id/, `${p.tablename} policy 必须匹配 app.workspace_id`);
      assert.match(p.qual ?? "", /app\.user_id/, `${p.tablename} policy 必须匹配 app.user_id`);
    }
  } finally {
    await pool.end();
  }
});

test("0088：关键索引与唯一约束存在", async () => {
  const pool = mustConnect();
  try {
    const expectedIndexes = [
      "companion_conversations_activity_idx",
      "companion_conversations_inbox_active_unique",
      "companion_messages_conversation_seq_unique",
      "companion_messages_client_message_unique",
      "companion_turn_runs_conversation_generation_unique",
      "companion_turn_runs_idempotency_unique",
      "companion_turn_runs_active_unique",
      "companion_stream_events_pkey",
      "companion_voice_artifacts_message_unique",
      "companion_proactive_deliveries_permit_unique",
    ];
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [expectedIndexes],
    );
    const missing = expectedIndexes.filter((n) => !(rows as Array<Record<string, string>>).some((r) => r.indexname === n));
    assert.deepEqual(missing, [], `缺索引/约束：${missing.join(", ")}`);
  } finally {
    await pool.end();
  }
});

test("0088：FORCE RLS 生效——ailearn_worker 无 session context 时查询零行", async () => {
  // 结构断言（pg_catalog 不受 RLS 影响）
  const pool = mustConnect();
  try {
    const { rows } = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE relname = 'companion_conversations'`,
    );
    assert.equal(rows[0].relrowsecurity, true, "ROW LEVEL SECURITY 必须开启");
    assert.equal(rows[0].relforcerowsecurity, true, "FORCE ROW LEVEL SECURITY 必须开启");
  } finally {
    await pool.end();
  }

  // 行为断言：ailearn（superuser/BYPASSRLS）无法验证 FORCE RLS，必须用
  // ailearn_worker（非 superuser、非 BYPASSRLS，0088 已 grant SELECT）。
  const worker = new Pool({
    // 允许通过 DATABASE_URL_WORKER 覆盖（默认 dev 拓扑），避免硬编码连接串。
    connectionString: process.env.DATABASE_URL_WORKER ?? "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn",
  });
  try {
    const { rows } = await worker.query(
      `SELECT count(*)::int AS n FROM public.companion_conversations`,
    );
    assert.equal(rows[0].n, 0, "ailearn_worker 无 session context 必须零行（FORCE RLS 兜底）");
  } finally {
    await worker.end();
  }
});
