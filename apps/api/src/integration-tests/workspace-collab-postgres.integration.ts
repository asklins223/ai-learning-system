/**
 * 双空间 · 双角色的行为契约（批次 0 验收底座）。
 *
 * 为什么要单独有这一份：`__tests__/sec01-cross-workspace-isolation.test.ts` 与
 * `__tests__/permission-guard.test.ts` 都是源码字符串包含断言
 * （`content.includes("workspaceId")` / `content.includes("requireOwner")`），
 * 不发 HTTP、不构造第二个空间、不校验 guard 是否真的绑在路由上——摘掉某个路由的
 * guard 它们仍然全绿。dev 库里 856 条成员记录全是 `owner`、`member` 零条，
 * 所以「只读成员」这条链路从来没有被任何一层证明过。
 *
 * fixture 一律走真实 invite 流程（`createInvite` → `POST /auth/join-workspace` →
 * `POST /auth/switch-workspace`），不直接 INSERT `workspace_members`：绕过业务校验
 * 的夹具会造出产品上不可能存在的状态（`companion-memory-routes-http-postgres`
 * 那份就把第二个用户写成了 personal 空间的 `role='owner'`）。
 *
 * 真实 Postgres。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import sensible from "@fastify/sensible";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——协作空间行为集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });

const tag = randomUUID().slice(0, 8);
const userOwner = randomUUID();
const userMember = randomUUID();
const userStranger = randomUUID();
// 三个账号各自的个人空间：session 必须绑定在「本人确实是成员」的空间上，
// 否则 decodeToken 的 LEFT JOIN 不命中会直接把 session 删掉（表现为 401）。
const wsOwnerPersonal = randomUUID();
const wsMemberPersonal = randomUUID();
const wsStrangerPersonal = randomUUID();
// 被测的协作空间，owner 是 userOwner。
const wsCollab = randomUUID();
// 批次 2 判据收敛的验收夹具：`workspaces.owner_id` 与 `workspace_members.role`
// 故意不一致的空间（见下方同名用例）。
const wsDivergent = randomUUID();

const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteRoutes } = await import("../modules/note/routes.ts");
const { sourceRoutes } = await import("../modules/source/routes.ts");
const { reviewRoutes } = await import("../modules/review/routes.ts");
const { exportRoutes } = await import("../modules/export/routes.ts");
const { statsRoutes } = await import("../modules/stats/routes.ts");
const { jobRoutes } = await import("../modules/job/routes.ts");
const { searchRoutes } = await import("../modules/search/routes.ts");
const { createInvite } = await import("../modules/identity/invite-service.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { closeDatabase } = await import("../db/client.ts");

let app: FastifyInstance;
let ownerToken = "";
let memberToken = "";
let strangerToken = "";
/** owner 在协作空间里建的笔记，用于测 member 的写权限与跨空间读取。 */
let sharedNoteId = "";

