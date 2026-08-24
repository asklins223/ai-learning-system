/**
 * LearningRun 纵切 DB 集成测试（真实 postgres，文档 16 §22.2 P2 Gate 的一部分）。
 *
 * 纵切：card origin 创建 Run（active/standby 双 Variant + private contract +
 * 事件）→ declared_unable 原子提交（lock + queued + outbox）→ processing
 * tick（确定性评估 → commit → schedule 恰好一个 successor + 恰好一个
 * canonical envelope + result）→ 幂等重放（创建/提交）→ text 提交在 Critic
 * 未配置时 fail closed 到 not_assessable checkpoint（0 canonical/schedule）。
 *
 * V1 夹具已退役：seed() 使用 V2 fixture 助手创建 learning_objectives_v2 +
 * learning_cards_v2，createRun 的 V1 薄壳将 keyPointId 映射为 objectiveId。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-runs-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  getLearningRunResultResponseV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  reviewQueueV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
// db client 读取 DATABASE_URL_API；未设置时与 CONN 同源（本地 dev 默认）。
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

// Critic 未配置：确保 fail closed 分支可复现。
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;
process.env.LEARNING_RUN_V1 ??= "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  createRun,
  createRunV2,
  submitArtifact,
  getRunPublicView,
  getLearningRunPublicSnapshotV2,
  getResultPayload,
  getResultPayloadV2,
  getReturnContractV2,
  applyAction,
  getEventsAfter,
} = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

interface Seeded {
  workspaceId: string;
  userId: string;
  cardId: string;
  /** V2 objectiveId（V1 keyPointId alias；createRun V1 薄壳映射二者一致）。 */
  keyPointId: string;
  token: string;
  cleanup: () => Promise<void>;
}

async function seed(): Promise<Seeded> {
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
    token: fixture.token,
    cleanup: fixture.cleanup,
  };
}

async function buildLearningRunApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const sensible = (await import("@fastify/sensible")).default;
  await app.register(sensible);
  const { learningRunRoutes } = await import("../modules/learning-runs/run-routes.ts");
  const { reviewRoutes } = await import("../modules/review/routes.ts");
  await app.register(reviewRoutes);
  await app.register(learningRunRoutes);
  return app;
}

test("P2 纵切：card 创建 → declared_unable 提交 → tick 评估+Commit → schedule+envelope", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };

    // 1) 创建 Run（card origin）。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 120,
          clientRequestId: "it-1",
          idempotencyKey: "it-create-1",
        },
      }),
    );
    assert.equal(run.phase, "active");
    assert.equal(run.timeBudgetSeconds, 120);
    assert.equal(run.target.keyPointId, seeded.keyPointId);
    assert.equal(run.taskSummaries.length, 1);
    assert.ok(run.activeTask, "active task present");
    assert.equal(run.activeTask.activeVariant.interaction.kind, "text_response");
    assert.equal(run.activeTask.availableAlternatives.length, 1);
    assert.equal(run.activeTask.availableAlternatives[0].family, "voice");
    assert.equal(run.eventCursor, 4); // created/prepared/started/presented
    assert.equal(
      run.schedulePolicySummary.kind,
      "create_on_canonical_outcome",
      "首次验证应获得 create_initial 授权",
    );

    // 2) 幂等重放创建：同 key 同 runId。
    const replayed = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 120,
          clientRequestId: "it-1",
          idempotencyKey: "it-create-1",
        },
      }),
    );
    assert.equal(replayed.runId, run.runId);

    // 3) declared_unable 提交（原子 lock + queued + outbox）。
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    const receipt = await withWorkspaceTransaction(scope, async (tx) =>
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
          idempotencyKey: "it-submit-1",
        },
      }),
    ) as {
      artifactId: string;
      artifactStatus: string;
      assessment: { assessmentId: string; status: string };
      runRevision: number;
      taskRevision: number;
      eventCursor: number;
    };
    assert.equal(receipt.artifactStatus, "locked");
    assert.equal(receipt.assessment.status, "queued");

    // 4) processing tick：确定性评估 → commit → schedule + envelope + result。
    // assessment_requested 处理过程中新入队 commit_requested，需多轮 tick 直至终态。
    let afterRunPhase = "";
    for (let round = 0; round < 6; round += 1) {
      const tickResult = await runLearningRunProcessingTick(`it-worker:${randomUUID()}`, 10);
      assert.ok(tickResult.failed === 0, `tick failed=${tickResult.failed}`);
      const probe = await withWorkspaceTransaction(scope, async (tx) =>
        getRunPublicView(tx, { ...scope, runId: run.runId }),
      );
      afterRunPhase = probe.phase;
      if (probe.phase === "completed" || probe.phase === "checkpoint") break;
    }
    assert.equal(afterRunPhase, "completed");

    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    assert.equal(afterRun.result?.outcome, "declared_unable");
    assert.equal(afterRun.result.scheduleImpact.kind, "created");
    assert.equal(afterRun.result.scheduleImpact.policyReason, "declared_unable");

    // 5) schedule：恰好一个 pending successor（短间隔）。
    const schedRows = await sql`
      SELECT id, generation, interval_days, reason_code FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId}
        AND subject_id = ${seeded.keyPointId} AND status = 'pending'
    `;
    assert.equal(schedRows.length, 1);
    assert.equal(schedRows[0].generation, 1);
    assert.equal(schedRows[0].interval_days, 1);
    assert.equal(schedRows[0].reason_code, "canonical_unable");

    // 6) 恰好一个 canonical envelope（unique commitId/canonicalEventId）。
    const envelopeRows = await sql`
      SELECT envelope FROM canonical_learning_event_outbox
      WHERE workspace_id = ${seeded.workspaceId} AND run_id = ${run.runId}
    `;
    assert.equal(envelopeRows.length, 1);
    const envelope = envelopeRows[0].envelope as { fact?: { kind?: string } };
    assert.equal(envelope.fact?.kind, "canonical_unable");

    // 7) result 端点语义。
    const result = await withWorkspaceTransaction(scope, async (tx) =>
      getResultPayload(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(result.status, "learning_result");

    // 8) 重复 tick：0 副作用（outbox 已 processed，envelope 仍恰好一个）。
    const tick2 = await runLearningRunProcessingTick(`it-worker:${randomUUID()}`, 10);
    assert.ok(tick2.failed === 0);
    const envelopeRows2 = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox
      WHERE workspace_id = ${seeded.workspaceId} AND run_id = ${run.runId}
    `;
    assert.equal(envelopeRows2[0].n, 1);
  } finally {
    await seeded.cleanup();
  }
});

test("P2 fail closed：text 提交 + Critic 未配置 → not_assessable checkpoint（0 canonical/schedule）", async () => {
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
          clientRequestId: "it-2",
          idempotencyKey: "it-create-2",
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
          payload: { kind: "text", text: "因为间隔复习可以对抗遗忘曲线。" },
          idempotencyKey: "it-submit-2",
        },
      }),
    );
    const tickResult = await runLearningRunProcessingTick(`it-worker:${randomUUID()}`, 10);
    assert.ok(tickResult.failed === 0, `tick failed=${tickResult.failed}`);

    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    // Critic 未配置 → fail closed：checkpoint(not_assessable)，不猜结果。
    assert.equal(afterRun.phase, "checkpoint");
    assert.equal(afterRun.checkpoint?.kind, "not_assessable");
    assert.equal(afterRun.activeAssessment?.status, "not_assessable");
    assert.ok(afterRun.activeAssessment?.reportHash, "fail-closed 报告必须有 hash");

    // 0 canonical / 0 schedule 副作用。
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND subject_id = ${seeded.keyPointId}
    `;
    assert.equal(schedCount[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

test("E08：请求提示后提交 text → Critic 未配置 fail closed → not_assessable checkpoint（0 canonical/0 schedule）", async () => {
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
          clientRequestId: "e08-1",
          idempotencyKey: "e08-create-1",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;

    // 请求提示（先写 exposure）。
    const { applyAction } = await import("../modules/learning-runs/run-service.ts");
    const afterHint = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: run.revision,
        runtimeEpoch: run.runtimeEpoch,
        action: { kind: "request_hint", level: 1 },
        idempotencyKey: "e08-hint-1",
      }),
    );
    assert.equal(afterHint.actionResult, "hint_revealed");

    // 提交 text（Critic 未配置——E08 路径不依赖 Critic，直接 practice）。
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: afterHint.snapshot.revision,
          taskRevision: afterHint.snapshot.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "text", text: "看了提示后的回答。" },
          idempotencyKey: "e08-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`e08-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    // 2026-08-23 语义对齐（审查发现）：text 提交在 submitArtifact 一律入队
    // assessment_critic（run-service.ts:2090 无 hint 旁路），Critic 未配置时按
    // 方案 16 冻结的 "Assessment fail closed" 结算为 not_assessable checkpoint
    // （绝不猜"掌握"）。本测试原期望 text+hint 走确定性 practice_completed，
    // 与现行合同不符——确定性 practice 路径仅存在于 structured 提交。
    // 不变量保持不变：0 canonical / 0 schedule / 不产生掌握证据。
    assert.equal(afterRun.phase, "checkpoint");
    assert.deepEqual(afterRun.checkpoint, {
      kind: "not_assessable",
      allowedFollowupIds: ["supplement:1"],
    });
    assert.equal(afterRun.result, null, "not_assessable 不产生 result");
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 0, "E08 提示暴露 0 canonical");
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0, "E08 提示暴露 0 schedule");
  } finally {
    await seeded.cleanup();
  }
});

