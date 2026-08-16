/**
 * LearningRun 纵切 DB 集成测试（真实 postgres，文档 16 §22.2 P2 Gate 的一部分）。
 *
 * 纵切：card origin 创建 Run（active/standby 双 Variant + private contract +
 * 事件）→ declared_unable 原子提交（lock + queued + outbox）→ processing
 * tick（确定性评估 → commit → schedule 恰好一个 successor + 恰好一个
 * canonical envelope + result）→ 幂等重放（创建/提交）→ text 提交在 Critic
 * 未配置时 fail closed 到 not_assessable checkpoint（0 canonical/schedule）。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-runs-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
// db client 读取 DATABASE_URL_API；未设置时与 CONN 同源（本地 dev 默认）。
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

// Critic 未配置：确保 fail closed 分支可复现。
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRun, submitArtifact, getRunPublicView, getResultPayload, applyAction, getEventsAfter } = await import(
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
  keyPointId: string;
  cleanup: () => Promise<void>;
}

async function seed(): Promise<Seeded> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${`lr-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
             VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${tx.json({ blocks: [] })}, ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', ${tx.json({ version: 1 })}, now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线表明复习间隔决定长期记忆', '间隔重复能显著降低遗忘率。')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_action_ledger WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_idempotency WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM practice_trail_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_processing_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_assessments WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_drafts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_private_solutions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_safety_reports WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_disclosure_profiles WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_private_contracts WHERE workspace_id = ${workspaceId}`;
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
        AND key_point_id = ${seeded.keyPointId} AND status = 'pending'
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
      WHERE workspace_id = ${seeded.workspaceId} AND key_point_id = ${seeded.keyPointId}
    `;
    assert.equal(schedCount[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

test("E08：请求提示后提交 → practice_completed（0 canonical/0 schedule，不依赖 Critic）", async () => {
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
    assert.equal(afterRun.phase, "completed");
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });
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
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, key_point_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'key_point', ${seeded.keyPointId}, ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 7, 'discrete-v2', 'initial_validation', now(), now())
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
        AND key_point_id = ${seeded.keyPointId}
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