async function seedIdentity(): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userOwner}, ${`collab-owner-${tag}@example.test`}, 'test-hash', 'owner'),
      (${userMember}, ${`collab-member-${tag}@example.test`}, 'test-hash', 'member'),
      (${userStranger}, ${`collab-stranger-${tag}@example.test`}, 'test-hash', 'member')
  `;
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES
      (${wsOwnerPersonal}, ${`collab-owner-personal-${tag}`}, ${userOwner}, 'personal'),
      (${wsMemberPersonal}, ${`collab-member-personal-${tag}`}, ${userMember}, 'personal'),
      (${wsStrangerPersonal}, ${`collab-stranger-personal-${tag}`}, ${userStranger}, 'personal'),
      (${wsCollab}, ${`collab-shared-${tag}`}, ${userOwner}, 'collaborative')
  `;
  // 此刻协作空间只有 owner 一人；member 由真实 invite 流程加入。
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES
      (${wsOwnerPersonal}, ${userOwner}, 'owner'),
      (${wsMemberPersonal}, ${userMember}, 'owner'),
      (${wsStrangerPersonal}, ${userStranger}, 'owner'),
      (${wsCollab}, ${userOwner}, 'owner')
  `;
}

before(async () => {
  await seedIdentity();

  app = Fastify({ logger: false });
  // server.ts 用 @fastify/sensible 提供 httpErrors 与统一错误序列化；缺了它
  // `throw app.httpErrors.badRequest(...)` 会退化成 500，测试会给出假象。
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteRoutes);
  await app.register(sourceRoutes);
  await app.register(reviewRoutes);
  await app.register(exportRoutes);
  await app.register(statsRoutes);
  await app.register(jobRoutes);
  // 搜索是这条边界上最宽的一个面（索引是全空间共用的一份），所以成员搜不到作者
  // 没共享的那篇这件事必须有它在。
  await app.register(searchRoutes);
  await app.ready();

  const owner = await issueSession(userOwner, wsCollab);
  ownerToken = owner.token;

  // 真实 invite 流程：owner 发 member 档邀请 → member 消费 → member 切进协作空间。
  const invite = await createInvite(wsCollab, userOwner, { role: "member" });
  const memberBootstrap = await issueSession(userMember, wsMemberPersonal);
  const joined = await appInject("POST", "/auth/join-workspace", memberBootstrap.token, {
    inviteToken: invite.token,
  });
  assert.equal(joined.statusCode, 200, `消费邀请必须成功，实际 ${joined.statusCode}: ${joined.body}`);
  // switch-workspace 会在同一事务里撤销 previousToken，所以旧 token 之后不可再用。
  const switched = await appInject(
    "POST",
    "/auth/switch-workspace",
    memberBootstrap.token,
    { workspaceId: wsCollab },
  );
  assert.equal(switched.statusCode, 200, `切换空间必须成功，实际 ${switched.statusCode}: ${switched.body}`);
  memberToken = switched.json().token as string;

  strangerToken = (await issueSession(userStranger, wsStrangerPersonal)).token;

  const created = await appInject("POST", "/notes", ownerToken, {
    blocks: [{ type: "paragraph", content: `协作空间正文 ${tag}` }],
  });
  assert.equal(created.statusCode, 200, `owner 建笔记必须成功，实际 ${created.statusCode}: ${created.body}`);
  sharedNoteId = created.json().note.id as string;
  // 这一行代替的是批次 4.5 那个「共享给空间」动作：新建的笔记默认「仅自己可见」，
  // 而本文件的前提是"共享空间里的共享资料"。等共享端点落地后这里要改成调用它，
  // 而不是长期靠一条 UPDATE 扮演用户点过一下。
  await sql`UPDATE notes SET share_scope = 'shared' WHERE id = ${sharedNoteId}`;
});

after(async () => {
  for (const token of [ownerToken, memberToken, strangerToken]) {
    if (token) await revokeSession(token).catch(() => {});
  }
  const workspaceIds = [wsCollab, wsOwnerPersonal, wsMemberPersonal, wsStrangerPersonal, wsDivergent];
  const userIds = [userOwner, userMember, userStranger];
  // 删除顺序有硬约束，踩错就会静默残留（既有 mem-http-* 夹具就是这么攒出来的）：
  //  - `users.personal_workspace_id` 对 workspaces 是 RESTRICT，必须先解掉；
  //  - `notes` 对 workspaces **没有外键**（96 张带 workspace_id 的表里只有 7 张真有
  //    FK），删空间不会带走笔记，只会留孤儿；
  //  - `workspaces.owner_id` 是 NO ACTION，空间不删就删不掉用户。
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id = ANY(${userIds})`;
  await sql`DELETE FROM notes WHERE workspace_id = ANY(${workspaceIds})`;
  await sql`DELETE FROM review_schedules WHERE workspace_id = ANY(${workspaceIds})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ANY(${workspaceIds})`;
  await sql`DELETE FROM workspaces WHERE id = ANY(${workspaceIds})`;
  await sql`DELETE FROM users WHERE id = ANY(${userIds})`;

  // 残留必须让测试失败，而不是被 catch 吞掉。
  const leftover = await sql`
    SELECT count(*)::int AS n FROM workspaces
    WHERE id = ANY(${workspaceIds}) OR name LIKE ${`%${tag}%`}
  `;
  assert.equal(leftover[0].n, 0, `夹具残留了 ${leftover[0].n} 个空间，teardown 顺序需要修`);

  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

/** 守卫矩阵里的 URL 占位符：路由清单在模块加载期求值，而 sharedNoteId 要 before() 后才有。 */
const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000";
const SHARED_NOTE_TOKEN = "{{sharedNoteId}}";

function appInject(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
): Promise<{ statusCode: number; body: string; json(): any }> {
  // token 为空串表示匿名：必须整个省掉 authorization 头，
  // 留一个 `Bearer ` 空值会让 requireSession 走「有凭据但解不开」的分支，测不到 401 基线。
  const options: InjectOptions = { method, url };
  if (token) options.headers = { authorization: `Bearer ${token}` };
  if (payload !== undefined) options.payload = payload;
  return app.inject(options);
}

// ─── 1. 真实 invite 流程产出的角色，服务端与投影必须一致 ───────────────────

test("经真实 invite 加入的成员，/auth/me 与空间列表都报 member", async () => {
  const me = await appInject("GET", "/auth/me", memberToken);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().workspaceId, wsCollab, `token 应绑在协作空间：${me.body}`);
  assert.equal(me.json().role, "member", `/auth/me role 应为 member：${me.body}`);
  assert.equal(me.json().isPersonal, false, "别人的空间对成员而言不是个人空间投影");

  const list = await appInject("GET", "/auth/workspaces", memberToken);
  assert.equal(list.statusCode, 200);
  const collab = list.json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === wsCollab);
  assert.ok(collab, `成员应能在空间列表里看到加入的协作空间：${list.body}`);
  assert.equal(collab.role, "member", `空间列表 role 应为 member：${JSON.stringify(collab)}`);
});

