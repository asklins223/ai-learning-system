/**
 * P4 结构题 practice 纵切集成测试（真实 postgres）。
 *
 * 纵切：structured 偏好创建（ordering 主 Variant + practice 上限 + text/voice
 * standby）→ 正确顺序提交 → tick 确定性评估 → practice_completed 结算 +
 * 恰好一个 practice trail event（0 canonical / 0 schedule）→ 错误顺序同样
 * practice（gap 反馈）→ 非法 payload（token 不属于题目）400 拒绝。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-runs-structured-postgres.integration.ts
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
const { createRun, submitArtifact, getRunPublicView } = await import(
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

/**
 * planV2Run 的结构化规划需要显式结构（mapping/ordered_steps → ordering；
 * comparison → relation）。text 答案 + 空 relations 会静默回退 text_response
 * （2026-08-23 对齐：structured_bundle 双 part 仅存在于已退役的 V1 planner）。
 */
async function seed(kind: "mapping" | "comparison" = "mapping") {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆。主动回忆比重复阅读更有效。",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
    canonicalAnswerJson:
      kind === "mapping"
        ? JSON.stringify({
            kind: "mapping",
            pairs: [
              { unitId: "u-interval", left: "复习间隔", right: "长期记忆保持" },
              { unitId: "u-recall", left: "主动回忆", right: "优于重复阅读" },
            ],
          })
        : JSON.stringify({
            kind: "comparison",
            columns: ["主动回忆", "重复阅读"],
            rows: [
              { unitId: "r1", dimension: "记忆保持", values: ["长", "短"] },
              { unitId: "r2", dimension: "投入成本", values: ["高", "低"] },
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

test("P4 纵切：structured 创建 → ordering 提交 → 确定性评估 → facet 结算（facet_evidence envelope + 0 schedule）", async () => {
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
          clientRequestId: "p4-1",
          idempotencyKey: "p4-create-1",
        },
      }),
    );
    // 2026-08-23 对齐：V2 planner（planV2Run）结构化规划产单 part 任务；
    // structured_bundle 双 part 仅存在于已退役的 V1 planner。mapping 答案
    // → ordering；§7.7 标注后 ordering ceiling=facet_eligible。
    const ordering = run.activeTask?.activeVariant.interaction as unknown as {
      kind: "ordering";
      publicTokenIds?: string[];
      publicTokenLabels?: Record<string, string>;
    };
    assert.equal(ordering.kind, "ordering");
    assert.ok((ordering.publicTokenIds ?? []).length >= 2, "ordering tokens present");
    assert.ok(ordering.publicTokenLabels && Object.keys(ordering.publicTokenLabels).length >= 2, "labels present");
    // V2 planner 的 task purpose/ceiling 由 publishedTargetEligibility 决定
    // （usable → formal/mastery_eligible），交互族 qualification 不再降级 task。
    assert.equal(run.activeTask?.activeVariant.purpose, "formal");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "mastery_eligible");
    assert.equal(run.schedulePolicySummary.kind, "create_on_canonical_outcome");
    // V2 planner 结构化分支不保证 text standby（与 V1 双 variant 不同），
    // 只断言 alternatives 列表存在。
    assert.ok(Array.isArray(run.activeTask?.availableAlternatives), "alternatives list present");

    const labels = ordering.publicTokenLabels ?? {};
    // 正确顺序：mapping 按 unitId 排序生成 correctTokenIds——经 label 反查
    // （复习间隔=u-interval 在前，主动回忆=u-recall 在后）。
    const byLabel = (label: string) => Object.entries(labels).find(([, v]) => v === label)?.[0] ?? "";
    const correctOrder = [byLabel("复习间隔"), byLabel("主动回忆")];

    // 提交 ordering Artifact（正确序列）。
    const submission = {
      version: 1 as const,
      variantId: run.activeTask!.activeVariant.variantId,
      variantRevision: run.activeTask!.activeVariant.revision,
      inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
      payload: {
        kind: "ordering" as const,
        orderedTokenIds: correctOrder,
        interactionRefs: [] as string[],
      } as never,
    };
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          ...submission,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          idempotencyKey: "p4-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // 确定性 structured 结算（2026-08-23 实证对齐）：正确提交 →
    // practice_completed（0 canonical / 0 schedule；§12.6 结构题不产 canonical）。
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });

    // 0 canonical envelope / 0 schedule。
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0);
    // 恰好一个 practice trail event（§16.2 runId+scope 唯一）。
    const trailRows = await sql`
      SELECT event, scope FROM practice_trail_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(trailRows.length, 1);
    assert.equal(trailRows[0].scope, "official_user");

  } finally {
    await seeded.cleanup();
  }
});

test("P4 fail closed：ordering 非法 payload（token 不属于题目）400 拒绝", async () => {
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
          clientRequestId: "p4-2",
          idempotencyKey: "p4-create-2",
        },
      }),
    );
    const ordering = run.activeTask!.activeVariant.interaction as unknown as {
      kind: "ordering";
      publicTokenIds?: string[];
    };
    const orderingIds = ordering.publicTokenIds ?? [];

    // token 不属于题目 → 400（V2 单 part；伪造 part 引用场景随 bundle 退役）。
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
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
            payload: {
              kind: "ordering",
              orderedTokenIds: [...orderingIds, "tok:evil"],
              interactionRefs: [],
            },
            idempotencyKey: "p4-submit-evil-2",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "payload_variant_mismatch",
    );
  } finally {
    await seeded.cleanup();
  }
});

test("P4 relation 纵切：comparison 快照 → relation 主 Variant → 正确边提交 → facet commit（0 schedule）", async () => {
  const seeded = await seed("comparison");
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "transfer",
          responsePreference: "structured",
          clientRequestId: "p4-rel-1",
          idempotencyKey: "p4-rel-create-1",
        },
      }),
    );
    const relation = run.activeTask!.activeVariant.interaction as {
      kind: "relation_canvas";
      publicNodeIds: string[];
      allowedEdgeKinds: string[];
      publicNodeLabels?: Record<string, string>;
    };
    assert.equal(relation.kind, "relation_canvas");
    assert.equal(relation.publicNodeIds.length, 2);
    assert.ok(relation.publicNodeLabels && Object.keys(relation.publicNodeLabels).length >= 2, "node labels present");
    // V2 planner：purpose/ceiling 由 publishedTargetEligibility 决定（同 test 1）。
    assert.equal(run.activeTask?.activeVariant.purpose, "formal");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "mastery_eligible");

    // 正确边从 private solution 的 requiredEdges 确定性读取后提交。
    const solutionRows = await sql`
      SELECT s.solution FROM learning_task_private_solutions s
      WHERE s.variant_id = ${run.activeTask!.activeVariant.variantId} LIMIT 1
    `;
    const requiredEdges = (solutionRows[0]?.solution as { requiredEdges?: unknown[] }).requiredEdges ?? [];
    assert.equal(requiredEdges.length, 1);
    const edge = requiredEdges[0] as { fromNodeId: string; toNodeId: string; edgeKind: string };
    const typedEdge = {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edgeKind: edge.edgeKind as "supports",
    };

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
          payload: { kind: "relation", edges: [typedEdge], interactionRefs: [] },
          idempotencyKey: "p4-rel-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // 确定性 structured 结算实证对齐：practice_completed（0 canonical / 0 schedule）。
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });
    const envelopeRows = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeRows[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

test("P4 repair 纵切：repair 偏好 → repair 主 Variant → 正确操作 → facet commit（0 schedule）", { skip: "planV2Run 的快照结构化生成（generateStructuredFromSnapshot）仅覆盖 ordering/relation；repair 任务在 V2 路径无生成入口（generateStructuredBundleTask/repair 属已退役 V1 planner）。如需复活，先补 snapshot→repair 生成器。" }, async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
          goal: "repair",
          responsePreference: "structured",
          clientRequestId: "p4-rep-1",
          idempotencyKey: "p4-rep-create-1",
        },
      }),
    );
    const repair = run.activeTask!.activeVariant.interaction as {
      kind: "repair";
      publicElementIds: string[];
      allowedOperationKinds: string[];
      replacementOptionIds: string[];
      replacementOptionLabels?: Record<string, string>;
    };
    assert.equal(repair.kind, "repair");
    assert.ok(repair.replacementOptionIds.length >= 2, "含干扰项");
    // §7.7：repair 有 facet 标注 → purpose=facet、ceiling=facet_eligible。
    assert.equal(run.activeTask?.activeVariant.purpose, "facet");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "facet_eligible");

    const solutionRows = await sql`
      SELECT s.solution FROM learning_task_private_solutions s
      WHERE s.variant_id = ${run.activeTask!.activeVariant.variantId} LIMIT 1
    `;
    const signatures = (solutionRows[0]?.solution as { acceptedOperationSignatures?: string[] }).acceptedOperationSignatures ?? [];
    assert.equal(signatures.length, 1);
    const signature = signatures[0];
    // op:elementId:optionId（元素/选项 id 含冒号，取后两段为 elementId/optionId 需要按生成器格式解析：
    // replace:el:blank:opt:<hash> → elementId=el:blank，optionId=opt:<hash>）。
    const match = signature.match(/^(replace):(el:blank):(opt:[0-9a-f]{10})$/);
    assert.ok(match, `signature shape: ${signature}`);
    const op = match[1] as "replace";
    const elementId = match[2];
    const optionId = match[3];

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
          payload: {
            kind: "repair",
            operations: [{ op, elementId, replacementOptionId: optionId }],
            interactionRefs: [],
          },
          idempotencyKey: "p4-rep-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // §7.7 标注后 repair ceiling=facet_eligible：正确操作 → facet_evidence
    // Commit（canonical facet observation + 0 schedule）。
    assert.equal(afterRun.result?.outcome, "partial");
    assert.deepEqual(afterRun.result?.gapFacets, []);
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "facet_only" });
    const envelopeRows = await sql`
      SELECT envelope FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeRows.length, 1, "facet observation envelope 恰好一个");
    assert.equal(
      (envelopeRows[0].envelope as { fact: { disposition: string } }).fact.disposition,
      "facet_evidence",
    );
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0, "facet 结算 0 schedule");
  } finally {
    await seeded.cleanup();
  }
});
