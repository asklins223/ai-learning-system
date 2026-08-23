/**
 * LearningRun origin/returnTarget 合同漂移修复集成测试（真实 postgres）。
 *
 * 背景（2026-08-22 审查）：createRunV2 把 V2 形状 origin（objectiveId，无
 * keyPointId）写入 learning_runs.origin，读取端原样 cast 成
 * LearningRunPublicV1——响应中 keyPointId 恒为 undefined；同时三处生产 SQL
 * 按 origin->>'keyPointId' 过滤，rebase 后创建的 run 全部漏配，导致
 * Objective Surface 的 personal.activeRun 永远解析不到（resume_run 主行动
 * 失效）。本测试锁定修复后的端到端行为：
 *
 * 1. createRunV2（生产写入路径）→ getRunPublicView 输出严格满足
 *    LearningRunPublicV1：origin 带 keyPointId、returnTarget 完整；
 * 2. assembleObjectiveSurfaceV3 能看到 active run → primaryAction = resume_run；
 * 3. 幂等重放路径同样满足合同。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-run-origin-contract.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { getRunPublicView } = await import("../modules/learning-runs/run-service.ts");
const { createRunV2 } = await import("../modules/learning-runs/run-service.ts");
const { assembleObjectiveSurfaceV3 } = await import(
  "../modules/learning-objectives/surface-service.ts"
);
const { seedV2Fixture } = await import("./helpers/v2-card-fixture.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

interface Created {
  seeded: { cleanup: () => Promise<void>; workspaceId: string; userId: string; objectiveId: string; cardId: string };
  runId: string;
}

async function createActiveRun(): Promise<Created> {
  const seeded = await seedV2Fixture(sql, {
    objectiveStatement: "间隔重复依赖遗忘曲线安排复习",
    publicSummary: "间隔重复",
    front: { cue: "间隔重复", prompt: "为什么间隔重复比集中复习更有效？" },
  });
  const { runId } = await withWorkspaceTransaction(
    { workspaceId: seeded.workspaceId, userId: seeded.userId },
    async (tx) =>
      createRunV2(tx, {
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.objectiveId },
          goal: "stabilize",
          idempotencyKey: `origin-contract-${seeded.workspaceId.slice(0, 8)}`,
        },
      }),
  );
  return { seeded, runId };
}

test("origin-contract: createRunV2 → 公开视图输出严格 V1 合同形状", async () => {
  const { seeded, runId } = await createActiveRun();
  try {
    await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => {
        const view = await getRunPublicView(tx, {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          runId,
        });
        // origin 必须是 V1 合同形状：keyPointId 存在且等于 objectiveId alias
        assert.equal(view.origin.kind, "card");
        assert.equal(
          (view.origin as { keyPointId?: string }).keyPointId,
          seeded.objectiveId,
          "公开 origin.keyPointId 必须携带 objectiveId alias（合同承诺字段）",
        );
        // returnTarget 完整：cardId + keyPointId + objectiveId 标记
        assert.deepEqual(view.returnTarget, {
          kind: "card",
          cardId: seeded.cardId,
          keyPointId: seeded.objectiveId,
          objectiveId: seeded.objectiveId,
        });
      },
    );
  } finally {
    await seeded.cleanup();
  }
});

test("origin-contract: 进行中的 run 在 Objective Surface 上解析出 resume_run", async () => {
  const { seeded, runId } = await createActiveRun();
  try {
    await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => {
        const surface = await assembleObjectiveSurfaceV3(tx, {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
        }, seeded.objectiveId);
        assert.ok(
          surface.personal.activeRun,
          "active run 必须经 origin alias 解析到 personal.activeRun",
        );
        assert.equal(surface.personal.activeRun?.runId, runId);
        assert.equal(
          surface.primaryAction.kind,
          "resume_run",
          "存在进行中 run 时唯一主行动必须是 resume_run（此前因漂移恒为 create_run）",
        );
        if (surface.primaryAction.kind === "resume_run") {
          assert.equal((surface.primaryAction as { runId: string }).runId, runId);
        }
      },
    );
  } finally {
    await seeded.cleanup();
  }
});

test("origin-contract: 幂等重放返回的既有 run 同样满足 V1 合同", async () => {
  const seeded = await seedV2Fixture(sql, {
    objectiveStatement: "工作记忆容量限制学习组块大小",
    publicSummary: "工作记忆",
    front: { cue: "工作记忆", prompt: "什么是工作记忆容量限制？" },
  });
  try {
    const request = {
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      request: {
        originV2: { kind: "card" as const, cardId: seeded.cardId, objectiveId: seeded.objectiveId },
        goal: "clarify" as const,
        idempotencyKey: "origin-contract-idem-1",
      },
    };
    const first = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => createRunV2(tx, request),
    );
    const replay = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => createRunV2(tx, request),
    );
    assert.equal(replay.runId, first.runId, "幂等 key 必须重放同一 run");
    await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => {
        const view = await getRunPublicView(tx, {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          runId: replay.runId,
        });
        assert.equal((view.origin as { keyPointId?: string }).keyPointId, seeded.objectiveId);
        if (view.returnTarget.kind === "card") {
          assert.equal(view.returnTarget.cardId, seeded.cardId);
          assert.equal(view.returnTarget.keyPointId, seeded.objectiveId);
        } else {
          throw new Error("returnTarget.kind 应为 card");
        }
      },
    );
  } finally {
    await seeded.cleanup();
  }
});