test("E09：assessing 阶段 end(abandon) → epoch 前移 → 迟到评估无副作用", async () => {
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
          clientRequestId: "e09-1",
          idempotencyKey: "e09-create-1",
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
          idempotencyKey: "e09-submit-1",
        },
      }),
    );
    // assessing 阶段 end(abandonLockedEvidence=true)：epoch 前移。
    const { applyAction } = await import("../modules/learning-runs/run-service.ts");
    const ended = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: run.revision + 1,
        runtimeEpoch: run.runtimeEpoch,
        action: { kind: "end", abandonLockedEvidence: true },
        idempotencyKey: "e09-end-1",
      }),
    );
    assert.equal(ended.snapshot.phase, "ended");
    assert.ok(ended.snapshot.runtimeEpoch > run.runtimeEpoch, "epoch 前移");

    // 迟到评估（tick 处理）：epoch 失配 → 不写结果、不 commit。
    for (let round = 0; round < 3; round += 1) {
      await runLearningRunProcessingTick(`e09-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "ended");
    assert.equal(afterRun.result, null, "迟到评估无结果");
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 0, "E09 迟到 Commit 0 canonical");
  } finally {
    await seeded.cleanup();
  }
});

test("P2 幂等：submission 同 idempotencyKey 重放返回同一 receipt，不重复 lock", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "clarify",
          clientRequestId: "it-3",
          idempotencyKey: "it-create-3",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    const input = {
      ...scope,
      runId: run.runId,
      taskId,
      request: {
        version: 1 as const,
        variantId: variant.variantId,
        variantRevision: variant.revision,
        runRevision: run.revision,
        taskRevision: run.activeTask!.revision,
        inputSchemaHash: variant.inputSchemaHash,
        payload: { kind: "text" as const, text: "第一次提交。" },
        idempotencyKey: "it-submit-3",
      },
    };
    const first = await withWorkspaceTransaction(scope, async (tx) => submitArtifact(tx, input)) as {
      artifactId: string;
      artifactStatus: string;
      assessment: { assessmentId: string; status: string };
      runRevision: number;
      taskRevision: number;
      eventCursor: number;
    };
    const second = await withWorkspaceTransaction(scope, async (tx) => submitArtifact(tx, input)) as typeof first;
    assert.equal(first.artifactId, second.artifactId, "重放必须返回同一 artifact");
    const artifactCount = await sql`
      SELECT count(*)::int AS n FROM learning_artifacts
      WHERE workspace_id = ${seeded.workspaceId} AND task_id = ${taskId} AND status = 'locked'
    `;
    assert.equal(artifactCount[0].n, 1, "重复提交不得重复锁定");
  } finally {
    await seeded.cleanup();
  }
});

test("P4 followup：partial checkpoint → activate_followup 激活补充任务 → 未授权拒绝", async () => {
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
          clientRequestId: "p4-followup-1",
          idempotencyKey: "p4-followup-create-1",
        },
      }),
    );
    // 构造 partial checkpoint（critic 判定 partial 后 tick 会这样写；此处
    // 直接验证 followup 状态机动作本身）。
    await sql`
      UPDATE learning_runs
      SET phase = 'checkpoint',
          checkpoint = '{"kind":"partial","allowedFollowupIds":["supplement:1"]}'::jsonb
      WHERE id = ${run.runId}
    `;

    // 未授权 followupId → 409 followup_not_authorized。
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) => applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: 1,
        runtimeEpoch: 0,
        action: { kind: "activate_followup", followupId: "bogus" },
        idempotencyKey: "p4-followup-bad",
      })),
      /未获授权/,
    );

    // 授权 followup → 激活补充 Task（sequence 2、intent repair、practice）。
    await withWorkspaceTransaction(scope, async (tx) => applyAction(tx, {
      ...scope,
      runId: run.runId,
      runRevision: 1,
      runtimeEpoch: 0,
      action: { kind: "activate_followup", followupId: "supplement:1" },
      idempotencyKey: "p4-followup-ok",
    }));
    const taskRows = await sql`
      SELECT id, intent, status FROM learning_tasks
      WHERE run_id = ${run.runId} ORDER BY sequence
    `;
    assert.equal(taskRows.length, 2, "核心 + 补充两个 task");
    assert.equal(taskRows[1].intent, "repair");
    assert.equal(taskRows[1].status, "active");
    const variantRows = await sql`
      SELECT purpose, template_trust_ceiling FROM learning_task_variants
      WHERE task_id = ${taskRows[1].id}
    `;
    assert.equal(variantRows.length, 1);
    assert.equal(variantRows[0].purpose, "practice");
    assert.equal(variantRows[0].template_trust_ceiling, "practice_only");
    const runRows = await sql`SELECT phase, active_task_id FROM learning_runs WHERE id = ${run.runId}`;
    assert.equal(runRows[0].phase, "active");
    assert.equal(runRows[0].active_task_id, taskRows[1].id);
  } finally {
    await seeded.cleanup();
  }
});

test("E04：review origin → consume_pending 授权 → declared_unable 提交 → 消费 schedule + 恰一 successor", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    // 预置 pending schedule（到期）供 review origin 消费。
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 7, 'discrete-v2', 'initial_validation', now(), now())
    `;

    // 1) review origin 创建（consume_pending 授权 + generation 校验）。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "review", scheduleId, keyPointId: seeded.keyPointId, scheduleGeneration: 7 },
          goal: "stabilize",
          clientRequestId: "e04-1",
          idempotencyKey: "e04-create-1",
        },
      }),
    );
    assert.equal(run.phase, "active");
    assert.equal(
      run.schedulePolicySummary.kind,
      "consume_on_canonical_outcome",
      "到期复习应获得 consume_pending 授权",
    );

    // 2) declared_unable 提交 → tick 确定性 unable Commit（消费 + 短间隔 successor）。
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
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
          idempotencyKey: "e04-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`e04-worker:${randomUUID()}`, 10);
    }

    // 3) 旧 schedule 被消费（非 pending）+ 恰好一个 successor。
    const oldSched = await sql`
      SELECT status FROM review_schedules WHERE id = ${scheduleId}
    `;
    assert.notEqual(oldSched[0].status, "pending", "旧 schedule 必须被消费");
    const successors = await sql`
      SELECT id FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId}
        AND id <> ${scheduleId}
        AND subject_id = ${seeded.keyPointId}
    `;
    assert.equal(successors.length, 1, "恰好一个 successor");

    // 4) 恰好一个 canonical envelope。
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 1);
  } finally {
    await seeded.cleanup();
  }
});

