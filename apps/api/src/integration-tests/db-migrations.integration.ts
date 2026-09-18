/**
 * DB 连通性与迁移状态集成测试（救火 2 验证 + 诊断）。
 *
 * 验证当前 LearningRun 核心表在真实 Postgres 中存在，且已退役的
 * Session/Episode 表不会被 fresh migration 重新创建。
 *
 * 环境：DATABASE_URL_API / DATABASE_URL（compose postgres）。
 * 跳过条件：无 DB 可达时 skip（CI 无 DB 时测试不失败，避免误报）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
const REQUIRED_TABLES = [
  "learning_runs",
  "learning_run_private_contracts",
  "learning_tasks",
  "learning_task_variants",
];
const RETIRED_TABLES = [
  "learning_sessions",
  "learning_episodes",
  "legacy_route_mappings_v2",
  "learning_session_probes",
  "learning_response_artifacts",
  "learning_assessment_reports",
  "learning_tutor_detours",
  "learning_tutor_permissions",
  "learning_tutor_action_nonces",
];

test("LearningRun 核心表存在且 Session/Episode 表已删除", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.' || table_name) AS regclass
       FROM (VALUES ${REQUIRED_TABLES.map((_, i) => `($${i + 1})`).join(",")}) AS t(table_name)`,
      REQUIRED_TABLES,
    );
    const missing = rows
      .map((r) => (r as { regclass?: string | null }).regclass ?? null)
      .filter((r: string | null) => r === null);
    assert.deepEqual(missing, [], `迁移未应用：缺表 ${REQUIRED_TABLES.filter((_, i) => rows[i]?.regclass === null).join(", ")}`);
    const retired = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [RETIRED_TABLES],
    );
    assert.deepEqual(retired.rows, [], `退役表仍存在：${retired.rows.map((row) => row.table_name).join(", ")}`);
  } finally {
    await pool.end();
  }
});

test("LearningRun 表列存在", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='learning_runs'`,
    );
    const cols = new Set(
      rows.map((r) => (r as { column_name?: string }).column_name ?? ""),
    );
    for (const required of ["id", "workspace_id", "user_id", "phase", "revision", "runtime_epoch", "active_task_id"]) {
      assert.ok(cols.has(required), `learning_runs 缺列 ${required}`);
    }
  } finally {
    await pool.end();
  }
});
