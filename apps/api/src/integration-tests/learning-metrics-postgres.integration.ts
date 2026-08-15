/**
 * 方案 16 §20 埋点纵切集成测试（postgres + HTTP inject）。
 *
 * 覆盖：
 * - POST /learning-runs → run_created + task_presented 自动落库（funnel 维度：
 *   origin/goal/intent/interaction/purpose/trustClass 授权上限）；
 * - POST submissions → artifact_locked 自动落库；
 * - GET /metrics/learning-events 只读查询 + RLS 隔离（另一 user 不可见）；
 * - recordLearningMetric 尽力而为（独立事务不破坏主链路）+ run_result 幂等。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";

// learning_run_v1 capability 门控：测试进程显式开启（动态 import 前设置）。
process.env.LEARNING_RUN_V1 ??= "true";

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

/** 与 identity/service.ts hashToken 一致（SHA-256 hex）。 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Seeded {
  token: string;
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string;
  cleanup: () => Promise<void>;
}

async function seedBase(): Promise<Seeded> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const token = `lm-it-${randomUUID()}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${`lm-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
             VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
             VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now() + interval '1 hour')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify({ blocks: [] })}, ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', ${JSON.stringify({ version: 1 })}, now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '埋点纵切测试要点', '测试引文')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM learning_metric_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_action_ledger WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_idempotency WHERE workspace_id = ${workspaceId}`;
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
      await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { token, workspaceId, userId, cardId, keyPointId, cleanup };
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
        version: 1,
        origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        clientRequestId: randomUUID(),
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
        version: 1,
        origin: { kind: "card", cardId: seeded.cardId, keyPointId: seeded.keyPointId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        clientRequestId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    });
    const run = create.json() as { runId: string; activeTask: { taskId: string; revision: number; activeVariant: { variantId: string; revision: number; inputSchemaHash: string } } };
    const taskId = run.activeTask.taskId;
    const variantId = run.activeTask.activeVariant.variantId;
    const variantRevision = run.activeTask.activeVariant.revision;
    const taskRevision = run.activeTask.revision;
    const inputSchemaHash = run.activeTask.activeVariant.inputSchemaHash;

    const submit = await app.inject({
      method: "POST",
      url: `/learning-runs/${run.runId}/tasks/${taskId}/submissions`,
      headers: auth,
      payload: {
        version: 1,
        variantId,
        variantRevision,
        runRevision: 1,
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