test("REVIEW-QUEUE-PROJECTION-01：真实 V2 queue identity 与 direct startability preconditions", async () => {
  const seeded = await seed();
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const dueScheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${dueScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 minute', 1, 12, 'discrete-v2', 'initial_validation', now(), now())
    `;

    const queueResponse = await app.inject({ method: "GET", url: "/reviews/v2/queue?limit=10", headers: auth });
    assert.equal(queueResponse.statusCode, 200, queueResponse.body);
    const queue = reviewQueueV2Schema.parse(queueResponse.json());
    const queued = queue.items.find((item) => item.scheduleId === dueScheduleId);
    assert.ok(queued, "due V2 schedule must be visible in strict queue");
    assert.equal(queued.reviewId, dueScheduleId);
    assert.equal(queued.objectiveId, seeded.keyPointId);
    assert.equal(queued.scheduleGeneration, 12);
    assert.deepEqual(queued.startability, { kind: "ready" });

    const startResponse = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: {
          kind: "review",
          scheduleId: queued.scheduleId,
          objectiveId: queued.objectiveId,
          scheduleGeneration: queued.scheduleGeneration,
        },
        goal: "stabilize",
        responsePreference: "text",
        idempotencyKey: `review-queue-start-${randomUUID()}`,
      },
    });
    assert.equal(startResponse.statusCode, 201, startResponse.body);
    const started = learningRunPublicSnapshotV2Schema.parse(startResponse.json());
    assert.deepEqual(started.originV2, {
      kind: "review",
      scheduleId: dueScheduleId,
      objectiveId: seeded.keyPointId,
      scheduleGeneration: 12,
    });

    const wrongObjectiveStart = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId: dueScheduleId, objectiveId: randomUUID(), scheduleGeneration: 12 },
        goal: "stabilize",
        idempotencyKey: `review-queue-wrong-objective-${randomUUID()}`,
      },
    });
    assert.equal(wrongObjectiveStart.statusCode, 409, wrongObjectiveStart.body);
    assert.equal(wrongObjectiveStart.json().error, "context_stale");

    const staleGenerationStart = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId: dueScheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 999 },
        goal: "stabilize",
        idempotencyKey: `review-queue-stale-generation-${randomUUID()}`,
      },
    });
    assert.equal(staleGenerationStart.statusCode, 409, staleGenerationStart.body);
    assert.equal(staleGenerationStart.json().error, "schedule_generation_changed");

    const futureScheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${futureScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() + interval '1 hour', 1, 13, 'discrete-v2', 'initial_validation', now(), now())
    `;
    const futureStart = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId: futureScheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 13 },
        goal: "stabilize",
        idempotencyKey: `review-queue-future-${randomUUID()}`,
      },
    });
    assert.equal(futureStart.statusCode, 409, futureStart.body);
    assert.equal(futureStart.json().error, "review_not_due");
    assert.equal(futureStart.json().blockedReason, "not_due");

    const cooldownScheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${cooldownScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 minute', 1, 14, 'discrete-v2', 'initial_validation', now(), now())
    `;
    await sql`
      INSERT INTO validation_assistance_exposures (id, workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after, input_schedule_id, created_at, updated_at)
      VALUES (${randomUUID()}, ${seeded.workspaceId}, ${seeded.userId}, ${seeded.keyPointId}, ${`review-cooldown-${randomUUID()}`}, 'pre_submit_source', now(), now(), now() + interval '1 hour', ${cooldownScheduleId}, now(), now())
    `;
    const cooldownStart = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId: cooldownScheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 14 },
        goal: "stabilize",
        idempotencyKey: `review-queue-cooldown-${randomUUID()}`,
      },
    });
    assert.equal(cooldownStart.statusCode, 409, cooldownStart.body);
    assert.equal(cooldownStart.json().error, "review_assistance_cooldown");
    assert.equal(cooldownStart.json().blockedReason, "cooldown");

    const runCount = await sql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${seeded.workspaceId}`;
    assert.equal(runCount[0].n, 1, "blocked direct starts must not create additional runs");
  } finally {
    await app.close();
    await seeded.cleanup();
  }
});