// ─── 2. 只读成员：写面必须被服务端挡下，读面必须放行 ───────────────────────

test("member 的笔记写操作一律 403，读操作放行", async () => {
  const create = await appInject("POST", "/notes", memberToken, {
    blocks: [{ type: "paragraph", content: "成员想新建" }],
  });
  assert.equal(create.statusCode, 403, `POST /notes 必须 403，实际 ${create.statusCode}`);

  const save = await appInject("PATCH", `/v2/notes/${sharedNoteId}`, memberToken, {
    version: 1,
    title: "成员想改名",
    baseVersionId: randomUUID(),
  });
  assert.equal(save.statusCode, 403, `PATCH /v2/notes/:id 必须 403，实际 ${save.statusCode}`);

  const remove = await appInject("DELETE", `/notes/${sharedNoteId}`, memberToken);
  assert.equal(remove.statusCode, 403, `DELETE /notes/:id 必须 403，实际 ${remove.statusCode}`);

  const restore = await appInject("POST", `/notes/${sharedNoteId}/restore`, memberToken, {
    baseVersionId: randomUUID(),
  });
  assert.equal(restore.statusCode, 403, `POST /notes/:id/restore 必须 403，实际 ${restore.statusCode}`);

  // 对照组：同一批操作 owner 不能也 403，否则上面的断言只是"所有人都被挡"。
  const ownerRead = await appInject("GET", `/v2/notes/${sharedNoteId}`, ownerToken);
  assert.equal(ownerRead.statusCode, 200);
  const memberRead = await appInject("GET", `/v2/notes/${sharedNoteId}`, memberToken);
  assert.equal(memberRead.statusCode, 200, `member 必须能读共享资料，实际 ${memberRead.statusCode}`);
});

test("member 的来源写与全空间导出被拒，owner 放行", async () => {
  const source = await appInject("POST", "/sources", memberToken, { url: `https://example.test/${tag}` });
  assert.equal(source.statusCode, 403, `POST /sources 必须 403，实际 ${source.statusCode}`);

  const memberExport = await appInject("GET", "/export/workspace", memberToken);
  assert.equal(memberExport.statusCode, 403, `member 导出必须 403，实际 ${memberExport.statusCode}`);

  const ownerExport = await appInject("GET", "/export/workspace", ownerToken);
  assert.equal(ownerExport.statusCode, 200, `owner 导出必须 200，实际 ${ownerExport.statusCode}：${ownerExport.body}`);
});

// ─── 3. 跨空间：别人的空间既读不到也不泄露存在性 ──────────────────────────

test("陌生空间的 token 打协作空间的笔记必须 404，不是 403", async () => {
  // 403 会暴露「这个 id 存在」。跨空间一律按不存在处理。
  const response = await appInject("GET", `/v2/notes/${sharedNoteId}`, strangerToken);
  assert.equal(response.statusCode, 404, `跨空间读取必须 404，实际 ${response.statusCode}`);

  const patch = await appInject("PATCH", `/v2/notes/${sharedNoteId}`, strangerToken, {
    version: 1,
    title: "越空间改写",
    baseVersionId: randomUUID(),
  });
  assert.equal(patch.statusCode, 404, `跨空间写入必须 404，实际 ${patch.statusCode}`);

  // 且必须真的没写进去。
  const after = await appInject("GET", `/v2/notes/${sharedNoteId}`, ownerToken);
  assert.equal(after.statusCode, 200);
  assert.match(JSON.stringify(after.json()), new RegExp(`协作空间正文 ${tag}`));
});

test("陌生空间的统计与列表都不含协作空间的资料", async () => {
  const list = await appInject("GET", "/notes", strangerToken);
  assert.equal(list.statusCode, 200);
  assert.doesNotMatch(
    JSON.stringify(list.json()),
    new RegExp(sharedNoteId),
    "别人的空间笔记 id 不得出现在我的列表里",
  );

  const stats = await appInject("GET", "/stats/overview", strangerToken);
  assert.equal(stats.statusCode, 200);
  assert.equal(Number(stats.json().noteCount ?? 0), 0, `陌生空间笔记数应为 0，实际 ${stats.body}`);
});

// ─── 4. 只读判据必须同源：同一个人不能"服务端可写、UI 判只读" ─────────────

test("笔记投影的 canEdit 与 /auth/me 的 role 必须同源", async () => {
  const memberView = await appInject("GET", `/v2/notes/${sharedNoteId}`, memberToken);
  assert.equal(memberView.statusCode, 200);
  assert.equal(
    memberView.json().permissions?.canEdit,
    false,
    `member 的 canEdit 必须 false：${memberView.body}`,
  );

  const ownerView = await appInject("GET", `/v2/notes/${sharedNoteId}`, ownerToken);
  assert.equal(ownerView.statusCode, 200);
  assert.equal(
    ownerView.json().permissions?.canEdit,
    true,
    `owner 的 canEdit 必须 true：${ownerView.body}`,
  );
});

