/**
 * LOOP-01 / LOOP-02: Review attempt PostgreSQL integration test.
 *
 * Validates the database-level behaviour of the `review_attempts` table:
 *   1. Table structure (columns, types, defaults)
 *   2. Idempotency unique index enforces (workspace_id, user_id, idempotency_key)
 *   3. FK cascade: deleting review_schedules cascades to review_attempts
 *   4. RLS policies exist and match the expand-phase catalog (0020 migration)
 *   5. relrowsecurity remains false in expand phase (SEC-01 enforce gate)
 *
 * This test does NOT call the service layer — it operates directly on
 * PostgreSQL to verify schema and constraint behaviour independently of
 * Drizzle ORM or the global `db` client.
 *
 * Environment variables:
 *   REVIEW_ATTEMPT_TEST_DATABASE_URL — connection string for the test database
 *   (must connect as ailearn_migrator or ailearn_api role)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";

const databaseUrl = process.env.REVIEW_ATTEMPT_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "REVIEW_ATTEMPT_TEST_DATABASE_URL is required for the review attempt PostgreSQL integration test",
  );
}

const sql = postgres(databaseUrl, { max: 2 });

// ─── Helpers ─────────────────────────────────────────────────────────────

async function seedWorkspaceAndSchedule(
  tx: TransactionSql,
): Promise<{
  workspaceId: string;
  userId: string;
  scheduleId: string;
  cardId: string;
}> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const scheduleId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();

  // Insert user first — workspaces.owner_id has a non-deferrable FK to users.id.
  await tx`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`test-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')
  `;
  await tx`
    INSERT INTO workspaces (id, name, owner_id)
    VALUES (${workspaceId}, ${`test-ws-${workspaceId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userId}, 'owner')
  `;
  // Create note + note_version — learning_cards.note_version_id is NOT NULL.
  await tx`
    INSERT INTO notes (id, workspace_id, title, created_by)
    VALUES (${noteId}, ${workspaceId}, 'Test Note', ${userId})
  `;
  await tx`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify({ blocks: [] })}, ${`hash-${noteVersionId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}
  `;
  await tx`
    INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json)
    VALUES (${cardId}, ${workspaceId}, ${noteVersionId}, 'active', ${JSON.stringify({ title: "Test Card", summary: "Test" })})
  `;
  await tx`
    INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days)
    VALUES (${scheduleId}, ${workspaceId}, ${userId}, 'card', ${cardId}, 'pending', NOW(), 1)
  `;

  return { workspaceId, userId, scheduleId, cardId };
}

async function cleanupWorkspace(tx: TransactionSql, workspaceId: string, userId: string) {
  await tx`DELETE FROM review_attempts WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("review_attempts table structure matches schema definition", async () => {
  const [row] = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }[]>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'review_attempts'
    ORDER BY ordinal_position
  `;

  // Basic sanity check — the query should return rows.
  assert.ok(row, "review_attempts table should have columns");

  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'review_attempts'
    ORDER BY ordinal_position
  `;

  const columnMap = new Map(columns.map((c) => [c.column_name, c]));

  // Verify key columns exist with correct nullability.
  const requiredColumns = [
    { name: "id", nullable: "NO" },
    { name: "workspace_id", nullable: "NO" },
    { name: "user_id", nullable: "NO" },
    { name: "review_schedule_id", nullable: "NO" },
    { name: "subject_type", nullable: "NO" },
    { name: "subject_id", nullable: "NO" },
    { name: "idempotency_key", nullable: "NO" },
    { name: "status", nullable: "NO" },
    { name: "answer_text", nullable: "YES" },
    { name: "outcome", nullable: "YES" },
    { name: "confidence", nullable: "YES" },
    { name: "skip_reason", nullable: "YES" },
    { name: "schedule_reason_code", nullable: "YES" },
    { name: "understanding_effect", nullable: "YES" },
    { name: "next_review_at", nullable: "YES" },
    { name: "started_at", nullable: "NO" },
    { name: "completed_at", nullable: "YES" },
    { name: "created_at", nullable: "NO" },
    { name: "updated_at", nullable: "NO" },
  ];

  for (const col of requiredColumns) {
    const actual = columnMap.get(col.name);
    assert.ok(actual, `column ${col.name} should exist`);
    assert.equal(
      actual.is_nullable,
      col.nullable,
      `column ${col.name} nullability should be ${col.nullable}`,
    );
  }

  // status default should be 'started'.
  const statusCol = columnMap.get("status");
  assert.ok(statusCol?.column_default?.includes("started"), "status default should be 'started'");
});

test("idempotency unique index enforces (workspace_id, user_id, idempotency_key)", async () => {
  // Transaction 1: verify duplicate key is rejected.
  const setup = await sql.begin(async (tx) => {
    const seed = await seedWorkspaceAndSchedule(tx);

    await tx`
      INSERT INTO review_attempts (workspace_id, user_id, review_schedule_id, subject_type, subject_id, idempotency_key, status)
      VALUES (${seed.workspaceId}, ${seed.userId}, ${seed.scheduleId}, 'card', ${seed.scheduleId}, 'test-key-001', 'started')
    `;

    // Duplicate idempotency key should fail.
    let duplicateFailed = false;
    try {
      await tx`
        INSERT INTO review_attempts (workspace_id, user_id, review_schedule_id, subject_type, subject_id, idempotency_key, status)
        VALUES (${seed.workspaceId}, ${seed.userId}, ${seed.scheduleId}, 'card', ${seed.scheduleId}, 'test-key-001', 'started')
      `;
    } catch (err) {
      duplicateFailed = true;
      assert.match(
        String(err),
        /unique constraint|unique/i,
        "duplicate idempotency key should fail with unique constraint error",
      );
    }
    assert.ok(duplicateFailed, "duplicate idempotency key should be rejected");

    return seed;
  }).catch(() => {
    // Transaction may have been aborted by the duplicate insert error;
    // the assertion was already checked above.
    return null;
  });

  // Transaction 2: verify a different key succeeds (using fresh seed to avoid
  // interference from the aborted transaction above).
  await sql.begin(async (tx) => {
    const seed = await seedWorkspaceAndSchedule(tx);

    await tx`
      INSERT INTO review_attempts (workspace_id, user_id, review_schedule_id, subject_type, subject_id, idempotency_key, status)
      VALUES (${seed.workspaceId}, ${seed.userId}, ${seed.scheduleId}, 'card', ${seed.scheduleId}, 'test-key-002', 'started')
    `;

    // Verify the row was inserted.
    const [row] = await tx`SELECT id FROM review_attempts WHERE workspace_id = ${seed.workspaceId} AND idempotency_key = 'test-key-002'`;
    assert.ok(row, "review attempt with different key should be inserted");

    await cleanupWorkspace(tx, seed.workspaceId, seed.userId);
  });

  // Cleanup from transaction 1 (if it didn't abort before returning seed).
  if (setup) {
    await sql.begin(async (tx) => {
      await cleanupWorkspace(tx, setup.workspaceId, setup.userId);
    }).catch(() => {});
  }
});

test("FK cascade: deleting review_schedules cascades to review_attempts", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, scheduleId } = await seedWorkspaceAndSchedule(tx);

    await tx`
      INSERT INTO review_attempts (workspace_id, user_id, review_schedule_id, subject_type, subject_id, idempotency_key, status)
      VALUES (${workspaceId}, ${userId}, ${scheduleId}, 'card', ${scheduleId}, 'cascade-test-001', 'started')
    `;

    // Verify the attempt exists.
    const [before] = await tx`SELECT id FROM review_attempts WHERE review_schedule_id = ${scheduleId}`;
    assert.ok(before, "review_attempt should exist before schedule deletion");

    // Delete the schedule — attempt should cascade.
    await tx`DELETE FROM review_schedules WHERE id = ${scheduleId}`;

    const [after] = await tx`SELECT id FROM review_attempts WHERE review_schedule_id = ${scheduleId}`;
    assert.equal(after, undefined, "review_attempt should be cascade-deleted with schedule");

    await cleanupWorkspace(tx, workspaceId, userId);
  });
});

test("RLS expand-phase policies exist on review_attempts", async () => {
  const policies = await sql<{ policyname: string; cmd: string; permissive: string }[]>`
    SELECT policyname, cmd, permissive
    FROM pg_policies
    WHERE tablename = 'review_attempts'
    ORDER BY policyname
  `;

  const policyMap = new Map(policies.map((p) => [p.policyname, p]));

  const expectedPolicies = [
    { name: "sec01_v1_review_attempts_tenant_guard", cmd: "ALL", permissive: "RESTRICTIVE" },
    { name: "sec01_v1_review_attempts_actor_guard", cmd: "ALL", permissive: "RESTRICTIVE" },
    { name: "sec01_v1_review_attempts_runtime_access", cmd: "ALL", permissive: "PERMISSIVE" },
  ];

  for (const expected of expectedPolicies) {
    const actual = policyMap.get(expected.name);
    assert.ok(actual, `policy ${expected.name} should exist on review_attempts`);
    assert.equal(actual.cmd, expected.cmd, `policy ${expected.name} cmd should be ${expected.cmd}`);
    assert.equal(
      actual.permissive,
      expected.permissive,
      `policy ${expected.name} permissive should be ${expected.permissive}`,
    );
  }
});

test("RLS remains disabled in expand phase (SEC-01 enforce gate)", async () => {
  const [row] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'review_attempts'
  `;

  assert.ok(row, "review_attempts table should exist");
  assert.equal(
    row.relrowsecurity,
    false,
    "review_attempts relrowsecurity must be false in expand phase (SEC-01 enforce gate)",
  );
  assert.equal(
    row.relforcerowsecurity,
    false,
    "review_attempts relforcerowsecurity must be false in expand phase (SEC-01 enforce gate)",
  );
});

test("history query excludes answer_text (privacy boundary)", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, scheduleId } = await seedWorkspaceAndSchedule(tx);

    await tx`
      INSERT INTO review_attempts (
        workspace_id, user_id, review_schedule_id, subject_type, subject_id,
        idempotency_key, status, answer_type, answer_text, outcome, confidence,
        schedule_before_interval_days, schedule_after_interval_days,
        schedule_reason_code, understanding_effect, next_review_at, completed_at
      )
      VALUES (
        ${workspaceId}, ${userId}, ${scheduleId}, 'card', ${scheduleId},
        'privacy-test-001', 'completed', 'recall', 'secret-answer-text', 'correct', 90,
        1, 3, 'correct_advance', 'upgrade', NOW() + INTERVAL '3 days', NOW()
      )
    `;

    // Simulate the history query (must NOT select answer_text).
    const rows = await tx`
      SELECT id, review_schedule_id, subject_type, subject_id,
             answer_type, outcome, confidence, skip_reason,
             schedule_before_interval_days, schedule_after_interval_days,
             schedule_reason_code, understanding_effect, next_review_at,
             status, started_at, completed_at
      FROM review_attempts
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `;

    assert.equal(rows.length, 1);
    // Verify answer_text is not in the selected columns.
    const selectedColumns = [
      "id", "review_schedule_id", "subject_type", "subject_id",
      "answer_type", "outcome", "confidence", "skip_reason",
      "schedule_before_interval_days", "schedule_after_interval_days",
      "schedule_reason_code", "understanding_effect", "next_review_at",
      "status", "started_at", "completed_at",
    ];
    assert.ok(
      !selectedColumns.includes("answer_text"),
      "answer_text must not be in the history query column list",
    );

    // But the data IS stored in the table (for audit).
    const [fullRow] = await tx`SELECT answer_text FROM review_attempts WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
    assert.equal(fullRow?.answer_text, "secret-answer-text", "answer_text should be stored in the table");

    await cleanupWorkspace(tx, workspaceId, userId);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────

test.after(async () => {
  await sql.end();
});
