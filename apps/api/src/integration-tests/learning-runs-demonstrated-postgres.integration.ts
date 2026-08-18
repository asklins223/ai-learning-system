/**
 * P2 Gate demonstrated 纵切（真实 Critic，文档 16 §22.2 P2 Gate 核心）。
 *
 * 依赖真实 LLM：ASSESSMENT_CRITIC_URL（+ ASSESSMENT_CRITIC_KEY 或
 * DASHSCOPE_API_KEY）。未配置时 skip（fail closed 分支由
 * learning-runs-postgres.integration.ts 覆盖）。
 *
 * 纵切：card origin 创建 Run → text 提交正确答案 → 真实 Critic 逐 rubric
 * verdict（covered）→ mastery 结算 → canonical Commit（恰好一个 envelope +
 * 恰好一个 schedule successor）+ completed result。
 *
 * 运行：
 *   set -a; source .env; set +a
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn" \
 *     node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/learning-runs-demonstrated-postgres.integration.ts
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
const { runLearningRunProcessingTick } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);

const criticConfigured =
  Boolean(process.env.ASSESSMENT_CRITIC_URL?.trim())
  && Boolean(
    process.env.ASSESSMENT_CRITIC_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim(),
  );

after(async () => {
  await sql.end({ timeout: 2 });
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

test("P2 Gate：text 正确答案 + 真实 Critic → mastery 结算 + canonical Commit + schedule", { skip: !criticConfigured && "ASSESSMENT_CRITIC_URL/KEY 未配置" }, async () => {
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
          clientRequestId: "demo-1",
          idempotencyKey: "demo-create-1",
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
          payload: {
            kind: "text",
            text: "遗忘曲线表明，复习间隔决定长期记忆效果：间隔重复可以显著降低遗忘率，把记忆保持在高位。",
          },
          idempotencyKey: "demo-submit-1",
        },
      }),
    );

    // 真实 Critic 网络调用：多轮 tick 直到离开 assessing（每轮 10 命令）。
    let view = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    for (let round = 0; round < 12 && !["completed", "cancelled", "stale"].includes(view.phase); round += 1) {
      const tickResult = await runLearningRunProcessingTick(`demo-worker:${randomUUID()}`, 10);
      assert.ok(tickResult.failed === 0, `tick failed=${tickResult.failed} round=${round}`);
      view = await withWorkspaceTransaction(scope, async (tx) =>
        getRunPublicView(tx, { ...scope, runId: run.runId }),
      );
      if (view.phase === "checkpoint" && view.checkpoint?.kind === "not_assessable") {
        break;
      }
    }

    // §13.1：真实 Critic 产出 verdicts 后结算。正确答案应覆盖 rubric → mastery。
    const envelopeRows = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    const schedRows = await sql`
      SELECT count(*)::int AS n, max(generation) AS gen FROM review_schedules
      WHERE workspace_id = ${seeded.workspaceId} AND subject_id = ${seeded.keyPointId}
    `;
    if (view.phase === "completed") {
      assert.equal(envelopeRows[0].n, 1, "canonical Commit 恰好一个 envelope");
      assert.equal(schedRows[0].n, 1, "恰好一个 schedule successor");
      assert.equal(view.result?.outcome ?? null, "demonstrated", "正确答案 mastery 结算");
      assert.equal(view.result?.scheduleImpact.kind ?? null, "created", "schedule impact 落地");
    } else {
      // 模型输出不稳定时允许 fail closed（不猜结果），但需明确报告。
      assert.fail(`demonstrated 纵切未达 completed：phase=${view.phase} checkpoint=${view.checkpoint?.kind ?? "none"}（真实 Critic 未产出 covered verdicts——检查 model 配置或 rubric 措辞）`);
    }
  } finally {
    await seeded.cleanup();
  }
});