// ─── 5. 路由守卫矩阵：取代 permission-guard 的源码字符串 grep ─────────────

/**
 * `__tests__/permission-guard.test.ts` 用 `content.includes("requireOwner")` 与
 * `preHandler` 正则计数来"证明"守卫存在——把某个路由的 guard 摘掉，只要同文件里
 * 还有别的 requireOwner，它就照样全绿。这里按路由逐条发真实请求。
 *
 * preHandler 先于 handler 执行，所以 id 是假的也不影响：member 必然拿到 403、
 * 匿名必然 401，轮不到 404。
 */
const OWNER_ONLY_ROUTES: ReadonlyArray<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}> = [
  { method: "POST", url: "/notes", payload: { blocks: [] } },
  { method: "PATCH", url: `/v2/notes/${SHARED_NOTE_TOKEN}`, payload: { version: 1, baseVersionId: PLACEHOLDER_UUID } },
  // 正文的增量上送口与 WS 的只读判定是同一条判据，它也必须在成员这里吃 403。
  { method: "POST", url: `/v2/notes/${SHARED_NOTE_TOKEN}/doc-update`, payload: { update: "AA==" } },
  { method: "DELETE", url: `/notes/${PLACEHOLDER_UUID}` },
  { method: "DELETE", url: `/notes/${PLACEHOLDER_UUID}/permanent` },
  { method: "POST", url: `/notes/${PLACEHOLDER_UUID}/restore`, payload: { baseVersionId: PLACEHOLDER_UUID } },
  { method: "POST", url: `/notes/${PLACEHOLDER_UUID}/versions/${PLACEHOLDER_UUID}/restore`, payload: {} },
  { method: "POST", url: "/sources", payload: { url: "https://example.test/guard" } },
  { method: "PATCH", url: `/sources/${PLACEHOLDER_UUID}`, payload: {} },
  { method: "DELETE", url: `/sources/${PLACEHOLDER_UUID}` },
  { method: "POST", url: `/sources/${PLACEHOLDER_UUID}/create-note`, payload: {} },
  { method: "GET", url: "/export/workspace" },
  { method: "POST", url: "/invites", payload: {} },
  { method: "GET", url: "/invites" },
  { method: "DELETE", url: `/invites/${PLACEHOLDER_UUID}` },
  { method: "GET", url: "/members" },
  { method: "DELETE", url: `/members/${PLACEHOLDER_UUID}` },
  { method: "GET", url: "/workspace/ai-audit-log" },
  { method: "POST", url: `/auth/recovered-users/${PLACEHOLDER_UUID}/reset-password`, payload: {} },
];

/** 成员必须能正常使用的用户级操作：产品合同要求「只读工作区数据，但可验证/复习」。 */
const SESSION_ONLY_ROUTES: ReadonlyArray<{
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}> = [
  { method: "GET", url: "/reviews/v2/queue" },
  { method: "GET", url: "/stats/overview" },
  // 跨空间总览读的是"我属于哪些空间"（成员自己的成员关系），不是空间数据，
  // 所以成员也必须能读——否则被空间切开的个人进度对成员永远不可见。
  { method: "GET", url: "/stats/overview/all" },
  // 版本历史属于「读工作区数据」，成员可读；恢复到旧版本才是 owner-only（见上）。
  { method: "GET", url: `/notes/${PLACEHOLDER_UUID}/versions` },
  // 任务状态是本人学习动作的派生，成员当然能查自己的。
  { method: "GET", url: "/jobs" },
  { method: "GET", url: "/auth/me" },
  // 成员可以改自己的档案：给一个过不了校验的 payload，只验守卫层、不真改数据。
  { method: "PUT", url: "/auth/profile", payload: { displayName: 123 } },
  { method: "GET", url: "/auth/workspaces" },
  { method: "GET", url: "/auth/capabilities/v1" },
  // 0237 起 AI 同意是账号级：成员必须能签自己的、改自己的（不再有 requireOwner）。
  // 与 /auth/profile 同一手法：给一个过不了校验的 payload，只验守卫层，
  // 否则这条「成员必须能用」的用例真的会把成员的签署状态改掉。
  { method: "GET", url: "/me/ai-settings" },
  { method: "PUT", url: "/me/ai-consent", payload: { consentVersion: "" } },
  {
    method: "PUT",
    url: "/me/ai-data-policy",
    payload: { sendToExternal: "not-a-boolean" },
  },
];

