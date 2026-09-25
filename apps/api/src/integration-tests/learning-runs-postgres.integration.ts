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
 * learning_cards_v2，createRunV2 直接使用 objectiveId。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-runs-postgres.integration.ts
 *
 * 角色：请使用受限的 ailearn_api（与 CI/生产一致，NOBYPASSRLS）。本文件的裸
 * SQL 校验统一经 scoped() 带 workspace/user 上下文，因此在受限角色下同样成立；
 * 用超级用户跑会绕过 RLS，让"恰好 1 行"类断言失去隔离意义。
 *
 * 上面那句"统一经 scoped()"在 2026-09-24 之前是不成立的：16 处裸 `sql` 校验没有
 * 带上下文，受限角色下全被 RLS 挡成 0 行（9 条用例红）。加新校验时请继续走
 * scoped()——本文件现已接入 CI（`.github/workflows/ci.yml` 的 fresh-migrations
 * job，用的就是受限角色），漏一次会在 CI 上直接变红，而不是等到某人手跑。
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
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
// db client 读取 DATABASE_URL_API；未设置时与 CONN 同源（本地 dev 默认）。
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

// Critic 未配置：确保 fail closed 分支可复现。
// 删之前先存一份原值——文件末尾那条"真模型一批"要把它们拿回来（与
// proactive-generator.test.ts 里 savedUrl 同一手法）。不存的话那条永远只能
// 在 40 ms 内拿到 "provider not configured"，也就是**看起来跑了、其实一分钱没花**。
const SAVED_ASSESSMENT_CRITIC_URL = process.env.ASSESSMENT_CRITIC_URL;
const SAVED_ASSESSMENT_CRITIC_KEY = process.env.ASSESSMENT_CRITIC_KEY;
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;
process.env.LEARNING_RUN_ENABLED ??= "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  createRunV2,
  submitArtifact,
  getRunPublicView,
  getLearningRunPublicSnapshotV2,
  getResultPayload,
  getResultPayloadV2,
  getReturnContractV2,
  applyAction,
  getEventsAfter,
  putDraft,
} = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);

/**
 * 裸 SQL 校验必须带 workspace/user 上下文。
 *
 * 本文件校验的目标表全部是 FORCE RLS（canonical_learning_event_outbox、
 * learning_artifacts、learning_runs、learning_run_idempotency、
 * learning_activity_leases、learning_task_variants、learning_tasks、
 * learning_cards_v2、learning_run_action_ledger…）。受限角色（ailearn_api）
 * 在无上下文的事务里读/写这些表会命中 0 行，使"恰好 1 行/0 schedule"这类断言
 * 假失败；超级用户则绕过 RLS 让同样的断言假通过。两者都不反映产品行为，因此
 * 校验统一走 scoped()，与运行时读取走同一套 RLS 上下文。
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

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

interface Seeded {
  workspaceId: string;
  userId: string;
  cardId: string;
  /** V2 objectiveId（V1 keyPointId alias；createRunV2 V1 薄壳映射二者一致）。 */
  keyPointId: string;
  objectiveRevisionId: string;
  noteId: string;
  noteVersionId: string;
  token: string;
  cleanup: () => Promise<void>;
}

async function seed(opts: { frozenEvidence?: boolean } = {}): Promise<Seeded> {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  if (opts.frozenEvidence) await seedFrozenEvidence(fixture);
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    objectiveRevisionId: fixture.objectiveRevisionId,
    noteId: fixture.noteId,
    noteVersionId: fixture.noteVersionId,
    token: fixture.token,
    cleanup: fixture.cleanup,
  };
}

/**
 * 给 fixture 的目标补一份完整的**冻结证据**（rubric 定向）。
 *
 * 为什么需要它：文本题走 critic 通道时，结算闸先验"这个评分点有没有冻结原文
 * 证据"（`run-processing-tick.ts` → `task rubric has no frozen evidence`）。
 * `seedV2Fixture` 默认不落 evidence binding，于是任何文本提交都在这道闸上被判
 * `not_assessable`/`no_frozen_evidence`——F28 之后那种原因不再签发补充按钮，
 * 于是"额度没用过 ⇒ 签发 supplement:1"这条正控制永远立不起来（2026-09-24 实
 * 测：它退化成和 E08 同一条断言）。补全证据后，这条提交会走到真正的下游失败
 * （本机没配 critic ⇒ `critic_unavailable`），那才是单槽规则该被检验的场景。
 *
 * 三个前置表缺一不可：`evidence_snapshots_v2`（冻结闭包读 hash）、
 * `evidence_eligibility_states_v2`（必须是 `usable`，否则冻结直接 fail）、
 * `evidence_snapshots_v2.block_id` 指向的 `note_blocks` 行（critic 输入要拿原文
 * 与 `block_content_hash` 对账，`hashCanonicalV2("block", …)` 必须相等）。
 */
