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

async function seed() {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆。主动回忆比重复阅读更有效。",
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

test("P4 纵切：structured 创建 → structured_bundle 双 part 提交 → 确定性评估 → practice 结算（0 canonical/0 schedule）", async () => {
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
    // §5.3/§7.7：主 Variant = structured_bundle（ordering + relation 双 part，
    // 无 qualification → practice 上限）。
    const bundleInteraction = run.activeTask?.activeVariant.interaction as unknown as {
      kind: "structured_bundle";
      parts: Array<{
        partId: string;
        interaction: { kind: "ordering" | "relation_canvas" | "repair"; publicTokenIds?: string[]; publicNodeIds?: string[]; allowedEdgeKinds?: string[] };
        labels?: Record<string, string>;
      }>;
    };
    assert.equal(bundleInteraction.kind, "structured_bundle");
    assert.equal(bundleInteraction.parts.length, 2);
    assert.equal(bundleInteraction.parts[0].interaction.kind, "ordering");
    assert.equal(bundleInteraction.parts[1].interaction.kind, "relation_canvas");
    assert.equal(run.activeTask?.activeVariant.purpose, "practice");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "practice_only");
    // §12.6：调度授权（run 级）与 Variant trust（artifact 级）是两道独立
    // 防火墙——create_initial 授权存在，但 practice Variant 无法产出 canonical
    // 消费它；结算必须 0 schedule（下面断言）。
    assert.equal(run.schedulePolicySummary.kind, "create_on_canonical_outcome");
    // standby alternatives 含 text。
    const textAlt = run.activeTask?.availableAlternatives.find((a) => a.family === "text");
    assert.ok(textAlt, "text standby alternative present");
    // labels 供 renderer 展示（part 级）。
    assert.ok(bundleInteraction.parts[0].labels, "ordering part labels present");

    const orderingPart = bundleInteraction.parts[0];
    const relationPart = bundleInteraction.parts[1];
    const orderingIds = orderingPart.interaction.kind === "ordering" ? orderingPart.interaction.publicTokenIds ?? [] : [];
    const relationNodes = relationPart.interaction.kind === "relation_canvas" ? relationPart.interaction.publicNodeIds ?? [] : [];
    const edgeKinds = relationPart.interaction.kind === "relation_canvas" ? relationPart.interaction.allowedEdgeKinds ?? [] : [];

    // 一次原子提交 bundle Artifact（两个 part 全部完成后）。
    const submission = {
      version: 1 as const,
      variantId: run.activeTask!.activeVariant.variantId,
      variantRevision: run.activeTask!.activeVariant.revision,
      inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
      payload: {
        kind: "structured_bundle" as const,
        partAnswers: [
          { kind: "ordering" as const, partId: orderingPart.partId, orderedTokenIds: [...orderingIds], interactionRefs: [] as string[] },
          { kind: "relation" as const, partId: relationPart.partId, edges: [{ fromNodeId: relationNodes[1], toNodeId: relationNodes[0], edgeKind: edgeKinds.includes("supports") ? "supports" : edgeKinds[0] }], interactionRefs: [] as string[] },
        ] as [Record<string, unknown>, Record<string, unknown>],
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

test("P4 fail closed：bundle 非法 payload（伪造 part 引用 / token 不属于题目）400 拒绝", async () => {
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
    const bundleInteraction = run.activeTask!.activeVariant.interaction as unknown as {
      kind: "structured_bundle";
      parts: Array<{ partId: string; interaction: { kind: "ordering" | "relation_canvas" | "repair"; publicTokenIds?: string[] } }>;
    };
    const orderingPart = bundleInteraction.parts[0];
    const orderingIds = orderingPart.interaction.kind === "ordering" ? orderingPart.interaction.publicTokenIds ?? [] : [];

    // 伪造 part 引用（partId 不属于题目）→ 400。
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
              kind: "structured_bundle",
              partAnswers: [
                { kind: "ordering", partId: "part:evil", orderedTokenIds: [...orderingIds] },
                { kind: "relation", partId: "part:2", edges: [] },
              ],
              interactionRefs: [],
            },
            idempotencyKey: "p4-submit-evil-1",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "payload_variant_mismatch",
    );

    // token 不属于题目 → 400。
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
              kind: "structured_bundle",
              partAnswers: [
                { kind: "ordering", partId: orderingPart.partId, orderedTokenIds: [...orderingIds, "tok:evil"] },
                { kind: "relation", partId: "part:2", edges: [] },
              ],
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

test("P4 relation 纵切：transfer 偏好 → relation 主 Variant → 正确边提交 → facet commit（0 schedule）", async () => {
  const seeded = await seed();
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
    assert.ok(relation.publicNodeLabels?.["node:claim"], "claim node label");
    assert.ok(relation.publicNodeLabels?.["node:quote"], "quote node label");
    assert.equal(run.activeTask?.activeVariant.purpose, "facet");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "facet_eligible");

    // 正确边（quote supports claim）：从 worker 侧读 solution 不可行（测试用
    // ailearn owner 连接可直接读），这里按生成器确定性提交正确边。
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
    // §7.7 标注后 relation ceiling=facet_eligible：正确提交 → facet_evidence
    // Commit（canonical facet observation + 0 schedule，§13.6）。
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

test("P4 repair 纵切：repair 偏好 → repair 主 Variant → 正确操作 → facet commit（0 schedule）", async () => {
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