test("每一条 owner-only 路由：member 一律 403、匿名一律 401", async () => {
  const offenders: string[] = [];
  for (const route of OWNER_ONLY_ROUTES) {
    const url = route.url.replace(SHARED_NOTE_TOKEN, sharedNoteId);
    const member = await appInject(route.method, url, memberToken, route.payload ?? {});
    if (member.statusCode !== 403) {
      offenders.push(`${route.method} ${url} member=${member.statusCode}（期望 403）`);
    }
    const anonymous = await appInject(route.method, url, "", route.payload ?? {});
    if (anonymous.statusCode !== 401) {
      offenders.push(`${route.method} ${url} 匿名=${anonymous.statusCode}（期望 401）`);
    }
  }
  assert.deepEqual(offenders, [], `守卫矩阵不一致：\n${offenders.join("\n")}`);
});

test("成员的用户级操作（复习队列、统计、会话信息）不得被 403", async () => {
  const blocked: string[] = [];
  for (const route of SESSION_ONLY_ROUTES) {
    const response = await appInject(route.method, route.url, memberToken, route.payload);
    if (response.statusCode === 403) {
      blocked.push(`${route.method} ${route.url} → 403：${response.body.slice(0, 160)}`);
    }
  }
  assert.deepEqual(blocked, [], `成员被误挡在用户级操作之外：\n${blocked.join("\n")}`);
});

// ─── 5. 协作空间必须真的能被创建出来 ──────────────────────────────────────

test("POST /workspaces 建出协作空间，且类型来自空间本身而非查看者", async () => {
  const created = await appInject("POST", "/workspaces", ownerToken, { name: `棘轮协作 ${tag}` });
  assert.equal(created.statusCode, 200, `创建协作空间必须 200，实际 ${created.statusCode}：${created.body}`);
  const createdId = created.json().workspaceId as string;

  const rows = await sql`SELECT workspace_type, owner_id FROM workspaces WHERE id = ${createdId}`;
  assert.equal(rows[0].workspace_type, "collaborative", "新建空间必须落成为 collaborative 行");
  assert.equal(rows[0].owner_id, userOwner);

  // 类型不能因为"换个人来看"就变。owner 看自己是 collaborative，成员看也必须是。
  const list = await appInject("GET", "/auth/workspaces", ownerToken);
  const row = list.json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === createdId);
  assert.equal(row?.workspaceType, "collaborative", `owner 视角类型应为 collaborative：${JSON.stringify(row)}`);
  assert.equal(row?.isPersonal, false, "自己的协作空间不是个人空间");

  await sql`DELETE FROM workspace_members WHERE workspace_id = ${createdId}`;
  await sql`DELETE FROM workspaces WHERE id = ${createdId}`;
});

// ─── 6. 待修项的验收断言（先跳过，对应批次落地时去掉 skip） ────────────────

