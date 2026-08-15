/**
 * 0117 LearningRun processing outbox 迁移静态验证（无 DB）。
 *
 * 覆盖：journal 注册、表创建、防答案正文入队 CHECK、命令枚举、RLS、
 * ailearn_api/worker 权限、幂等 scope key。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0117_learning_run_processing_outbox.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as {
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

test("0117 注册在 journal 且 idx=117", () => {
  const entry = journal.entries.find((e) => e.tag === "0117_learning_run_processing_outbox");
  assert.ok(entry, "journal must contain 0117_learning_run_processing_outbox");
  assert.equal(entry.idx, 117);
});

test("0117 创建 outbox 表并限制命令枚举", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.learning_run_processing_outbox \(/);
  assert.match(
    migration,
    /command_type IN \('assessment_requested', 'commit_requested'\)/,
  );
});

test("0117 payload 不得包含答案正文（§13.5 防泄漏 CHECK）", () => {
  assert.match(migration, /NOT \(payload \? 'answer'\)/);
  assert.match(migration, /NOT \(payload \? 'answerText'\)/);
  assert.match(migration, /NOT \(payload \? 'userAnswer'\)/);
  assert.match(migration, /NOT \(payload \? 'transcript'\)/);
});

test("0117 幂等 scope key（workspace, run, idempotency_key）唯一", () => {
  assert.match(
    migration,
    /learning_run_processing_outbox_scope_key_unique\s+UNIQUE \(workspace_id, run_id, idempotency_key\)/,
  );
});

test("0117 RLS workspace+user 双条件 + worker 豁免", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /workspace_user_isolation/);
  assert.match(migration, /app\.workspace_id/);
  assert.match(migration, /app\.user_id/);
  assert.match(migration, /CURRENT_USER = 'ailearn_worker'/);
});

test("0117 权限：api CRUD、worker 读+更新（评估/提交处理）", () => {
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.learning_run_processing_outbox TO ailearn_api/,
  );
  assert.match(
    migration,
    /GRANT SELECT, UPDATE ON public\.learning_run_processing_outbox TO ailearn_worker/,
  );
});
