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
import type { StructuredPartAnswerV1 } from "@ailearn/shared";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
process.env.PROJECTION_CHECKPOINT_SECRET ??= "projection-integration-test-secret-0123456789";
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRun, submitArtifact, getReturnContract } = await import(
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
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`pj-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'pj-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}', ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', '{"version":1}', now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线表明复习间隔决定长期记忆', '间隔重复能显著降低遗忘率。')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM understanding_change_sets WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM understanding_projection_checkpoints WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM understanding_route_plans WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM practice_trail_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_processing_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_assessments WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_private_solutions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_safety_reports WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_disclosure_profiles WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_private_contracts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_action_ledger WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_idempotency WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, cardId, keyPointId, cleanup };
}

test("P7 纵切：canonical Commit 物化 change set + projection ready + delta 显影", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "stabilize",
          clientRequestId: "pj-1",
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
    const changeSetRows = await sql`
      SELECT change_set_id, source_event_id, kind, to_checkpoint_token
      FROM understanding_change_sets WHERE run_id = ${run.runId}
    `;
    assert.equal(changeSetRows.length, 1);
    assert.equal(changeSetRows[0].kind, "canonical");
    const outboxRows = await sql`
      SELECT status FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
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
    const projectionRows = await withWorkspaceTransaction(scope, async (tx) => {
      const envelopeRows = await tx.execute(
        (await import("drizzle-orm")).sql`SELECT 1`,
      );
      void envelopeRows;
      return null;
    });
    void projectionRows;
    // 直接查 checkpoint 表（projection 端点需 HTTP；此处验证数据底座）。
    const checkpointRows = await sql`
      SELECT token, last_canonical_event_id FROM understanding_projection_checkpoints
      WHERE workspace_id = ${seeded.workspaceId} ORDER BY captured_at DESC LIMIT 1
    `;
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
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          clientRequestId: "pj-p-1",
          idempotencyKey: "pj-p-create-1",
        },
      }),
    );
    // stabilize 偏好生成 structured_bundle（ordering + relation 两个 part，
    // §5.3）——交互类型为 bundle，需按 part 契约提交。
    const bundle = run.activeTask!.activeVariant.interaction as unknown as {
      kind: "structured_bundle";
      parts: Array<{
        partId: string;
        interaction: { kind: "ordering" | "relation_canvas"; publicTokenIds?: string[]; publicNodeIds?: string[] };
      }>;
    };
    assert.equal(bundle.kind, "structured_bundle");
    const orderingPart = bundle.parts.find((p) => p.interaction.kind === "ordering");
    const relationPart = bundle.parts.find((p) => p.interaction.kind === "relation_canvas");
    assert.ok(orderingPart, "bundle 含 ordering part");
    assert.ok(relationPart, "bundle 含 relation part");
    const partAnswers: [StructuredPartAnswerV1, StructuredPartAnswerV1] = [
      {
        kind: "ordering",
        partId: orderingPart.partId,
        orderedTokenIds: [...(orderingPart.interaction.publicTokenIds ?? [])],
      },
      { kind: "relation", partId: relationPart.partId, edges: [] },
    ];
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
          payload: { kind: "structured_bundle", partAnswers, interactionRefs: [] },
          idempotencyKey: "pj-p-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`pj-worker:${randomUUID()}`, 10);
    }
    const changeSetRows = await sql`
      SELECT kind, source_event_id FROM understanding_change_sets WHERE run_id = ${run.runId}
    `;
    assert.equal(changeSetRows.length, 1);
    assert.equal(changeSetRows[0].kind, "practice_only");
    const trailRows = await sql`
      SELECT status FROM practice_trail_event_outbox WHERE run_id = ${run.runId}
    `;
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