test("GS-01B：V2 review origin → public snapshot/result/return 全链绑定且 start 幂等", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 9, 'discrete-v2', 'initial_validation', now(), now())
    `;

    const request = {
      version: 2 as const,
      originV2: {
        kind: "review" as const,
        scheduleId,
        objectiveId: seeded.keyPointId,
        scheduleGeneration: 9,
      },
      goal: "stabilize" as const,
      requestedTimeBudgetSeconds: 120,
      responsePreference: "text" as const,
      idempotencyKey: "gs01b-v2-start-1",
    };

    const first = await withWorkspaceTransaction(scope, (tx) =>
      createRunV2(tx, { ...scope, request }),
    );
    const snapshot = await withWorkspaceTransaction(scope, (tx) =>
      getLearningRunPublicSnapshotV2(tx, { ...scope, runId: first.runId }),
    );

    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.runId, first.runId);
    assert.equal(snapshot.snapshotId, first.snapshotId);
    assert.deepEqual(snapshot.originV2, request.originV2);
    assert.deepEqual(snapshot.returnTargetV2, {
      kind: "review",
      scheduleId,
      objectiveId: seeded.keyPointId,
    });
    assert.equal(snapshot.target.objectiveId, seeded.keyPointId);
    assert.equal("canonicalAnswer" in snapshot.target, false);
    assert.equal("scoringRubric" in snapshot.target, false);

    const replay = await withWorkspaceTransaction(scope, (tx) =>
      createRunV2(tx, { ...scope, request }),
    );
    assert.equal(replay.runId, first.runId, "exact V2 start replay must return the same run");
    assert.equal(replay.snapshotId, first.snapshotId, "exact replay must retain snapshot binding");

    await assert.rejects(
      () => withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
        ...scope,
        request: { ...request, goal: "clarify" },
      })),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict",
    );

    await assert.rejects(
      () => withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
        ...scope,
        request: {
          ...request,
          originV2: { ...request.originV2, objectiveId: randomUUID() },
        },
      })),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict",
      "same idempotency key must conflict when the V2 objective binding changes",
    );

    await assert.rejects(
      () => withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
        ...scope,
        request: {
          ...request,
          originV2: { ...request.originV2, scheduleGeneration: request.originV2.scheduleGeneration + 1 },
        },
      })),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict",
      "same idempotency key must conflict when the V2 schedule generation changes",
    );

    const result = await withWorkspaceTransaction(scope, (tx) =>
      getResultPayloadV2(tx, { ...scope, runId: first.runId }),
    );
    assert.equal(result.status, "pending");
    assert.equal(result.runId, first.runId);
    assert.deepEqual(result.originV2, request.originV2);
    assert.deepEqual(result.returnTargetV2, snapshot.returnTargetV2);

    const returnContract = await withWorkspaceTransaction(scope, (tx) =>
      getReturnContractV2(tx, { ...scope, runId: first.runId }),
    );
    assert.equal(returnContract.status, "run_active");
    assert.equal(returnContract.runId, first.runId);
    assert.equal(returnContract.snapshotId, first.snapshotId);
    assert.deepEqual(returnContract.originV2, request.originV2);
    assert.deepEqual(returnContract.returnTargetV2, snapshot.returnTargetV2);
  } finally {
    await seeded.cleanup();
  }
});

test("RUN-V2-START-IDEMPOTENCY-01：同 key 并发 V2 start 只产生一个 run", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 15, 'discrete-v2', 'initial_validation', now(), now())
    `;
    const request = {
      version: 2 as const,
      originV2: {
        kind: "review" as const,
        scheduleId,
        objectiveId: seeded.keyPointId,
        scheduleGeneration: 15,
      },
      goal: "stabilize" as const,
      requestedTimeBudgetSeconds: 120,
      responsePreference: "text" as const,
      idempotencyKey: `run-v2-overlap-${randomUUID()}`,
    };

    const results = await Promise.all([
      withWorkspaceTransaction(scope, (tx) => createRunV2(tx, { ...scope, request })),
      withWorkspaceTransaction(scope, (tx) => createRunV2(tx, { ...scope, request })),
    ]);
    assert.equal(results[0].runId, results[1].runId);
    assert.equal(results[0].snapshotId, results[1].snapshotId);

    const runCount = await sql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${seeded.workspaceId}`;
    const ledgerCount = await sql`
      SELECT count(*)::int AS n FROM learning_run_idempotency
      WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId} AND idempotency_key = ${request.idempotencyKey}
    `;
    assert.equal(runCount[0].n, 1, "overlap loser must not create a second run");
    assert.equal(ledgerCount[0].n, 1, "overlap must leave one idempotency ledger row");
  } finally {
    await seeded.cleanup();
  }
});

test("RUN-V2-WIRE-01：HTTP V2 draft/submit receipt → response-loss replay → worker result/return", async () => {
  const seeded = await seed();
  const app = await buildLearningRunApp();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const auth = { authorization: `Bearer ${seeded.token}` };
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 10, 'discrete-v2', 'initial_validation', now(), now())
    `;

    const startBody = {
      version: 2 as const,
      originV2: {
        kind: "review" as const,
        scheduleId,
        objectiveId: seeded.keyPointId,
        scheduleGeneration: 10,
      },
      goal: "stabilize" as const,
      requestedTimeBudgetSeconds: 120,
      responsePreference: "text" as const,
      idempotencyKey: `run-v2-wire-start-${randomUUID()}`,
    };
    const startResponse = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: startBody,
    });
    assert.equal(startResponse.statusCode, 201, startResponse.body);
    const startSnapshot = learningRunPublicSnapshotV2Schema.parse(startResponse.json());
    assert.deepEqual(startSnapshot.originV2, startBody.originV2);
    assert.equal(startSnapshot.returnTargetV2.kind, "review");
    assert.equal(startSnapshot.returnTargetV2.scheduleId, scheduleId);
    assert.ok(startSnapshot.activeTask, "V2 start must expose an active task");

    // Simulate a lost 201 response: replaying the exact HTTP command must
    // recover the same run/snapshot rather than creating an orphan run.
    const startReplayResponse = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: startBody,
    });
    assert.equal(startReplayResponse.statusCode, 201, startReplayResponse.body);
    const startReplaySnapshot = learningRunPublicSnapshotV2Schema.parse(startReplayResponse.json());
    assert.equal(startReplaySnapshot.runId, startSnapshot.runId);
    assert.equal(startReplaySnapshot.snapshotId, startSnapshot.snapshotId);
    assert.deepEqual(startReplaySnapshot.originV2, startSnapshot.originV2);

    const task = startSnapshot.activeTask;
    const variant = task.activeVariant;
    assert.equal(variant.interaction.kind, "text_response");

    // GET resync must be the same strict snapshot identity as the start response.
    const getResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${startSnapshot.runId}/v2`,
      headers: auth,
    });
    assert.equal(getResponse.statusCode, 200, getResponse.body);
    const resyncedSnapshot = learningRunPublicSnapshotV2Schema.parse(getResponse.json());
    assert.equal(resyncedSnapshot.runId, startSnapshot.runId);
    assert.equal(resyncedSnapshot.snapshotId, startSnapshot.snapshotId);
    assert.deepEqual(resyncedSnapshot.originV2, startSnapshot.originV2);

    const staleStream = await app.inject({
      method: "GET",
      url: `/learning-runs/${startSnapshot.runId}/events?snapshotId=${randomUUID()}`,
      headers: auth,
    });
    assert.equal(staleStream.statusCode, 409, staleStream.body);
    assert.equal(staleStream.json().error, "context_stale");

    const draftBody = {
      version: 2 as const,
      snapshotId: startSnapshot.snapshotId,
      variantId: variant.variantId,
      variantRevision: variant.revision,
      taskRevision: task.revision,
      expectedDraftRevision: null,
      payload: { kind: "text" as const, text: "先保存一份跨设备草稿。" },
      rendererState: { kind: "text" as const, selectionStart: 0, selectionEnd: 10 },
      idempotencyKey: `run-v2-wire-draft-${randomUUID()}`,
    };
    const draftResponse = await app.inject({
      method: "PUT",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/draft/v2`,
      headers: auth,
      payload: draftBody,
    });
    assert.equal(draftResponse.statusCode, 200, draftResponse.body);
    const draftReceipt = learningTaskDraftWriteReceiptV2Schema.parse(draftResponse.json());
    assert.equal(draftReceipt.runId, startSnapshot.runId);
    assert.equal(draftReceipt.snapshotId, startSnapshot.snapshotId);
    assert.equal(draftReceipt.taskId, task.taskId);
    assert.equal(draftReceipt.variantId, variant.variantId);
    assert.equal(draftReceipt.runRevision, startSnapshot.runRevision);

    const draftResyncResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/draft/v2`,
      headers: auth,
    });
    assert.equal(draftResyncResponse.statusCode, 200, draftResyncResponse.body);
    const draftResync = learningTaskDraftV2Schema.parse(draftResyncResponse.json());
    assert.equal(draftResync.snapshotId, startSnapshot.snapshotId);
    assert.deepEqual(draftResync.payload, draftBody.payload);
    assert.deepEqual(draftResync.rendererState, draftBody.rendererState);

    const submitBody = {
      version: 2 as const,
      snapshotId: startSnapshot.snapshotId,
      variantId: variant.variantId,
      variantRevision: variant.revision,
      runRevision: startSnapshot.runRevision,
      taskRevision: task.revision,
      inputSchemaHash: variant.inputSchemaHash,
      payload: { kind: "declared_unable" as const, reasonCode: "cannot_recall" as const },
      idempotencyKey: `run-v2-wire-submit-${randomUUID()}`,
    };
    const submitResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/submissions/v2`,
      headers: auth,
      payload: submitBody,
    });
    assert.equal(submitResponse.statusCode, 202, submitResponse.body);
    const submitReceipt = submitTaskArtifactReceiptV2Schema.parse(submitResponse.json());
    assert.equal(submitReceipt.runId, startSnapshot.runId);
    assert.equal(submitReceipt.snapshotId, startSnapshot.snapshotId);
    assert.equal(submitReceipt.taskId, task.taskId);
    assert.equal(submitReceipt.artifactStatus, "locked");
    assert.equal(submitReceipt.assessment.status, "queued");

    // A lost 202 response is recovered by exact replay, even after the run
    // has advanced to assessing. The receipt must remain byte-for-byte stable.
    const submitReplayResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/submissions/v2`,
      headers: auth,
      payload: submitBody,
    });
    assert.equal(submitReplayResponse.statusCode, 202, submitReplayResponse.body);
    assert.deepEqual(submitTaskArtifactReceiptV2Schema.parse(submitReplayResponse.json()), submitReceipt);

    // The draft ledger also has to replay its original runRevision after the
    // submit transition changed the current run revision.
    const draftReplayAfterSubmit = await app.inject({
      method: "PUT",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/draft/v2`,
      headers: auth,
      payload: draftBody,
    });
    assert.equal(draftReplayAfterSubmit.statusCode, 200, draftReplayAfterSubmit.body);
    assert.deepEqual(learningTaskDraftWriteReceiptV2Schema.parse(draftReplayAfterSubmit.json()), draftReceipt);

    const draftConflict = await app.inject({
      method: "PUT",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/draft/v2`,
      headers: auth,
      payload: { ...draftBody, payload: { kind: "text", text: "同 key 的不同草稿必须冲突。" } },
    });
    assert.equal(draftConflict.statusCode, 409, draftConflict.body);
    assert.equal(draftConflict.json().error, "idempotency_conflict");

    const submitRevisionConflict = await app.inject({
      method: "POST",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${task.taskId}/submissions/v2`,
      headers: auth,
      payload: { ...submitBody, runRevision: submitBody.runRevision + 1 },
    });
    assert.equal(submitRevisionConflict.statusCode, 409, submitRevisionConflict.body);
    assert.equal(submitRevisionConflict.json().error, "idempotency_conflict");

    const submitTaskConflict = await app.inject({
      method: "POST",
      url: `/learning-runs/${startSnapshot.runId}/tasks/${randomUUID()}/submissions/v2`,
      headers: auth,
      payload: submitBody,
    });
    assert.equal(submitTaskConflict.statusCode, 409, submitTaskConflict.body);
    assert.equal(submitTaskConflict.json().error, "idempotency_conflict");

    let finalResult: ReturnType<typeof getLearningRunResultResponseV2Schema.parse> | null = null;
    for (let round = 0; round < 8; round += 1) {
      const tickResult = await runLearningRunProcessingTick(`run-v2-wire-worker:${randomUUID()}`, 10);
      assert.equal(tickResult.failed, 0, `tick failed=${tickResult.failed}`);
      const resultResponse = await app.inject({
        method: "GET",
        url: `/learning-runs/${startSnapshot.runId}/result/v2`,
        headers: auth,
      });
      assert.ok([200, 202].includes(resultResponse.statusCode), resultResponse.body);
      finalResult = getLearningRunResultResponseV2Schema.parse(resultResponse.json());
      if (finalResult.status === "learning_result") break;
    }
    assert.ok(finalResult, "worker must produce a V2 result response");
    assert.equal(finalResult.status, "learning_result");
    assert.equal(finalResult.runId, startSnapshot.runId);
    assert.equal(finalResult.snapshotId, startSnapshot.snapshotId);
    assert.deepEqual(finalResult.originV2, startSnapshot.originV2);
    assert.deepEqual(finalResult.result.returnTargetV2, startSnapshot.returnTargetV2);

    const returnResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${startSnapshot.runId}/return-contract/v2`,
      headers: auth,
    });
    assert.equal(returnResponse.statusCode, 200, returnResponse.body);
    const returnContract = learningRunReturnContractV2Schema.parse(returnResponse.json());
    assert.equal(returnContract.runId, startSnapshot.runId);
    assert.equal(returnContract.snapshotId, startSnapshot.snapshotId);
    assert.deepEqual(returnContract.originV2, startSnapshot.originV2);
    assert.deepEqual(returnContract.returnTargetV2, startSnapshot.returnTargetV2);
    assert.notEqual(returnContract.status, "run_active");

    // The SSE/resync source is still cursor-based, but it is read from this
    // same V2 run scope; the desktop gateway only forwards the resulting
    // sequence as a safe notification and re-queries /v2.
    const events = await withWorkspaceTransaction(scope, (tx) =>
      getEventsAfter(tx, { ...scope, runId: startSnapshot.runId, afterSequence: 0 }),
    );
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.sequence > 0));
    assert.ok(events.some((event) => event.eventType === "learning_artifact.locked"));
  } finally {
    await app.close();
    await seeded.cleanup();
  }
});

test("RUN-V2-ACTION-IDEMPOTENCY-01：V2 action availability 与 response-loss exact replay", async () => {
  const seeded = await seed();
  const otherSeeded = await seed();
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 11, 'discrete-v2', 'initial_validation', now(), now())
    `;

    const startResponse = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 11 },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        responsePreference: "text",
        idempotencyKey: `run-v2-action-start-${randomUUID()}`,
      },
    });
    assert.equal(startResponse.statusCode, 201, startResponse.body);
    const before = learningRunPublicSnapshotV2Schema.parse(startResponse.json());
    assert.ok(before.allowedActions.some((action) => action.kind === "pause"));
    assert.equal(before.phase, "active");

    const leaseBody = {
      version: 2 as const,
      snapshotId: before.snapshotId,
      runRevision: before.runRevision,
      runtimeEpoch: before.runtimeEpoch,
      deviceSessionId: "device-v2-action-test",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      endedAt: new Date().toISOString(),
    };
    const leaseResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/activity-lease/v2`,
      headers: auth,
      payload: leaseBody,
    });
    assert.equal(leaseResponse.statusCode, 204, leaseResponse.body);
    const leaseReplay = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/activity-lease/v2`,
      headers: auth,
      payload: leaseBody,
    });
    assert.equal(leaseReplay.statusCode, 204, leaseReplay.body);
    const leaseCount = await sql`
      SELECT count(*)::int AS n FROM learning_activity_leases
      WHERE run_id = ${before.runId} AND device_session_id = ${leaseBody.deviceSessionId}
    `;
    assert.equal(leaseCount[0].n, 1, "duplicate lease replay must not double-write the lease row");
    const afterLeaseResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/v2`,
      headers: auth,
    });
    assert.equal(afterLeaseResponse.statusCode, 200, afterLeaseResponse.body);
    const afterLease = learningRunPublicSnapshotV2Schema.parse(afterLeaseResponse.json());
    assert.ok(afterLease.activeSecondsUsed > before.activeSecondsUsed, "V2 snapshot must expose the server-credited active time");

    const malformedAction = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: before.snapshotId,
        runRevision: before.runRevision,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "unknown_action" },
        idempotencyKey: `run-v2-action-malformed-${randomUUID()}`,
      },
    });
    assert.equal(malformedAction.statusCode, 400, malformedAction.body);

    const forgedParameters = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: before.snapshotId,
        runRevision: before.runRevision,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "pause", unexpected: true },
        idempotencyKey: `run-v2-action-forged-parameter-${randomUUID()}`,
      },
    });
    assert.equal(forgedParameters.statusCode, 400, forgedParameters.body);

    const staleSnapshot = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: randomUUID(),
        runRevision: before.runRevision,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "pause" },
        idempotencyKey: `run-v2-action-stale-snapshot-${randomUUID()}`,
      },
    });
    assert.equal(staleSnapshot.statusCode, 409, staleSnapshot.body);
    assert.equal(staleSnapshot.json().error, "context_stale");

    const staleRevision = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: before.snapshotId,
        runRevision: before.runRevision + 1,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "pause" },
        idempotencyKey: `run-v2-action-stale-revision-${randomUUID()}`,
      },
    });
    assert.equal(staleRevision.statusCode, 409, staleRevision.body);
    assert.equal(staleRevision.json().error, "stale_run_revision");

    const unauthorized = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: { authorization: `Bearer ${otherSeeded.token}` },
      payload: {
        version: 2,
        snapshotId: before.snapshotId,
        runRevision: before.runRevision,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "pause" },
        idempotencyKey: `run-v2-action-cross-workspace-${randomUUID()}`,
      },
    });
    assert.equal(unauthorized.statusCode, 404, unauthorized.body);
    assert.equal(unauthorized.json().error, "run_not_found");

    const forbidden = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: before.snapshotId,
        runRevision: before.runRevision,
        runtimeEpoch: before.runtimeEpoch,
        action: { kind: "resume" },
        idempotencyKey: `run-v2-action-forbidden-${randomUUID()}`,
      },
    });
    assert.equal(forbidden.statusCode, 409, forbidden.body);
    assert.equal(forbidden.json().error, "action_not_allowed");

    const actionBody = {
      version: 2 as const,
      snapshotId: before.snapshotId,
      runRevision: before.runRevision,
      runtimeEpoch: before.runtimeEpoch,
      action: { kind: "pause" as const },
      idempotencyKey: `run-v2-action-pause-${randomUUID()}`,
    };
    // 首次 action 也必须抵抗真实 HTTP overlap：winner 只产生一次状态
    // 变更，loser 等待 advisory lock 后读取同一 ledger receipt。
    const [actionResponse, overlapActionResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/learning-runs/${before.runId}/actions/v2`,
        headers: auth,
        payload: actionBody,
      }),
      app.inject({
        method: "POST",
        url: `/learning-runs/${before.runId}/actions/v2`,
        headers: auth,
        payload: actionBody,
      }),
    ]);
    assert.equal(actionResponse.statusCode, 200, actionResponse.body);
    const actionReceipt = learningRunActionResponseV2Schema.parse(actionResponse.json());
    assert.equal(overlapActionResponse.statusCode, 200, overlapActionResponse.body);
    assert.deepEqual(learningRunActionResponseV2Schema.parse(overlapActionResponse.json()), actionReceipt);
    assert.equal(actionReceipt.runId, before.runId);
    assert.equal(actionReceipt.snapshotId, before.snapshotId);
    assert.deepEqual(actionReceipt.originV2, before.originV2);
    assert.equal(actionReceipt.actionResult.kind, "state_changed");
    assert.equal(actionReceipt.snapshot.phase, "paused");
    assert.equal(actionReceipt.snapshot.runRevision, before.runRevision + 1);
    const actionLedgerRows = await sql`
      SELECT count(*)::int AS n FROM learning_run_action_ledger
      WHERE run_id = ${before.runId} AND idempotency_key = ${actionBody.idempotencyKey}
    `;
    assert.equal(actionLedgerRows[0].n, 1, "overlap must claim one action ledger row");

    // The next public snapshot must re-project the exact paused action set:
    // resume/end are available, while pause is no longer server-authorized.
    const pausedGetResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/v2`,
      headers: auth,
    });
    assert.equal(pausedGetResponse.statusCode, 200, pausedGetResponse.body);
    const paused = learningRunPublicSnapshotV2Schema.parse(pausedGetResponse.json());
    assert.equal(paused.phase, "paused");
    assert.equal(paused.runRevision, before.runRevision + 1);
    assert.ok(paused.allowedActions.some((action) => action.kind === "resume"));
    assert.ok(paused.allowedActions.some((action) => action.kind === "end" && !action.abandonLockedEvidence));
    assert.equal(paused.allowedActions.some((action) => action.kind === "pause"), false);

    const pausedPauseAttempt = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: paused.snapshotId,
        runRevision: paused.runRevision,
        runtimeEpoch: paused.runtimeEpoch,
        action: { kind: "pause" },
        idempotencyKey: `run-v2-action-paused-pause-${randomUUID()}`,
      },
    });
    assert.equal(pausedPauseAttempt.statusCode, 409, pausedPauseAttempt.body);
    assert.equal(pausedPauseAttempt.json().error, "action_not_allowed");

    // Exact replay occurs after the phase/revision changed. The ledger lookup
    // must precede action availability and stale checks, returning the exact
    // original V2 response rather than a new paused/resume projection.
    const replayResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: actionBody,
    });
    assert.equal(replayResponse.statusCode, 200, replayResponse.body);
    assert.deepEqual(learningRunActionResponseV2Schema.parse(replayResponse.json()), actionReceipt);

    const changedEpoch = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: { ...actionBody, runtimeEpoch: actionBody.runtimeEpoch + 1 },
    });
    assert.equal(changedEpoch.statusCode, 409, changedEpoch.body);
    assert.equal(changedEpoch.json().error, "idempotency_conflict");

    const changedAction = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: { ...actionBody, action: { kind: "end", abandonLockedEvidence: false } },
    });
    assert.equal(changedAction.statusCode, 409, changedAction.body);
    assert.equal(changedAction.json().error, "idempotency_conflict");

    const endResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/actions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: paused.snapshotId,
        runRevision: paused.runRevision,
        runtimeEpoch: paused.runtimeEpoch,
        action: { kind: "end", abandonLockedEvidence: false },
        idempotencyKey: `run-v2-action-end-${randomUUID()}`,
      },
    });
    assert.equal(endResponse.statusCode, 200, endResponse.body);
    const endReceipt = learningRunActionResponseV2Schema.parse(endResponse.json());
    assert.equal(endReceipt.snapshot.phase, "ended");
    assert.deepEqual(endReceipt.snapshot.allowedActions, []);

    const terminalResultResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/result/v2`,
      headers: auth,
    });
    assert.equal(terminalResultResponse.statusCode, 200, terminalResultResponse.body);
    const terminalResult = getLearningRunResultResponseV2Schema.parse(terminalResultResponse.json());
    assert.equal(terminalResult.status, "terminal_without_result");
    assert.equal(terminalResult.phase, "ended");

    const terminalReturnResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/return-contract/v2`,
      headers: auth,
    });
    assert.equal(terminalReturnResponse.statusCode, 200, terminalReturnResponse.body);
    const terminalReturn = learningRunReturnContractV2Schema.parse(terminalReturnResponse.json());
    assert.equal(terminalReturn.status, "no_projection_change");

    // A terminal review run must not keep emitting a deleted schedule as if
    // it were navigable. The API may provide only the still-active card as a
    // server-proven fallback; the resolver must not invent another route.
    await sql`DELETE FROM review_schedules WHERE id = ${scheduleId}`;
    const deletedTargetReturnResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/return-contract/v2`,
      headers: auth,
    });
    assert.equal(deletedTargetReturnResponse.statusCode, 200, deletedTargetReturnResponse.body);
    const deletedTargetReturn = learningRunReturnContractV2Schema.parse(deletedTargetReturnResponse.json());
    assert.deepEqual(deletedTargetReturn, {
      version: 2,
      runId: before.runId,
      snapshotId: before.snapshotId,
      originV2: before.originV2,
      returnTargetV2: before.returnTargetV2,
      status: "unavailable",
      reason: "return_target_deleted",
      fallbackTargetV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
    });

    await sql`UPDATE learning_cards_v2 SET lifecycle = 'archived' WHERE workspace_id = ${seeded.workspaceId} AND card_id = ${seeded.cardId}`;
    const noFallbackReturnResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/return-contract/v2`,
      headers: auth,
    });
    assert.equal(noFallbackReturnResponse.statusCode, 200, noFallbackReturnResponse.body);
    const noFallbackReturn = learningRunReturnContractV2Schema.parse(noFallbackReturnResponse.json());
    assert.equal(noFallbackReturn.status, "unavailable");
    assert.equal(noFallbackReturn.reason, "return_target_deleted");
    assert.equal(noFallbackReturn.fallbackTargetV2, null);

    const crossWorkspaceReturnResponse = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/return-contract/v2`,
      headers: { authorization: `Bearer ${otherSeeded.token}` },
    });
    assert.equal(crossWorkspaceReturnResponse.statusCode, 404, crossWorkspaceReturnResponse.body);
    assert.equal(crossWorkspaceReturnResponse.json().error, "run_not_found");
  } finally {
    await app.close();
    await seeded.cleanup();
    await otherSeeded.cleanup();
  }
});

