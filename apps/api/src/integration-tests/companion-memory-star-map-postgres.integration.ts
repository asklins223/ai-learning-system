/**
 * 记忆星图（GET /companion/memory/star-map）的实库契约。
 *
 * 该模块此前零覆盖，但它承载三条产品硬规则：
 *   1. 候选记忆（candidate=true）**不得**进入星图——星图展示的是用户已确认的理解，
 *      未确认的模型推测不能以「节点」形式出现在用户的知识视图里；
 *   2. 已删除 / 已归档记忆不出现；
 *   3. pinned 节点排在 active 之前，实体关联（含 orphaned 标记）随之返回。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getMemoryStarMap } from "../modules/companion-conversation/memory-star-map.ts";
import {
  archiveMemory,
  confirmMemory,
  deleteMemory,
  pinMemory,
  upsertMemory,
} from "../modules/companion-conversation/memory-service.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——memory star map 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();
const scope = { workspaceId, userId };
const email = `memory-star-map-${userId.slice(0, 8)}@example.test`;

after(async () => {
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${email}, 'test-hash', 'owner')
`;

const inTx = <T>(run: (tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0]) => Promise<T>) =>
  withWorkspaceTransaction(scope, run);

test("候选记忆不进星图；确认后才成为节点（默认 candidate=true 是隐私安全默认）", async () => {
  // upsertMemory 的默认是 candidate=true（未显式声明即为未确认）——这条默认保证
  // 「模型/接口随手写入的内容」不会自动出现在用户的知识视图里。
  const candidate = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "preference",
    content: "候选：喜欢早上学习",
    sourceEventId: `star-map-candidate:${randomUUID()}`,
  }));
  assert.equal(candidate.candidate, true, "未显式传 candidate 时必须落为候选");

  const pendingIds = (await inTx((tx) => getMemoryStarMap(tx, scope))).nodes.map((node) => node.memoryId);
  assert.equal(pendingIds.includes(candidate.memoryItemId), false, "候选记忆必须被排除");

  // 用户确认 → 成为正式节点。
  await inTx((tx) => confirmMemory(tx, scope, candidate.memoryItemId));
  const confirmedIds = (await inTx((tx) => getMemoryStarMap(tx, scope))).nodes.map((node) => node.memoryId);
  assert.equal(confirmedIds.includes(candidate.memoryItemId), true, "确认后的记忆必须出现");
  assert.equal(
    (await inTx((tx) => getMemoryStarMap(tx, scope))).nodes.find((n) => n.memoryId === candidate.memoryItemId)?.state,
    "active",
  );

  // 显式 candidate=false（已确认来源，如用户手动写入）直接成为节点。
  const direct = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "goal",
    content: "已确认：本月完成拓扑一章",
    sourceEventId: `star-map-confirmed:${randomUUID()}`,
    candidate: false,
  }));
  const map = await inTx((tx) => getMemoryStarMap(tx, scope));
  assert.equal(map.nodes.map((node) => node.memoryId).includes(direct.memoryItemId), true);
  assert.equal(map.version, 1);
  assert.equal(map.cursor, null);
});

test("已删除与已归档记忆不出现在星图", async () => {
  const deleted = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "learning_context",
    content: "将被删除",
    sourceEventId: `star-map-deleted:${randomUUID()}`,
    candidate: false,
  }));
  const archived = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "learning_context",
    content: "将被归档",
    sourceEventId: `star-map-archived:${randomUUID()}`,
    candidate: false,
  }));

  await inTx((tx) => deleteMemory(tx, scope, deleted.memoryItemId));
  await inTx((tx) => archiveMemory(tx, scope, archived.memoryItemId));

  const ids = (await inTx((tx) => getMemoryStarMap(tx, scope))).nodes.map((node) => node.memoryId);
  assert.equal(ids.includes(deleted.memoryItemId), false, "已删除记忆不得出现");
  assert.equal(ids.includes(archived.memoryItemId), false, "已归档记忆不得出现");
});

test("pinned 节点排在 active 之前，且实体关联与 orphaned 标记如实返回", async () => {
  const plain = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "interaction_note",
    content: "普通记忆",
    importance: 0.9,
    sourceEventId: `star-map-plain:${randomUUID()}`,
    candidate: false,
  }));
  const pinned = await inTx((tx) => upsertMemory(tx, scope, {
    kind: "interaction_note",
    content: "固定记忆（重要性更低）",
    importance: 0.1,
    sourceEventId: `star-map-pinned:${randomUUID()}`,
    candidate: false,
  }));
  await inTx((tx) => pinMemory(tx, scope, pinned.memoryItemId));

  const entityId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`
      INSERT INTO memory_links (memory_id, workspace_id, user_id, entity_type, entity_id, auto_linked, orphaned)
      VALUES (${pinned.memoryItemId}, ${workspaceId}, ${userId}, 'note', ${entityId}, true, true)
    `;
  });

  const map = await inTx((tx) => getMemoryStarMap(tx, scope));
  const pinnedIndex = map.nodes.findIndex((node) => node.memoryId === pinned.memoryItemId);
  const plainIndex = map.nodes.findIndex((node) => node.memoryId === plain.memoryItemId);
  assert.ok(pinnedIndex >= 0 && plainIndex >= 0, "两条记忆都必须在星图中");
  assert.ok(pinnedIndex < plainIndex, "pinned 必须排在 active 之前（与 importance 无关）");
  assert.equal(map.nodes[pinnedIndex]?.state, "pinned");

  const links = map.nodes[pinnedIndex]?.entityLinks ?? [];
  assert.deepEqual(links, [{ entityType: "note", entityId, orphaned: true }]);
  assert.deepEqual(map.nodes[plainIndex]?.entityLinks, [], "无关联节点返回空数组而不是 null");
});

test("跨用户隔离：另一个用户的星图为空", async () => {
  const map = await withWorkspaceTransaction(
    { workspaceId, userId: randomUUID() },
    async (tx) => {
      // RLS 会按 app.user_id 过滤；即使 scope 指向别人的 userId，也不得返回行。
      return getMemoryStarMap(tx, { workspaceId, userId });
    },
  );
  assert.equal(map.nodes.length, 0);
});