test("owner_id 与 membership role 不一致时，三个只读信号仍然同源", async () => {
  // 造出「本人是 workspaces.owner_id，但成员行写着 member」的状态。
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${wsDivergent}, ${`collab-divergent-${tag}`}, ${userMember}, 'collaborative')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${wsDivergent}, ${userMember}, 'member')
  `;
  const token = (await issueSession(userMember, wsDivergent)).token;

  const me = await appInject("GET", "/auth/me", token);
  const caps = await appInject("GET", "/auth/capabilities/v1", token);
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(caps.statusCode, 200, caps.body);

  const meSaysOwner = me.json().role === "owner";
  const capsSaysWritable = caps.json().actionCapabilities["note.create"] === "allowed";
  const write = await appInject("POST", "/notes", token, {
    blocks: [{ type: "paragraph", content: `判据一致性探针 ${tag}` }],
  });
  const serverAllows = write.statusCode !== 403;

  await revokeSession(token).catch(() => {});
  assert.equal(
    capsSaysWritable,
    meSaysOwner,
    `能力投影与 /auth/me 不同源：me.role=${me.json().role}，note.create=${caps.json().actionCapabilities["note.create"]}`,
  );
  assert.equal(
    serverAllows,
    meSaysOwner,
    `服务端写入判定与 /auth/me 不同源：me.role=${me.json().role}，POST /notes 实际 ${write.statusCode}`,
  );
});

test("个人空间不能被发邀请，协作空间可以", async () => {
  await assert.rejects(
    () => createInvite(wsOwnerPersonal, userOwner, { role: "member" }),
    (error: unknown) =>
      (error as { code?: string }).code === "personal_workspace_not_shareable",
    "为 personal 空间发邀请必须被拒",
  );

  // 反向对照：同一账号对协作空间发邀请必须成功，否则上面的拒绝只是"谁都发不了"。
  const invite = await createInvite(wsCollab, userOwner, { role: "member" });
  assert.ok(invite.token, "协作空间应当能发出邀请");
});

test("整库导出不含其他成员的私有行", async () => {
  await sql`
    INSERT INTO review_schedules (workspace_id, user_id, subject_type, subject_id, next_review_at)
    VALUES (${wsCollab}, ${userMember}, 'card', ${randomUUID()}, now() - interval '1 hour')
  `;
  const response = await appInject("GET", "/export/workspace", ownerToken);
  assert.equal(response.statusCode, 200);
  const dump = response.json() as Record<string, Array<Record<string, unknown>>>;
  // 「整包里没有成员 uuid」是错的断言：owner 自己的排程行本来就用笔记作者当
  // subject_id，而那正是成员的 id。私有性要看**行的归属**，不是看字符串。
  const ownedBy: Record<string, string> = {
    reviewSchedules: "userId",
    onboardingStates: "userId",
    workspaceMembers: "userId",
    users: "id",
  };
  for (const [section, key] of Object.entries(ownedBy)) {
    const foreign = (dump[section] ?? []).filter((row) => row[key] === userMember);
    assert.deepEqual(
      foreign,
      [],
      `${section} 里出现了 ${foreign.length} 行属于其他成员的私有数据`,
    );
  }
  assert.doesNotMatch(
    response.body,
    /member@collab\.test/,
    "成员邮箱不得进入 owner 的导出包：成员关系是私有数据",
  );
});

test("owner 的到期数只数自己的", async () => {
  await sql`
      INSERT INTO review_schedules (workspace_id, user_id, subject_type, subject_id, next_review_at)
      VALUES (${wsCollab}, ${userMember}, 'card', ${randomUUID()}, now() - interval '1 hour')
    `;
    const ownerStats = await appInject("GET", "/stats/overview", ownerToken);
    assert.equal(ownerStats.statusCode, 200);
    const due = Number(
      ownerStats.json().objectiveReviewDueCount ?? ownerStats.json().reviewDueCount ?? 0,
    );
    assert.equal(due, 0, `owner 没有到期复习，却报出 ${due} —— 数进了成员的排程`);
});

// ─── 7. `review_schedules` 的 RLS 真的在执行（迁移 0241） ──────────────────

/**
 * 以 `ailearn_api` 身份读一次到期排程。
 *
 * 为什么必须 `SET LOCAL ROLE`：dev 栈和这些测试都用 `ailearn`（superuser +
 * BYPASSRLS）连接，RLS 对它天然不可见——直接跑只会得到"开了 RLS 也一切正常"的
 * 假绿。生产里 API 连的是 `ailearn_api`（NOBYPASSRLS），策略是真的会生效的。
 */
async function countDueRowsAsApiRole(
  subjectId: string,
  scope: { workspaceId: string; userId: string | null },
): Promise<number> {
  return sql.begin(async (tx) => {
    // 静态语句，不拼任何外部输入。
    await tx.unsafe("SET LOCAL ROLE ailearn_api");
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId ?? ""}, true)`;
    // 故意**不**写 workspace/user 的 WHERE：这条查询要问的是"策略本身挡不挡得住"，
    // 带上 WHERE 就变成在测调用方自己记得过滤了——那正是这次要消灭的写法。
    const rows = await tx`SELECT id FROM review_schedules WHERE subject_id = ${subjectId}`;
    return rows.length;
  });
}

test("到期排程按人隔离：换人读不到，缺 app.user_id 时是 0 行不是全表", async () => {
  const subjectId = randomUUID();
  await sql`
    INSERT INTO review_schedules (workspace_id, user_id, subject_type, subject_id, next_review_at)
    VALUES (${wsCollab}, ${userMember}, 'card', ${subjectId}, now())
  `;

  const asMember = await countDueRowsAsApiRole(subjectId, { workspaceId: wsCollab, userId: userMember });
  const asOwner = await countDueRowsAsApiRole(subjectId, { workspaceId: wsCollab, userId: userOwner });
  const asNoActor = await countDueRowsAsApiRole(subjectId, { workspaceId: wsCollab, userId: null });

  assert.equal(asMember, 1, "成员用自己的上下文必须读得到自己的排程");
  assert.equal(asOwner, 0, `actor_guard 没有生效：owner 读到了成员的 ${asOwner} 行排程`);
  // 这条断言记录的是**已知代价**：少设一次 app.user_id 不会报错，只会静默 0 行。
  // 批次 3 先把 18 个读写点逐个补上 user_id，才敢翻这个开关；顺序不能反过来。
  assert.equal(asNoActor, 0, "没有 app.user_id 时应为 0 行——这是 RLS 生效的证据，不是 bug");
});