async function seedFrozenEvidence(fixture: {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  objectiveRevisionId: string;
}): Promise<void> {
  const blockContent = "复利效应是本金产生利息后加入本金继续生息的现象";
  const blockId = randomUUID();
  const evidenceSnapshotId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.userId}, true)`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${blockId}, ${fixture.noteVersionId}, ${fixture.workspaceId}, 0, 'paragraph', ${blockContent})`;
    await tx`INSERT INTO evidence_snapshots_v2
      (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
       note_id, block_id, start_offset, end_offset, protected_quote_ref, quote_hash,
       block_content_hash, source_content_hash, modality)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${evidenceSnapshotId}, ${"b".repeat(64)},
              ${randomUUID()}, ${fixture.noteId}, ${blockId}, 0, ${blockContent.length},
              ${`evidence://snapshot/${evidenceSnapshotId}`},
              ${hashCanonicalV2("evidence-quote", { quote: blockContent })},
              ${hashCanonicalV2("block", { content: blockContent })}, ${"f".repeat(64)}, 'text')`;
    await tx`INSERT INTO evidence_eligibility_states_v2
      (id, workspace_id, eligibility_id, evidence_snapshot_id, status, eligibility_epoch, eligibility_vector_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${evidenceSnapshotId},
              'usable', 1, ${"a".repeat(64)})`;
    await tx`INSERT INTO learning_objective_evidence_bindings_v2
      (id, workspace_id, binding_id, objective_revision_id, target_unit_kind, target_unit_id,
       evidence_snapshot_id, relation, support_strength, semantic_support_report_id,
       semantic_support_report_hash, binding_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${fixture.objectiveRevisionId},
              'rubric', 'fixture-rubric-u1', ${evidenceSnapshotId}, 'entails', 'direct',
              ${randomUUID()}, ${"c".repeat(64)}, ${"d".repeat(64)})`;
  });
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 120,
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 120,
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
    const schedRows = await scoped(scope, (tx) => tx`
      SELECT id, generation, interval_days, reason_code FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId}
        AND subject_id = ${seeded.keyPointId} AND status = 'pending'
    `);
    assert.equal(schedRows.length, 1);
    assert.equal(schedRows[0].generation, 1);
    assert.equal(schedRows[0].interval_days, 1);
    // reason_code 来自**调度策略域**（DiscreteV2ReasonCode）：declared_unable 经
    // calculateDiscreteV2Schedule({outcome:"unable"}) → "unable_reset"。
    // "canonical_unable" 是 canonical envelope 的 fact.kind（下面单独断言），
    // 不是 schedule 的 reason code —— 两个域不能混用。
    assert.equal(schedRows[0].reason_code, "unable_reset");

    // 6) 恰好一个 canonical envelope（unique commitId/canonicalEventId）。
    const envelopeRows = await scoped(scope, (tx) => tx`
      SELECT envelope FROM canonical_learning_event_outbox
      WHERE workspace_id = ${seeded.workspaceId} AND run_id = ${run.runId}
    `);
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
    const envelopeRows2 = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox
      WHERE workspace_id = ${seeded.workspaceId} AND run_id = ${run.runId}
    `);
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
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
    const envelopeCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeCount[0].n, 0);
    const schedCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND subject_id = ${seeded.keyPointId}
    `);
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
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
    // 审计 F28 之后的新契约：结算闸因为**系统侧缺冻结证据**而 fail closed 时，
    // 不再签发补充证据的入口（`supplementOffer` 见到 `no_frozen_evidence` 就回空），
    // 并把原因码带上——界面据此说"缺的是原文证据，不是你答得不够好"。
    assert.deepEqual(afterRun.checkpoint, {
      kind: "not_assessable",
      allowedFollowupIds: [],
      reasonCode: "no_frozen_evidence",
    });
    assert.equal(afterRun.result, null, "not_assessable 不产生 result");
    const envelopeCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeCount[0].n, 0, "E08 提示暴露 0 canonical");
    const schedCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `);
    assert.equal(schedCount[0].n, 0, "E08 提示暴露 0 schedule");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 审计 F29：结果载荷必须带上**本轮交上来的原文**。
 *
 * 病是这么来的：结果页那颗按钮写"看这次的答案与解释"，展开后只有参考要点——因为
 * 正文只活在客户端一个内存态里（提交回执那一刻写进去），刷新、从历史重进就没了，
 * 而 `/learning-runs/:id/*` 那一批端点里没有任何一条读 `learning_artifacts`。
 * 这条用例钉的是服务端这一侧：已锁定的原文要随结果出来，未锁的（草稿）不算"交过"。
 *
 * 结算结果由夹具直接写进 `learning_runs.result`：本机没配 critic，走不到真判定，
 * 但被测的是"读已锁 artifact"这一段，与谁写下那份 result 无关。
 */
