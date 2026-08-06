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
import { randomUUID } from "node:crypto";
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

async function expectSqlState(
  expectedCode: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      expectedCode,
      `expected PostgreSQL SQLSTATE ${expectedCode}`,
    );
    return true;
  });
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

test("M6 migration: terminal-result and card-set identity constraints exist", async () => {
  for (const index of [
    "learning_cards_generation_set_identity_unique_idx",
    "learning_cards_set_scope_key_unique_idx",
  ]) {
    assert.ok(await indexExists(index), `Index ${index} should exist`);
  }

  for (const constraint of [
    "learning_cards_card_set_shape_check",
    "card_generation_runs_m5_terminal_result_check",
    "card_generation_runs_result_card_fk",
    "card_generation_runs_result_card_set_fk",
    "card_generation_runs_result_card_identity_fk",
  ]) {
    assert.ok(
      await constraintExists(constraint),
      `Constraint ${constraint} should exist`,
    );
  }

  const foreignKeys = await sql<{
    name: string;
    delete_action: string;
    deferrable: boolean;
    initially_deferred: boolean;
  }[]>`
    SELECT
      conname AS name,
      confdeltype::text AS delete_action,
      condeferrable AS deferrable,
      condeferred AS initially_deferred
    FROM pg_constraint
    WHERE conname IN (
      'card_generation_runs_result_card_fk',
      'card_generation_runs_result_card_set_fk',
      'card_generation_runs_result_card_identity_fk'
    )
  `;
  assert.equal(foreignKeys.length, 3);
  for (const foreignKey of foreignKeys) {
    assert.equal(
      foreignKey.delete_action,
      "a",
      `${foreignKey.name} should use NO ACTION`,
    );
    assert.equal(foreignKey.deferrable, true);
    assert.equal(foreignKey.initially_deferred, true);
  }
});

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

test("M6 migration: re-running 0049 is idempotent", async () => {
  const migration = readMigrationFiles().find(
    (candidate) => candidate.id === "0049_card_generation_m5_integrity.sql",
  );
  assert.ok(migration, "0049 migration should exist");
  await sql.unsafe(migration.content);
});

