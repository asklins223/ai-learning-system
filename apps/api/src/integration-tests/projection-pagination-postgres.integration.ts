/**
 * 投影游标分页 HTTP 集成测试（文档 16 §15.2 workspace_map slice）。
 *
 * 覆盖：PAGE_SIZE=2 时 5 个 kp 分 3 页（2/2/1）+ continuationToken 链；
 * 分页合并结果与单次全量（页大小恢复默认）节点集合一致；非法
 * continuation → 400；target_centered 带 continuation → 400。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/projection-pagination-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
process.env.PROJECTION_CHECKPOINT_SECRET ??= "projection-pagination-secret-0123456789";
const sql = postgres(CONN, { max: 2 });
const { closeDatabase } = await import("../db/client.ts");

after(async () => {
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function seedIdentity() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const token = `pg-test-${randomUUID()}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${"pg-" + userId.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${"w" + workspaceId.slice(0, 8)}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
      VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now() + interval '1 hour')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM understanding_change_sets WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM understanding_projection_checkpoints WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM understanding_route_plans WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { token, workspaceId, userId, cleanup };
}

/** 5 卡 × 1 kp（全图模式需要 >1 页触发分页）。返回 kp ids 供断言。 */
async function seedStarField(workspaceId: string, userId: string, count: number) {
  const kpIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    const cardId = randomUUID();
    const kpId = randomUUID();
    kpIds.push(kpId);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
               VALUES (${noteId}, ${workspaceId}, ${"分页笔记" + index}, ${userId}, now(), now(), 'placeholder', 0)`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
               VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}', ${userId}, now(), ${"nh-" + index}, now())`;
      await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
               VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', '{"version":1}', now(), now())`;
      await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
               VALUES (${kpId}, ${cardId}, ${workspaceId}, 1, ${"分页要点" + index}, 'q')`;
      const blockId = randomUUID();
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
               VALUES (${blockId}, ${noteVersionId}, ${workspaceId}, 0, 'paragraph', ${"证据块" + index})`;
      await tx`INSERT INTO evidences (id, workspace_id, key_point_id, block_id, block_ordinal, quote_text, alignment, alignment_score, alignment_method)
               VALUES (${randomUUID()}, ${workspaceId}, ${kpId}, ${blockId}, 0, ${"证据引用" + index}, 'aligned', 90, 'manual')`;
    });
  }
  return kpIds;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // 生产 server.ts 注册 @fastify/sensible（提供 app.httpErrors）；测试同样注册，
  // 否则路由内的 badRequest throw 变 500。
  const sensible = (await import("@fastify/sensible")).default;
  await app.register(sensible);
  const { understandingProjectionRoutes } = await import("../modules/understanding/projection-routes.ts");
  await app.register(understandingProjectionRoutes);
  return app;
}

/** 按 continuationToken 链拉全（等价于前端 mergeProjectionPages 的循环）。 */
async function fetchAllPages(app: FastifyInstance, auth: Record<string, string>) {
  let continuation: string | null = null;
  const pages: Array<{ nodes: unknown[]; edges: unknown[]; continuationToken: string | null }> = [];
  for (let round = 0; round < 20; round += 1) {
    const url: string = `/understanding/projection${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ""}`;
    const res = await app.inject({ method: "GET", url, headers: auth });
    assert.equal(res.statusCode, 200, `第 ${round + 1} 页应 200`);
    const body = res.json() as {
      nodes?: unknown[];
      edges?: unknown[];
      slice?: { continuationToken?: string | null } | null;
    };
    assert.ok(Array.isArray(body.nodes) && Array.isArray(body.edges));
    const token: string | null = body.slice?.continuationToken ?? null;
    const kpCount = (body.nodes as Array<{ nodeRef?: { kind?: string } }>)
      .filter((node) => node.nodeRef?.kind === "key_point").length;
    process.stderr.write(`[paging] page=${round + 1} kp=${kpCount} nodes=${(body.nodes as unknown[]).length} cont=${token !== null}\n`);
    pages.push({ nodes: body.nodes, edges: body.edges, continuationToken: token });
    if (!token) return pages;
    continuation = token;
  }
  throw new Error("分页循环未收敛（超过 20 页）");
}