test("F29：结果载荷带上本轮已锁的原文，被取代的那一份不算", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "f29-create",
        },
      }),
    );
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
          payload: { kind: "text", text: "因为检索本身就在改记忆，重读没有这个作用。" },
          idempotencyKey: "f29-submit",
        },
      }),
    );

    const resultJson = JSON.stringify({
      outcome: "partial",
      demonstratedFacets: ["recall"],
      gapFacets: ["explain"],
      scheduleImpact: { kind: "none", reasonCode: "facet_only" },
      returnTarget: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId, objectiveId: seeded.keyPointId },
    });
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs SET phase = 'completed', result = ${resultJson}::jsonb
      WHERE id = ${run.runId}
    `);

    const payload = await withWorkspaceTransaction(scope, async (tx) =>
      getResultPayloadV2(tx, { ...scope, runId: run.runId }),
    );
    if (payload.status !== "learning_result") {
      assert.fail(`应当读到学习结果，实际 status=${payload.status}`);
    }
    assert.deepEqual(payload.result.submitted, [{
      taskId: run.activeTaskId!,
      sequence: 1,
      kind: "text",
      text: "因为检索本身就在改记忆，重读没有这个作用。",
    }], "已锁定的原文要随结果载荷出来（F29 的全部意义就在这）");

    // 补充证据的真实形状：一个任务**只允许一条 locked**（部分唯一索引
    // `learning_artifacts_task_locked_unique_idx`），所以第二次作答是"把前一条标成
    // superseded + 锁一条新的"。这一步同时守三件事：superseded 不再被报出、
    // 语音取的是确认过的逐字稿、报的是当下这条而不是最早那条。
    await scoped(scope, (tx) => tx`
      UPDATE learning_artifacts SET status = 'superseded', updated_at = now()
      WHERE run_id = ${run.runId} AND status = 'locked'
    `);
    await scoped(scope, (tx) => tx`
      INSERT INTO learning_artifacts (
        id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload,
        payload_hash, public_payload_hash, input_schema_hash, private_solution_hash,
        safety_report_hash, disclosure_profile_hash, assistance_snapshot_hash,
        status, locked_at, supersedes_artifact_id)
      SELECT gen_random_uuid(), run_id, task_id, variant_id, workspace_id, user_id,
             revision + 1,
             ${tx.json({ kind: "voice", confirmedTranscript: "口述：检索练习比重读更有效。" })},
             payload_hash, public_payload_hash, input_schema_hash, private_solution_hash,
             safety_report_hash, disclosure_profile_hash, assistance_snapshot_hash,
             'locked', now(), id
      FROM learning_artifacts WHERE run_id = ${run.runId} ORDER BY revision DESC LIMIT 1
    `);
    const afterSupplement = await withWorkspaceTransaction(scope, async (tx) =>
      getResultPayloadV2(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterSupplement.status === "learning_result" ? afterSupplement.result.submitted?.length : -1, 1,
      "一个任务只报当下这一条");
    assert.deepEqual(afterSupplement.status === "learning_result" ? afterSupplement.result.submitted?.[0] : null, {
      taskId: run.activeTaskId!,
      sequence: 1,
      kind: "voice",
      text: "口述：检索练习比重读更有效。",
    }, "语音答案带的是确认过的逐字稿");

    // 反向对照：被**取代**的那一份不算这一轮交过的答案（artifact 只有
    // locked / superseded 两种终态，补充证据会把前一次标成 superseded）。
    // 不写这一句，用例其实只在测"有 artifact 行就带出来"，与锁没锁无关。
    await scoped(scope, (tx) => tx`
      UPDATE learning_artifacts SET status = 'superseded' WHERE run_id = ${run.runId} AND status = 'locked'
    `);
    const afterUnlock = await withWorkspaceTransaction(scope, async (tx) =>
      getResultPayloadV2(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterUnlock.status === "learning_result"
      ? afterUnlock.result.submitted : undefined, undefined, "superseded 的那一份不该当成这一轮交过的答案");
  } finally {
    await seeded.cleanup();
  }
});

test("E09：assessing 阶段 end(abandon) → epoch 前移 → 迟到评估无副作用", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
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
    const envelopeCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "clarify",
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
    const artifactCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_artifacts
      WHERE workspace_id = ${seeded.workspaceId} AND task_id = ${taskId} AND status = 'locked'
    `);
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "p4-followup-create-1",
        },
      }),
    );
    // 构造 partial checkpoint（critic 判定 partial 后 tick 会这样写；此处
    // 直接验证 followup 状态机动作本身）。
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs
      SET phase = 'checkpoint',
          checkpoint = '{"kind":"partial","allowedFollowupIds":["supplement:1"]}'::jsonb
      WHERE id = ${run.runId}
    `);

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
    const taskRows = await scoped(scope, (tx) => tx`
      SELECT id, intent, status FROM learning_tasks
      WHERE run_id = ${run.runId} ORDER BY sequence
    `);
    assert.equal(taskRows.length, 2, "核心 + 补充两个 task");
    assert.equal(taskRows[1].intent, "repair");
    assert.equal(taskRows[1].status, "active");
    const variantRows = await scoped(scope, (tx) => tx`
      SELECT purpose, template_trust_ceiling, rubric_target_ids FROM learning_task_variants
      WHERE task_id = ${taskRows[1].id}
    `);
    assert.equal(variantRows.length, 1);
    assert.equal(variantRows[0].purpose, "practice");
    assert.equal(variantRows[0].template_trust_ceiling, "practice_only");
    // D2（2026-09-23）：补充任务必须与主任务用同一把 rubric。此前
    // planFollowupTask 调 buildClosure 少传 rubricTargetIdOverride，补充任务
    // 带的是现造的 `rubric:repair:<hash>`，Critic 输入按冻结快照解析必然落空
    // → 每次都被 fail closed 成 not_assessable（dev 实测 5/5）。
    const primaryVariantRows = await scoped(scope, (tx) => tx`
      SELECT v.rubric_target_ids FROM learning_task_variants v
      JOIN learning_tasks t ON t.id = v.task_id
      WHERE t.run_id = ${run.runId} AND t.sequence = 1 AND v.status = 'active'
    `);
    assert.deepEqual(
      [...(variantRows[0].rubric_target_ids as string[])].sort(),
      [...(primaryVariantRows[0].rubric_target_ids as string[])].sort(),
      "补充任务的 rubric 目标必须等于主任务的（冻结快照 required unit）",
    );
    const runRows = await scoped(scope, (tx) => tx`
      SELECT phase, active_task_id, revision, runtime_epoch FROM learning_runs WHERE id = ${run.runId}
    `);
    assert.equal(runRows[0].phase, "active");
    assert.equal(runRows[0].active_task_id, taskRows[1].id);
    // D1b：补充额度是单槽。把 run 拨回"旧 tick 会写出的那种状态"（checkpoint
    // 里仍带 supplement:1，但任务已经占到 sequence 2）再点第二次——必须是
    // 409，不能是撞 learning_tasks_run_sequence_unique 的裸 500。
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs
      SET phase = 'checkpoint',
          checkpoint = '{"kind":"partial","allowedFollowupIds":["supplement:1"]}'::jsonb
      WHERE id = ${run.runId}
    `);
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) => applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: runRows[0].revision,
        runtimeEpoch: runRows[0].runtime_epoch,
        action: { kind: "activate_followup", followupId: "supplement:1" },
        idempotencyKey: "p4-followup-second-slot-used",
      })),
      /已经用过唯一一次补充机会/,
      "第二次激活必须是明确的 409，不是 23505",
    );
    const taskCountAfterSecond = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_tasks WHERE run_id = ${run.runId}
    `);
    assert.equal(taskCountAfterSecond[0].n, 2, "被拒的第二次激活不得留下半个任务");
  } finally {
    await seeded.cleanup();
  }
});

test("P4 followup 单槽：补充任务自己再落 checkpoint 时不再签发 supplement:1", async () => {
  const seeded = await seed({ frozenEvidence: true });
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const { buildLearningRunAllowedActionsV2 } = await import(
      "../modules/learning-runs/run-action-availability.ts"
    );
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "it-slot-create",
        },
      }),
    );
    // 夹具自检：冻下来的目标必须真的带上 rubric 定向证据，否则下面的正控制
    // 会和 E08 撞在同一条"系统侧缺证据"上（见 seedFrozenEvidence 的注释）。
    const frozenEvidence = await scoped(scope, (tx) =>
      tx`SELECT target->'evidence' AS evidence FROM learning_target_snapshots_v2
         WHERE workspace_id = ${seeded.workspaceId} AND run_id = ${run.runId}`,
    );
    assert.deepEqual(
      (frozenEvidence[0]?.evidence as Array<{ targetUnit: { kind: string; rubricUnitId: string } }>)
        ?.map((e) => e.targetUnit),
      [{ kind: "rubric", rubricUnitId: "fixture-rubric-u1" }],
      "冻结快照必须含一条 rubric 定向证据",
    );
    const submitText = (
      taskId: string,
      taskRevision: number,
      runRevision: number,
      variant: { variantId: string; revision: number; inputSchemaHash: string },
      idempotencyKey: string,
    ) => withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision,
          taskRevision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "text", text: "地球绕太阳一圈大约 365 天。" },
          idempotencyKey,
        },
      }));

    await submitText(
      run.activeTaskId!,
      run.activeTask!.revision,
      run.revision,
      run.activeTask!.activeVariant,
      "it-slot-submit-1",
    );
    const tick1 = await runLearningRunProcessingTick(`it-worker:${randomUUID()}`, 10);
    assert.ok(tick1.failed === 0, `tick1 failed=${tick1.failed}`);

    // 正控制：额度没用过时必须照旧签发，否则下面的"变空"只是读不到东西。
    const cp1 = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(cp1.phase, "checkpoint");
    assert.deepEqual(cp1.checkpoint?.allowedFollowupIds, ["supplement:1"]);
    assert.ok(
      buildLearningRunAllowedActionsV2(cp1).some((a) => a.kind === "activate_followup"),
      "首次 checkpoint 必须签发补充按钮",
    );
    // 正控制的成因也要认对：签发它不是因为"系统侧缺证据"（那正是 F28 要拦的
    // 情况），而是本机没配 critic。理由码认错，这条测试就成了假绿。
    const failClosed = await scoped(scope, (tx) =>
      tx`SELECT payload FROM learning_run_events
         WHERE run_id = ${run.runId} AND event_type = 'learning_assessment.not_assessable'
         ORDER BY sequence DESC LIMIT 1`,
    );
    assert.equal(
      (failClosed[0]?.payload as { reasonCode?: string } | undefined)?.reasonCode,
      "critic_unavailable",
    );

    const activated = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: cp1.revision,
        runtimeEpoch: cp1.runtimeEpoch,
        action: { kind: "activate_followup", followupId: "supplement:1" },
        idempotencyKey: "it-slot-activate",
      }),
    );
    await submitText(
      activated.snapshot.activeTaskId!,
      activated.snapshot.activeTask!.revision,
      activated.snapshot.revision,
      activated.snapshot.activeTask!.activeVariant,
      "it-slot-submit-2",
    );
    const tick2 = await runLearningRunProcessingTick(`it-worker:${randomUUID()}`, 10);
    assert.ok(tick2.failed === 0, `tick2 failed=${tick2.failed}`);

    const cp2 = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(cp2.phase, "checkpoint", "补充任务作答后同样落到 checkpoint");
    assert.deepEqual(cp2.checkpoint?.allowedFollowupIds, [], "额度已用，不再签发第二次补充");
    const secondActions = buildLearningRunAllowedActionsV2(cp2).map((a) => a.kind);
    assert.ok(!secondActions.includes("activate_followup"), "第二次 checkpoint 不得再签发补充按钮");
    assert.ok(secondActions.includes("end"), "收掉按钮后必须仍留出口，不能把 run 关死");
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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 7, 'discrete-v2', 'initial_validation', now(), now())
    `);

    // 1) review origin 创建（consume_pending 授权 + generation 校验）。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "review", scheduleId, objectiveId: seeded.keyPointId, scheduleGeneration: 7 },
          goal: "stabilize",
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
    const oldSched = await scoped(scope, (tx) => tx`
      SELECT status FROM review_schedules WHERE id = ${scheduleId}
    `);
    assert.notEqual(oldSched[0].status, "pending", "旧 schedule 必须被消费");
    const successors = await scoped(scope, (tx) => tx`
      SELECT id FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId}
        AND id <> ${scheduleId}
        AND subject_id = ${seeded.keyPointId}
    `);
    assert.equal(successors.length, 1, "恰好一个 successor");

    // 4) 恰好一个 canonical envelope。
    const envelopeCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeCount[0].n, 1);
  } finally {
    await seeded.cleanup();
  }
});

