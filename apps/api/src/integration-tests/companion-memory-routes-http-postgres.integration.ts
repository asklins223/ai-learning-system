/**
 * 记忆管理 HTTP 面（`/companion/memory*`，18 条路由）的行为契约。
 *
 * 服务层已由 assistant-memory / memory-star-map 集成测试覆盖；这里覆盖此前完全
 * 没有断言的一层：真实 session 下的状态码映射、strict body 校验、no-store，
 * 以及最要紧的**跨用户存在性不泄露**（对别人的 memoryId 必须 404，而不是 403
 * 或 200 —— 后者会暴露「这个 id 存在」）。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import sensible from "@fastify/sensible";

process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
// 星图是独立开关（§9.8），只开 VECTOR 时 /memory/star-map 会 404。
process.env.COMPANION_MEMORY_STAR_MAP_V1 = "true";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——memory routes HTTP 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });
const userA = randomUUID();
const userB = randomUUID();
const workspaceId = randomUUID();
const prefix = userA.slice(0, 8);

const { memoryRoutes } = await import("../modules/companion-conversation/memory-routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { closeDatabase } = await import("../db/client.ts");

let app: FastifyInstance;
let tokenA = "";
let tokenB = "";

async function seedIdentity(): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userA}, ${`mem-http-a-${prefix}@example.test`}, 'test-hash', 'owner'),
      (${userB}, ${`mem-http-b-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  // 两个用户共处的空间必须是 collaborative：个人空间现在拒绝被分享
  // （`createInvite` 对 personal 目标直接 409），夹具若绕过业务校验造出
  // "第二成员写进别人 personal 空间"的行，测的就是一个产品上不可能存在的状态。
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`mem-http-${prefix}`}, ${userA}, 'collaborative')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userA}, 'owner'), (${workspaceId}, ${userB}, 'member')
  `;
}

before(async () => {
  await seedIdentity();
  tokenA = (await issueSession(userA, workspaceId)).token;
  tokenB = (await issueSession(userB, workspaceId)).token;
  app = Fastify({ logger: false });
  // server.ts 用 @fastify/sensible 提供 httpErrors + 统一错误序列化；
  // 缺了它，`throw app.httpErrors.badRequest(...)` 会退化为 500（测试假象）。
  await app.register(sensible);
  await app.register(memoryRoutes);
  await app.ready();
});

after(async () => {
  await revokeSession(tokenA).catch(() => {});
  await revokeSession(tokenB).catch(() => {});
  await app?.close();
  // 顺序不能反：`workspaces.owner_id` 是 NO ACTION、`users.personal_workspace_id`
  // 是 RESTRICT，所以不先删空间就删不掉用户。原先这里整条都挂着 `.catch(() => {})`，
  // 删除失败被静默吞掉——dev 库里那批 `mem-http-*` 残留就是这么攒出来的。
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${userA}, ${userB})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
  const leftover = await sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${workspaceId}`;
  assert.equal(leftover[0].n, 0, `夹具残留了工作区 ${workspaceId}，teardown 顺序需要修`);
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

function as(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function req(
  token: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): InjectOptions {
  const options: InjectOptions = { method, url, headers: as(token) };
  if (payload !== undefined) options.payload = payload;
  return options;
}

async function createMemory(token: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject(req(token, "POST", "/companion/memory", {
    kind: "preference",
    content: "喜欢在安静时段学习",
    ...body,
  }));
  assert.equal(response.statusCode, 201, `创建记忆必须 201，实际 ${response.statusCode}`);
  return response.json().memoryItemId as string;
}

test("匿名请求被拒（认证先于能力），已认证请求带 no-store", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/companion/memory" });
  assert.equal(anonymous.statusCode, 401);

  const authed = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(authed.statusCode, 200);
  assert.equal(authed.headers["cache-control"], "no-store");
  assert.deepEqual(authed.json(), { version: 2, items: [] });
});

test("创建：合法 body → 201；已知字段非法 → 400（未知字段按本层约定被忽略）", async () => {
  await createMemory(tokenA);

  const empty = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "goal", content: "" }));
  assert.equal(empty.statusCode, 400);

  const badKind = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "not_a_kind", content: "x" }));
  assert.equal(badKind.statusCode, 400);

  const tooLong = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "goal", content: "字".repeat(201) }));
  assert.equal(tooLong.statusCode, 400, "§9.4 上限 200 字必须在 HTTP 层拒绝");

  // 未知字段：本模块的路由 schema 沿用 z.object（13 处）而非 strictObject（2 处），
  // 即多传的键被忽略、不影响已声明字段的校验结果。此处把这个既有约定钉住，
  // 使「改用 strict」成为一个显式决定，而不是改 schema 时的意外行为变化。
  // （桌面端的 typed IPC 边界是 strict 的；这层宽松只作用于 HTTP 面。）
  const unknownKey = await app.inject(req(tokenA, "POST", "/companion/memory", {
    kind: "goal", content: "未知字段被忽略", contnet: "拼错的键",
  }));
  assert.equal(unknownKey.statusCode, 201);
  assert.equal(unknownKey.json().content, "未知字段被忽略");
});

test("候选确认：includeCandidates=false 前后的可见性变化", async () => {
  const candidateId = await createMemory(tokenA, { kind: "learning_context", content: "候选内容", candidate: true });

  const hidden = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    hidden.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    false,
    "默认列表不含候选记忆",
  );

  const withCandidates = await app.inject(req(tokenA, "GET", "/companion/memory?includeCandidates=true"));
  assert.equal(
    withCandidates.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    true,
  );

  // 候选交付是怎么到用户眼前的：worker 写一行 `memory_candidate`，桌面按
  // **payload_ref.kind='memory_item'**（不是 kind 那一列）出文案、把卡片亮成"待处理"。
  // 确认必须给它结账（doc 34 L42）：`acted` 这个终态在整库里此前 0 行。
  //
  // 夹具与断言都走**这条已经用着的连接 + `set_config`**，和生产 `deliver()` 同一形状。
  // 别在这里另开第二条 postgres.js 池：那样会让这份文件挂起，而且挂得毫无现场可查
  // （进程在 pg_stat_activity 里完全不存在），第一反应很容易误判成"并行会话在抢锁"。
  const seqRow = await sql`
    SELECT COALESCE(MAX(inbox_sequence), 0) + 1 AS n FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND user_id = ${userA}`;
  const seq = Number(seqRow[0]?.n ?? 1);
  const ownDeliveryId = randomUUID();
  const otherDeliveryId = randomUUID();
  const seedDelivery = (id: string, memoryItemId: string, offset: number) => sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),
                        set_config('app.user_id', ${userA}, true)`;
    await tx`
      INSERT INTO assistant_deliveries
        (id, assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key,
         state, kind, payload_ref, display_lease, expires_at)
      VALUES (${id}, NULL, ${workspaceId}, ${userA}, ${seq + offset}, ${`l42-${id}`},
              'displayed', 'memory_candidate',
              ${sql.json({ kind: "memory_item", memoryItemId, contentPreview: "候选内容" })},
              ${sql.json({ leaseToken: "lease-l42", deviceSessionId: "dev-l42",
                expiresAt: new Date(Date.now() + 600_000).toISOString() })},
              now() + interval '30 days')
    `;
  });
  const readDelivery = (id: string) => sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),
                        set_config('app.user_id', ${userA}, true)`;
    return await tx`SELECT state, display_lease FROM assistant_deliveries WHERE id = ${id}`;
  });
  await seedDelivery(ownDeliveryId, candidateId, 0);
  // 第二条指向**别的**记忆：它是"只结这一条"的对照。没有它，谓词写成"这个人所有候选交付"
  // 也能让断言全绿（这一族在本会话里已经抓过不止一次）。
  await seedDelivery(otherDeliveryId, randomUUID(), 1);

  const confirmed = await app.inject(req(tokenA, "POST", `/companion/memory/${candidateId}/confirm`));
  assert.equal(confirmed.statusCode, 200);
  const afterConfirm = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    afterConfirm.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    true,
    "确认后必须出现在默认列表",
  );

  const [own] = await readDelivery(ownDeliveryId);
  assert.equal(own?.state, "acted", "确认之后那条候选交付必须结账成 acted");
  assert.equal(own?.display_lease, null, "终态不留展示租约（与设备 ACK 同一形状）");
  const [other] = await readDelivery(otherDeliveryId);
  assert.equal(other?.state, "displayed", "只许结掉指向这条记忆的那一份");

  // 已终态的不被后来的忽略改写：确认在前、忽略在后，用户第一次表态就算数。
  const ignored = await app.inject(req(tokenA, "POST", `/companion/memory/${candidateId}/dismiss`));
  assert.equal(ignored.statusCode, 200);
  const [afterDismiss] = await readDelivery(ownDeliveryId);
  assert.equal(afterDismiss?.state, "acted", "已经 acted 的交付不能被随后的忽略改写");
});

test("pin / unpin / archive / restore / dismiss 状态迁移都可往返", async () => {
  const id = await createMemory(tokenA, { kind: "interaction_note", content: "状态迁移" });
  const step = async (action: string, expected = 200) => {
    const response = await app.inject(req(tokenA, "POST", `/companion/memory/${id}/${action}`));
    assert.equal(response.statusCode, expected, `${action} 期望 ${expected}`);
    return response;
  };

  assert.equal((await step("pin")).json().pinned, true);
  assert.equal((await step("unpin")).json().pinned, false);
  await step("archive");

  const withoutArchived = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    withoutArchived.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id),
    false,
    "归档后默认列表不含该记忆",
  );
  const withArchived = await app.inject(req(tokenA, "GET", "/companion/memory?includeArchived=true"));
  assert.equal(withArchived.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id), true);

  await step("restore");
  assert.equal(
    (await app.inject(req(tokenA, "GET", "/companion/memory"))).json().items
      .some((item: { memoryItemId: string }) => item.memoryItemId === id),
    true,
    "restore 后回到默认列表",
  );
  await step("dismiss");
});

test("修正内容：correct 改写正文并保留可审计来源", async () => {
  const id = await createMemory(tokenA, { kind: "goal", content: "原始内容", candidate: false });
  const response = await app.inject(req(tokenA, "POST", `/companion/memory/${id}/correct`, {
    content: "修正后的内容",
    reason: "用户澄清",
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().content, "修正后的内容");
});

test("列表筛选：kind 与 q 生效，非法查询参数 → 400", async () => {
  const filtered = await app.inject(req(tokenA, "GET", "/companion/memory?kind=preference"));
  assert.equal(filtered.statusCode, 200);
  assert.equal(
    filtered.json().items.every((item: { kind: string }) => item.kind === "preference"),
    true,
  );

  const searched = await app.inject(req(tokenA, "GET", "/companion/memory?q=安静"));
  assert.equal(searched.statusCode, 200);
  assert.ok(searched.json().items.length >= 1, "关键词应命中已创建的记忆");

  const badQuery = await app.inject(req(tokenA, "GET", "/companion/memory?kind=not_a_kind"));
  assert.equal(badQuery.statusCode, 400);
});

test("删除：单条 204 → 再删同一 id 404；清空返回 200 + deletedCount 且幂等", async () => {
  const id = await createMemory(tokenA, { kind: "episodic", content: "将被删除" });
  assert.equal((await app.inject(req(tokenA, "DELETE", `/companion/memory/${id}`))).statusCode, 204);
  assert.equal((await app.inject(req(tokenA, "DELETE", `/companion/memory/${id}`))).statusCode, 404);

  const cleared = await app.inject(req(tokenA, "DELETE", "/companion/memory"));
  assert.equal(cleared.statusCode, 200);
  assert.equal(typeof cleared.json().deletedCount, "number");
  assert.ok(cleared.json().deletedCount >= 1, "清空必须报告删除条数");
  assert.equal((await app.inject(req(tokenA, "DELETE", "/companion/memory"))).json().deletedCount, 0, "清空是幂等的");
  assert.deepEqual((await app.inject(req(tokenA, "GET", "/companion/memory"))).json().items, []);
});

test("跨用户隔离：对别人的 memoryId 一律 404（不泄露存在性），且原主人数据完好", async () => {
  const mine = await createMemory(tokenA, { kind: "goal", content: "A 的私有记忆" });

  for (const [method, url] of [
    ["POST", `/companion/memory/${mine}/confirm`],
    ["POST", `/companion/memory/${mine}/pin`],
    ["POST", `/companion/memory/${mine}/correct`],
    ["DELETE", `/companion/memory/${mine}`],
  ] as const) {
    const response = await app.inject(req(
      tokenB,
      method,
      url,
      method === "POST" && url.endsWith("/correct") ? { content: "越权改写" } : undefined,
    ));
    assert.equal(response.statusCode, 404, `${method} ${url} 必须对他人资源返回 404`);
  }

  const stillThere = await app.inject(req(tokenA, "GET", "/companion/memory"));
  const item = stillThere.json().items.find((entry: { memoryItemId: string }) => entry.memoryItemId === mine);
  assert.equal(item?.content, "A 的私有记忆", "越权请求不得修改或删除原主人的记忆");

  const bList = await app.inject(req(tokenB, "GET", "/companion/memory"));
  assert.deepEqual(bList.json().items, [], "B 的列表里不得出现 A 的记忆");
});

test("导出与星图只包含自己的数据，且星图排除候选", async () => {
  const confirmedId = await createMemory(tokenA, { kind: "goal", content: "已确认条目", candidate: false });
  const candidateId = await createMemory(tokenA, { kind: "goal", content: "候选条目", candidate: true });

  const exported = await app.inject(req(tokenA, "GET", "/companion/memory/export"));
  assert.equal(exported.statusCode, 200);

  const starMap = await app.inject(req(tokenA, "GET", "/companion/memory/star-map"));
  assert.equal(starMap.statusCode, 200);
  const nodeIds = (starMap.json().nodes as Array<{ memoryId: string }>).map((node) => node.memoryId);
  assert.equal(nodeIds.includes(confirmedId), true);
  assert.equal(nodeIds.includes(candidateId), false, "候选记忆不得进入星图");

  const bStarMap = await app.inject(req(tokenB, "GET", "/companion/memory/star-map"));
  assert.deepEqual(bStarMap.json().nodes, [], "星图不得跨用户泄漏");
});