test("跨空间读不到别人的到期排程（tenant_guard），并且正向对照读得到自己的", async () => {
  const subjectId = randomUUID();
  const ownSubjectId = randomUUID();
  await sql`
    INSERT INTO review_schedules (workspace_id, user_id, subject_type, subject_id, next_review_at)
    VALUES (${wsCollab}, ${userMember}, 'card', ${subjectId}, now())
  `;
  // 正向对照：陌生人在**自己**空间里的那一行必须读得到。没有这一条，"读到 0 行"
  // 就分不清是策略在挡还是策略被删了——0027 的 DISABLE 循环会同时满足两条断言。
  await sql`
    INSERT INTO review_schedules (workspace_id, user_id, subject_type, subject_id, next_review_at)
    VALUES (${wsStrangerPersonal}, ${userStranger}, 'card', ${ownSubjectId}, now())
  `;
  const seen = await countDueRowsAsApiRole(subjectId, {
    workspaceId: wsStrangerPersonal,
    userId: userStranger,
  });
  assert.equal(seen, 0, "陌生空间不该看到协作空间的排程");
  const own = await countDueRowsAsApiRole(ownSubjectId, {
    workspaceId: wsStrangerPersonal,
    userId: userStranger,
  });
  assert.equal(own, 1, `陌生空间自己的排程读不到了（${own}）——策略或 session 变量没生效，上一条的 0 是假绿`);
});

// ─── 6. 笔记归属：默认仅自己可见，共享是一次显式动作（批次 4.5）───────────────

/** 每条断言都配一个正向对照：只报"读不到"的话，判据把所有人全挡住时同样是绿的。 */
test("新建的笔记默认「仅自己可见」，同空间成员读不到也不在列表里", async () => {
  const created = await appInject("POST", "/notes", ownerToken, {
    blocks: [{ type: "paragraph", content: `只有作者看得见 ${tag}` }],
  });
  assert.equal(created.statusCode, 200, `owner 建笔记必须成功：${created.body}`);
  const noteId = created.json().note.id as string;

  const detail = await appInject("GET", `/v2/notes/${noteId}`, ownerToken);
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().shareScope, "private", "新建的笔记必须是「仅自己可见」");
  assert.equal(detail.json().permissions.canShare, true, "作者本人必须能决定共享");

  const memberList = await appInject("GET", "/notes", memberToken);
  assert.equal(memberList.statusCode, 200);
  const ids = (memberList.json().items as Array<{ id: string }>).map((item) => item.id);
  assert.ok(!ids.includes(noteId), "作者没共享的笔记不该出现在成员的列表里");

  const memberRead = await appInject("GET", `/v2/notes/${noteId}`, memberToken);
  assert.equal(memberRead.statusCode, 404, `成员读作者的私有笔记必须 404：${memberRead.body}`);

  // 正向对照：同一篇共享之后，成员两条路都要变成"看得见"。
  const shared = await appInject("PATCH", `/v2/notes/${noteId}/share-scope`, ownerToken, { shareScope: "shared" });
  assert.equal(shared.statusCode, 200, `作者共享自己的笔记必须成功：${shared.body}`);
  assert.equal(shared.json().changed, true);
  const afterRead = await appInject("GET", `/v2/notes/${noteId}`, memberToken);
  assert.equal(afterRead.statusCode, 200, "共享之后成员读不到——判据接错了读取路径");
  const afterList = await appInject("GET", "/notes", memberToken);
  const afterIds = (afterList.json().items as Array<{ id: string }>).map((item) => item.id);
  assert.ok(afterIds.includes(noteId), "共享之后成员的列表里仍然没有它");

  // 撤回：作者的另一个权利，也是"这一列可以双向改"这件事唯一的证据。
  const unshared = await appInject("PATCH", `/v2/notes/${noteId}/share-scope`, ownerToken, { shareScope: "private" });
  assert.equal(unshared.statusCode, 200);
  assert.equal(unshared.json().shareScope, "private");
  assert.equal((await appInject("GET", `/v2/notes/${noteId}`, memberToken)).statusCode, 404, "撤回之后成员还读得到");
  assert.equal((await appInject("GET", `/v2/notes/${noteId}`, ownerToken)).statusCode, 200, "撤回之后作者自己也读不到了");
});

test("不是作者的人改不了归属，而且改不到（404 而不是 403）", async () => {
  const foreign = await appInject("PATCH", `/v2/notes/${sharedNoteId}/share-scope`, memberToken, { shareScope: "private" });
  // 用 404 而不是 403：这一列说的是"我的东西要不要拿出去"，别人的东西对它没有立场，
  // 而"这篇存在但不归你改"这个信息本身不该从状态码里漏出去。
  assert.equal(foreign.statusCode, 404, `非作者改归属必须 404：${foreign.body}`);
  const stillShared = await appInject("GET", `/v2/notes/${sharedNoteId}`, memberToken);
  assert.equal(stillShared.statusCode, 200, "夹具那篇本该是已共享的");
  assert.equal(stillShared.json().shareScope, "shared", "非作者的调用不该已经改掉了归属");
});