test("REVIEW-QUEUE-PROJECTION-01：真实 V2 queue identity 与 direct startability preconditions", async () => {
  const seeded = await seed();
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const dueScheduleId = randomUUID();
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${dueScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 minute', 1, 12, 'discrete-v2', 'initial_validation', now(), now())
    `);

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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${futureScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() + interval '1 hour', 1, 13, 'discrete-v2', 'initial_validation', now(), now())
    `);
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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${cooldownScheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 minute', 1, 14, 'discrete-v2', 'initial_validation', now(), now())
    `);
    // validation_assistance_exposures 是**启用 RLS 的用户私有表**（策略要求
    // user_id = app.user_id），裸 INSERT 必须在带会话上下文的事务中执行，否则
    // WITH CHECK 求值为 NULL 直接 42501。这里模拟"该用户此前已被提示过"以命中
    // cooldown 分支，写入本身是合法的用户自有行。
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`
        INSERT INTO validation_assistance_exposures (id, workspace_id, user_id, key_point_id, exposure_fingerprint, last_exposure_kind, first_exposed_at, last_exposed_at, unassisted_eligible_after, input_schedule_id, created_at, updated_at)
        VALUES (${randomUUID()}, ${seeded.workspaceId}, ${seeded.userId}, ${seeded.keyPointId}, ${`review-cooldown-${randomUUID()}`}, 'pre_submit_source', now(), now(), now() + interval '1 hour', ${cooldownScheduleId}, now(), now())
      `;
    });
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

    const runCount = await scoped(scope, (tx) => tx`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${seeded.workspaceId}`);
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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 9, 'discrete-v2', 'initial_validation', now(), now())
    `);

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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 15, 'discrete-v2', 'initial_validation', now(), now())
    `);
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

    const runCount = await scoped(scope, (tx) => tx`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${seeded.workspaceId}`);
    const ledgerCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_run_idempotency
      WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId} AND idempotency_key = ${request.idempotencyKey}
    `);
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
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 10, 'discrete-v2', 'initial_validation', now(), now())
    `);

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
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const scheduleId = randomUUID();
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 11, 'discrete-v2', 'initial_validation', now(), now())
    `);

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
    const leaseCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_activity_leases
      WHERE run_id = ${before.runId} AND device_session_id = ${leaseBody.deviceSessionId}
    `);
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
    const actionLedgerRows = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_run_action_ledger
      WHERE run_id = ${before.runId} AND idempotency_key = ${actionBody.idempotencyKey}
    `);
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

    /**
     * 审计 F51：一条已经进终态的 run 不许再被写计时。
     *
     * 现场是：一个没人点过的窗口自己建了一条正式挑战、自己把它记成"用户结束"，
     * 屏上计时还继续走。计时的入口只有这一条（`POST …/activity-lease/v2`），
     * 所以这里钉住相位闸——终态上续租必须被拒，`active_seconds_used` 与 `revision`
     * 都不许再动。（`recordActivityLease` 里那句 `run.phase !== "active"` 就是它；
     * 这条用例存在的原因是这个形状的窗口在真机上真的出现过，不是假想。）
     */
    const terminalLeaseResponse = await app.inject({
      method: "POST",
      url: `/learning-runs/${before.runId}/activity-lease/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: endReceipt.snapshot.snapshotId,
        runRevision: endReceipt.snapshot.runRevision,
        runtimeEpoch: endReceipt.snapshot.runtimeEpoch,
        deviceSessionId: leaseBody.deviceSessionId,
        startedAt: new Date(Date.now() - 3_000).toISOString(),
        endedAt: new Date().toISOString(),
      },
    });
    assert.ok(
      terminalLeaseResponse.statusCode >= 400 && terminalLeaseResponse.statusCode < 500,
      `终态 run 的续租必须被拒，实际 ${terminalLeaseResponse.statusCode}：${terminalLeaseResponse.body}`,
    );
    const afterTerminalLease = await app.inject({
      method: "GET",
      url: `/learning-runs/${before.runId}/v2`,
      headers: auth,
    });
    assert.equal(afterTerminalLease.statusCode, 200, afterTerminalLease.body);
    const terminalSnapshot = learningRunPublicSnapshotV2Schema.parse(afterTerminalLease.json());
    assert.equal(
      terminalSnapshot.activeSecondsUsed,
      endReceipt.snapshot.activeSecondsUsed,
      "终态之后不许再计秒",
    );
    assert.equal(terminalSnapshot.runRevision, endReceipt.snapshot.runRevision, "终态之后 revision 不许再动");

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
    await scoped(scope, (tx) => tx`DELETE FROM review_schedules WHERE id = ${scheduleId}`);
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

    await scoped(scope, (tx) => tx`UPDATE learning_cards_v2 SET lifecycle = 'archived' WHERE workspace_id = ${seeded.workspaceId} AND card_id = ${seeded.cardId}`);
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
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const app = await buildLearningRunApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const scheduleId = randomUUID();
    await scoped(scope, (tx) => tx`
      INSERT INTO review_schedules (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.keyPointId}, 'pending', now() - interval '1 day', 1, 12, 'discrete-v2', 'initial_validation', now(), now())
    `);
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
      // 直接改 phase 也必须在 workspace 上下文里执行：learning_runs 是 FORCE RLS，
      // 无上下文的 UPDATE 会静默匹配 0 行，让后面的 allowedActions 断言读到旧快照。
      await scoped(scope, (tx) => tx.unsafe(
        `UPDATE learning_runs SET phase = $1, revision = $2, checkpoint = NULL, failure = NULL WHERE id = $3`,
        [phase, revision, initial.runId],
      ));
      if (extra) await scoped(scope, (tx) => tx.unsafe(extra, [initial.runId]));
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
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 120,
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

/**
 * 2026-08-24 审查 H1/H4：recoverable_error(stage=assessment) 的恢复链路必须
 * 端到端可用——tick 失败路径会把 assessment 收尾为 failed（或留下 queued/
 * running），retry_assessment 必须能重新入队（此前只认 failed → 恒 409），
 * 且 end 必须被状态机接受（此前 availability 宣告可用但 applyAction 拒绝）。
 */
test("RECOVERY-01：recoverable_error(assessment) → retry_assessment 可重复重试 + end 可放弃", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: `recovery01-create-${randomUUID()}`,
        },
      }),
    );
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
          payload: { kind: "text", text: "因为间隔复习可以对抗遗忘曲线。" },
          idempotencyKey: `recovery01-submit-${randomUUID()}`,
        },
      }),
    ) as { assessment: { assessmentId: string } };
    const assessmentId = receipt.assessment.assessmentId;

    const readSnapshot = () => withWorkspaceTransaction(scope, async (tx) =>
      getLearningRunPublicSnapshotV2(tx, { ...scope, runId: run.runId }));
    const readView = () => withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }));

    // 模拟 tick 失败路径的收尾：run → recoverable_error(stage=assessment)，
    // assessment 停在 running（Critic 写回事务回滚时的真实状态）。
    const failAssessmentStage = async (assessmentStatus: "running" | "queued" | "failed") => {
      const view = await readView();
      await scoped(scope, (tx) => tx`
        UPDATE learning_runs
        SET phase = 'recoverable_error',
            failure = '{"stage":"assessment","code":"assessment_timeout","retryable":true}'::jsonb,
            revision = ${view.revision + 1}
        WHERE id = ${run.runId}
      `);
      await scoped(scope, (tx) => tx`
        UPDATE learning_assessments SET status = ${assessmentStatus} WHERE id = ${assessmentId}
      `);
    };

    await failAssessmentStage("running");
    const failedSnapshot = await readSnapshot();
    // H1：投影必须给出 retry_assessment（带着真实可重试的 assessmentId）。
    assert.deepEqual(
      failedSnapshot.allowedActions.filter((a) => a.kind === "retry_assessment"),
      [{ version: 2, kind: "retry_assessment", assessmentId }],
    );
    // H4：recoverable_error 的 end 必须真实可用（下方验证状态机接受）。
    assert.ok(failedSnapshot.allowedActions.some((a) => a.kind === "end"));

    // 第一次重试：running → queued → outbox(assessment_requested)。
    const firstRetry = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: failedSnapshot.runRevision,
        runtimeEpoch: failedSnapshot.runtimeEpoch,
        action: { kind: "retry_assessment", assessmentId },
        idempotencyKey: `recovery01-retry-1-${randomUUID()}`,
      }));
    assert.equal(firstRetry.snapshot.phase, "assessing");
    assert.equal(firstRetry.snapshot.activeAssessment?.status, "queued");

    // 第二次重试（同一 assessment，run.revision 已前进）：不得撞 outbox
    // (workspace, run, idempotency_key) 唯一索引（否则裸 23505/500）。
    await failAssessmentStage("failed");
    const failedAgain = await readSnapshot();
    const secondRetry = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: failedAgain.runRevision,
        runtimeEpoch: failedAgain.runtimeEpoch,
        action: { kind: "retry_assessment", assessmentId },
        idempotencyKey: `recovery01-retry-2-${randomUUID()}`,
      }));
    assert.equal(secondRetry.snapshot.phase, "assessing");
    const outboxRows = await scoped(scope, (tx) => tx`
      SELECT idempotency_key FROM learning_run_processing_outbox
      WHERE run_id = ${run.runId} AND idempotency_key LIKE 'assessment:retry:%'
      ORDER BY created_at
    `);
    assert.equal(outboxRows.length, 2, "两次重试各产生一条可领取命令");
    assert.equal(new Set(outboxRows.map((r) => r.idempotency_key)).size, 2, "两次重试的 scope key 必须不同");

    // H4：recoverable_error → end（abandonLockedEvidence:false）必须被接受，
    // 且 epoch 前移、未终态 assessment 收尾为 failed。
    await failAssessmentStage("running");
    const beforeEnd = await readSnapshot();
    const ended = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: beforeEnd.runRevision,
        runtimeEpoch: beforeEnd.runtimeEpoch,
        action: { kind: "end", abandonLockedEvidence: false },
        idempotencyKey: `recovery01-end-${randomUUID()}`,
      }));
    assert.equal(ended.snapshot.phase, "ended");
    assert.ok(ended.snapshot.runtimeEpoch > beforeEnd.runtimeEpoch, "end 必须前移 epoch 作废在途写回");
    const assessmentRows = await scoped(scope, (tx) => tx`
      SELECT status FROM learning_assessments WHERE id = ${assessmentId}
    `);
    assert.equal(assessmentRows[0].status, "failed", "放弃后不得留下 running/queued 评估");
    assert.deepEqual((await readSnapshot()).allowedActions, [], "终态 run 无可用 action");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 2026-08-24 审查 H2/H3：Commit 门禁拒绝必须收尾（不得裸 return 把 run 永久
 * 留在 committing），且结算必须绑定「命令指向的那一条 assessment」——即使 run
 * 内存在更新的 completed assessment（followup 之后的第二个评估）。
 */
test("COMMIT-GUARD-01：结算绑定 command.assessmentId；门禁拒绝落到 checkpoint 而非卡死 committing", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: `commit-guard-create-${randomUUID()}`,
        },
      }),
    );
    const task1 = run.activeTaskId!;
    const variant1 = run.activeTask!.activeVariant;
    const receipt1 = await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: task1,
        request: {
          version: 1,
          variantId: variant1.variantId,
          variantRevision: variant1.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant1.inputSchemaHash,
          payload: { kind: "text", text: "间隔复习对抗遗忘曲线。" },
          idempotencyKey: `commit-guard-submit-1-${randomUUID()}`,
        },
      }),
    ) as { artifactId: string; assessment: { assessmentId: string } };
    const assessment1 = receipt1.assessment.assessmentId;

    // 本测试手动构造 committing 前状态：不再需要待处理的 assessment 命令。
    await scoped(scope, (tx) => tx`
      DELETE FROM learning_run_processing_outbox WHERE run_id = ${run.runId}
    `);
    // assessment1：本次要结算的评估（facet_eligible，较旧）。
    await scoped(scope, (tx) => tx`
      UPDATE learning_assessments
      SET status = 'completed', trust_class = 'facet_eligible', report_hash = 'report-a1',
          rubric_results = '[{"rubricItemId":"r1","facet":"explain","verdict":"partial","userFacingReason":"部分覆盖"}]'::jsonb
      WHERE id = ${assessment1}
    `);

    // 通过真实 followup 链路产生第二个（更新的）completed assessment（practice_only）：
    // A1 已是 completed，A2 之后才出现——正是 H3 描述的弱引用场景。
    const partialRevision = (await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }))).revision;
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs
      SET phase = 'checkpoint',
          checkpoint = '{"kind":"partial","allowedFollowupIds":["supplement:1"]}'::jsonb,
          revision = ${partialRevision + 1}
      WHERE id = ${run.runId}
    `);
    const afterFollowup = await withWorkspaceTransaction(scope, async (tx) =>
      applyAction(tx, {
        ...scope,
        runId: run.runId,
        runRevision: partialRevision + 1,
        runtimeEpoch: 0,
        action: { kind: "activate_followup", followupId: "supplement:1" },
        idempotencyKey: `commit-guard-followup-${randomUUID()}`,
      }));
    const task2 = afterFollowup.snapshot.activeTaskId!;
    const variant2 = afterFollowup.snapshot.activeTask!.activeVariant;
    const receipt2 = await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: task2,
        request: {
          version: 1,
          variantId: variant2.variantId,
          variantRevision: variant2.revision,
          runRevision: afterFollowup.snapshot.revision,
          taskRevision: afterFollowup.snapshot.activeTask!.revision,
          inputSchemaHash: variant2.inputSchemaHash,
          payload: { kind: "text", text: "补充说明间隔复习的机制。" },
          idempotencyKey: `commit-guard-submit-2-${randomUUID()}`,
        },
      }),
    ) as { assessment: { assessmentId: string } };
    const assessment2 = receipt2.assessment.assessmentId;
    await scoped(scope, (tx) => tx`
      DELETE FROM learning_run_processing_outbox WHERE run_id = ${run.runId}
    `);
    await scoped(scope, (tx) => tx`
      UPDATE learning_assessments
      SET status = 'completed', trust_class = 'practice_only', report_hash = 'report-a2',
          rubric_results = '[]'::jsonb, created_at = now() + interval '1 second'
      WHERE id = ${assessment2}
    `);

    // 把 run 放回「task1 的 facet Commit 正在结算」：activeTaskId=task1 + phase=committing。
    const committingRevision = (await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }))).revision;
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs
      SET phase = 'committing', active_task_id = ${task1}, failure = NULL, revision = ${committingRevision + 1}
      WHERE id = ${run.runId}
    `);
    await scoped(scope, (tx) => tx`
      INSERT INTO learning_run_processing_outbox
        (run_id, task_id, artifact_id, workspace_id, user_id, command_type, payload, idempotency_key, available_at, created_at, updated_at)
      VALUES (
        ${run.runId}, ${task1}, ${receipt1.artifactId}, ${seeded.workspaceId}, ${seeded.userId},
        'commit_requested',
        ${sql.json({ assessmentId: assessment1, disposition: "facet_evidence", runtimeEpoch: 0 })},
        'commit:test:assessment-binding', now(), now(), now()
      )
    `);

    const tick = await runLearningRunProcessingTick(`commit-guard-worker:${randomUUID()}`, 10);
    assert.equal(tick.failed, 0, `tick failed=${tick.failed}`);

    const after = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }));
    // H3：结算用了 command.assessmentId（facet_eligible A1）→ partial canonical；
    // 若取了更新的 A2（practice_only），会被 trust 门禁拒绝（旧代码：永久 committing）。
    assert.equal(after.phase, "completed", `phase=${after.phase}`);
    assert.equal(after.result?.outcome, "partial");
    const envelopeRows = await scoped(scope, (tx) => tx`
      SELECT envelope FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeRows.length, 1, "facet Commit 恰好一个 canonical envelope");
    const envelope = envelopeRows[0].envelope as { assessments: Array<{ assessmentId: string }> };
    assert.equal(envelope.assessments[0].assessmentId, assessment1, "envelope 必须引用命令的 assessment");
    // facet_evidence 0 schedule（§13.6）。
    const schedCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND subject_id = ${seeded.keyPointId}
    `);
    assert.equal(schedCount[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 2026-08-24 审查 H2：trustClass 门禁拒绝（与 ceiling 门禁对称）必须把 run
 * 从 committing 收尾到 checkpoint(not_assessable)，而不是留在 committing。
 */
test("COMMIT-GUARD-02：trustClass 门禁拒绝 → checkpoint(not_assessable) 而非永久 committing", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: `commit-guard2-create-${randomUUID()}`,
        },
      }),
    );
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
          payload: { kind: "text", text: "间隔复习对抗遗忘曲线。" },
          idempotencyKey: `commit-guard2-submit-${randomUUID()}`,
        },
      }),
    ) as { artifactId: string; assessment: { assessmentId: string } };
    await scoped(scope, (tx) => tx`
      DELETE FROM learning_run_processing_outbox WHERE run_id = ${run.runId}
    `);
    // practice_only 的评估 + facet_evidence 命令：trust 门禁必须拒绝。
    await scoped(scope, (tx) => tx`
      UPDATE learning_assessments
      SET status = 'completed', trust_class = 'practice_only', report_hash = 'report-practice',
          rubric_results = '[]'::jsonb
      WHERE id = ${receipt.assessment.assessmentId}
    `);
    const revision = (await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }))).revision;
    await scoped(scope, (tx) => tx`
      UPDATE learning_runs SET phase = 'committing', revision = ${revision + 1} WHERE id = ${run.runId}
    `);
    await scoped(scope, (tx) => tx`
      INSERT INTO learning_run_processing_outbox
        (run_id, task_id, artifact_id, workspace_id, user_id, command_type, payload, idempotency_key, available_at, created_at, updated_at)
      VALUES (
        ${run.runId}, ${taskId}, ${receipt.artifactId}, ${seeded.workspaceId}, ${seeded.userId},
        'commit_requested',
        ${sql.json({ assessmentId: receipt.assessment.assessmentId, disposition: "facet_evidence", runtimeEpoch: 0 })},
        'commit:test:trust-gate', now(), now(), now()
      )
    `);
    const tick = await runLearningRunProcessingTick(`commit-guard2-worker:${randomUUID()}`, 10);
    assert.equal(tick.failed, 0, `tick failed=${tick.failed}`);
    const after = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }));
    assert.equal(after.phase, "checkpoint", `phase=${after.phase}`);
    assert.equal(after.checkpoint?.kind, "not_assessable");
    assert.equal(after.result, null);
    const envelopeRows = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeRows[0].n, 0, "门禁拒绝 0 canonical");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 2026-08-24 审查 H1/M6：真实 tick 失败路径——assessment 行必须收尾为 failed
 * （否则 retry_assessment 与状态机脱节），且事件 payload 不得携带内部错误
 * 文本（Postgres 驱动细节经 SSE 直达客户端）。
 */
test("RECOVERY-02：tick 失败路径收尾 assessment=failed，事件不泄露内部错误", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: `recovery02-create-${randomUUID()}`,
        },
      }),
    );
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
          idempotencyKey: `recovery02-submit-${randomUUID()}`,
        },
      }),
    ) as { artifactId: string; assessment: { assessmentId: string } };
    // 预占 declared_unable 结算要写的 outbox scope key → tick 处理该 assessment
    // 时在事务内撞唯一索引（真实 DB 冲突类错误），走 recoverable_error 失败路径。
    await scoped(scope, (tx) => tx`
      INSERT INTO learning_run_processing_outbox
        (run_id, task_id, artifact_id, workspace_id, user_id, command_type, payload, idempotency_key, available_at, created_at, updated_at)
      VALUES (
        ${run.runId}, ${taskId}, ${receipt.artifactId}, ${seeded.workspaceId}, ${seeded.userId},
        'commit_requested',
        ${sql.json({ assessmentId: receipt.assessment.assessmentId, disposition: "unable_evidence", runtimeEpoch: 0 })},
        ${`commit:${receipt.assessment.assessmentId}`},
        now() + interval '1 hour', now(), now()
      )
    `);

    const tick = await runLearningRunProcessingTick(`recovery02-worker:${randomUUID()}`, 10);
    assert.ok(tick.failed >= 1, `tick 必须记录失败（failed=${tick.failed}）`);

    const after = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }));
    assert.equal(after.phase, "recoverable_error");
    assert.equal(after.failure?.stage, "assessment");
    // H1：assessment 不得停在 queued/running。
    const assessmentRows = await scoped(scope, (tx) => tx`
      SELECT status FROM learning_assessments WHERE id = ${receipt.assessment.assessmentId}
    `);
    assert.equal(assessmentRows[0].status, "failed");

    // M6：事件 payload 只带稳定 stage/code，绝不含 err.message（驱动细节/约束名）。
    const eventRows = await scoped(scope, (tx) => tx`
      SELECT payload FROM learning_run_events
      WHERE run_id = ${run.runId} AND event_type = 'learning_run.recoverable_error'
    `);
    assert.equal(eventRows.length, 1);
    const payload = eventRows[0].payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["code", "stage"]);
    assert.equal(payload.stage, "assessment");
    assert.ok(!("message" in payload), "不得把内部错误文本写进事件账本");

    // 端到端：该 run 此时确实可重试（投影 = 状态机）。
    const snapshot = await withWorkspaceTransaction(scope, async (tx) =>
      getLearningRunPublicSnapshotV2(tx, { ...scope, runId: run.runId }));
    assert.deepEqual(
      snapshot.allowedActions.filter((a) => a.kind === "retry_assessment"),
      [{ version: 2, kind: "retry_assessment", assessmentId: receipt.assessment.assessmentId }],
    );
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 2026-08-24 审查 M1：draft 幂等边界此前未串行化——同 key 并发 PUT 会同时
 * miss ledger 后各自写入，loser 撞 learning_run_action_ledger 唯一索引 →
 * 裸 23505/500。修后并发请求必须都拿到同一 receipt。
 */
test("DRAFT-IDEMPOTENCY-RACE：同 key 并发 draft PUT 幂等返回（无裸 23505）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: `draft-race-create-${randomUUID()}`,
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    const idempotencyKey = `draft-race-${randomUUID()}`;
    const draftInput = {
      ...scope,
      runId: run.runId,
      taskId,
      variantId: variant.variantId,
      variantRevision: variant.revision,
      taskRevision: run.activeTask!.revision,
      expectedDraftRevision: null,
      payload: { kind: "text", text: "草稿正文" },
      rendererState: {},
      idempotencyKey,
    };
    const [first, second] = await Promise.all([
      withWorkspaceTransaction(scope, (tx) => putDraft(tx, draftInput)),
      withWorkspaceTransaction(scope, (tx) => putDraft(tx, draftInput)),
    ]);
    assert.deepEqual(first, second, "并发同 key 必须返回同一 receipt");
    const ledgerRows = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_run_action_ledger
      WHERE run_id = ${run.runId} AND idempotency_key = ${idempotencyKey}
    `);
    assert.equal(ledgerRows[0].n, 1, "账本恰好一行");
    const draftRows = await scoped(scope, (tx) => tx`
      SELECT draft_revision FROM learning_task_drafts WHERE task_id = ${taskId}
    `);
    assert.equal(draftRows.length, 1, "草稿恰好一行");
    assert.equal(draftRows[0].draft_revision, 1, "并发请求不得写两次草稿版本");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 2026-08-24 审查 M2：同目标并发 PREPARE（不同幂等 key）此前都会 miss
 * disclosure profile 存在性检查 → 双双 INSERT → loser 撞
 * (workspace_id, profile_hash) 唯一索引，整个创建事务 500。
 */
