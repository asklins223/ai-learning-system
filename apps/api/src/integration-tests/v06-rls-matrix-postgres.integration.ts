/**
 * v0.6 RLS 多 workspace/多 user 矩阵集成测试 (计划 §13.2, §10.7, M1 Gate)
 *
 * 计划 §4.1 安全不变量：
 *   "0 次跨 workspace/user 题目、回答、rubric、assessment 或复习历史泄漏"
 *
 * 测试矩阵覆盖：
 *   - 同 workspace 不同 user 的数据隔离（user-private RLS）
 *   - 跨 workspace 的数据隔离（workspace-level RLS）
 *   - 所有 v0.6 新表的 RLS policy 覆盖验证
 *   - current_setting('app.user_id') / current_setting('app.workspace_id') 切换
 *
 * 环境变量:
 *   V06_RLS_ADMIN_DATABASE_URL — 隔离测试库的迁移/fixture 管理连接
 *   V06_RLS_TEST_DATABASE_URL  — 同一数据库的非 superuser、非 BYPASSRLS
 *                                运行时连接（例如 ailearn_api）
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";

const databaseUrl = process.env.V06_RLS_TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.V06_RLS_ADMIN_DATABASE_URL;
if (!databaseUrl || !adminDatabaseUrl) {
  throw new Error(
    "V06_RLS_ADMIN_DATABASE_URL and V06_RLS_TEST_DATABASE_URL are required "
      + "for the v0.6 RLS matrix integration test",
  );
}

const sql = postgres(adminDatabaseUrl, { max: 6 });
const rlsSql = postgres(databaseUrl, { max: 6 });

test.before(async () => {
  const [[adminIdentity], [runtimeIdentity]] = await Promise.all([
    sql<{ database_name: string }[]>`
      SELECT current_database() AS database_name
    `,
    rlsSql<{
      database_name: string;
      current_user: string;
      is_superuser: boolean;
      bypass_rls: boolean;
      can_read_v06: boolean;
      can_read_card_sets: boolean;
    }[]>`
      SELECT
        current_database() AS database_name,
        current_user::text AS current_user,
        role.rolsuper AS is_superuser,
        role.rolbypassrls AS bypass_rls,
        has_table_privilege(
          current_user,
          'public.validation_submissions',
          'SELECT'
        ) AS can_read_v06,
        has_table_privilege(
          current_user,
          'public.learning_card_sets',
          'SELECT'
        ) AS can_read_card_sets
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `,
  ]);
  assert.equal(runtimeIdentity?.database_name, adminIdentity?.database_name);
  assert.equal(runtimeIdentity?.is_superuser, false);
  assert.equal(runtimeIdentity?.bypass_rls, false);
  assert.equal(
    runtimeIdentity?.can_read_v06,
    true,
    `${runtimeIdentity?.current_user ?? "runtime role"} needs v0.6 table grants`,
  );
  assert.equal(
    runtimeIdentity?.can_read_card_sets,
    true,
    `${runtimeIdentity?.current_user ?? "runtime role"} needs learning-card set grants`,
  );
});

test.after(async () => {
  await Promise.allSettled([
    sql.end({ timeout: 5 }),
    rlsSql.end({ timeout: 5 }),
  ]);
});

// ─── v0.6 user-private tables (RLS on user_id) ────────────────────────────

// Documented table lists — referenced via void to suppress TS6133
const USER_PRIVATE_TABLES = [
  { table: "validation_submissions", userCol: "user_id" },
  { table: "validation_action_commands", userCol: "user_id" },
  { table: "validation_assistance_exposures", userCol: "user_id" },
  { table: "validation_point_assessments", userCol: "user_id" },
  { table: "scheduling_shadow_decisions", userCol: "user_id" },
  { table: "validation_quality_signals", userCol: "user_id" },
] as const;

// ─── v0.6 workspace-level tables (RLS on workspace_id) ────────────────────

const WORKSPACE_TABLES = [
  { table: "validation_question_rubric_items", wsCol: "workspace_id" },
  { table: "learning_card_sets", wsCol: "workspace_id" },
] as const;

// Reference documentation arrays to satisfy noUnusedLocals
void USER_PRIVATE_TABLES;
void WORKSPACE_TABLES;

// ─── Seed helpers ─────────────────────────────────────────────────────────

async function seedUser(
  tx: TransactionSql,
  email: string,
): Promise<string> {
  const userId = randomUUID();
  await tx`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${email}, 'test-hash', 'owner')
  `;
  return userId;
}

async function seedWorkspace(
  tx: TransactionSql,
  name: string,
  ownerId: string,
): Promise<string> {
  const wsId = randomUUID();
  await tx`
    INSERT INTO workspaces (id, name, owner_id)
    VALUES (${wsId}, ${name}, ${ownerId})
  `;
  await tx`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${wsId}, ${ownerId}, 'owner')
  `;
  return wsId;
}

async function seedCardAndKeyPoint(
  tx: TransactionSql,
  wsId: string,
  userId: string,
): Promise<{
  cardId: string;
  keyPointId: string;
  noteId: string;
  noteVersionId: string;
  evidenceId: string;
}> {
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const blockId = randomUUID();
  const evidenceId = randomUUID();

  await tx`
    INSERT INTO notes (id, workspace_id, title, created_by)
    VALUES (${noteId}, ${wsId}, 'Test Note', ${userId})
  `;
  await tx`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${noteVersionId}, ${noteId}, ${wsId}, 1, ${tx.json({ blocks: [] })}, ${`hash-${noteVersionId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}
  `;
  await tx`
    INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json)
    VALUES (${cardId}, ${wsId}, ${noteVersionId}, 'active', ${tx.json({ title: "Test Card", summary: "Test" })})
  `;
  await tx`
    INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
    VALUES (${blockId}, ${noteVersionId}, ${wsId}, 0, 'paragraph', 'Test block')
  `;
  await tx`
    INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
    VALUES (${keyPointId}, ${cardId}, ${wsId}, 0, 'Test claim', 'Test quote')
  `;
  await tx`
    INSERT INTO evidences (id, workspace_id, key_point_id, block_id, block_ordinal, quote_text, alignment, alignment_score, alignment_method)
    VALUES (${evidenceId}, ${wsId}, ${keyPointId}, ${blockId}, 0, 'Test evidence', 'aligned', 90, 'fuzzy')
  `;
  return { cardId, keyPointId, noteId, noteVersionId, evidenceId };
}

async function seedLearningCardSet(
  tx: TransactionSql,
  wsId: string,
  noteId: string,
  noteVersionId: string,
): Promise<{ runId: string; cardSetId: string }> {
  const runId = randomUUID();
  const cardSetId = randomUUID();
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
      asset_manifest_hash
    )
    VALUES (
      ${runId},
      ${wsId},
      ${noteId},
      ${noteVersionId},
      ${`rls-idem-${runId}`},
      ${`rls-fingerprint-${runId}`},
      1,
      'RLS card set',
      'source-hash',
      'block-hash',
      'asset-hash'
    )
  `;
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
    VALUES (
      ${cardSetId},
      ${wsId},
      ${noteId},
      ${noteVersionId},
      ${runId},
      'RLS card set',
      'Workspace-private set'
    )
  `;
  return { runId, cardSetId };
}

async function seedQuestion(
  tx: TransactionSql,
  wsId: string,
  userId: string,
  cardId: string,
  keyPointId: string,
  noteVersionId: string,
): Promise<{ questionId: string; rubricItemId: string }> {
  const questionId = randomUUID();
  await tx`
    INSERT INTO validation_questions (id, workspace_id, card_id, key_point_id, note_version_id, question_type, question, created_by, user_id, status, generator_kind, source_fingerprint, rubric_version, expires_at)
    VALUES (${questionId}, ${wsId}, ${cardId}, ${keyPointId}, ${noteVersionId}, 'explain', 'Test Q?', ${userId}, ${userId}, 'active', 'ai', ${`fp-${questionId.slice(0, 8)}`}, 'rubric-v1', NOW() + INTERVAL '30 days')
  `;
  const rubricItemId = randomUUID();
  await tx`
    INSERT INTO validation_question_rubric_items (id, workspace_id, question_id, ordinal, criterion, expected_concept, weight, required, evidence_id)
    VALUES (${rubricItemId}, ${wsId}, ${questionId}, 0, 'Test criterion', 'Test expected', 1, true, NULL)
  `;
  return { questionId, rubricItemId };
}

async function seedSubmission(
  tx: TransactionSql,
  wsId: string,
  userId: string,
  cardId: string,
  keyPointId: string,
  questionId: string,
  status = "ready",
): Promise<string> {
  const submissionId = randomUUID();
  await tx`
    INSERT INTO validation_submissions (id, workspace_id, user_id, card_id, key_point_id, question_id, context, status, start_idempotency_key, source_fingerprint, user_answer)
    VALUES (${submissionId}, ${wsId}, ${userId}, ${cardId}, ${keyPointId}, ${questionId}, 'initial_validation', ${status}, ${`idem-${submissionId.slice(0, 8)}`}, ${`fp-${submissionId.slice(0, 8)}`}, 'My secret answer')
  `;
  return submissionId;
}

async function seedValidationEvent(
  tx: TransactionSql,
  wsId: string,
  userId: string,
  cardId: string,
  keyPointId: string,
): Promise<string> {
  const eventId = randomUUID();
  await tx`
    INSERT INTO validation_events (
      id, workspace_id, user_id, card_id, key_point_id,
      question, question_type, user_answer, outcome, confidence, feedback
    )
    VALUES (
      ${eventId}, ${wsId}, ${userId}, ${cardId}, ${keyPointId},
      'Test question?', 'explain', 'Test answer',
      'preliminary_understanding', 85, ${tx.json({ summary: "Good" })}
    )
  `;
  return eventId;
}

async function cleanupAll(tx: TransactionSql, wsIds: string[], userIds: string[]) {
  for (const wsId of wsIds) {
    await tx`DELETE FROM validation_quality_signals WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM scheduling_shadow_decisions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_point_assessments WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_assistance_exposures WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_action_commands WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_submission_jobs WHERE submission_id IN (SELECT id FROM validation_submissions WHERE workspace_id = ${wsId})`;
    await tx`DELETE FROM validation_submissions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_question_rubric_items WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_questions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM validation_events WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM review_attempts WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM review_schedules WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM evidences WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM card_key_points WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM card_generation_runs WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM learning_cards WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_versions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM notes WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM workspaces WHERE id = ${wsId}`;
  }
  for (const userId of userIds) {
    await tx`DELETE FROM users WHERE id = ${userId}`;
  }
}

// ─── Helper: Run a query with the same transaction-local GUCs as runtime ───

async function withRlsContext<T>(
  context: { workspaceId?: string; userId?: string },
  operation: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return rlsSql.begin(async (tx) => {
    if (context.workspaceId !== undefined) {
      await tx`
        SELECT set_config('app.workspace_id', ${context.workspaceId}, true)
      `;
    }
    if (context.userId !== undefined) {
      await tx`
        SELECT set_config('app.user_id', ${context.userId}, true)
      `;
    }
    return operation(tx);
  }) as Promise<T>;
}

// ─── Tests ────────────────────────────────────────────────────────────────

test("v0.6 RLS: RLS is enabled on all v0.6 new tables", async () => {
  const newTables = [
    "validation_question_rubric_items",
    "validation_submissions",
    "validation_submission_jobs",
    "validation_action_commands",
    "validation_assistance_exposures",
    "validation_point_assessments",
    "scheduling_shadow_decisions",
    "validation_quality_signals",
    "learning_card_sets",
  ];

  for (const table of newTables) {
    const [row] = await sql`
      SELECT relrowsecurity FROM pg_class WHERE relname = ${table}
    `;
    assert.ok(
      row?.relrowsecurity,
      `RLS should be enabled on ${table}`,
    );
  }
});

test("v0.6 RLS: user-private tables enforce user_id isolation — same workspace, different users cannot see each other's data", async () => {
  // Setup: Two users in the same workspace
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `userA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `userB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-rls-1", userA);
    // Add userB as member
    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${wsId}, ${userB}, 'member')
    `;
    const card = await seedCardAndKeyPoint(tx, wsId, userA);
    const q = await seedQuestion(tx, wsId, userA, card.cardId, card.keyPointId, card.noteVersionId);
    // UserA creates a submission with a secret answer
    const subA = await seedSubmission(tx, wsId, userA, card.cardId, card.keyPointId, q.questionId, "completed");
    // UserB creates a submission with a different secret answer
    const subB = await seedSubmission(tx, wsId, userB, card.cardId, card.keyPointId, q.questionId, "completed");
    return { userA, userB, wsId, card, q, subA, subB };
  });

  try {
    const userASubs = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ id: string; user_id: string; user_answer: string | null }[]>`
        SELECT id, user_id, user_answer
        FROM validation_submissions
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(userASubs.length, 1, "UserA should see only their own submission");
    assert.equal(userASubs[0].user_id, ctx.userA, "UserA's submission should be their own");
    assert.equal(userASubs[0].user_answer, "My secret answer", "UserA should see their own answer");
    assert.notEqual(userASubs[0].id, ctx.subB, "UserA should NOT see UserB's submission");

    const userBSubs = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ id: string; user_id: string; user_answer: string | null }[]>`
        SELECT id, user_id, user_answer
        FROM validation_submissions
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(userBSubs.length, 1, "UserB should see only their own submission");
    assert.equal(userBSubs[0].user_id, ctx.userB, "UserB's submission should be their own");
    assert.notEqual(userBSubs[0].id, ctx.subA, "UserB should NOT see UserA's submission");
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: cross-workspace isolation — users in different workspaces cannot see each other's data", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `wsA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `wsB-${randomUUID().slice(0, 8)}@test.com`);
    const wsA = await seedWorkspace(tx, "workspace-A", userA);
    const wsB = await seedWorkspace(tx, "workspace-B", userB);
    const cardA = await seedCardAndKeyPoint(tx, wsA, userA);
    const cardB = await seedCardAndKeyPoint(tx, wsB, userB);
    const qA = await seedQuestion(tx, wsA, userA, cardA.cardId, cardA.keyPointId, cardA.noteVersionId);
    const qB = await seedQuestion(tx, wsB, userB, cardB.cardId, cardB.keyPointId, cardB.noteVersionId);
    const subA = await seedSubmission(tx, wsA, userA, cardA.cardId, cardA.keyPointId, qA.questionId, "completed");
    const subB = await seedSubmission(tx, wsB, userB, cardB.cardId, cardB.keyPointId, qB.questionId, "completed");
    return { userA, userB, wsA, wsB, cardA, cardB, qA, qB, subA, subB };
  });

  try {
    const subs = await withRlsContext(
      { workspaceId: ctx.wsA, userId: ctx.userA },
      (tx) => tx<{ id: string; workspace_id: string }[]>`
        SELECT id, workspace_id FROM validation_submissions
      `,
    );
    assert.deepEqual(subs.map((sub) => sub.id), [ctx.subA]);
    for (const sub of subs) {
      assert.notEqual(sub.workspace_id, ctx.wsB, "UserA should NOT see workspace B's submissions");
    }
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsA, ctx.wsB], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: validation_action_commands enforce user_id isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `cmdA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `cmdB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-cmd", userA);
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userB}, 'member')`;

    // UserA creates an action command
    await tx`
      INSERT INTO validation_action_commands (workspace_id, user_id, action, idempotency_key, request_hash, response_status)
      VALUES (${wsId}, ${userA}, 'start', ${`key-A-${randomUUID().slice(0, 8)}`}, 'hashA', 'success')
    `;
    // UserB creates an action command
    await tx`
      INSERT INTO validation_action_commands (workspace_id, user_id, action, idempotency_key, request_hash, response_status)
      VALUES (${wsId}, ${userB}, 'start', ${`key-B-${randomUUID().slice(0, 8)}`}, 'hashB', 'success')
    `;
    return { userA, userB, wsId };
  });

  try {
    const cmdsA = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ user_id: string }[]>`
        SELECT user_id
        FROM validation_action_commands
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(cmdsA.length, 1, "UserA should see only their own action command");
    assert.equal(cmdsA[0].user_id, ctx.userA);

    const cmdsB = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ user_id: string }[]>`
        SELECT user_id
        FROM validation_action_commands
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(cmdsB.length, 1, "UserB should see only their own action command");
    assert.equal(cmdsB[0].user_id, ctx.userB);
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: validation_assistance_exposures enforce user_id isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `expA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `expB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-exp", userA);
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userB}, 'member')`;
    const card = await seedCardAndKeyPoint(tx, wsId, userA);

    // UserA creates an exposure
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${wsId}, ${userA}, ${card.keyPointId}, ${`fp-A-${randomUUID().slice(0, 8)}`}, 'pre_submit_source', NOW(), NOW(), NOW() + INTERVAL '24 hours')
    `;
    // UserB creates an exposure for the same key point
    await tx`
      INSERT INTO validation_assistance_exposures (workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after)
      VALUES (${wsId}, ${userB}, ${card.keyPointId}, ${`fp-B-${randomUUID().slice(0, 8)}`}, 'post_result_feedback', NOW(), NOW(), NOW() + INTERVAL '48 hours')
    `;
    return { userA, userB, wsId, keyPointId: card.keyPointId };
  });

  try {
    const expA = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ user_id: string; last_exposure_kind: string }[]>`
        SELECT user_id, last_exposure_kind
        FROM validation_assistance_exposures
        WHERE key_point_id = ${ctx.keyPointId}
      `,
    );
    assert.equal(expA.length, 1, "UserA should see only their own exposure");
    assert.equal(expA[0].user_id, ctx.userA);

    const expB = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ user_id: string; last_exposure_kind: string }[]>`
        SELECT user_id, last_exposure_kind
        FROM validation_assistance_exposures
        WHERE key_point_id = ${ctx.keyPointId}
      `,
    );
    assert.equal(expB.length, 1, "UserB should see only their own exposure");
    assert.equal(expB[0].user_id, ctx.userB);
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: validation_point_assessments enforce user_id isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `paA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `paB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-pa", userA);
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userB}, 'member')`;
    const card = await seedCardAndKeyPoint(tx, wsId, userA);
    const q = await seedQuestion(tx, wsId, userA, card.cardId, card.keyPointId, card.noteVersionId);
    const subA = await seedSubmission(tx, wsId, userA, card.cardId, card.keyPointId, q.questionId, "completed");
    const subB = await seedSubmission(tx, wsId, userB, card.cardId, card.keyPointId, q.questionId, "completed");

    // Create assessments for both users
    await tx`
      INSERT INTO validation_point_assessments (workspace_id, user_id, submission_id, rubric_item_id, verdict, assessment_source, confidence, rationale)
      VALUES (${wsId}, ${userA}, ${subA}, ${q.rubricItemId}, 'covered', 'ai', 90, 'Good answer from A')
    `;
    await tx`
      INSERT INTO validation_point_assessments (workspace_id, user_id, submission_id, rubric_item_id, verdict, assessment_source, confidence, rationale)
      VALUES (${wsId}, ${userB}, ${subB}, ${q.rubricItemId}, 'missing', 'ai', 0, 'Bad answer from B')
    `;
    return { userA, userB, wsId, subA, subB, rubricItemId: q.rubricItemId };
  });

  try {
    const assessA = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ user_id: string; rationale: string }[]>`
        SELECT user_id, rationale
        FROM validation_point_assessments
        WHERE rubric_item_id = ${ctx.rubricItemId}
      `,
    );
    assert.equal(assessA.length, 1, "UserA should see only their own assessment");
    assert.equal(assessA[0].user_id, ctx.userA);
    assert.equal(assessA[0].rationale, "Good answer from A");

    const assessB = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ user_id: string; rationale: string }[]>`
        SELECT user_id, rationale
        FROM validation_point_assessments
        WHERE rubric_item_id = ${ctx.rubricItemId}
      `,
    );
    assert.equal(assessB.length, 1, "UserB should see only their own assessment");
    assert.equal(assessB[0].user_id, ctx.userB);
    assert.equal(assessB[0].rationale, "Bad answer from B");
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: scheduling_shadow_decisions enforce user_id isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `sdA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `sdB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-sd", userA);
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userB}, 'member')`;
    const card = await seedCardAndKeyPoint(tx, wsId, userA);
    const sourceIdA = randomUUID();
    const sourceIdB = randomUUID();

    await tx`
      INSERT INTO scheduling_shadow_decisions (workspace_id, user_id, key_point_id, source_type, source_id, algorithm, algorithm_version, parameters_version, predicted_due_at)
      VALUES (${wsId}, ${userA}, ${card.keyPointId}, 'validation_event', ${sourceIdA}, 'fsrs', '4.6.0', 'v1', NOW() + INTERVAL '3 days')
    `;
    await tx`
      INSERT INTO scheduling_shadow_decisions (workspace_id, user_id, key_point_id, source_type, source_id, algorithm, algorithm_version, parameters_version, predicted_due_at)
      VALUES (${wsId}, ${userB}, ${card.keyPointId}, 'validation_event', ${sourceIdB}, 'fsrs', '4.6.0', 'v1', NOW() + INTERVAL '7 days')
    `;
    return { userA, userB, wsId, keyPointId: card.keyPointId, sourceIdA, sourceIdB };
  });

  try {
    const sdA = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ user_id: string; source_id: string }[]>`
        SELECT user_id, source_id
        FROM scheduling_shadow_decisions
        WHERE key_point_id = ${ctx.keyPointId}
      `,
    );
    assert.equal(sdA.length, 1, "UserA should see only their own shadow decision");
    assert.equal(sdA[0].source_id, ctx.sourceIdA);

    const sdB = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ user_id: string; source_id: string }[]>`
        SELECT user_id, source_id
        FROM scheduling_shadow_decisions
        WHERE key_point_id = ${ctx.keyPointId}
      `,
    );
    assert.equal(sdB.length, 1, "UserB should see only their own shadow decision");
    assert.equal(sdB[0].source_id, ctx.sourceIdB);
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: validation_quality_signals enforce user_id isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `qsA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `qsB-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-qs", userA);
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userB}, 'member')`;
    const card = await seedCardAndKeyPoint(tx, wsId, userA);
    const eventA = await seedValidationEvent(tx, wsId, userA, card.cardId, card.keyPointId);
    const eventB = await seedValidationEvent(tx, wsId, userB, card.cardId, card.keyPointId);

    await tx`
      INSERT INTO validation_quality_signals (workspace_id, user_id, validation_event_id, reason, comment)
      VALUES (${wsId}, ${userA}, ${eventA}, 'question_bad', 'A says question is bad')
    `;
    await tx`
      INSERT INTO validation_quality_signals (workspace_id, user_id, validation_event_id, reason, comment)
      VALUES (${wsId}, ${userB}, ${eventB}, 'too_strict', 'B says rubric is too strict')
    `;
    return { userA, userB, wsId, eventA, eventB };
  });

  try {
    const qsA = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userA },
      (tx) => tx<{ user_id: string; comment: string }[]>`
        SELECT user_id, comment
        FROM validation_quality_signals
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(qsA.length, 1, "UserA should see only their own quality signal");
    assert.equal(qsA[0].comment, "A says question is bad");

    const qsB = await withRlsContext(
      { workspaceId: ctx.wsId, userId: ctx.userB },
      (tx) => tx<{ user_id: string; comment: string }[]>`
        SELECT user_id, comment
        FROM validation_quality_signals
        WHERE workspace_id = ${ctx.wsId}
      `,
    );
    assert.equal(qsB.length, 1, "UserB should see only their own quality signal");
    assert.equal(qsB[0].comment, "B says rubric is too strict");
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: validation_question_rubric_items enforce workspace-level isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `riA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `riB-${randomUUID().slice(0, 8)}@test.com`);
    const wsA = await seedWorkspace(tx, "ws-rubric-A", userA);
    const wsB = await seedWorkspace(tx, "ws-rubric-B", userB);
    const cardA = await seedCardAndKeyPoint(tx, wsA, userA);
    const cardB = await seedCardAndKeyPoint(tx, wsB, userB);
    const qA = await seedQuestion(tx, wsA, userA, cardA.cardId, cardA.keyPointId, cardA.noteVersionId);
    const qB = await seedQuestion(tx, wsB, userB, cardB.cardId, cardB.keyPointId, cardB.noteVersionId);
    return { userA, userB, wsA, wsB, qA, qB };
  });

  try {
    const riA = await withRlsContext(
      { workspaceId: ctx.wsA, userId: ctx.userA },
      (tx) => tx<{ workspace_id: string; expected_concept: string }[]>`
        SELECT workspace_id, expected_concept
        FROM validation_question_rubric_items
      `,
    );
    assert.ok(riA.length > 0, "Workspace A should see its rubric items");
    for (const ri of riA) {
      assert.equal(ri.workspace_id, ctx.wsA, "UserA should only see workspace A's rubric items");
    }

    const riB = await withRlsContext(
      { workspaceId: ctx.wsB, userId: ctx.userB },
      (tx) => tx<{ workspace_id: string; expected_concept: string }[]>`
        SELECT workspace_id, expected_concept
        FROM validation_question_rubric_items
      `,
    );
    assert.ok(riB.length > 0, "Workspace B should see its rubric items");
    for (const ri of riB) {
      assert.equal(ri.workspace_id, ctx.wsB, "UserB should only see workspace B's rubric items");
    }
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsA, ctx.wsB], [ctx.userA, ctx.userB]);
    });
  }
});

test("M6 RLS: learning_card_sets enforce workspace-level isolation", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `setA-${randomUUID().slice(0, 8)}@test.com`);
    const userB = await seedUser(tx, `setB-${randomUUID().slice(0, 8)}@test.com`);
    const wsA = await seedWorkspace(tx, "ws-card-set-A", userA);
    const wsB = await seedWorkspace(tx, "ws-card-set-B", userB);
    const cardA = await seedCardAndKeyPoint(tx, wsA, userA);
    const cardB = await seedCardAndKeyPoint(tx, wsB, userB);
    const setA = await seedLearningCardSet(
      tx,
      wsA,
      cardA.noteId,
      cardA.noteVersionId,
    );
    const setB = await seedLearningCardSet(
      tx,
      wsB,
      cardB.noteId,
      cardB.noteVersionId,
    );
    return { userA, userB, wsA, wsB, setA, setB };
  });

  try {
    const visibleToA = await withRlsContext(
      { workspaceId: ctx.wsA, userId: ctx.userA },
      (tx) => tx<{ id: string; workspace_id: string }[]>`
        SELECT id, workspace_id
        FROM learning_card_sets
      `,
    );
    assert.deepEqual(
      visibleToA.map((row) => ({ id: row.id, workspace_id: row.workspace_id })),
      [{
        id: ctx.setA.cardSetId,
        workspace_id: ctx.wsA,
      }],
    );

    const visibleToB = await withRlsContext(
      { workspaceId: ctx.wsB, userId: ctx.userB },
      (tx) => tx<{ id: string; workspace_id: string }[]>`
        SELECT id, workspace_id
        FROM learning_card_sets
      `,
    );
    assert.deepEqual(
      visibleToB.map((row) => ({ id: row.id, workspace_id: row.workspace_id })),
      [{
        id: ctx.setB.cardSetId,
        workspace_id: ctx.wsB,
      }],
    );
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsA, ctx.wsB], [ctx.userA, ctx.userB]);
    });
  }
});

test("v0.6 RLS: RLS policies exist on all v0.6 new tables", async () => {
  const expectedPolicies = [
    { table: "validation_submissions", policy: "val_submissions_user_isolation" },
    { table: "validation_action_commands", policy: "val_action_cmd_user_isolation" },
    { table: "validation_assistance_exposures", policy: "val_assist_exp_user_isolation" },
    { table: "validation_point_assessments", policy: "val_point_assess_user_isolation" },
    { table: "scheduling_shadow_decisions", policy: "sched_shadow_user_isolation" },
    { table: "validation_quality_signals", policy: "val_quality_sig_user_isolation" },
    { table: "validation_question_rubric_items", policy: "vq_rubric_items_workspace_isolation" },
    { table: "validation_submission_jobs", policy: "val_sub_jobs_workspace_isolation" },
    { table: "learning_card_sets", policy: "learning_card_sets_workspace_isolation" },
  ];

  for (const { table, policy } of expectedPolicies) {
    const [row] = await sql`
      SELECT policyname FROM pg_policies WHERE tablename = ${table} AND policyname = ${policy}
    `;
    assert.ok(row, `Policy ${policy} should exist on table ${table}`);
  }
});

test("v0.6 RLS: without app.user_id set, user-private tables return zero rows", async () => {
  const ctx = await sql.begin(async (tx) => {
    const userA = await seedUser(tx, `nouser-${randomUUID().slice(0, 8)}@test.com`);
    const wsId = await seedWorkspace(tx, "test-ws-nouser", userA);
    const card = await seedCardAndKeyPoint(tx, wsId, userA);
    const q = await seedQuestion(tx, wsId, userA, card.cardId, card.keyPointId, card.noteVersionId);
    await seedSubmission(tx, wsId, userA, card.cardId, card.keyPointId, q.questionId, "completed");
    return { userA, wsId };
  });

  try {
    const results = await rlsSql`
      SELECT id FROM validation_submissions WHERE workspace_id = ${ctx.wsId}
    `;
    assert.equal(results.length, 0, "Without app.user_id, no rows should be visible");
  } finally {
    await sql.begin(async (tx) => {
      await cleanupAll(tx, [ctx.wsId], [ctx.userA]);
    });
  }
});