test("RUN-V2-ACTION-AVAILABILITY-01：direct API 覆盖 full phase/checkpoint/recoverable-error projection", async () => {
  const seeded = await seed();
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const scheduleId = randomUUID();
    await sql`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 12, 'discrete-v2', 'initial_validation', now(), now())
    `;
    const startResponse = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "review", scheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 12 },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        responsePreference: "text",
        idempotencyKey: `run-v2-action-matrix-${randomUUID()}`,
      },
    });
    assert.equal(startResponse.statusCode, 201, startResponse.body);
    const initial = learningRunPublicSnapshotV2Schema.parse(startResponse.json());
    let revision = initial.runRevision;
    const readSnapshot = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/learning-runs/${initial.runId}/v2`,
        headers: auth,
      });
      assert.equal(response.statusCode, 200, response.body);
      return learningRunPublicSnapshotV2Schema.parse(response.json());
    };
    const mutateRun = async (phase: string, extra = "") => {
      revision += 1;
      await sql.unsafe(
        `UPDATE learning_runs SET phase = $1, revision = $2, checkpoint = NULL, failure = NULL WHERE id = $3`,
        [phase, revision, initial.runId],
      );
      if (extra) await sql.unsafe(extra, [initial.runId]);
    };

    await mutateRun("preparing");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    ]);

    await mutateRun("paused");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "resume" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    ]);

    await mutateRun("assessing");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "end", abandonLockedEvidence: true, confirmationRequired: true },
    ]);

    await mutateRun("committing");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "end", abandonLockedEvidence: true, confirmationRequired: true },
    ]);

    await mutateRun("checkpoint", "UPDATE learning_runs SET checkpoint = '{\"kind\":\"partial\",\"allowedFollowupIds\":[\"supplement:1\"]}'::jsonb WHERE id = $1");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "finish_current_evidence" },
      { version: 2, kind: "activate_followup", followupId: "supplement:1" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    ]);

    await mutateRun("checkpoint", "UPDATE learning_runs SET checkpoint = '{\"kind\":\"not_assessable\",\"allowedFollowupIds\":[]}'::jsonb WHERE id = $1");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "finish_without_commit" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    ]);

    await mutateRun("recoverable_error", "UPDATE learning_runs SET failure = '{\"stage\":\"prepare\",\"code\":\"planner_unavailable\",\"retryable\":true}'::jsonb WHERE id = $1");
    assert.deepEqual((await readSnapshot()).allowedActions, [
      { version: 2, kind: "retry_prepare" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    ]);

    await mutateRun("ended", "UPDATE learning_runs SET active_task_id = NULL, terminal_reason_code = 'user_ended' WHERE id = $1");
    assert.deepEqual((await readSnapshot()).allowedActions, []);
  } finally {
    await app.close();
    await seeded.cleanup();
  }
});

test("§8.5/§20.2 恢复：SSE Last-Event-ID 重放——getEventsAfter 只返回断点后新事件", async () => {
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
          requestedTimeBudgetSeconds: 120,
          clientRequestId: randomUUID(),
          idempotencyKey: randomUUID(),
        },
      }),
    );
    // 断点 = 当前 eventCursor（客户端最后收到的 sequence）
    const checkpoint = run.eventCursor;
    assert.ok(checkpoint >= 4, `PREPARE 事件集应已产生（实际 cursor=${checkpoint}）`);

    // 断线期间发生新事件：pause
    await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: run.revision,
        runtimeEpoch: run.runtimeEpoch,
        action: { kind: "pause" },
        idempotencyKey: randomUUID(),
      }),
    );

    // 重连：lastEventId=断点 → 只返回 pause 后的新事件（不含历史）
    const replayed = await withWorkspaceTransaction(scope, (tx) =>
      getEventsAfter(tx, { ...scope, runId: run.runId, afterSequence: checkpoint }),
    );
    assert.ok(replayed.length >= 1, "重放应包含断线期间的新事件");
    assert.ok(replayed.every((e) => e.sequence > checkpoint), "重放不含已消费事件");
    assert.ok(
      replayed.some((e) => e.eventType === "learning_run.paused"),
      "重放包含 learning_run.paused",
    );

    // 全量重放（lastEventId=0）包含 PREPARE 事件集
    const full = await withWorkspaceTransaction(scope, (tx) =>
      getEventsAfter(tx, { ...scope, runId: run.runId, afterSequence: 0 }),
    );
    assert.ok(full.length > replayed.length, "全量重放包含历史事件");
    assert.ok(full.some((e) => e.eventType === "learning_run.created"));
    assert.ok(full.some((e) => e.eventType === "learning_task.presented"));
  } finally {
    await seeded.cleanup();
  }
});