test("PREPARE-DISCLOSURE-RACE：同目标并发 PREPARE 都成功（disclosure 幂等复用）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const create = (suffix: string) => withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "text",
          idempotencyKey: `prepare-race-${suffix}-${randomUUID()}`,
        },
      }));
    const [first, second] = await Promise.all([create("a"), create("b")]);
    assert.notEqual(first.runId, second.runId);
    assert.equal(first.phase, "active");
    assert.equal(second.phase, "active");
    // 同一 workspace 内同 hash 的 disclosure profile 只允许一行（幂等复用）。
    const dupRows = await scoped(scope, (tx) => tx`
      SELECT profile_hash, count(*)::int AS n
      FROM learning_task_disclosure_profiles
      WHERE workspace_id = ${seeded.workspaceId}
      GROUP BY profile_hash HAVING count(*) > 1
    `);
    assert.equal(dupRows.length, 0, "不得出现重复 profile_hash 行");
  } finally {
    await seeded.cleanup();
  }
});

// ─── 每波末尾那一次真跑（W0 纪律：确定性路径全绿之后，才花这一笔钱）──────
//
// 默认**不跑**：`REAL_MODEL_BATCH=1` 才跑。CI 永远不设这个变量——把付费调用
// 接进 CI 会让每次 push 都花钱，也会让 CI 变成"偶尔红在计费失败上"的地方。
// 本地怎么跑（.env 里 ASSESSMENT_CRITIC_URL ＋ DASHSCOPE_API_KEY 已在）：
//   set -a; . ../../.env; set +a
//   # 根 .env 的四条 DATABASE_URL* 主机段是**容器内的 `postgres`**，宿主机上连不通
//   # 且**不报错、只是静默挂住**；而它们四条都是超户 ailearn（BYPASSRLS），
//   # 拿它当"受限角色"会让依赖 RLS 的断言反过来红。所以从宿主机跑必须改两条：
//   lf() { echo "${1/@postgres:/@localhost:}"; }
//   export DATABASE_URL="$(lf "$DATABASE_URL")" DATABASE_URL_MIGRATOR="$(lf "$DATABASE_URL")" \
//     DATABASE_URL_WORKER="$(lf "$DATABASE_URL")" \
//     DATABASE_URL_API="postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn"
//   REAL_MODEL_BATCH=1 node --import tsx --test --test-concurrency=1 \
//     --test-name-pattern="真模型一批" src/integration-tests/learning-runs-postgres.integration.ts
// 2026-09-25 第一次照这段跑通：`submit→首个有效反馈 1413 ms；assessment=completed
// trust=facet_eligible`（读数记在 39d §19 那行"每波末尾那一次真跑"）。
//
// 它与上面那条 "P2 fail closed：text 提交 + Critic 未配置" 是**同一条路径的两个世界**：
// 那里断言的是"没有 Critic 就不猜"，这里断言的是"有 Critic 就真判分"。
// 这也是 W3-5 迁内核之后**第一次真跑评估那一步**（前面所有读数都是替身）。
const REAL_BATCH = process.env.REAL_MODEL_BATCH === "1";
test("真模型一批：text 提交 → 真 Critic 判分 → 结算，并打印提交→首个有效反馈的实测耗时",
  { skip: !REAL_BATCH && "REAL_MODEL_BATCH≠1：付费调用只在每波末尾手动跑一次" },
  async () => {
    // 必须带冻结证据：Critic 的输入构造在"rubric 没有冻结证据"时直接 fail closed
    // （第一次跑就踩到这里，29 ms 就 not_assessable，钱一分没花）。
    // 拿回真配置（本文件顶部为可复现性把它们删掉了）。只有这一条用例走真网络，
    // 而它默认不跑，所以恢复环境变量不会污染同进程里的其它用例。
    if (!SAVED_ASSESSMENT_CRITIC_URL) {
      throw new Error("真模型一批需要 .env 里的 ASSESSMENT_CRITIC_URL（否则这条用例等于没跑）");
    }
    process.env.ASSESSMENT_CRITIC_URL = SAVED_ASSESSMENT_CRITIC_URL;
    if (SAVED_ASSESSMENT_CRITIC_KEY) process.env.ASSESSMENT_CRITIC_KEY = SAVED_ASSESSMENT_CRITIC_KEY;
    const seeded = await seed({ frozenEvidence: true });
    try {
      const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
      const run = await withWorkspaceTransaction(scope, async (tx) =>
        createLearningRunForTest(tx, {
          ...scope,
          request: {
            originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
            goal: "stabilize",
            idempotencyKey: `real-batch-${randomUUID()}`,
          },
        }),
      );
      const variant = run.activeTask!.activeVariant;
      const submittedAt = Date.now();
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
            payload: { kind: "text", text: "因为遗忘在刚学完时最快，间隔复习能在遗忘发生前巩固，所以复习的时间安排直接决定长期记忆。" },
            idempotencyKey: `real-batch-submit-${randomUUID()}`,
          },
        }),
      );

      let assessment: { status: unknown; trust_class: unknown; rubric_results: unknown } | null = null;
      for (let round = 0; round < 6; round += 1) {
        const tick = await runLearningRunProcessingTick(`real-batch-${randomUUID()}`, 10);
        assert.equal(tick.failed, 0, "真模型这一跑把命令打成了 failed（不是慢，是断）");
        const rows = await scoped(scope, (tx) => tx`
          SELECT status, trust_class, rubric_results FROM learning_assessments
          WHERE run_id = ${run.runId} ORDER BY created_at DESC LIMIT 1
        `);
        const row = rows[0];
        // postgres-js 把裸 SQL 的行标成无名 Row 类型，只能逐字段取出来再收窄。
        assessment = row
          ? { status: row.status, trust_class: row.trust_class, rubric_results: row.rubric_results }
          : null;
        if (assessment && ["completed", "not_assessable", "failed"].includes(String(assessment.status))) break;
      }
      const elapsedMs = Date.now() - submittedAt;
      process.stderr.write(
        `[real-model-batch] submit→首个有效反馈 ${elapsedMs} ms；`
        + `assessment=${assessment ? String(assessment.status) : "无"} trust=${assessment?.trust_class ?? "无"} `
        + `rubric条数=${Array.isArray(assessment?.rubric_results) ? (assessment!.rubric_results as unknown[]).length : "非数组"}\n`,
      );
      assert.ok(assessment, "真 Critic 配好了却没有评估行：入队或 tick 没跑起来");
      // W0-8 的分位数是 n=91 的读数，这里 n=1，只能当"这一笔落在哪个桶"的读数用，
      // 不能拿来宣布门槛通过。真正要防的是劣化到分钟级（那说明迁内核把重试串成了等待）。
      assert.equal(String(assessment!.status), "completed",
        `真模型应当判得出来，实际=${String(assessment!.status)}（not_assessable 说明 provider 或解析坏了）`);
      assert.ok(elapsedMs < 30_000, `单次评估等了 ${elapsedMs} ms，已超过内核 2 次尝试的合理预算`);
      assert.ok(Array.isArray(assessment!.rubric_results) && (assessment!.rubric_results as unknown[]).length >= 1,
        "strict 合同：每条冻结 rubric 目标要恰好一条判定");
      assert.ok(assessment!.trust_class, "判分要落出 trustClass");
    } finally {
      await seeded.cleanup();
    }
  });
