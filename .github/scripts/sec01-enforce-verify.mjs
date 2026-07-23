#!/usr/bin/env node
/**
 * SEC-01: RLS Enforce 验证脚本
 *
 * 在执行 0024_sec01_rls_enforce.sql 后运行此脚本，自动验证：
 *   1. 所有 24 张表的 RLS 已启用并强制（relrowsecurity + relforcerowsecurity）
 *   2. Worker 对 jobs 的直接 UPDATE 权限已被收回
 *   3. SECURITY DEFINER 函数仍可正常调用
 *   4. 跨 workspace 隔离在 enforce 模式下无泄漏
 *
 * 用法：
 *   node .github/scripts/sec01-enforce-verify.mjs
 *
 * 环境变量：
 *   SEC01_VERIFY_MIGRATOR_URL — migrator 角色连接字符串（必需）
 *   SEC01_VERIFY_API_URL      — API 角色连接字符串（必需）
 *   SEC01_VERIFY_WORKER_URL   — Worker 角色连接字符串（必需）
 *
 * 退出码：
 *   0 — 所有验证通过
 *   1 — 有验证项失败
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const MIGRATOR_URL = process.env.SEC01_VERIFY_MIGRATOR_URL;
const API_URL = process.env.SEC01_VERIFY_API_URL;
const WORKER_URL = process.env.SEC01_VERIFY_WORKER_URL;

if (!MIGRATOR_URL || !API_URL || !WORKER_URL) {
  console.error("需要环境变量：SEC01_VERIFY_MIGRATOR_URL, SEC01_VERIFY_API_URL, SEC01_VERIFY_WORKER_URL");
  process.exit(1);
}

// Dynamic import of postgres
const { default: postgres } = await import("postgres");

const EXPECTED_RLS_TABLES = [
  "workspaces",
  "workspace_members",
  "invite_codes",
  "sources",
  "source_segments",
  "notes",
  "note_versions",
  "note_blocks",
  "learning_cards",
  "card_key_points",
  "evidences",
  "validation_questions",
  "search_documents",
  "ai_artifacts",
  "ai_audit_log",
  "benchmark_reports",
  "benchmark_labels",
  "evidence_overrides",
  "validation_events",
  "review_schedules",
  "understanding_events",
  "jobs",
  "review_attempts",
  "onboarding_states",
];

let checksPassed = 0;
let checksFailed = 0;

function check(name, passed, detail = "") {
  const symbol = passed ? "✓" : "✗";
  console.log(`  ${symbol} ${name}${detail ? ` — ${detail}` : ""}`);
  if (passed) checksPassed++;
  else checksFailed++;
}

async function main() {
  console.log("[sec01-enforce-verify] 开始验证 RLS enforce 结果...");
  console.log("");

  const migrator = postgres(MIGRATOR_URL, { max: 1 });
  const api = postgres(API_URL, { max: 1 });
  const worker = postgres(WORKER_URL, { max: 1 });

  try {
    // ─── Check 1: 所有表的 RLS 状态 ─────────────────────────────
    console.log("[sec01-enforce-verify] 检查 1: RLS 启用和强制状态");

    // EXPECTED_RLS_TABLES is a hardcoded constant, safe to use in raw SQL
    const tableList = EXPECTED_RLS_TABLES.map((t) => `'${t}'`).join(", ");
    const rlsStatus = await migrator.unsafe(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = 'public'
        AND relname IN (${tableList})
      ORDER BY relname
    `);

    check(
      `找到 ${EXPECTED_RLS_TABLES.length} 张表`,
      rlsStatus.length === EXPECTED_RLS_TABLES.length,
      `实际 ${rlsStatus.length} 张`,
    );

    const tablesWithoutRls = [];
    const tablesWithoutForce = [];
    for (const row of rlsStatus) {
      if (!row.relrowsecurity) tablesWithoutRls.push(row.relname);
      if (!row.relforcerowsecurity) tablesWithoutForce.push(row.relname);
    }

    check(
      "所有表已启用 RLS (relrowsecurity=true)",
      tablesWithoutRls.length === 0,
      tablesWithoutRls.length > 0 ? `未启用: ${tablesWithoutRls.join(", ")}` : "",
    );

    check(
      "所有表已强制 RLS (relforcerowsecurity=true)",
      tablesWithoutForce.length === 0,
      tablesWithoutForce.length > 0 ? `未强制: ${tablesWithoutForce.join(", ")}` : "",
    );

    console.log("");

    // ─── Check 2: Worker UPDATE 权限已收回 ─────────────────────
    console.log("[sec01-enforce-verify] 检查 2: Worker 直接 UPDATE 权限已收回");

    const workerPrivs = await migrator`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'ailearn_worker'
        AND table_name = 'jobs'
        AND table_schema = 'public'
    `;

    const hasUpdate = workerPrivs.some((p) => p.privilege_type === "UPDATE");
    const hasSelect = workerPrivs.some((p) => p.privilege_type === "SELECT");

    check("Worker 对 jobs 的 UPDATE 权限已收回", !hasUpdate, hasUpdate ? "UPDATE 仍存在" : "");
    check("Worker 对 jobs 的 SELECT 权限仍保留", hasSelect, !hasSelect ? "SELECT 缺失" : "");

    console.log("");

    // ─── Check 3: SECURITY DEFINER 函数存在 ─────────────────────
    console.log("[sec01-enforce-verify] 检查 3: SECURITY DEFINER 函数存在");

    const functions = await migrator`
      SELECT routine_name, security_type
      FROM information_schema.routines
      WHERE routine_schema = 'public'
        AND routine_name IN ('ailearn_renew_job_lease', 'ailearn_finish_job', 'ailearn_fail_job')
      ORDER BY routine_name
    `;

    const expectedFunctions = ["ailearn_fail_job", "ailearn_finish_job", "ailearn_renew_job_lease"];
    check(
      `找到 ${expectedFunctions.length} 个 SECURITY DEFINER 函数`,
      functions.length === expectedFunctions.length,
      `实际 ${functions.length} 个`,
    );

    for (const fn of functions) {
      check(
        `${fn.routine_name} 是 SECURITY DEFINER`,
        fn.security_type === "DEFINER",
        `security_type=${fn.security_type}`,
      );
    }

    console.log("");

    // ─── Check 4: 跨 workspace 隔离验证 ─────────────────────────
    console.log("[sec01-enforce-verify] 检查 4: 跨 workspace 隔离");

    const runId = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const sourceA = randomUUID();
    const sourceB = randomUUID();

    // Setup: Create test data as migrator
    await migrator.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${userA}, ${`verify-a-${runId}@test.invalid`}, 'not-used')`;
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${userB}, ${`verify-b-${runId}@test.invalid`}, 'not-used')`;
      await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceA}, ${userA}, 'verify-A')`;
      await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceB}, ${userB}, 'verify-B')`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceA}, ${userA}, 'owner')`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceB}, ${userB}, 'owner')`;
      await tx`INSERT INTO sources (id, workspace_id, type, title, created_by) VALUES (${sourceA}, ${workspaceA}, 'text', 'source-A', ${userA})`;
      await tx`INSERT INTO sources (id, workspace_id, type, title, created_by) VALUES (${sourceB}, ${workspaceB}, 'text', 'source-B', ${userB})`;
    });

    try {
      // Workspace A user should only see sourceA
      const wsAResults = await api.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.workspace_id', ${workspaceA}, true)`;
        await tx`SELECT pg_catalog.set_config('app.user_id', ${userA}, true)`;
        return tx`SELECT id FROM sources WHERE id IN (${sourceA}, ${sourceB}) ORDER BY id`;
      });

      check(
        "Workspace A 只看到自己的数据",
        wsAResults.length === 1 && wsAResults[0].id === sourceA,
        `看到 ${wsAResults.length} 条`,
      );

      // Workspace A user should NOT see workspace B's data
      const wsBResults = await api.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.workspace_id', ${workspaceA}, true)`;
        await tx`SELECT pg_catalog.set_config('app.user_id', ${userA}, true)`;
        return tx`SELECT id FROM sources WHERE id = ${sourceB}`;
      });

      check(
        "Workspace A 看不到 Workspace B 的数据",
        wsBResults.length === 0,
        `看到 ${wsBResults.length} 条`,
      );

      // Cross-workspace write should be denied
      let crossWriteDenied = false;
      try {
        await api.begin(async (tx) => {
          await tx`SELECT pg_catalog.set_config('app.workspace_id', ${workspaceA}, true)`;
          await tx`SELECT pg_catalog.set_config('app.user_id', ${userA}, true)`;
          await tx`INSERT INTO sources (id, workspace_id, type, title, created_by) VALUES (${randomUUID()}, ${workspaceB}, 'text', 'cross-write', ${userA})`;
        });
      } catch (err) {
        crossWriteDenied = err.code === "42501";
      }

      check("跨 workspace 写入被 RLS 拒绝 (42501)", crossWriteDenied);

      // Empty workspace context should return 0 rows
      const emptyResults = await api.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('app.workspace_id', '', true)`;
        await tx`SELECT pg_catalog.set_config('app.user_id', '', true)`;
        return tx`SELECT id FROM sources WHERE id IN (${sourceA}, ${sourceB})`;
      });

      check("空 workspace 上下文返回 0 行", emptyResults.length === 0);
    } finally {
      // Cleanup
      await migrator`DELETE FROM sources WHERE id IN (${sourceA}, ${sourceB})`;
      await migrator`DELETE FROM workspace_members WHERE workspace_id IN (${workspaceA}, ${workspaceB})`;
      await migrator`DELETE FROM workspaces WHERE id IN (${workspaceA}, ${workspaceB})`;
      await migrator`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
    }

    console.log("");

    // ─── Check 5: Worker 无法直接 UPDATE jobs ──────────────────
    console.log("[sec01-enforce-verify] 检查 5: Worker 无法直接 UPDATE jobs");

    const testJobId = randomUUID();
    const testWorkspaceId = randomUUID();
    const testUserId = randomUUID();

    await migrator.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${testUserId}, ${`verify-job-${runId}@test.invalid`}, 'not-used')`;
      await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${testWorkspaceId}, ${testUserId}, 'verify-jobs')`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${testWorkspaceId}, ${testUserId}, 'owner')`;
      await tx`INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status) VALUES (${testJobId}, 'generate_card', ${testWorkspaceId}, ${testUserId}, ${tx.json({})}::jsonb, 'pending')`;
    });

    try {
      let directUpdateDenied = false;
      try {
        await worker.begin(async (tx) => {
          await tx`SELECT pg_catalog.set_config('app.workspace_id', ${testWorkspaceId}, true)`;
          await tx`SELECT pg_catalog.set_config('app.user_id', ${testUserId}, true)`;
          await tx`UPDATE jobs SET last_error = 'direct update attempt' WHERE id = ${testJobId}`;
        });
      } catch (err) {
        directUpdateDenied = err.code === "42501";
      }

      check("Worker 直接 UPDATE jobs 被拒绝 (42501)", directUpdateDenied);
    } finally {
      await migrator`DELETE FROM jobs WHERE id = ${testJobId}`;
      await migrator`DELETE FROM workspace_members WHERE workspace_id = ${testWorkspaceId}`;
      await migrator`DELETE FROM workspaces WHERE id = ${testWorkspaceId}`;
      await migrator`DELETE FROM users WHERE id = ${testUserId}`;
    }

    console.log("");
  } finally {
    await migrator.end();
    await api.end();
    await worker.end();
  }

  // ─── Summary ──────────────────────────────────────────────────
  console.log("[sec01-enforce-verify] ========================================");
  console.log(`[sec01-enforce-verify]  通过: ${checksPassed}`);
  console.log(`[sec01-enforce-verify]  失败: ${checksFailed}`);
  console.log("[sec01-enforce-verify] ========================================");

  if (checksFailed > 0) {
    console.error(`[sec01-enforce-verify] ${checksFailed} 项验证失败`);
    process.exit(1);
  }
  console.log("[sec01-enforce-verify] 所有验证通过");
  process.exit(0);
}

main().catch((err) => {
  console.error("[sec01-enforce-verify] 未预期的错误:", err);
  process.exit(1);
});
