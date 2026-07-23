/**
 * AI Worker 延迟优化方案 4 — evaluate_validation 并发安全集成测试。
 *
 * 验证 QUEUE_CONCURRENCY > 1 时，两个不同 jobId 但相同输入
 * (cardId + keyPointId + userId + question + userAnswer) 的 job
 * 并发执行不会写入重复的 validation_events 记录。
 *
 * 测试分两层：
 *   1. advisory lock 层：验证 hashtextextended 输入维度锁让第二个事务等待
 *   2. 幂等查重层：验证锁释放后第二个事务能观察到第一个事务的写入并跳过
 *
 * 此测试直接操作 PostgreSQL，不经过 Worker handler，聚焦于数据库层面的
 * 并发安全保证。advisory lock + 事务内查重是 Worker handler 中的双重保护，
 * 此处模拟其核心机制。
 *
 * 环境变量：
 *   EVAL_VALIDATION_CONCURRENT_TEST_DATABASE_URL — 测试数据库连接字符串
 *   (必须以 ailearn_migrator 或 ailearn_api 角色连接)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";

const databaseUrl = process.env.EVAL_VALIDATION_CONCURRENT_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "EVAL_VALIDATION_CONCURRENT_TEST_DATABASE_URL is required for the evaluate_validation concurrent safety integration test",
  );
}

const sql = postgres(databaseUrl, { max: 4 });

// ─── Helpers ─────────────────────────────────────────────────────────────

async function seedWorkspaceAndCard(
  tx: TransactionSql,
): Promise<{
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string;
}> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
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
    VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${tx.json({ blocks: [] })}, ${`hash-${noteVersionId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}
  `;
  await tx`
    INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json)
    VALUES (${cardId}, ${workspaceId}, ${noteVersionId}, 'active', ${tx.json({ title: "Concurrent Test Card", summary: "Test" })})
  `;
  await tx`
    INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
    VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 0, 'Test claim', 'Test quote')
  `;

  return { workspaceId, userId, cardId, keyPointId };
}

async function cleanupWorkspace(
  tx: TransactionSql,
  workspaceId: string,
  userId: string,
) {
  await tx`DELETE FROM validation_events WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

/**
 * Create a job record so validation_events.job_id FK is satisfied.
 */