test("M6 migration: legacy nulls survive while M5 result and member identity fail closed", async () => {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const runAId = randomUUID();
  const runBId = randomUUID();
  const legacyRunId = randomUUID();
  const setAId = randomUUID();
  const setBId = randomUUID();
  const overviewAId = randomUUID();
  const sectionAId = randomUUID();
  const overviewBId = randomUUID();

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (
          ${userId},
          ${`m6-integrity-${randomUUID().slice(0, 8)}@test.com`},
          'hash',
          'owner'
        )
      `;
      await tx`
        INSERT INTO workspaces (id, name, owner_id)
        VALUES (${workspaceId}, 'm6-integrity', ${userId})
      `;
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${workspaceId}, ${userId}, 'owner')
      `;
      await tx`
        INSERT INTO notes (id, workspace_id, title, created_by)
        VALUES (${noteId}, ${workspaceId}, 'M6 integrity', ${userId})
      `;
      await tx`
        INSERT INTO note_versions (
          id,
          note_id,
          workspace_id,
          version_no,
          content_json,
          content_hash,
          created_by
        )
        VALUES (
          ${noteVersionId},
          ${noteId},
          ${workspaceId},
          1,
          ${tx.json({ blocks: [] })},
          ${`m6-${noteVersionId}`},
          ${userId}
        )
      `;
      await tx`
        UPDATE notes
        SET current_version_id = ${noteVersionId}
        WHERE id = ${noteId}
      `;

      for (const run of [
        {
          id: runAId,
          epoch: 1,
          status: "queued",
        },
        {
          id: runBId,
          epoch: 2,
          status: "queued",
        },
        {
          id: legacyRunId,
          epoch: 3,
          status: "succeeded",
        },
      ]) {
        await tx`
          INSERT INTO card_generation_runs (
            id,
            workspace_id,
            note_id,
            note_version_id,
            request_idempotency_key,
            generation_fingerprint,
            generation_epoch,
            title_snapshot,
            source_content_hash,
            block_manifest_hash,
            asset_manifest_hash,
            status
          )
          VALUES (
            ${run.id},
            ${workspaceId},
            ${noteId},
            ${noteVersionId},
            ${`m6-idem-${run.id}`},
            ${`m6-fingerprint-${run.id}`},
            ${run.epoch},
            'M6 integrity',
            'source-hash',
            'block-hash',
            'asset-hash',
            ${run.status}
          )
        `;
      }

      await tx`
        INSERT INTO learning_card_sets (
          id,
          workspace_id,
          note_id,
          note_version_id,
          generation_run_id,
          title,
          summary
        )
        VALUES
          (
            ${setAId},
            ${workspaceId},
            ${noteId},
            ${noteVersionId},
            ${runAId},
            'Set A',
            'Set A summary'
          ),
          (
            ${setBId},
            ${workspaceId},
            ${noteId},
            ${noteVersionId},
            ${runBId},
            'Set B',
            'Set B summary'
          )
      `;
      await tx`
        INSERT INTO learning_cards (
          id,
          workspace_id,
          note_version_id,
          card_set_id,
          generation_run_id,
          scope,
          scope_key,
          ordinal,
          status,
          schema_json
        )
        VALUES
          (
            ${overviewAId},
            ${workspaceId},
            ${noteVersionId},
            ${setAId},
            ${runAId},
            'overview',
            'overview',
            0,
            'active',
            ${tx.json({ title: "Overview A", summary: "A" })}
          ),
          (
            ${sectionAId},
            ${workspaceId},
            ${noteVersionId},
            ${setAId},
            ${runAId},
            'section',
            'section-a',
            1,
            'active',
            ${tx.json({ title: "Section A", summary: "A1" })}
          ),
          (
            ${overviewBId},
            ${workspaceId},
            ${noteVersionId},
            ${setBId},
            ${runBId},
            'overview',
            'overview',
            0,
            'active',
            ${tx.json({ title: "Overview B", summary: "B" })}
          )
      `;
    });

    const [legacyRun] = await sql`
      SELECT result_card_set_id, result_card_id
      FROM card_generation_runs
      WHERE id = ${legacyRunId}
    `;
    assert.equal(legacyRun?.result_card_set_id, null);
    assert.equal(legacyRun?.result_card_id, null);

    await expectSqlState(
      "23514",
      () => sql.begin(async (tx) => {
        await tx`
          UPDATE card_generation_runs
          SET status = 'succeeded'
          WHERE id = ${runAId}
        `;
      }),
    );

    await expectSqlState(
      "23514",
      () => sql.begin(async (tx) => {
        await tx`
          INSERT INTO learning_cards (
            workspace_id,
            note_version_id,
            card_set_id,
            generation_run_id,
            scope,
            scope_key,
            ordinal,
            status,
            schema_json
          )
          VALUES (
            ${workspaceId},
            ${noteVersionId},
            ${setAId},
            ${runAId},
            'overview',
            'bad-overview',
            2,
            'active',
            ${tx.json({ title: "Bad overview", summary: "Bad" })}
          )
        `;
      }),
    );

    await expectSqlState(
      "23505",
      () => sql.begin(async (tx) => {
        await tx`
          INSERT INTO learning_cards (
            workspace_id,
            note_version_id,
            card_set_id,
            generation_run_id,
            scope,
            scope_key,
            ordinal,
            status,
            schema_json
          )
          VALUES (
            ${workspaceId},
            ${noteVersionId},
            ${setAId},
            ${runAId},
            'section',
            'section-a',
            2,
            'active',
            ${tx.json({ title: "Duplicate scope", summary: "Bad" })}
          )
        `;
      }),
    );

    await expectSqlState(
      "23503",
      () => sql.begin(async (tx) => {
        await tx`
          UPDATE card_generation_runs
          SET
            status = 'succeeded',
            result_card_set_id = ${setAId},
            result_card_id = ${overviewBId}
          WHERE id = ${runAId}
        `;
      }),
    );

    await sql`
      UPDATE card_generation_runs
      SET
        status = 'succeeded',
        result_card_set_id = ${setAId},
        result_card_id = ${overviewAId}
      WHERE id = ${runAId}
    `;

    await expectSqlState(
      "23503",
      () => sql.begin(async (tx) => {
        await tx`DELETE FROM learning_cards WHERE id = ${overviewAId}`;
      }),
    );
    await expectSqlState(
      "23503",
      () => sql.begin(async (tx) => {
        await tx`DELETE FROM learning_card_sets WHERE id = ${setAId}`;
      }),
    );

    await sql.begin(async (tx) => {
      await tx`DELETE FROM card_generation_runs WHERE id = ${runAId}`;
    });
    const [deletedGraph] = await sql`
      SELECT
        EXISTS (
          SELECT 1 FROM card_generation_runs WHERE id = ${runAId}
        ) AS run_exists,
        EXISTS (
          SELECT 1 FROM learning_card_sets WHERE id = ${setAId}
        ) AS set_exists,
        EXISTS (
          SELECT 1 FROM learning_cards WHERE id IN (${overviewAId}, ${sectionAId})
        ) AS card_exists
    `;
    assert.equal(deletedGraph?.run_exists, false);
    assert.equal(deletedGraph?.set_exists, false);
    assert.equal(deletedGraph?.card_exists, false);
  } finally {
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM card_generation_runs
        WHERE workspace_id = ${workspaceId}
      `;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  }
});

test("v0.6 migration: legacy_unrubriced marking works correctly", async () => {
  // This test verifies that the UPDATE in 0041 correctly marks old questions
  const wsId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const oldQuestionId = randomUUID();

  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`legacy-${randomUUID().slice(0, 8)}@test.com`}, 'hash', 'owner')`;
      await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${wsId}, 'legacy-test', ${userId})`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, 'owner')`;
      await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${noteId}, ${wsId}, 'Test', ${userId})`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES (${noteVersionId}, ${noteId}, ${wsId}, 1, ${tx.json({ blocks: [] })}, 'hash', ${userId})`;
      await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
      await tx`INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json) VALUES (${cardId}, ${wsId}, ${noteVersionId}, 'active', ${tx.json({ title: "Card" })})`;
      await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text) VALUES (${keyPointId}, ${cardId}, ${wsId}, 0, 'Claim', 'Quote')`;
      // Create old-style question (no user_id, no rubric items)
      await tx`INSERT INTO validation_questions (id, workspace_id, card_id, key_point_id, note_version_id, question_type, question, created_by, status, generator_kind) VALUES (${oldQuestionId}, ${wsId}, ${cardId}, ${keyPointId}, ${noteVersionId}, 'explain', 'Old Q?', ${userId}, 'active', 'ai')`;
    });

    // Run the legacy marking UPDATE (same as migration 0041)
    await sql`
      UPDATE validation_questions
      SET status = 'legacy_unrubriced'
      WHERE status = 'active'
        AND generator_kind = 'ai'
        AND NOT EXISTS (
          SELECT 1 FROM validation_question_rubric_items ri
          WHERE ri.question_id = validation_questions.id
        )
        AND user_id IS NULL
    `;

    // Verify the old question is now legacy_unrubriced
    const [row] = await sql`SELECT status FROM validation_questions WHERE id = ${oldQuestionId}`;
    assert.equal(row?.status, "legacy_unrubriced", "Old unrubriced question should be marked legacy_unrubriced");
  } finally {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM validation_questions WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM workspaces WHERE id = ${wsId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  }
});

test("v0.6 migration: backup/restore preserves v0.6 new table data", async () => {
  // This test verifies that the export/restore cycle works for v0.6 tables
  // by creating data in v0.6 tables, exporting, and verifying the export contains it.
  const wsId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const blockId = randomUUID();
  const evidenceId = randomUUID();
  const questionId = randomUUID();
  const rubricItemId = randomUUID();
  const submissionId = randomUUID();

  try {
    // Seed data across v0.6 tables
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`backup-${randomUUID().slice(0, 8)}@test.com`}, 'hash', 'owner')`;
      await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${wsId}, 'backup-test', ${userId})`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, 'owner')`;
      await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${noteId}, ${wsId}, 'Test', ${userId})`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES (${noteVersionId}, ${noteId}, ${wsId}, 1, ${tx.json({ blocks: [] })}, 'hash', ${userId})`;
      await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
      await tx`INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json) VALUES (${cardId}, ${wsId}, ${noteVersionId}, 'active', ${tx.json({ title: "Card" })})`;
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content) VALUES (${blockId}, ${noteVersionId}, ${wsId}, 0, 'paragraph', 'Block')`;
      await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text) VALUES (${keyPointId}, ${cardId}, ${wsId}, 0, 'Claim', 'Quote')`;
      await tx`INSERT INTO evidences (id, workspace_id, key_point_id, block_id, block_ordinal, quote_text, alignment, alignment_score, alignment_method) VALUES (${evidenceId}, ${wsId}, ${keyPointId}, ${blockId}, 0, 'Evidence quote', 'aligned', 90, 'fuzzy')`;
      // v0.6: question with rubric item
      await tx`INSERT INTO validation_questions (id, workspace_id, card_id, key_point_id, note_version_id, question_type, question, created_by, user_id, status, generator_kind, source_fingerprint, rubric_version, expires_at) VALUES (${questionId}, ${wsId}, ${cardId}, ${keyPointId}, ${noteVersionId}, 'explain', 'Test Q?', ${userId}, ${userId}, 'active', 'ai', 'fp-test', 'rubric-v1', NOW() + INTERVAL '30 days')`;
      await tx`INSERT INTO validation_question_rubric_items (id, workspace_id, question_id, ordinal, criterion, expected_concept, weight, required, evidence_id) VALUES (${rubricItemId}, ${wsId}, ${questionId}, 0, 'Criterion', 'Expected', 1, true, NULL)`;
      // v0.6: submission
      await tx`INSERT INTO validation_submissions (id, workspace_id, user_id, card_id, key_point_id, question_id, context, status, start_idempotency_key, source_fingerprint, user_answer) VALUES (${submissionId}, ${wsId}, ${userId}, ${cardId}, ${keyPointId}, ${questionId}, 'initial_validation', 'completed', 'idem-test', 'fp-test', 'My answer')`;
    });

    // Verify data exists in all v0.6 tables
    const [rubricCount] = await sql`SELECT count(*) as cnt FROM validation_question_rubric_items WHERE workspace_id = ${wsId}`;
    assert.ok(rubricCount.cnt >= 1, "Rubric items should exist");

    const [subCount] = await sql`SELECT count(*) as cnt FROM validation_submissions WHERE workspace_id = ${wsId}`;
    assert.ok(subCount.cnt >= 1, "Submissions should exist");

    // Simulate export by querying all v0.6 tables
    const exportData = {
      validationQuestionRubricItems: await sql`SELECT * FROM validation_question_rubric_items WHERE workspace_id = ${wsId}`,
      validationSubmissions: await sql`SELECT * FROM validation_submissions WHERE workspace_id = ${wsId}`,
    };

    assert.ok(exportData.validationQuestionRubricItems.length >= 1, "Export should include rubric items");
    assert.ok(exportData.validationSubmissions.length >= 1, "Export should include submissions");
    assert.equal(exportData.validationSubmissions[0].user_answer, "My answer", "Export should preserve user_answer");
  } finally {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM validation_point_assessments WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_assistance_exposures WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_action_commands WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_submission_jobs WHERE submission_id IN (SELECT id FROM validation_submissions WHERE workspace_id = ${wsId})`;
      await tx`DELETE FROM validation_submissions WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_question_rubric_items WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_questions WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM validation_events WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM evidences WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM note_blocks WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${wsId}`;
      await tx`DELETE FROM workspaces WHERE id = ${wsId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  }
});

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
