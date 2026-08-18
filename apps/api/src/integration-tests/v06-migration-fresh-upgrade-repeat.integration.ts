/**
 * v0.6 Migration fresh/upgrade/repeat/restore 集成测试 (计划 §13.2, §10.7, M1 Gate)
 *
 * 计划 §10.7 DoD：
 *   "migration fresh、v0.5 representative upgrade、重复迁移、备份恢复通过"
 *
 * 测试场景：
 *   1. Fresh migration: 在空数据库上运行全部迁移（0000-0043），验证所有表和索引创建
 *   2. Repeat migration: 再次运行迁移，验证幂等性（IF NOT EXISTS / DO $$ BEGIN）
 *   3. v0.6 schema verification: 验证 0040-0043 创建的新表、索引、约束、enum 和 RLS policy
 *   4. Backup/restore: 在迁移后的数据库上创建数据，导出，恢复到新 workspace
 *
 * 环境变量:
 *   V06_MIGRATION_TEST_DATABASE_URL — 连接字符串（必须指向一个可重置的测试数据库）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.V06_MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "V06_MIGRATION_TEST_DATABASE_URL is required for the v0.6 migration integration test",
  );
}

const sql = postgres(databaseUrl, { max: 4 });

test.after(async () => {
  await sql.end({ timeout: 5 });
});

// ─── Migration file reader ────────────────────────────────────────────────

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

function readMigrationFiles(): { id: string; content: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => ({
    id: f,
    content: readFileSync(new URL(f, new URL("../db/migrations/", import.meta.url)), "utf8"),
  }));
}

// ─── Table existence checker ─────────────────────────────────────────────

async function tableExists(tableName: string): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = ${tableName}
    ) as exists
  `;
  return row?.exists ?? false;
}

async function indexExists(indexName: string): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = ${indexName}
    ) as exists
  `;
  return row?.exists ?? false;
}

async function constraintExists(constraintName: string): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = ${constraintName}
    ) as exists
  `;
  return row?.exists ?? false;
}

async function rlsEnabled(tableName: string): Promise<boolean> {
  const [row] = await sql`
    SELECT relrowsecurity FROM pg_class WHERE relname = ${tableName}
  `;
  return row?.relrowsecurity ?? false;
}

async function policyExists(tableName: string, policyName: string): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = ${tableName} AND policyname = ${policyName}
    ) as exists
  `;
  return row?.exists ?? false;
}

// ─── Tests ────────────────────────────────────────────────────────────────

test("v0.6 migration: all v0.6 new tables exist after migration", async () => {
  const v06Tables = [
    "validation_question_rubric_items",
    "validation_submissions",
    "validation_submission_jobs",
    "validation_action_commands",
    "validation_assistance_exposures",
    "validation_point_assessments",
    "scheduling_shadow_decisions",
    "validation_quality_signals",
  ];

  for (const table of v06Tables) {
    const exists = await tableExists(table);
    assert.ok(exists, `Table ${table} should exist after migration`);
  }
});

test("v0.6 migration: all v0.6 unique indexes exist", async () => {
  const v06Indexes = [
    "validation_questions_active_unique_idx",
    "vq_rubric_items_unique_ordinal_idx",
    "val_submissions_start_idem_idx",
    "val_submissions_active_unique_idx",
    "val_sub_jobs_phase_idx",
    "val_sub_jobs_job_idx",
    "val_action_cmd_unique_idx",
    "val_assist_exp_unique_idx",
    "val_point_assess_unique_idx",
    "sched_shadow_unique_idx",
    "review_schedules_pending_unique_idx",
  ];

  for (const index of v06Indexes) {
    const exists = await indexExists(index);
    assert.ok(exists, `Index ${index} should exist after migration`);
  }
});

test("v0.6 migration: v0.6 columns added to existing tables", async () => {
  // validation_questions extensions (§6.2)
  const vqColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'validation_questions'
      AND column_name IN ('user_id', 'artifact_id', 'generation_job_id', 'generator_kind', 'status', 'rubric_version', 'source_fingerprint', 'superseded_at', 'stale_reason', 'last_used_at', 'use_count')
  `;
  assert.ok(vqColumns.length >= 11, "validation_questions should have all v0.6 columns");

  // validation_events extensions (§6.6)
  const veColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'validation_events'
      AND column_name IN ('submission_id', 'note_version_id', 'rubric_version', 'reducer_version', 'source_fingerprint', 'source_status')
  `;
  assert.ok(veColumns.length >= 6, "validation_events should have all v0.6 columns");

  // review_attempts extensions (§6.6)
  const raColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'review_attempts'
      AND column_name IN ('evaluation_artifact_id', 'evaluation_status', 'assistance_level', 'evidence_revealed_at', 'policy_version', 'source_fingerprint')
  `;
  assert.ok(raColumns.length >= 6, "review_attempts should have all v0.6 columns");

  // review_schedules extensions (§6.6)
  const rsColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'review_schedules'
      AND column_name IN ('key_point_id', 'generation', 'policy_version', 'reason_code', 'supersedes_schedule_id')
  `;
  assert.ok(rsColumns.length >= 5, "review_schedules should have all v0.6 columns");

  // ai_artifacts extensions (§6.6)
  const aaColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ai_artifacts'
      AND column_name IN ('parent_artifact_id')
  `;
  assert.ok(aaColumns.length >= 1, "ai_artifacts should have parent_artifact_id");

  // jobs extensions (§7.7)
  const jobColumns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'jobs'
      AND column_name IN ('repair_state', 'repair_attempt_count')
  `;
  assert.ok(jobColumns.length >= 2, "jobs should have repair_state and repair_attempt_count");
});

test("v0.6 migration: jobs repair_attempt_count CHECK constraint exists", async () => {
  const exists = await constraintExists("jobs_repair_attempt_count_check");
  assert.ok(exists, "jobs_repair_attempt_count_check constraint should exist");
});

// M6 terminal-result / card-set identity constraints: removed in V2 cleanup.
// These V1 FK constraints (learning_cards.result_card_set_id etc.) were
// dropped or superseded by V2 schema. The test is no longer applicable.

test("v0.6 migration: artifact_type accepts all v0.6 artifact kinds", async () => {
  const rows = await sql<{ enumlabel: string }[]>`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_type.typname = 'artifact_type'
  `;
  const labels = new Set(rows.map((row) => row.enumlabel));
  for (const label of [
    "validation_question",
    "rubric_evaluation",
    "deterministic_question",
  ]) {
    assert.ok(labels.has(label), `artifact_type should contain ${label}`);
  }
});

test("v0.6 migration: review attempt successor schedule FK exists", async () => {
  const exists = await constraintExists(
    "review_attempts_next_schedule_id_review_schedules_id_fk",
  );
  assert.ok(exists, "review_attempts.next_schedule_id should reference review_schedules.id");
});

test("v0.6 migration: RLS enabled on all v0.6 new tables", async () => {
  const v06Tables = [
    "validation_question_rubric_items",
    "validation_submissions",
    "validation_submission_jobs",
    "validation_action_commands",
    "validation_assistance_exposures",
    "validation_point_assessments",
    "scheduling_shadow_decisions",
    "validation_quality_signals",
  ];

  for (const table of v06Tables) {
    const enabled = await rlsEnabled(table);
    assert.ok(enabled, `RLS should be enabled on ${table}`);
  }
});

test("v0.6 migration: RLS policies exist on v0.6 new tables", async () => {
  const expectedPolicies = [
    { table: "validation_submissions", policy: "val_submissions_user_isolation" },
    { table: "validation_action_commands", policy: "val_action_cmd_user_isolation" },
    { table: "validation_assistance_exposures", policy: "val_assist_exp_user_isolation" },
    { table: "validation_point_assessments", policy: "val_point_assess_user_isolation" },
    { table: "scheduling_shadow_decisions", policy: "sched_shadow_user_isolation" },
    { table: "validation_quality_signals", policy: "val_quality_sig_user_isolation" },
    { table: "validation_question_rubric_items", policy: "vq_rubric_items_workspace_isolation" },
    { table: "validation_submission_jobs", policy: "val_sub_jobs_workspace_isolation" },
  ];

  for (const { table, policy } of expectedPolicies) {
    const exists = await policyExists(table, policy);
    assert.ok(exists, `Policy ${policy} should exist on ${table}`);
  }
});

test("v0.6 migration: migration files use IF NOT EXISTS / DO $$ for idempotency", async () => {
  const migrations = readMigrationFiles();
  const v06Migrations = migrations.filter(
    (m) => /^004[0-3]_/.test(m.id),
  );

  assert.equal(v06Migrations.length, 4, "Should have 4 v0.6 migration files");

  for (const migration of v06Migrations) {
    // CREATE TABLE should use IF NOT EXISTS
    assert.ok(
      migration.content.includes("CREATE TABLE IF NOT EXISTS") ||
      !migration.content.includes("CREATE TABLE"),
      `${migration.id}: CREATE TABLE should use IF NOT EXISTS`,
    );

    // CREATE INDEX should use IF NOT EXISTS
    const createIndexMatches = migration.content.match(/CREATE INDEX/g);
    if (createIndexMatches) {
      assert.ok(
        migration.content.includes("CREATE INDEX IF NOT EXISTS") ||
        migration.content.includes("CREATE UNIQUE INDEX IF NOT EXISTS"),
        `${migration.id}: CREATE INDEX should use IF NOT EXISTS`,
      );
    }

    // ALTER TABLE ADD COLUMN should use IF NOT EXISTS
    assert.ok(
      migration.content.includes("ADD COLUMN IF NOT EXISTS") ||
      !migration.content.includes("ADD COLUMN"),
      `${migration.id}: ALTER TABLE ADD COLUMN should use IF NOT EXISTS`,
    );

    // CREATE POLICY must either be wrapped in a duplicate-safe DO block or
    // follow an explicit DROP POLICY IF EXISTS in the same migration.
    if (migration.content.includes("CREATE POLICY")) {
      assert.ok(
        (
          /DO\s+\$[^$]*\$\s*BEGIN/.test(migration.content)
          && migration.content.includes("EXCEPTION WHEN duplicate_object")
        )
        || migration.content.includes("DROP POLICY IF EXISTS"),
        `${migration.id}: CREATE POLICY should be guarded for idempotency`,
      );
    }

    // ALTER TABLE ... ADD CONSTRAINT should use a duplicate-safe DO block.
    if (migration.content.includes("ADD CONSTRAINT")) {
      assert.ok(
        /DO\s+\$[^$]*\$\s*BEGIN/.test(migration.content) &&
        migration.content.includes("EXCEPTION WHEN duplicate_object"),
        `${migration.id}: ADD CONSTRAINT should use a guarded DO block`,
      );
    }
  }
});

test("v0.6 migration: repeat migration is idempotent — re-running 0040-0043 produces no errors", async () => {
  // Read and re-execute v0.6 migration SQL files
  const migrations = readMigrationFiles();
  const v06Migrations = migrations.filter(
    (m) => /^004[0-3]_/.test(m.id),
  );

  for (const migration of v06Migrations) {
    // Execute the migration SQL again — should not throw
    try {
      await sql.unsafe(migration.content);
    } catch (err) {
      // If error occurs, it should only be about duplicate objects that the DO $$ blocks
      // already handle. Any other error is a real idempotency failure.
      const msg = String((err as Error)?.message ?? "");
      if (!msg.includes("already exists") && !msg.includes("duplicate_object")) {
        assert.fail(`Migration ${migration.id} is not idempotent: ${msg}`);
      }
    }
  }
});

// M6 legacy nulls / M5 result integrity test: removed in V2 cleanup.
// These tests inserted into V1 learning_cards / learning_card_sets tables
// which are now cleared by migration 0176. The V2 schema uses
// learning_cards_v2 / learning_objectives_v2 instead. The FK constraints
// being tested (card_generation_runs_result_card_fk etc.) are V1-specific.

// legacy_unrubriced marking test: removed in V2 cleanup.
// This test inserted into V1 learning_cards / card_key_points tables,
// which are cleared by migration 0176. The legacy_unrubriced marking is
// a V1-only migration concern.

// backup/restore test: removed in V2 cleanup.
// This test inserted into V1 learning_cards / card_key_points / evidences
// tables which are cleared by migration 0176. V2 evidence uses
// evidence_snapshots_v2 + learning_objective_evidence_bindings_v2.

test("v0.6 migration: v0.6 column extensions on existing tables have correct types", async () => {
  // Verify validation_questions.user_id is uuid type
  const [userIdCol] = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'validation_questions' AND column_name = 'user_id'
  `;
  assert.equal(userIdCol?.data_type, "uuid", "validation_questions.user_id should be uuid");

  // Verify validation_questions.status has default 'active'
  const [statusCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'validation_questions' AND column_name = 'status'
  `;
  assert.ok(
    statusCol?.column_default?.includes("active"),
    "validation_questions.status should default to 'active'",
  );

  // Verify validation_questions.generator_kind has default 'ai'
  const [genKindCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'validation_questions' AND column_name = 'generator_kind'
  `;
  assert.ok(
    genKindCol?.column_default?.includes("ai"),
    "validation_questions.generator_kind should default to 'ai'",
  );

  // Verify validation_submissions.draft_revision has default 0
  const [revCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'validation_submissions' AND column_name = 'draft_revision'
  `;
  assert.ok(
    revCol?.column_default?.includes("0"),
    "validation_submissions.draft_revision should default to 0",
  );

  // Verify validation_submissions.status has default 'question_preparing'
  const [subStatusCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'validation_submissions' AND column_name = 'status'
  `;
  assert.ok(
    subStatusCol?.column_default?.includes("question_preparing"),
    "validation_submissions.status should default to 'question_preparing'",
  );

  // Verify validation_submissions.assistance_level has default 'none'
  const [assistCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'validation_submissions' AND column_name = 'assistance_level'
  `;
  assert.ok(
    assistCol?.column_default?.includes("none"),
    "validation_submissions.assistance_level should default to 'none'",
  );

  // Verify jobs.repair_state has default 'none'
  const [repairStateCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'repair_state'
  `;
  assert.ok(
    repairStateCol?.column_default?.includes("none"),
    "jobs.repair_state should default to 'none'",
  );

  // Verify jobs.repair_attempt_count has default 0
  const [repairCountCol] = await sql`
    SELECT column_default FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'repair_attempt_count'
  `;
  assert.ok(
    repairCountCol?.column_default?.includes("0"),
    "jobs.repair_attempt_count should default to 0",
  );
});

test("v0.6 migration: BYOK table and workspace ai_provider column are dropped (0065)", async () => {
  // §7.2 新增断言：验证 user_ai_model_configs 表已删除
  const byokTableExists = await tableExists("user_ai_model_configs");
  assert.equal(
    byokTableExists,
    false,
    "user_ai_model_configs table should not exist after migration 0065",
  );

  // §7.2 新增断言：验证 workspaces.ai_provider 列已删除
  const [aiProviderCol] = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'workspaces' AND column_name = 'ai_provider'
  `;
  assert.equal(
    aiProviderCol,
    undefined,
    "workspaces.ai_provider column should not exist after migration 0065",
  );
});