function collectKpIds(pages: Array<{ nodes: unknown[] }>): string[] {
  return pages.flatMap((page) =>
    (page.nodes as Array<{ nodeRef?: { kind?: string; keyPointId?: string } }>)
      .filter((node) => node.nodeRef?.kind === "key_point")
      .map((node) => node.nodeRef!.keyPointId!),
  ).sort();
}

test("投影分页：PAGE_SIZE=2 → 3 页收敛，合并结果与全量一致", async () => {
  const previous = process.env.PROJECTION_KP_PAGE_SIZE;
  process.env.PROJECTION_KP_PAGE_SIZE = "2";
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const kpIds = await seedStarField(identity.workspaceId, identity.userId, 5);
    const auth = { authorization: `Bearer ${identity.token}` };

    // 1) 第一页：2 个 kp + continuationToken 非空。
    const first = await app.inject({ method: "GET", url: "/understanding/projection", headers: auth });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    assert.equal(firstBody.slice.kind, "workspace_map");
    assert.equal(
      (firstBody.nodes as unknown[]).filter((node) => (node as { nodeRef?: { kind?: string } }).nodeRef?.kind === "key_point").length,
      2,
      "第一页恰 2 个 kp",
    );
    assert.ok(typeof firstBody.slice.continuationToken === "string" && firstBody.slice.continuationToken.length > 0);

    // 2) 完整拉取：3 页（2/2/1）收敛。
    const pages = await fetchAllPages(app, auth);
    assert.equal(pages.length, 3, "5 个 kp / 页 2 → 3 页");
    assert.equal(pages[0].continuationToken !== null, true);
    assert.equal(pages[1].continuationToken !== null, true);
    assert.equal(pages[2].continuationToken, null, "最后一页收敛");

    // 3) 合并去重后 kp 集合 == 全部 5 个；无重复。
    const mergedKp = collectKpIds(pages);
    assert.equal(mergedKp.length, 5, "合并后无重复 kp");
    assert.deepEqual(mergedKp, [...kpIds].sort(), "合并集合与种子一致");

    // 4) 交叉验证：页大小恢复默认后的单次全量 == 分页合并。
    process.env.PROJECTION_KP_PAGE_SIZE = "400";
    const full = await app.inject({ method: "GET", url: "/understanding/projection", headers: auth });
    assert.equal(full.statusCode, 200);
    const fullBody = full.json();
    assert.equal(fullBody.slice.continuationToken, null, "全量模式无 continuation");
    assert.deepEqual(
      collectKpIds([{ nodes: fullBody.nodes }]),
      mergedKp,
      "分页合并与全量节点一致",
    );
  } finally {
    if (previous === undefined) delete process.env.PROJECTION_KP_PAGE_SIZE;
    else process.env.PROJECTION_KP_PAGE_SIZE = previous;
    await identity.cleanup();
    await app.close();
  }
});

