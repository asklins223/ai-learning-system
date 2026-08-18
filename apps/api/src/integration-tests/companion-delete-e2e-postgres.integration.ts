/**
 * §24.5 E15/E16 服务端等价集成测试。
 *
 * E15：删除对话（正文/消息物理清除 + 审计留痕）与删除记忆（soft delete，
 * canonical 学习事实不受影响）。
 * E16：global off（账号级关闭桌宠）不取消 active LearningRun——Run 继续
 * 独立完成（§9.5：globalEnabled=false 不生成 proactive delivery，运行中的
 * Run 继续；只有显式 runtime kill 才产生 cancelled）。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-delete-e2e-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRun } = await import("../modules/learning-runs/run-service.ts");
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);
const { deleteCompanionConversation, ensureCompanionInbox } = await import(
  "../modules/companion-conversation/companion-conversations-service.ts"
);
const { upsertMemory, listMemories, deleteMemory } = await import(
  "../modules/companion-conversation/memory-service.ts"
);
const { updateCompanionAccountState } = await import("../modules/companion-shell/service.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeStructuredSolutionSql();
  await closeDatabase();
});

async function seedIdentity() {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "复习间隔决定长期记忆",
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

test("E15：删除对话与记忆——正文物理清除、审计留痕、学习事实不受影响", async () => {
  const seeded = await seedIdentity();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    // 会话 + 消息（ensureCompanionInbox 返回 HTTP 形状 {statusCode, body}）。
    const conv = await ensureCompanionInbox(scope);
    const conversationId = (conv.body as { id?: string }).id ?? "";
    assert.ok(conversationId, "inbox conversationId");
    // RLS 上下文：set_config 同事务后插入消息。
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
      await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
               VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.userId}, ${conversationId}, 1, 'user', 'text',
                       '[{"kind":"text","text":"删除测试正文"}]'::jsonb, 'h1', now())`;
    });
    // 记忆。
    await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, { kind: "goal", content: "长期目标：掌握间隔重复", userStated: true, candidate: false }),
    );
    const memoriesBefore = await withWorkspaceTransaction(scope, (tx) => listMemories(tx, scope, {}));
    assert.equal(memoriesBefore.length, 1);

    // 删除会话 → 消息/会话物理清除。
    const result = await withWorkspaceTransaction(scope, () =>
      deleteCompanionConversation({ ...scope, conversationId }),
    );
    assert.ok(result.statusCode === 200 || result.statusCode === 204);
    const msgRows = await sql`
      SELECT count(*)::int AS n FROM companion_messages WHERE conversation_id = ${conversationId}
    `;
    assert.equal(msgRows[0].n, 0, "消息正文物理清除");
    const convRows = await sql`SELECT count(*)::int AS n FROM companion_conversations WHERE id = ${conversationId}`;
    assert.equal(convRows[0].n, 0, "会话物理清除");

    // 删除记忆 → 列表为空；审计 tombstone（deleted_at）保留。
    await withWorkspaceTransaction(scope, (tx) => deleteMemory(tx, scope, memoriesBefore[0].memoryItemId));
    const memoriesAfter = await withWorkspaceTransaction(scope, (tx) => listMemories(tx, scope, {}));
    assert.equal(memoriesAfter.length, 0, "删除后记忆不可见");
    const tombstoneRows = await sql`
      SELECT count(*)::int AS n FROM assistant_memory_items WHERE id = ${memoriesBefore[0].memoryItemId} AND deleted_at IS NOT NULL
    `;
    assert.equal(tombstoneRows[0].n, 1, "最小审计留痕保留");

    // canonical 学习事实不受影响（本测试无 run；断言同 workspace 无残留关联行）。
    const runRows = await sql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${seeded.workspaceId}`;
    assert.equal(runRows[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

test("E16：global off 不取消 active LearningRun——Run 独立完成（0 cancelled）", async () => {
  const seeded = await seedIdentity();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "stabilize",
          clientRequestId: "e16-1",
          idempotencyKey: "e16-create-1",
        },
      }),
    );
    assert.equal(run.phase, "active");

    // 账号级关闭桌宠（globalEnabled=false）——只关闭伴星，不取消 Run。
    await updateCompanionAccountState(seeded.userId, seeded.workspaceId, {
      revision: 0,
      globalEnabled: false,
    });
    const runAfter = await sql`SELECT phase FROM learning_runs WHERE id = ${run.runId}`;
    assert.equal(runAfter[0].phase, "active", "global off 不取消 Run");

    // Run 继续独立完成（declared_unable 确定性结算）。
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      (await import("../modules/learning-runs/run-service.ts")).submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "e16-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`e16-worker:${randomUUID()}`, 10);
    }
    const settled = await sql`SELECT phase FROM learning_runs WHERE id = ${run.runId}`;
    assert.equal(settled[0].phase, "completed", "Run 在 global off 下独立完成");
    const cancelledEvents = await sql`
      SELECT count(*)::int AS n FROM learning_run_events
      WHERE run_id = ${run.runId} AND event_type = 'learning_run.cancelled'
    `;
    assert.equal(cancelledEvents[0].n, 0, "global off 绝不产生 cancelled");
  } finally {
    await seeded.cleanup();
  }
});
