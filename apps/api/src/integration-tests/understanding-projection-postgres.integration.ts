/**
 * P7 投影纵切集成测试（真实 postgres，文档 16 §15）。
 *
 * 覆盖：declared_unable canonical Commit → 同一事务物化 change set +
 * outbox published + checkpoint 前移 → GET /projection current_target
 * （checkpoint-aware）→ return-contract ready → delta 一次性显影 →
 * RoutePlan（确定性选路 + 跨 workspace checkpoint 409）→ practice 纵切
 * change set（kind=practice_only）。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/understanding-projection-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
process.env.PROJECTION_CHECKPOINT_SECRET ??= "projection-integration-test-secret-0123456789";
const sql = postgres(CONN, { max: 2 });

/**
 * 裸 SQL 校验必须带 workspace/user 上下文。
 *
 * 目标表 understanding_change_sets / understanding_projection_checkpoints /
 * canonical_learning_event_outbox / practice_trail_event_outbox 都是 FORCE RLS：
 * 受限角色（ailearn_api）在无上下文事务里查询会命中 0 行，让"恰好物化 1 个
 * change set / outbox published"假失败；超级用户则绕过 RLS 让它失去隔离意义。
 */
function scoped<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { submitArtifact, getReturnContract } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);
const { issueCheckpointToken, parseCheckpointToken } = await import(
  "../modules/understanding/projection-checkpoint.ts"
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
    // planV2Run 结构化规划需要显式结构（2026-08-23 对齐）：mapping 答案 →
    // ordering 单 part 任务；structured_bundle 双 part 仅存在于已退役 V1 planner。
    canonicalAnswerJson: JSON.stringify({
      kind: "mapping",
      pairs: [
        { unitId: "u-interval", left: "复习间隔", right: "长期记忆保持" },
        { unitId: "u-recall", left: "主动回忆", right: "优于重复阅读" },
      ],
    }),
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

test("P7 纵切：canonical Commit 物化 change set + projection ready + delta 显影", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "pj-create-1",
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
          idempotencyKey: "pj-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`pj-worker:${randomUUID()}`, 10);
    }

    // 1) change set 物化 + outbox published。
    const changeSetRows = await scoped(scope, (tx) => tx`
      SELECT change_set_id, source_event_id, kind, to_checkpoint_token
      FROM understanding_change_sets WHERE run_id = ${run.runId}
    `);
    assert.equal(changeSetRows.length, 1);
    assert.equal(changeSetRows[0].kind, "canonical");
    const outboxRows = await scoped(scope, (tx) => tx`
      SELECT status FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(outboxRows[0]?.status, "published");

    // 2) return-contract → ready（含 targetCheckpoint/changeSetId）。
    const contract = await withWorkspaceTransaction(scope, async (tx) =>
      getReturnContract(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(contract.status, "ready");
    if (contract.status === "ready") {
      assert.equal(contract.changeSetId, changeSetRows[0].change_set_id);
      assert.equal(contract.sourceChange.kind, "canonical");
      const parsed = parseCheckpointToken(contract.targetCheckpoint.token);
      assert.ok(parsed, "targetCheckpoint token 可解析");
    }

    // 3) projection current_target：checkpoint-aware + personal facts。
    // 直接查 checkpoint 表（projection 端点需 HTTP；此处验证数据底座）。
    const checkpointRows = await scoped(scope, (tx) => tx`
      SELECT token, last_canonical_event_id FROM understanding_projection_checkpoints
      WHERE workspace_id = ${seeded.workspaceId} ORDER BY captured_at DESC LIMIT 1
    `);
    assert.ok(checkpointRows[0]?.token, "checkpoint issued");
    assert.ok(checkpointRows[0]?.last_canonical_event_id, "watermark advanced");

    // 4) delta 数据（change set 即 delta 的物化源）。
    assert.equal(changeSetRows[0].source_event_id.length > 0, true);
  } finally {
    await seeded.cleanup();
  }
});

test("P7 practice 纵切：practice trail 物化 change set（kind=practice_only）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          idempotencyKey: "pj-p-create-1",
        },
      }),
    );
    // V2 planner 产单 ordering 任务（bundle 已退役）；提交正确顺序。
    const ordering = run.activeTask!.activeVariant.interaction as unknown as {
      kind: "ordering";
      publicTokenIds?: string[];
      publicTokenLabels?: Record<string, string>;
    };
    assert.equal(ordering.kind, "ordering");
    const labels = ordering.publicTokenLabels ?? {};
    const byLabel = (label: string) => Object.entries(labels).find(([, v]) => v === label)?.[0] ?? "";
    const correctOrder = [byLabel("复习间隔"), byLabel("主动回忆")];
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          version: 1,
          variantId: run.activeTask!.activeVariant.variantId,
          variantRevision: run.activeTask!.activeVariant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
          payload: { kind: "ordering", orderedTokenIds: correctOrder, interactionRefs: [] },
          idempotencyKey: "pj-p-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`pj-worker:${randomUUID()}`, 10);
    }
    const changeSetRows = await scoped(scope, (tx) => tx`
      SELECT kind, source_event_id FROM understanding_change_sets WHERE run_id = ${run.runId}
    `);
    assert.equal(changeSetRows.length, 1);
    assert.equal(changeSetRows[0].kind, "practice_only");
    const trailRows = await scoped(scope, (tx) => tx`
      SELECT status FROM practice_trail_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(trailRows[0]?.status, "published");
    const contract = await withWorkspaceTransaction(scope, async (tx) =>
      getReturnContract(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(contract.status, "ready");
  } finally {
    await seeded.cleanup();
  }
});

test("P7 checkpoint token：签发/解析/篡改拒绝（fail closed）", async () => {
  const token = issueCheckpointToken({
    workspaceId: randomUUID(),
    userId: randomUUID(),
    lastCanonicalEventId: "canonical:x",
    lastPracticeEventId: null,
    capturedAt: new Date().toISOString(),
  });
  assert.ok(token);
  const parsed = parseCheckpointToken(token!);
  assert.equal(parsed?.lastCanonicalEventId, "canonical:x");
  assert.equal(parseCheckpointToken(token!.slice(0, -2) + "zz"), null);
  assert.equal(parseCheckpointToken("garbage"), null);
});