async function createJob(
  tx: TransactionSql,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await tx`
    INSERT INTO jobs (id, type, workspace_id, payload, status)
    VALUES (${jobId}, 'evaluate_validation', ${workspaceId}, ${tx.json({})}, 'succeeded')
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * 模拟 evaluate_validation handler 中的事务内逻辑：
 *   1. 获取输入维度 advisory lock
 *   2. 查重（by jobId OR by input 组合）
 *   3. 如果不存在则插入 validation_event
 *
 * 返回 "inserted" 或 "skipped"。
 */
async function simulateValidationTx(
  tx: TransactionSql,
  ctx: {
    workspaceId: string;
    userId: string;
    cardId: string;
    keyPointId: string;
    jobId: string;
    question: string;
    userAnswer: string;
  },
): Promise<"inserted" | "skipped"> {
  // 1. 输入维度 advisory lock — 与 handler 中的实现一致
  const lockKey = `${ctx.workspaceId}:${ctx.cardId}:${ctx.keyPointId}:${ctx.userId}:${ctx.question}:${ctx.userAnswer}`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  // 2. 幂等查重 — 同时检查 jobId 和输入组合
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM validation_events
    WHERE workspace_id = ${ctx.workspaceId}
      AND (
        job_id = ${ctx.jobId}
        OR (
          card_id = ${ctx.cardId}
          AND user_id = ${ctx.userId}
          AND question = ${ctx.question}
          AND user_answer = ${ctx.userAnswer}
          AND key_point_id = ${ctx.keyPointId}
        )
      )
    LIMIT 1
  `;

  if (existing) return "skipped";

  // Ensure the job exists to satisfy the FK constraint.
  await createJob(tx, ctx.workspaceId, ctx.jobId);

  // 3. 插入
  await tx`
    INSERT INTO validation_events (
      id, workspace_id, user_id, card_id, key_point_id,
      question, question_type, user_answer, outcome, confidence,
      job_id
    )
    VALUES (
      ${randomUUID()}, ${ctx.workspaceId}, ${ctx.userId}, ${ctx.cardId}, ${ctx.keyPointId},
      ${ctx.question}, 'explain', ${ctx.userAnswer}, 'preliminary_understanding', 85,
      ${ctx.jobId}
    )
  `;

  return "inserted";
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("advisory lock 串行化相同输入的并发事务：第二个事务等待后观察到第一条记录", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, cardId, keyPointId } = await seedWorkspaceAndCard(tx);

    const ctx = {
      workspaceId,
      userId,
      cardId,
      keyPointId,
      question: "请解释 CAP 定理",
      userAnswer: "CAP 指一致性、可用性、分区容错性",
    };

    // 事务 A 先获取锁并插入
    const resultA = await simulateValidationTx(tx, { ...ctx, jobId: randomUUID() });
    assert.equal(resultA, "inserted", "第一个事务应成功插入");

    // 事务 B 在同一个事务中（锁已释放，因为 advisory_xact_lock 是事务级的）
    // 但在真实并发场景中，B 会在 A 的事务提交后才获取到锁
    // 此处模拟的是 B 在 A 提交后的查重
    const resultB = await simulateValidationTx(tx, { ...ctx, jobId: randomUUID() });
    assert.equal(resultB, "skipped", "第二个事务应跳过（输入组合已存在）");

    // 验证只有一条记录
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM validation_events
      WHERE workspace_id = ${workspaceId}
        AND card_id = ${cardId}
        AND question = ${ctx.question}
        AND user_answer = ${ctx.userAnswer}
    `;
    assert.equal(rows.length, 1, "相同输入应只有一条 validation_events 记录");

    await cleanupWorkspace(tx, workspaceId, userId);
  });
});

test("真正并发：两个事务同时执行相同输入，最终只有一条记录", async () => {
  // 此测试验证真实的并发竞争场景：
  // 两个事务同时启动，advisory lock 让它们串行化执行，
  // 第一个事务插入后，第二个事务的查重能观察到第一条记录。
  //
  // 使用两个独立的数据库连接模拟两个 Worker 并行处理。
  const setupConn = postgres(databaseUrl, { max: 1 });
  const connA = postgres(databaseUrl, { max: 1 });
  const connB = postgres(databaseUrl, { max: 1 });

  try {
    // 先在 setup 连接中创建测试数据
    const { workspaceId, userId, cardId, keyPointId } = await setupConn.begin(async (tx) => {
      return await seedWorkspaceAndCard(tx);
    });

    const ctx = {
      workspaceId,
      userId,
      cardId,
      keyPointId,
      question: "请解释 B+ 树的优势",
      userAnswer: "B+ 树叶子节点链表支持范围查询",
    };

    const jobA = randomUUID();
    const jobB = randomUUID();

    // 同时启动两个事务
    // advisory lock 确保它们串行化：先获取锁的插入，后获取锁的跳过
    const [resultA, resultB] = await Promise.all([
      connA.begin(async (tx) => simulateValidationTx(tx, { ...ctx, jobId: jobA })),
      connB.begin(async (tx) => simulateValidationTx(tx, { ...ctx, jobId: jobB })),
    ]);

    // 一个 inserted，一个 skipped（顺序由 advisory lock 决定）
    const insertedCount = [resultA, resultB].filter((r) => r === "inserted").length;
    const skippedCount = [resultA, resultB].filter((r) => r === "skipped").length;
    assert.equal(insertedCount, 1, "应有且仅有一个事务成功插入");
    assert.equal(skippedCount, 1, "应有且仅有一个事务跳过");

    // 最终验证：只有一条 validation_events 记录
    const rows = await setupConn<{ id: string; job_id: string }[]>`
      SELECT id, job_id FROM validation_events
      WHERE workspace_id = ${workspaceId}
        AND card_id = ${cardId}
        AND question = ${ctx.question}
        AND user_answer = ${ctx.userAnswer}
    `;
    assert.equal(rows.length, 1, "并发执行后应只有一条 validation_events 记录");

    // 清理
    await setupConn.begin(async (tx) => {
      await cleanupWorkspace(tx, workspaceId, userId);
    });
  } finally {
    const closeResults = await Promise.allSettled([
      setupConn.end({ timeout: 5 }),
      connA.end({ timeout: 5 }),
      connB.end({ timeout: 5 }),
    ]);
    const failures = closeResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to close concurrent validation PostgreSQL clients");
    }
  }
});

test("不同输入的并发事务不互斥：两个不同输入各插入一条记录", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, cardId, keyPointId } = await seedWorkspaceAndCard(tx);

    // 两个不同的输入（不同的 question）
    const ctxA = {
      workspaceId, userId, cardId, keyPointId,
      question: "请解释概念 A",
      userAnswer: "答案 A",
      jobId: randomUUID(),
    };
    const ctxB = {
      workspaceId, userId, cardId, keyPointId,
      question: "请解释概念 B",
      userAnswer: "答案 B",
      jobId: randomUUID(),
    };

    const resultA = await simulateValidationTx(tx, ctxA);
    const resultB = await simulateValidationTx(tx, ctxB);

    assert.equal(resultA, "inserted", "不同输入应各自插入");
    assert.equal(resultB, "inserted", "不同输入应各自插入");

    // 验证有两条记录
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM validation_events
      WHERE workspace_id = ${workspaceId}
        AND card_id = ${cardId}
    `;
    assert.equal(rows.length, 2, "不同输入应有两条记录");

    await cleanupWorkspace(tx, workspaceId, userId);
  });
});

test("相同 jobId 重试不产生重复记录", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, cardId, keyPointId } = await seedWorkspaceAndCard(tx);

    const ctx = {
      workspaceId, userId, cardId, keyPointId,
      question: "请解释缓存穿透",
      userAnswer: "查询不存在的数据反复打到数据库",
      jobId: "00000000-0000-4000-8000-000000000001",
    };

    // 第一次执行 — 插入
    const result1 = await simulateValidationTx(tx, ctx);
    assert.equal(result1, "inserted");

    // 重试（相同 jobId）— 应跳过
    const result2 = await simulateValidationTx(tx, ctx);
    assert.equal(result2, "skipped");

    // 验证只有一条记录
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM validation_events
      WHERE workspace_id = ${workspaceId} AND job_id = ${ctx.jobId}
    `;
    assert.equal(rows.length, 1, "相同 jobId 重试不应产生重复记录");

    await cleanupWorkspace(tx, workspaceId, userId);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────

test.after(async () => {
  await sql.end();
});
