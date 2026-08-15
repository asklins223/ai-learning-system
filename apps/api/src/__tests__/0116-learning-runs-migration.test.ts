/**
 * 0116 LearningRun V1 数据底座迁移的静态验证（无 DB，读 SQL + journal）。
 *
 * 覆盖：journal 注册、17 张表创建、RLS workspace+user 双条件覆盖全部表、
 * 权限契约（private 三表 ailearn_api 无 SELECT、draft 对 worker REVOKE ALL）、
 * §16.2 唯一约束（envelope commitId/canonicalEventId、practice(runId,scope)）、
 * §12.3 artifact 单 locked 约束与 locked 不可变 CHECK。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0116_learning_runs.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as {
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

const RUN_TABLES = [
  "learning_runs",
  "learning_run_private_contracts",
  "learning_tasks",
  "learning_task_variants",
  "learning_task_private_solutions",
  "learning_task_safety_reports",
  "learning_task_disclosure_profiles",
  "learning_artifacts",
  "learning_assessments",
  "learning_task_drafts",
  "learning_run_events",
  "learning_run_action_ledger",
  "learning_activity_leases",
  "learning_task_presentation_history",
  "canonical_learning_event_outbox",
  "practice_trail_event_outbox",
  "learning_run_idempotency",
];

test("0116 注册在 journal 且 idx=116", () => {
  const entry = journal.entries.find((e) => e.tag === "0116_learning_runs");
  assert.ok(entry, "journal must contain 0116_learning_runs");
  assert.equal(entry.idx, 116);
  assert.equal(entry.version, "7");
  assert.ok(entry.breakpoints);
});

test("0116 创建全部 17 张 LearningRun 表", () => {
  for (const table of RUN_TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(`),
      `must create ${table}`,
    );
  }
});

test("0116 RLS 覆盖全部 17 张表（ENABLE + FORCE + workspace_user_isolation policy）", () => {
  const rlsBlock = migration.split("─ RLS：workspace+user 双条件隔离")[1]
    ?.split("─ 表级权限契约")[0];
  assert.ok(rlsBlock, "RLS block exists");
  for (const table of RUN_TABLES) {
    assert.match(
      rlsBlock ?? "",
      new RegExp(`'${table}'`, "g"),
      `RLS table list must contain ${table}`,
    );
  }
  assert.match(rlsBlock ?? "", /ENABLE ROW LEVEL SECURITY/);
  assert.match(rlsBlock ?? "", /FORCE ROW LEVEL SECURITY/);
  assert.match(rlsBlock ?? "", /workspace_user_isolation/);
  assert.match(rlsBlock ?? "", /app\.workspace_id/);
  assert.match(rlsBlock ?? "", /app\.user_id/);
  assert.match(rlsBlock ?? "", /CURRENT_USER = 'ailearn_worker'/);
});

test("private 三表：ailearn_api 无 SELECT/UPDATE/DELETE，仅 INSERT；worker 可读写", () => {
  for (const table of [
    "learning_task_private_solutions",
    "learning_task_safety_reports",
    "learning_task_disclosure_profiles",
  ]) {
    assert.match(
      migration,
      new RegExp(`REVOKE SELECT, UPDATE, DELETE ON public\\.${table} FROM ailearn_api`),
      `api must not read ${table}`,
    );
    assert.match(
      migration,
      new RegExp(`GRANT INSERT ON public\\.${table} TO ailearn_api`),
      `api may insert ${table}`,
    );
    assert.match(
      migration,
      new RegExp(`GRANT SELECT, INSERT, UPDATE ON public\\.${table} TO ailearn_worker`),
      `worker may read/write ${table}`,
    );
  }
});

test("draft 对 worker 显式 REVOKE ALL（§12.7 服务端草稿不可被读取）", () => {
  assert.match(migration, /REVOKE ALL ON public\.learning_task_drafts FROM ailearn_worker/);
});

test("§16.2 唯一约束：canonical envelope(commitId) 与 canonicalEventId 唯一", () => {
  assert.match(
    migration,
    /CONSTRAINT canonical_learning_event_outbox_commit_unique UNIQUE \(commit_id\)/,
  );
  assert.match(
    migration,
    /CONSTRAINT canonical_learning_event_outbox_event_unique UNIQUE \(canonical_event_id\)/,
  );
});

test("§16.2 唯一约束：practice event(runId, scope) 唯一", () => {
  assert.match(
    migration,
    /CONSTRAINT practice_trail_event_outbox_run_scope_unique UNIQUE \(run_id, scope\)/,
  );
});

test("§12.3 artifact：单 locked 唯一索引 + locked 不可变 CHECK", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_artifacts_task_locked_unique_idx\s+ON public\.learning_artifacts \(task_id\)\s+WHERE status = 'locked'/,
  );
  assert.match(
    migration,
    /learning_artifacts_locked_immutable_check CHECK \(\s*status <> 'locked' OR locked_at IS NOT NULL/,
  );
});

test("§12.4 assessment：终态必须带 reportHash（fail closed）", () => {
  assert.match(
    migration,
    /learning_assessments_terminal_report_check CHECK \(\s*status NOT IN \('completed', 'not_assessable'\) OR report_hash IS NOT NULL/,
  );
});

test("run budget 约束：30..180 秒与 planned<=budget 空间", () => {
  assert.match(migration, /learning_runs_budget_check CHECK \(/);
  assert.match(migration, /time_budget_seconds >= 30 AND time_budget_seconds <= 180/);
});

test("§13.4 事件类型约束覆盖关键领域事件", () => {
  const checkBlock = migration.split("learning_run_events_type_check")[1];
  assert.ok(checkBlock, "event type check exists");
  for (const eventType of [
    "learning_run.created",
    "learning_task.presented",
    "learning_artifact.locked",
    "learning_assessment.queued",
    "learning_commit.completed",
    "learning_result.viewed",
  ]) {
    assert.match(checkBlock, new RegExp(`'${eventType}'`));
  }
});

test("创建幂等账本：workspace+user+key 唯一", () => {
  assert.match(
    migration,
    /CONSTRAINT learning_run_idempotency_key_unique UNIQUE \(workspace_id, user_id, idempotency_key\)/,
  );
});
