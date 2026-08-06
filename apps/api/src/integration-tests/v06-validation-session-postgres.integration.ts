/**
 * v0.6 Validation Session PostgreSQL Integration Tests (计划 §13.2)
 *
 * Tests database-level concurrency, locking, and state migration invariants
 * that cannot be verified with unit tests alone.
 *
 * Test scenarios (计划 §13.2):
 * 1. validation_submissions unique active index enforces one non-terminal submission
 * 2. validation_action_commands idempotency unique index
 * 3. validation_assistance_exposures unique fingerprint index
 * 4. validation_point_assessments unique (submission_id, rubric_item_id)
 * 5. scheduling_shadow_decisions unique (source_type, source_id, algorithm, parameters_version)
 * 6. validation_quality_signals table structure and RLS
 * 7. FOR UPDATE lock prevents concurrent submit and reveal-source
 * 8. Draft revision CAS conflict at DB level
 * 9. Legacy question marking (legacy_unrubriced)
 *
 * Environment variables:
 *   V06_SESSION_TEST_DATABASE_URL — connection string for the test database
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";

const databaseUrl = process.env.V06_SESSION_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "V06_SESSION_TEST_DATABASE_URL is required for the v0.6 session PostgreSQL integration test",
  );
}

const sql = postgres(databaseUrl, { max: 4 });

test.after(async () => {
  await sql.end({ timeout: 5 });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function seedWorkspace(
  tx: TransactionSql,
): Promise<{
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string;
  noteId: string;
  noteVersionId: string;
  evidenceId: string;
}> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const evidenceId = randomUUID();
  const blockId = randomUUID();

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
  await tx`
    INSERT INTO notes (id, workspace_id, title, created_by)
    VALUES (${noteId}, ${workspaceId}, 'Test Note', ${userId})
  `;
  await tx`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${tx.json({ blocks: [] })}, ${`hash-${noteVersionId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}
  `;
  await tx`
    INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json)
    VALUES (${cardId}, ${workspaceId}, ${noteVersionId}, 'active', ${tx.json({ title: "Test Card", summary: "Test" })})
  `;
  await tx`
    INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
    VALUES (${blockId}, ${noteVersionId}, ${workspaceId}, 0, 'paragraph', 'Test block content')
  `;
  await tx`
    INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
    VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 0, 'Test claim', 'Test quote')
  `;
  await tx`
    INSERT INTO evidences (id, workspace_id, key_point_id, block_id, block_ordinal, quote_text, alignment, alignment_score, alignment_method)
    VALUES (${evidenceId}, ${workspaceId}, ${keyPointId}, ${blockId}, 0, 'Test evidence quote', 'aligned', 90, 'fuzzy')
  `;

  return { workspaceId, userId, cardId, keyPointId, noteId, noteVersionId, evidenceId };
}

async function cleanupWorkspace(tx: TransactionSql, workspaceId: string, userId: string) {
  await tx`DELETE FROM scheduling_shadow_decisions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_quality_signals WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_point_assessments WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_assistance_exposures WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_action_commands WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_submission_jobs WHERE submission_id IN (SELECT id FROM validation_submissions WHERE workspace_id = ${workspaceId})`;
  await tx`DELETE FROM validation_submissions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_question_rubric_items WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_questions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM validation_events WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM review_attempts WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM evidences WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

async function createQuestion(
  tx: TransactionSql,
  workspaceId: string,
  userId: string,
  cardId: string,
  keyPointId: string,
  noteVersionId: string,
): Promise<string> {
  const questionId = randomUUID();
  await tx`
    INSERT INTO validation_questions (id, workspace_id, card_id, key_point_id, note_version_id, question_type, question, created_by, user_id, status, generator_kind, source_fingerprint, rubric_version, expires_at)
    VALUES (${questionId}, ${workspaceId}, ${cardId}, ${keyPointId}, ${noteVersionId}, 'explain', 'Test question?', ${userId}, ${userId}, 'active', 'ai', ${`fp-${questionId.slice(0, 8)}`}, 'rubric-v1', NOW() + INTERVAL '30 days')
  `;
  // Create rubric item
  const rubricItemId = randomUUID();
  await tx`
    INSERT INTO validation_question_rubric_items (id, workspace_id, question_id, ordinal, criterion, expected_concept, weight, required, evidence_id)
    VALUES (${rubricItemId}, ${workspaceId}, ${questionId}, 0, 'Test criterion', 'Test expected concept', 1, true, NULL)
  `;
  return questionId;
}

async function createSubmission(
  tx: TransactionSql,
  workspaceId: string,
  userId: string,
  cardId: string,
  keyPointId: string,
  questionId: string,
  status = "ready",
): Promise<string> {
  const submissionId = randomUUID();
  await tx`
    INSERT INTO validation_submissions (id, workspace_id, user_id, card_id, key_point_id, question_id, context, status, start_idempotency_key, source_fingerprint)
    VALUES (${submissionId}, ${workspaceId}, ${userId}, ${cardId}, ${keyPointId}, ${questionId}, 'initial_validation', ${status}, ${`idem-${submissionId.slice(0, 8)}`}, ${`fp-${submissionId.slice(0, 8)}`})
  `;
  return submissionId;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("v0.6: validation_submissions active unique index prevents duplicate non-terminal submissions", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
    const sub1 = await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, questionId, "ready");
    return { ...ctx, questionId, sub1 };
  });

  // Try to create a second non-terminal submission for the same (workspace, user, keyPoint, context)
  await assert.rejects(
    sql.begin(async (tx) => {
      await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.questionId, "question_preparing");
    }),
    // Should fail due to unique index
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("val_submissions_active_unique_idx") || msg.includes("unique");
    },
  );

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: terminal submissions do NOT block new submission creation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
    // Create a terminal (abandoned) submission
    const sub1 = await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, questionId, "abandoned");
    return { ...ctx, questionId, sub1 };
  });

  // Should be able to create a new non-terminal submission
  const sub2 = await sql.begin(async (tx) => {
    return await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.questionId, "ready");
  });

  assert.ok(sub2, "New submission created after terminal submission");

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: validation_action_commands unique index prevents duplicate idempotency keys", async () => {
  const ctx = await sql.begin(async (tx) => {
    return await seedWorkspace(tx);
  });

  const idempotencyKey = `test-key-${randomUUID().slice(0, 8)}`;

  // First action command
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_action_commands (workspace_id, user_id, action, idempotency_key, request_hash, response_status)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, 'start', ${idempotencyKey}, 'hash1', 'success')
    `;
  });

  // Duplicate with same (workspace, user, action, idempotency_key) should fail
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO validation_action_commands (workspace_id, user_id, action, idempotency_key, request_hash, response_status)
        VALUES (${ctx.workspaceId}, ${ctx.userId}, 'start', ${idempotencyKey}, 'hash2', 'success')
      `;
    }),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("val_action_cmd_unique_idx") || msg.includes("unique");
    },
  );

  // Different action with same key should succeed
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_action_commands (workspace_id, user_id, action, idempotency_key, request_hash, response_status)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, 'submit', ${idempotencyKey}, 'hash3', 'success')
    `;
  });

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: validation_assistance_exposures unique fingerprint index", async () => {
  const ctx = await sql.begin(async (tx) => {
    return await seedWorkspace(tx);
  });

  const exposureFingerprint = `exp-fp-${randomUUID().slice(0, 8)}`;

  // First exposure
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, ${exposureFingerprint}, 'pre_submit_source', NOW(), NOW(), NOW() + INTERVAL '24 hours')
    `;
  });

  // Duplicate (workspace, user, keyPoint, fingerprint) should fail
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
        VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, ${exposureFingerprint}, 'post_result_feedback', NOW(), NOW(), NOW() + INTERVAL '24 hours')
      `;
    }),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("val_assist_exp_unique_idx") || msg.includes("unique");
    },
  );

  // Different fingerprint for same keyPoint should succeed
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, ${`other-fp-${randomUUID().slice(0, 8)}`}, 'pre_submit_source', NOW(), NOW(), NOW() + INTERVAL '24 hours')
    `;
  });

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: validation_point_assessments unique (submission_id, rubric_item_id)", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
    const submissionId = await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, questionId, "completed");
    return { ...ctx, questionId, submissionId };
  });

  // Get rubric item ID
  const [rubricItem] = await sql`
    SELECT id FROM validation_question_rubric_items WHERE question_id = ${ctx.questionId}
  `;
  assert.ok(rubricItem, "Rubric item should exist");

  // First assessment
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_point_assessments (workspace_id, user_id, submission_id, rubric_item_id, verdict, assessment_source, confidence)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.submissionId}, ${rubricItem.id}, 'covered', 'ai', 85)
    `;
  });

  // Duplicate (submission_id, rubric_item_id) should fail
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO validation_point_assessments (workspace_id, user_id, submission_id, rubric_item_id, verdict, assessment_source, confidence)
        VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.submissionId}, ${rubricItem.id}, 'missing', 'ai', 0)
      `;
    }),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("val_point_assess_unique_idx") || msg.includes("unique");
    },
  );

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: FOR UPDATE lock prevents concurrent submit and reveal-source on same submission", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
    const submissionId = await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, questionId, "ready");
    return { ...ctx, questionId, submissionId };
  });

  // Transaction 1: Lock the submission row
  const tx1 = sql.begin(async (tx) => {
    // Lock submission row
    await tx`
      SELECT id FROM validation_submissions WHERE id = ${ctx.submissionId} FOR UPDATE
    `;
    // Simulate work — hold the lock
    await tx`SELECT pg_sleep(0.2)`;
    // Update status
    await tx`
      UPDATE validation_submissions SET status = 'evaluation_pending', updated_at = NOW()
      WHERE id = ${ctx.submissionId}
    `;
  });

  // Transaction 2: Try to lock the same row concurrently
  const tx2Result = (async () => {
    // Wait a tiny bit to ensure tx1 acquires the lock first
    await new Promise((r) => setTimeout(r, 50));
    return sql.begin(async (tx) => {
      // This should block until tx1 commits
      const [row] = await tx`
        SELECT status FROM validation_submissions WHERE id = ${ctx.submissionId} FOR UPDATE
      `;
      // After tx1 commits, we should see the updated status
      return row?.status;
    });
  })();

  // Wait for both transactions
  await tx1;
  const finalStatus = await tx2Result;

  // tx2 should see the status updated by tx1 (evaluation_pending)
  assert.equal(
    finalStatus,
    "evaluation_pending",
    "FOR UPDATE lock should serialize concurrent access — tx2 sees tx1's commit",
  );

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: draft revision CAS — concurrent draft updates cause conflict", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
    const submissionId = await createSubmission(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, questionId, "ready");
    return { ...ctx, questionId, submissionId };
  });

  // Transaction 1: Update draft with revision 0 → 1
  const tx1 = sql.begin(async (tx) => {
    const result = await tx`
      UPDATE validation_submissions
      SET draft_revision = 1, user_answer = 'answer-from-tx1', updated_at = NOW()
      WHERE id = ${ctx.submissionId} AND draft_revision = 0
      RETURNING draft_revision
    `;
    return result[0]?.draft_revision;
  });

  // Wait for tx1 to commit
  const rev1 = await tx1;
  assert.equal(rev1, 1, "tx1 should successfully update revision to 1");

  // Transaction 2: Try to update with stale revision 0
  const tx2Result = await sql.begin(async (tx) => {
    const result = await tx`
      UPDATE validation_submissions
      SET draft_revision = 1, user_answer = 'answer-from-tx2', updated_at = NOW()
      WHERE id = ${ctx.submissionId} AND draft_revision = 0
      RETURNING draft_revision
    `;
    return result.length;
  });

  assert.equal(tx2Result, 0, "tx2 should not update any rows (CAS conflict)");

  // Verify tx1's answer was preserved
  const [finalRow] = await sql`
    SELECT user_answer, draft_revision FROM validation_submissions WHERE id = ${ctx.submissionId}
  `;
  assert.equal(finalRow?.user_answer, "answer-from-tx1");
  assert.equal(finalRow?.draft_revision, 1);

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: validation_quality_signals table structure and RLS", async () => {
  // Verify table exists
  const columns = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'validation_quality_signals'
    ORDER BY ordinal_position
  `;

  const columnMap = new Map(columns.map((c) => [c.column_name, c]));

  // Verify required columns
  const requiredColumns = [
    { name: "id", nullable: "NO" },
    { name: "workspace_id", nullable: "NO" },
    { name: "user_id", nullable: "NO" },
    { name: "validation_event_id", nullable: "NO" },
    { name: "reason", nullable: "NO" },
    { name: "comment", nullable: "YES" },
    { name: "source_fingerprint", nullable: "YES" },
    { name: "rubric_version", nullable: "YES" },
    { name: "reducer_version", nullable: "YES" },
    { name: "policy_version", nullable: "YES" },
    { name: "created_at", nullable: "NO" },
  ];

  for (const col of requiredColumns) {
    const actual = columnMap.get(col.name);
    assert.ok(actual, `Column ${col.name} should exist`);
    assert.equal(actual?.is_nullable, col.nullable, `Column ${col.name} nullability mismatch`);
  }

  // Verify RLS is enabled
  const [rlsRow] = await sql`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'validation_quality_signals'
  `;
  assert.ok(rlsRow?.relrowsecurity, "RLS should be enabled on validation_quality_signals");

  // Verify RLS policy exists
  const policies = await sql`
    SELECT policyname FROM pg_policies WHERE tablename = 'validation_quality_signals'
  `;
  assert.ok(
    policies.some((p) => p.policyname === "val_quality_sig_user_isolation"),
    "User isolation policy should exist",
  );
});

test("v0.6: scheduling_shadow_decisions unique (source_type, source_id, algorithm, parameters_version)", async () => {
  const ctx = await sql.begin(async (tx) => {
    return await seedWorkspace(tx);
  });

  const sourceId = randomUUID();

  // First shadow decision
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO scheduling_shadow_decisions (workspace_id, user_id, key_point_id, source_type, source_id, algorithm, algorithm_version, parameters_version, predicted_due_at)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, 'validation_event', ${sourceId}, 'fsrs', '4.6.0', 'v1', NOW() + INTERVAL '3 days')
    `;
  });

  // Duplicate should fail
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO scheduling_shadow_decisions (workspace_id, user_id, key_point_id, source_type, source_id, algorithm, algorithm_version, parameters_version, predicted_due_at)
        VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, 'validation_event', ${sourceId}, 'fsrs', '4.6.0', 'v1', NOW() + INTERVAL '7 days')
      `;
    }),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("sched_shadow_unique_idx") || msg.includes("unique");
    },
  );

  // Different parameters_version should succeed
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO scheduling_shadow_decisions (workspace_id, user_id, key_point_id, source_type, source_id, algorithm, algorithm_version, parameters_version, predicted_due_at)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, 'validation_event', ${sourceId}, 'fsrs', '4.6.0', 'v2', NOW() + INTERVAL '5 days')
    `;
  });

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: legacy_unrubriced marking — old questions without rubric items", async () => {
  const ctx = await sql.begin(async (tx) => {
    const ctx = await seedWorkspace(tx);
    // Create an old-style question without user_id and without rubric items
    const oldQuestionId = randomUUID();
    await tx`
      INSERT INTO validation_questions (id, workspace_id, card_id, key_point_id, note_version_id, question_type, question, created_by, status, generator_kind)
      VALUES (${oldQuestionId}, ${ctx.workspaceId}, ${ctx.cardId}, ${ctx.keyPointId}, ${ctx.noteVersionId}, 'explain', 'Old question?', ${ctx.userId}, 'active', 'ai')
    `;
    return { ...ctx, oldQuestionId };
  });

  // Run the legacy marking UPDATE (same as in migration 0041)
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
  const [row] = await sql`
    SELECT status FROM validation_questions WHERE id = ${ctx.oldQuestionId}
  `;
  assert.equal(row?.status, "legacy_unrubriced", "Old unrubriced question should be marked legacy_unrubriced");

  // Verify a v0.6 question with rubric items is NOT affected
  const v06QuestionId = await sql.begin(async (tx) => {
    return await createQuestion(tx, ctx.workspaceId, ctx.userId, ctx.cardId, ctx.keyPointId, ctx.noteVersionId);
  });

  const [v06Row] = await sql`
    SELECT status FROM validation_questions WHERE id = ${v06QuestionId}
  `;
  assert.equal(v06Row?.status, "active", "v0.6 question with rubric items should remain active");

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: jobs repair_state CHECK constraint enforces 0..1", async () => {
  // Verify the CHECK constraint exists
  const [constraint] = await sql`
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'jobs' AND con.conname = 'jobs_repair_attempt_count_check'
  `;
  assert.ok(constraint, "jobs_repair_attempt_count_check constraint should exist");

  // Verify repair_attempt_count = 2 is rejected
  const ctx = await sql.begin(async (tx) => {
    return await seedWorkspace(tx);
  });

  await assert.rejects(
    sql.begin(async (tx) => {
      const jobId = randomUUID();
      await tx`
        INSERT INTO jobs (
          id, workspace_id, type, payload, status, requested_by,
          lease_token, repair_state, repair_attempt_count
        )
        VALUES (
          ${jobId}, ${ctx.workspaceId}, 'execute_card_agent_turn', ${tx.json({})},
          'pending', ${ctx.userId}, ${`lease-${randomUUID().slice(0, 8)}`},
          'none', 2
        )
      `;
    }),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? "");
      return msg.includes("jobs_repair_attempt_count_check") || msg.includes("check");
    },
  );

  // Verify repair_attempt_count = 1 is accepted
  await sql.begin(async (tx) => {
    const jobId = randomUUID();
    await tx`
      INSERT INTO jobs (
        id, workspace_id, type, payload, status, requested_by,
        lease_token, repair_state, repair_attempt_count
      )
      VALUES (
        ${jobId}, ${ctx.workspaceId}, 'execute_card_agent_turn', ${tx.json({})},
        'pending', ${ctx.userId}, ${`lease-${randomUUID().slice(0, 8)}`},
        'completed', 1
      )
    `;
  });

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: concurrent review schedule completion — FOR UPDATE serializes, only one completes", async () => {
  const ctx = await sql.begin(async (tx) => {
    const seed = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, seed.workspaceId, seed.userId, seed.cardId, seed.keyPointId, seed.noteVersionId);
    // Create a pending review schedule
    const scheduleId = randomUUID();
    await tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, key_point_id, status, interval_days, next_review_at, policy_version, generation)
      VALUES (${scheduleId}, ${seed.workspaceId}, ${seed.userId}, 'key_point', ${seed.keyPointId}, ${seed.keyPointId}, 'pending', 3, NOW(), 'discrete-v2', 0)
    `;
    return { ...seed, questionId, scheduleId };
  });

  const connA = postgres(databaseUrl!, { max: 1 });
  const connB = postgres(databaseUrl!, { max: 1 });

  try {
    // Two concurrent transactions try to lock and complete the same schedule
    const txAPromise = connA.begin(async (tx) => {
      const [row] = await tx`
        SELECT id, status FROM review_schedules WHERE id = ${ctx.scheduleId} FOR UPDATE
      `;
      if (!row || row.status !== "pending") return "skipped";
      await tx`SELECT pg_sleep(0.2)`;
      await tx`
        UPDATE review_schedules SET status = 'completed', updated_at = NOW()
        WHERE id = ${ctx.scheduleId}
      `;
      return "completed";
    });

    const txBPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return connB.begin(async (tx) => {
        const [row] = await tx`
          SELECT id, status FROM review_schedules WHERE id = ${ctx.scheduleId} FOR UPDATE
        `;
        if (!row || row.status !== "pending") return "skipped";
        await tx`
          UPDATE review_schedules SET status = 'completed', updated_at = NOW()
          WHERE id = ${ctx.scheduleId}
        `;
        return "completed";
      });
    })();

    const [resultA, resultB] = await Promise.all([txAPromise, txBPromise]);

    const completedCount = [resultA, resultB].filter((r) => r === "completed").length;
    const skippedCount = [resultA, resultB].filter((r) => r === "skipped").length;
    assert.equal(completedCount, 1, "Exactly one transaction should complete the schedule");
    assert.equal(skippedCount, 1, "Exactly one transaction should skip (already completed)");

    // Verify final state
    const [finalRow] = await sql`
      SELECT status FROM review_schedules WHERE id = ${ctx.scheduleId}
    `;
    assert.equal(finalRow?.status, "completed", "Schedule should be completed");
  } finally {
    await Promise.allSettled([connA.end({ timeout: 5 }), connB.end({ timeout: 5 })]);
    await sql.begin(async (tx) => {
      await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
    });
  }
});

test("v0.6: submission status state migration — ready to answer_saved serialized by FOR UPDATE", async () => {
  const ctx = await sql.begin(async (tx) => {
    const seed = await seedWorkspace(tx);
    const questionId = await createQuestion(tx, seed.workspaceId, seed.userId, seed.cardId, seed.keyPointId, seed.noteVersionId);
    const submissionId = await createSubmission(tx, seed.workspaceId, seed.userId, seed.cardId, seed.keyPointId, questionId, "ready");
    return { ...seed, questionId, submissionId };
  });

  // Transaction 1: Transition ready → answer_saved (holds lock during sleep)
  const tx1Promise = sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT status FROM validation_submissions WHERE id = ${ctx.submissionId} FOR UPDATE
    `;
    assert.equal(row?.status, "ready", "tx1 should see 'ready' status");
    await tx`SELECT pg_sleep(0.2)`;
    await tx`
      UPDATE validation_submissions SET status = 'answer_saved', draft_revision = 1, user_answer = 'test answer', updated_at = NOW()
      WHERE id = ${ctx.submissionId}
    `;
  });

  // Transaction 2: Tries to read + update concurrently, should block and see answer_saved
  const tx2Promise = (async () => {
    await new Promise((r) => setTimeout(r, 50));
    return sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT status, user_answer FROM validation_submissions WHERE id = ${ctx.submissionId} FOR UPDATE
      `;
      // After tx1 commits, tx2 sees the updated state
      return { status: row?.status, userAnswer: row?.user_answer };
    });
  })();

  await tx1Promise;
  const tx2Result = await tx2Promise;

  assert.equal(tx2Result.status, "answer_saved", "tx2 should see 'answer_saved' after tx1 commits");
  assert.equal(tx2Result.userAnswer, "test answer", "tx2 should see tx1's answer");

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});

test("v0.6: exposure cooldown monotonic upsert — re-exposure refreshes unassisted_eligible_after", async () => {
  const ctx = await sql.begin(async (tx) => {
    return await seedWorkspace(tx);
  });

  const exposureFingerprint = `exp-fp-${randomUUID().slice(0, 8)}`;
  const firstEligibleAfter = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h
  const secondEligibleAfter = new Date(Date.now() + 48 * 60 * 60 * 1000); // +48h

  // First exposure (pre_submit_source)
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, ${exposureFingerprint}, 'pre_submit_source', NOW(), NOW(), ${firstEligibleAfter})
    `;
  });

  // Re-exposure with post_result_feedback — upsert should update, not insert
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${ctx.keyPointId}, ${exposureFingerprint}, 'post_result_feedback', NOW(), NOW(), ${secondEligibleAfter})
      ON CONFLICT (workspace_id, user_id, key_point_id, exposure_fingerprint)
      DO UPDATE SET
        last_exposure_kind = EXCLUDED.last_exposure_kind,
        last_exposed_at = EXCLUDED.last_exposed_at,
        unassisted_eligible_after = GREATEST(validation_assistance_exposures.unassisted_eligible_after, EXCLUDED.unassisted_eligible_after)
    `;
  });

  // Verify only one row exists, with the LATER eligible_after
  const [row] = await sql`
    SELECT last_exposure_kind, unassisted_eligible_after
    FROM validation_assistance_exposures
    WHERE workspace_id = ${ctx.workspaceId}
      AND user_id = ${ctx.userId}
      AND key_point_id = ${ctx.keyPointId}
      AND exposure_fingerprint = ${exposureFingerprint}
  `;
  assert.ok(row, "Exposure row should exist");
  assert.equal(row?.last_exposure_kind, "post_result_feedback", "last_exposure_kind should be updated");
  // GREATEST should pick the later (48h) eligible_after
  const dbEligibleAfter = new Date(row!.unassisted_eligible_after).getTime();
  assert.ok(
    Math.abs(dbEligibleAfter - secondEligibleAfter.getTime()) < 5000,
    "unassisted_eligible_after should be the later (48h) value",
  );

  // Cleanup
  await sql.begin(async (tx) => {
    await cleanupWorkspace(tx, ctx.workspaceId, ctx.userId);
  });
});
