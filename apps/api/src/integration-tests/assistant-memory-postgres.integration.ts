/**
 * P8 记忆 + Orchestrator 接线集成测试（真实 postgres）。
 *
 * 覆盖：记忆 upsert（sourceEventId 去重）→ confirm（候选→确认）→ softDelete
 * （审计保留 + canonical 解耦）→ list（默认不含候选）；Run 结算触发
 * proactive deliver（Policy allowed → system_event 入队 dedupe）。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/assistant-memory-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  upsertMemory,
  confirmMemory,
  deleteMemory,
  listMemories,
} = await import("../modules/companion-conversation/memory-service.ts");
const { deliver } = await import("../modules/companion-conversation/delivery-service.ts");
const { submitArtifact } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);

after(async () => {
  await sql.end({ timeout: 2 });
  await closeStructuredSolutionSql();
  await closeDatabase();
});

async function seed() {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

test("P8 记忆：upsert 去重 → confirm → softDelete → list 不含候选/已删", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    const item = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "goal",
        content: "希望先掌握遗忘曲线",
        sourceEventId: "goal:1",
        userStated: true,
        candidate: false,
      }, now),
    );
    assert.equal(item.userStated, true);
    // 同 sourceEventId upsert → 更新不新建。
    const again = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "goal",
        content: "希望先掌握遗忘曲线（更新）",
        sourceEventId: "goal:1",
        userStated: true,
      }, now),
    );
    assert.equal(again.memoryItemId, item.memoryItemId);
    let countN = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_memory_items WHERE workspace_id = ${seeded.workspaceId}`;
      countN = rows[0].n;
    });
    assert.equal(countN, 1, "sourceEventId 去重");

    // 候选记忆：list 默认不含。
    const candidate = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "learning_context",
        content: "模型推断的候选上下文",
        sourceEventId: "evt:2",
        candidate: true,
      }, now),
    );
    const withoutCandidates = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.equal(withoutCandidates.some((m) => m.memoryItemId === candidate.memoryItemId), false);
    // confirm → 参与 list。
    const confirmed = await withWorkspaceTransaction(scope, (tx) =>
      confirmMemory(tx, scope, candidate.memoryItemId, now),
    );
    assert.ok(confirmed);
    assert.equal(confirmed.userConfirmed, true);
    const withCandidates = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.ok(withCandidates.some((m) => m.memoryItemId === candidate.memoryItemId));

    // softDelete：审计保留（deletedAt 非空）+ list 不含。
    const deleted = await withWorkspaceTransaction(scope, (tx) =>
      deleteMemory(tx, scope, item.memoryItemId, now),
    );
    assert.equal(deleted, true);
    const afterDelete = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.equal(afterDelete.some((m) => m.memoryItemId === item.memoryItemId), false);
    let tombstoneDeletedAt: string | null = null;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT deleted_at FROM assistant_memory_items WHERE id = ${item.memoryItemId}`;
      tombstoneDeletedAt = rows[0]?.deleted_at ?? null;
    });
    assert.ok(tombstoneDeletedAt, "soft delete 保留审计");
  } finally {
    await seeded.cleanup();
  }
});

test("E15：记忆删除不影响 canonical 事实；对话删除保留 inbox 历史", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 记忆 + canonical 事实（declared_unable Run 结算）并存。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "e15-create-1",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "e15-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`e15-worker:${randomUUID()}`, 10);
    }
    // FORCE RLS 表裸查：同事务 context（set_config is_local=true：事务结束
    // 自动恢复，不污染连接池）。
    let canonicalBeforeCount = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}`;
      canonicalBeforeCount = rows[0].n;
    });
    assert.equal(canonicalBeforeCount, 1);

    // 删除记忆（soft delete）：canonical 事实保持不变（解耦）。
    const item = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "interaction_note",
        content: "关于该 Run 的记忆",
        sourceEventId: "run.completed:" + run.runId,
        candidate: false,
      }, now),
    );
    await withWorkspaceTransaction(scope, (tx) => deleteMemory(tx, scope, item.memoryItemId, now));
    let canonicalAfterCount = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}`;
      canonicalAfterCount = rows[0].n;
    });
    assert.equal(canonicalAfterCount, 1, "记忆删除不影响 canonical 学习事实");

    // 对话删除（保留 inbox 历史语义）：FORCE RLS 表——set_config 必须在所有
    // 裸 SQL 之前且同事务。
    const sessionId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status, next_message_seq, next_event_seq, next_generation, summary_version)
               VALUES (${sessionId}, ${seeded.workspaceId}, ${seeded.userId}, 'journey', '测试', 'placeholder', 'active', 1, 1, 1, 0)`;
    });
    await withWorkspaceTransaction(scope, (tx) =>
      deliver(tx, scope, {
        assistantSessionId: sessionId,
        kind: "system_event",
        payloadRef: { kind: "system_event", systemEventId: "e15-evt" },
        dedupeKey: "e15-delivery",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now),
    );
    let deliveryCountBefore = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
      deliveryCountBefore = rows[0].n;
    });
    assert.ok(deliveryCountBefore >= 1);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`DELETE FROM companion_conversations WHERE id = ${sessionId}`;
      const deliveryAfter = await tx`SELECT assistant_session_id FROM assistant_deliveries WHERE dedupe_key = 'e15-delivery'`;
      assert.ok(deliveryAfter.length >= 1, "delivery 保留（会话删除不破坏 inbox 历史）");
    });
  } finally {
    await seeded.cleanup();
  }
});

test("P8 Orchestrator：Run 结算触发 proactive deliver（Policy allowed + dedupe）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "mm-run-create-1",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "mm-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`mm-worker:${randomUUID()}`, 10);
    }
    // Policy（online/moderate 默认）允许 → system_event 入队。
    let deliveryRows: { kind: string; state: string; dedupe_key: string }[] = [];
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      deliveryRows = await tx`SELECT kind, state, dedupe_key FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
    });
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].kind, "system_event");
    assert.equal(deliveryRows[0].state, "queued");
    assert.equal(deliveryRows[0].dedupe_key, `run.completed:${run.runId}`);
    // 重复 tick：dedupe 不新增。
    for (let round = 0; round < 2; round += 1) {
      await runLearningRunProcessingTick(`mm-worker:${randomUUID()}`, 10);
    }
    let afterRetickN = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
      afterRetickN = rows[0].n;
    });
    assert.equal(afterRetickN, 1, "dedupe 不重复入队");
  } finally {
    await seeded.cleanup();
  }
});