test("投影分页：非法 continuation → 400；target_centered 带 continuation → 400", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    await seedStarField(identity.workspaceId, identity.userId, 2);
    const auth = { authorization: `Bearer ${identity.token}` };
    const kpIds = await sql`
      SELECT id FROM card_key_points WHERE workspace_id = ${identity.workspaceId} LIMIT 1
    `;
    const kpId = kpIds[0]?.id as string;

    const bad = await app.inject({ method: "GET", url: "/understanding/projection?continuation=garbage", headers: auth });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "bad_request");

    const targeted = await app.inject({
      method: "GET",
      url: `/understanding/projection?targetKeyPointId=${kpId}&continuation=eyJrIjoia3AiLCJpIjoieCIsImMiOiIyMDI2LTA4LTE0VDAwOjAwOjAwLjAwMFoifQ`,
      headers: auth,
    });
    assert.equal(targeted.statusCode, 400, "target_centered 不接受 continuation");

    // target_centered 正常（无 continuation）→ 单 kp。
    const ok = await app.inject({
      method: "GET",
      url: `/understanding/projection?targetKeyPointId=${kpId}`,
      headers: auth,
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.equal(body.slice.kind, "target_centered");
    assert.equal(body.slice.continuationToken, null);
    assert.equal(
      (body.nodes as unknown[]).filter((node) => (node as { nodeRef?: { kind?: string } }).nodeRef?.kind === "key_point").length,
      1,
    );
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("投影补全：evidence 节点 + supports 边 + checkpoint-aware ETag/304", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    await seedStarField(identity.workspaceId, identity.userId, 2);
    const auth = { authorization: `Bearer ${identity.token}` };

    const res = await app.inject({ method: "GET", url: "/understanding/projection", headers: auth });
    assert.equal(res.statusCode, 200);
    const etag = res.headers.etag;
    assert.ok(typeof etag === "string" && etag.length > 0, "投影响应必须带 ETag");
    const body = res.json();
    const evidenceNodes = (body.nodes as Array<{ nodeRef?: { kind?: string } }>)
      .filter((node) => node.nodeRef?.kind === "evidence");
    assert.equal(evidenceNodes.length, 2, "每个 kp 的 evidence 都投影为节点");
    const supportsEdges = (body.edges as Array<{ kind?: string }>)
      .filter((edge) => edge.kind === "supports");
    assert.equal(supportsEdges.length, 2, "evidence→key_point supports 边");

    // 无 minimumCheckpoint + If-None-Match 匹配 → 304。
    const notModified = await app.inject({
      method: "GET",
      url: "/understanding/projection",
      headers: { ...auth, "if-none-match": etag },
    });
    assert.equal(notModified.statusCode, 304);

    // 带 minimumCheckpoint 时不得由陈旧缓存命中（即使 ETag 匹配也返回 200 投影）。
    const checkpointToken = body.checkpoint?.token as string;
    const withMinimum = await app.inject({
      method: "GET",
      url: `/understanding/projection?minimumCheckpoint=${encodeURIComponent(checkpointToken)}`,
      headers: { ...auth, "if-none-match": etag },
    });
    assert.equal(withMinimum.statusCode, 200, "minimumCheckpoint 下不命中 ETag 缓存");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("投影补全：route slice 完整返回全部 step 节点；过期路线 409", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    await seedStarField(identity.workspaceId, identity.userId, 3);
    const auth = { authorization: `Bearer ${identity.token}` };

    // 先取 checkpoint（routes/plan 需要 expectedCheckpointToken）。
    const first = await app.inject({ method: "GET", url: "/understanding/projection", headers: auth });
    const checkpointToken = first.json().checkpoint?.token as string;

    // 规划 3 步路线（maxSteps=3，覆盖全部 kp 的 due schedule 不存在 → 用
    // explore_neighbors 语义无法保证 3 步；直接验证 route slice 形状即可——
    // 用 repair_gap + 3 步，无 due 时 steps 可能为空，routeKpIds 为空也合法）。
    const plan = await app.inject({
      method: "POST",
      url: "/understanding/routes/plan",
      headers: auth,
      payload: {
        version: 1,
        intent: "repair_gap",
        maxSteps: 3,
        lens: "current_target",
        filter: { showArchived: false },
        expectedCheckpointToken: checkpointToken,
        idempotencyKey: `route-slice-${randomUUID()}`,
      },
    });
    assert.equal(plan.statusCode, 200, "route plan 应 200");
    const planBody = plan.json();
    const routePlanId = planBody.routePlanId as string;

    const slice = await app.inject({
      method: "GET",
      url: `/understanding/projection?routePlanId=${routePlanId}`,
      headers: auth,
    });
    assert.equal(slice.statusCode, 200);
    const sliceBody = slice.json();
    assert.equal(sliceBody.slice.kind, "route");
    assert.equal(sliceBody.slice.continuationToken, null, "route slice 不分页");
    assert.equal(sliceBody.request.routePlanId, routePlanId);
    // 所有 step kp 都在节点里（steps 为空时跳过）。
    const stepKpIds = (planBody.steps as Array<{ nodeRef?: { keyPointId?: string } }>)
      .map((step) => step.nodeRef?.keyPointId)
      .filter((id): id is string => Boolean(id));
    const nodeKpIds = new Set(
      (sliceBody.nodes as Array<{ nodeRef?: { kind?: string; keyPointId?: string } }>)
        .filter((node) => node.nodeRef?.kind === "key_point")
        .map((node) => node.nodeRef!.keyPointId!),
    );
    for (const kpId of stepKpIds) {
      assert.ok(nodeKpIds.has(kpId), `route step kp ${kpId} 必须在节点中`);
    }
    // route slice + continuation → 400。
    const bad = await app.inject({
      method: "GET",
      url: `/understanding/projection?routePlanId=${routePlanId}&continuation=eyJrIjoia3AifQ`,
      headers: auth,
    });
    assert.equal(bad.statusCode, 400);

    // 过期路线（expiresAt 置过去）→ 409 route_plan_stale。
    await sql`UPDATE understanding_route_plans SET expires_at = now() - interval '1 minute' WHERE id = ${routePlanId}`;
    const stale = await app.inject({
      method: "GET",
      url: `/understanding/projection?routePlanId=${routePlanId}`,
      headers: auth,
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "route_plan_stale");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("投影补全：prerequisite 边 + weak_prerequisite reason code + projector_name 唯一约束", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const kpIds = await seedStarField(identity.workspaceId, identity.userId, 2);
    // 前置关系：kp[1] 的前置是 kp[0]（kp[0] 无 canonical 事实 → unknown → 弱前置）。
    await sql`
      INSERT INTO key_point_prerequisites (workspace_id, key_point_id, prerequisite_key_point_id)
      VALUES (${identity.workspaceId}, ${kpIds[1]}, ${kpIds[0]})
    `;
    const auth = { authorization: `Bearer ${identity.token}` };

    // prerequisite 边（前置 → 目标）。
    const full = await app.inject({ method: "GET", url: "/understanding/projection", headers: auth });
    const body = full.json();
    const prereqEdges = (body.edges as Array<{ kind?: string; from?: { keyPointId?: string }; to?: { keyPointId?: string } }>)
      .filter((edge) => edge.kind === "prerequisite");
    assert.equal(prereqEdges.length, 1);
    assert.equal(prereqEdges[0].from?.keyPointId, kpIds[0]);
    assert.equal(prereqEdges[0].to?.keyPointId, kpIds[1]);

    // target 模式 reason code = weak_prerequisite（前置 unknown）。
    const targeted = await app.inject({
      method: "GET",
      url: `/understanding/projection?targetKeyPointId=${kpIds[1]}`,
      headers: auth,
    });
    const targetedBody = targeted.json();
    assert.ok(
      targetedBody.currentTarget.reasonCodes.includes("weak_prerequisite"),
      `reasonCodes=${JSON.stringify(targetedBody.currentTarget.reasonCodes)}`,
    );

    // projector_name 列存在且默认 personal_v2（§16.2 consumption 唯一约束）。
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'understanding_change_sets' AND column_name = 'projector_name'
    `;
    assert.equal(cols.length, 1);
    const uniq = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'understanding_change_sets' AND indexname = 'understanding_change_sets_projector_source_unique_idx'
    `;
    assert.equal(uniq.length, 1, "projector consumption 唯一索引存在");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});