test("设成当前值不写行：幂等，也不推更新时间", async () => {
  const first = await appInject("PATCH", `/v2/notes/${sharedNoteId}/share-scope`, ownerToken, { shareScope: "shared" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().changed, false, "已经是 shared 了还说 changed:true");
  const stored = await sql`SELECT updated_at FROM notes WHERE id = ${sharedNoteId}`;
  const before = (stored[0].updated_at as Date).toISOString();
  // 不要用 `new Date(String(date))` 比较：那是秒级精度，同一年内的两次写入根本分不出高低。
  const again = await appInject("PATCH", `/v2/notes/${sharedNoteId}/share-scope`, ownerToken, { shareScope: "shared" });
  assert.equal(again.json().updatedAt, before, "无变化的归属调用重写了行（updated_at 被推走）");
});

test("判据的两份写法在同一份数据上给同一个结果集", async () => {
  // `visibleNotesCondition`（drizzle）与 `noteVisibleSqlText`（伴星那两处手写 SQL）
  // 是同一句话的两种写法——本仓少有的重复。比字符串证明不了它们在真实行上同结果，
  // 所以这里两边都跑一遍，比返回的 noteId 集合。
  const { visibleNotesCondition, noteVisibleSqlText } = await import("../modules/note/visibility.ts");
  void visibleNotesCondition; // 只取模块，drizzle 那半边由列表接口代表
  const viaHttp = await appInject("GET", "/notes?limit=100", memberToken);
  const fromApp = (viaHttp.json().items as Array<{ id: string }>).map((item) => item.id).sort();

  const rows = await sql`
    SELECT id FROM notes
    WHERE workspace_id = ${wsCollab} AND deleted_at IS NULL
      AND ${sql.unsafe(noteVisibleSqlText("notes", `'${userMember}'::uuid`))}
  `;
  const fromRaw = rows.map((row) => String(row.id)).sort();
  assert.deepEqual(fromRaw, fromApp, "两份写法结果不同——以后改一处就会静默分叉");
  // 正向对照：作者自己那一份两边都更全，否则上一条可能只是"两边都空"。
  const ownerRaw = await sql`
    SELECT id FROM notes
    WHERE workspace_id = ${wsCollab} AND deleted_at IS NULL
      AND ${sql.unsafe(noteVisibleSqlText("notes", `'${userOwner}'::uuid`))}
  `;
  assert.ok(ownerRaw.length >= fromRaw.length, "作者在同一个夹具下读到的反而更少");
  assert.ok(ownerRaw.length > 0, "夹具里作者一篇都没有，上面两条都是假绿");
});

test("搜索索引收全量、发结果按人筛：私有笔记的正文不出现在成员的命中里", async () => {
  // 这条钉的是批次 4.5 里唯一一处"故意不裁"的地方：`search_documents` 是全空间共用的
  // 一份索引，建索引时按某人可见范围裁就等于把他的视角烧进共用数据（下一次 owner
  // 重索引，私有笔记连作者自己都搜不到）。所以索引收全量，发不发由查询侧那次 join 判。
  const phrase = `只在作者私有笔记里的一句话 ${tag}`;
  const created = await appInject("POST", "/notes", ownerToken, {
    blocks: [{ type: "paragraph", content: phrase }],
  });
  const noteId = created.json().note.id as string;

  const memberHits = await appInject("GET", `/search?q=${encodeURIComponent(tag)}&type=note`, memberToken);
  assert.equal(memberHits.statusCode, 200, memberHits.body);
  const memberIds = (memberHits.json().items as Array<{ objectId: string }>).map((item) => item.objectId);
  assert.ok(!memberIds.includes(noteId), "成员搜到了作者没共享的那篇");

  // 正向对照：同一篇、同一个关键词，作者自己必须搜得到——否则上一条的"没有"
  // 只是索引没建起来或者查询整个坏了。
  const ownerHits = await appInject("GET", `/search?q=${encodeURIComponent(phrase)}&type=note`, ownerToken);
  const ownerIds = (ownerHits.json().items as Array<{ objectId: string }>).map((item) => item.objectId);
  assert.ok(ownerIds.includes(noteId), `作者自己搜不到这篇（命中 ${ownerIds.length} 条）——上一条的"搜不到"是假绿`);

  // 共享之后成员也要搜得到：证明筛的是归属，不是"这篇有没有进索引"。
  await appInject("PATCH", `/v2/notes/${noteId}/share-scope`, ownerToken, { shareScope: "shared" });
  const afterShare = await appInject("GET", `/search?q=${encodeURIComponent(phrase)}&type=note`, memberToken);
  const afterIds = (afterShare.json().items as Array<{ objectId: string }>).map((item) => item.objectId);
  assert.ok(afterIds.includes(noteId), "共享之后成员仍然搜不到——查询侧那次 join 接错了");

  // 撤回之后总数不能还带着它：缓存键没带查看者的话，这里会拿到作者那份的数字。
  await appInject("PATCH", `/v2/notes/${noteId}/share-scope`, ownerToken, { shareScope: "private" });
  const afterUnshare = await appInject("GET", `/search?q=${encodeURIComponent(phrase)}&type=note`, memberToken);
  assert.equal(
    (afterUnshare.json().items as unknown[]).length,
    0,
    "撤回之后成员的搜索里还有它（或者命中数缓存没按人分键）",
  );
});
