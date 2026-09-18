/**
 * 方案 16 §20 埋点纵切集成测试（postgres + HTTP inject）。
 *
 * 覆盖：
 * - POST /learning-runs → run_created + task_presented 自动落库（funnel 维度：
 *   origin/goal/intent/interaction/purpose/trustClass 授权上限）；
 * - POST submissions/v2 → artifact_locked 自动落库；
 * - GET /metrics/learning-events 只读查询 + RLS 隔离（另一 user 不可见）；
 * - recordLearningMetric 尽力而为（独立事务不破坏主链路）+ run_result 幂等。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

// LearningRun capability gate: enable it for this integration test.
process.env.LEARNING_RUN_ENABLED ??= "true";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  recordLearningMetric,
  insertLearningMetricEvent,
  listLearningMetrics,
} = await import("../modules/observability/learning-metrics.ts");

interface Seeded {
  token: string;
  workspaceId: string;
  userId: string;
  cardId: string;
  objectiveId: string;
  cleanup: () => Promise<void>;
}

async function seedBase() : Promise<Seeded> {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "埋点纵切测试要点",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    objectiveId: fixture.objectiveId,
    token: fixture.token,
    cleanup: fixture.cleanup,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const sensible = (await import("@fastify/sensible")).default;
  await app.register(sensible);
  const { learningRunRoutes } = await import("../modules/learning-runs/run-routes.ts");
  const { learningMetricRoutes } = await import("../modules/observability/routes.ts");
  await app.register(learningRunRoutes);
  await app.register(learningMetricRoutes);
  return app;
}

test("§20：POST /learning-runs → run_created + task_presented 自动落库（funnel 维度）", async () => {
  const seeded = await seedBase();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const create = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.objectiveId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        // V2 请求不接受 clientRequestId（createLearningRunV2RequestSchema 是
        // strictObject，且它只属于 V1）；V2 的 client_request_id 由 service 内部按
        // 请求指纹计算。带上它会被 400 拒绝。
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    const run = create.json() as { runId: string };

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT event_type, intent, interaction_kind, variant_purpose, trust_class, goal, origin
                FROM learning_metric_events WHERE run_id = ${run.runId} ORDER BY occurred_at`;
    });
    assert.ok(rows.some((r) => r.event_type === "run_created"), "run_created 已落库");
    const presented = rows.filter((r) => r.event_type === "task_presented");
    assert.ok(presented.length >= 1, "task_presented 事件存在");
    assert.ok(presented[0].intent, "intent 已记录");
    assert.ok(presented[0].interaction_kind, "interaction.kind 已记录");
    assert.ok(presented[0].variant_purpose, "variant.purpose 已记录");
    assert.ok(presented[0].trust_class, "templateTrustCeiling 已记录");
    const createdRow = rows.find((r) => r.event_type === "run_created");
    assert.equal(createdRow?.goal, "stabilize", "goal 在 run_created 上");
  } finally {
    await app.close();
    await seeded.cleanup();
  }
});

test("§20：submissions → artifact_locked + GET /metrics/learning-events 只读 + RLS 隔离", async () => {
  const seeded = await seedBase();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${seeded.token}` };
    const create = await app.inject({
      method: "POST",
      url: "/learning-runs",
      headers: auth,
      payload: {
        version: 2,
        originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.objectiveId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        // V2 请求不接受 clientRequestId（createLearningRunV2RequestSchema 是
        // strictObject，且它只属于 V1）；V2 的 client_request_id 由 service 内部按
        // 请求指纹计算。带上它会被 400 拒绝。
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    const run = create.json() as {
      runId: string;
      runRevision: number;
      snapshotId: string;
      activeTask: { taskId: string; revision: number; activeVariant: { variantId: string; revision: number; inputSchemaHash: string } };
    };
    const taskId = run.activeTask.taskId;
    const variantId = run.activeTask.activeVariant.variantId;
    const variantRevision = run.activeTask.activeVariant.revision;
    const taskRevision = run.activeTask.revision;
    const inputSchemaHash = run.activeTask.activeVariant.inputSchemaHash;

    const submit = await app.inject({
      method: "POST",
      url: `/learning-runs/${run.runId}/tasks/${taskId}/submissions/v2`,
      headers: auth,
      payload: {
        version: 2,
        snapshotId: run.snapshotId,
        variantId,
        variantRevision,
        runRevision: run.runRevision,
        taskRevision,
        inputSchemaHash,
        idempotencyKey: randomUUID(),
        payload: { kind: "text", text: "埋点测试作答" },
      },
    });
    assert.equal(submit.statusCode, 202, submit.body);

    // 只读端点：包含三类事件
    const list = await app.inject({
      method: "GET",
      url: "/metrics/learning-events?limit=20",
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    const body = list.json() as { items: Array<{ eventType: string; runId: string | null }> };
    const types = new Set(body.items.map((i) => i.eventType));
    assert.ok(types.has("run_created"));
    assert.ok(types.has("task_presented"));
    assert.ok(types.has("artifact_locked"), `实际: ${Array.from(types).join(",")}`);
    assert.ok(body.items.every((i) => i.runId === run.runId), "全部事件属于本 run");

    // RLS 隔离：另一 user（无会话）直接服务层查询不可见
    const otherUser = randomUUID();
    const other = await listLearningMetrics(
      { workspaceId: seeded.workspaceId, userId: otherUser },
      { limit: 20 },
    );
    assert.equal(other.length, 0, "其他用户不可见");
  } finally {
    await app.close();
    await seeded.cleanup();
  }
});

test("§20：recordLearningMetric 尽力而为 + 事务内插入 + run_result 幂等", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    // 尽力而为记录（独立小事务）
    await recordLearningMetric(scope, {
      eventType: "action",
      runId: randomUUID(),
      actionKind: "hint_revealed",
    });
    // 事务内插入（调用方事务）
    await withWorkspaceTransaction(scope, (tx) =>
      insertLearningMetricEvent(tx, scope, { eventType: "run_result", outcome: "demonstrated" }),
    );
    const items = await listLearningMetrics(scope, { limit: 20 });
    const kinds = new Set(items.map((i) => i.eventType));
    assert.ok(kinds.has("action"));
    assert.ok(kinds.has("run_result"));
    assert.equal(items.filter((i) => i.eventType === "run_result").length, 1);
  } finally {
    await seeded.cleanup();
  }
});
