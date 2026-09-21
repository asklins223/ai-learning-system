/**
 * 笔记协同 WS 的真实行为契约（批次 4.2 验收）。
 *
 * 为什么必须起真服务器 + 真客户端：这一层的承诺全是**协议与进程内状态**决定的——
 * token 从握手后的 Auth 消息里来（不是请求头）、只读要靠服务端回一条
 * `Authenticated("readonly")` 让客户端知道自己只读、上送的更新要被否定确认挡掉、
 * 快照要在 debounce 之后落 `note_document_states` 并投影成 `note_blocks`。
 * 用 `app.inject` 或 mock 事务一样都测不到。
 *
 * 客户端直接用 `@hocuspocus/provider`（批次 4.3 主进程要装的就是它）而不是手搓帧：
 * 手搓会把"版本对不齐"这类问题伪装成"我们的鉴权有 bug"，而且测过的协议帧跟真正
 * 要发布出去的客户端不是同一个东西。
 *
 * 真实 Postgres。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import * as Y from "yjs";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { createNote } from "../modules/note/service.ts";
import { documentNameForNote, closeNoteCollaboration, collaborationLoad } from "../modules/note/collaboration.ts";
import { docFromSnapshot, editBlockContent, projectNoteBlocks } from "../modules/note/doc.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——笔记协同集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });
const tag = randomUUID().slice(0, 8);
const userOwner = randomUUID();
const userMember = randomUUID();
const userStranger = randomUUID();
const wsOwnerPersonal = randomUUID();
const wsMemberPersonal = randomUUID();
const wsStrangerPersonal = randomUUID();
const wsCollab = randomUUID();

const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteRoutes } = await import("../modules/note/routes.ts");
const { noteCollaborationRoutes } = await import("../modules/note/collaboration.ts");
const { createInvite } = await import("../modules/identity/invite-service.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");

let app: FastifyInstance;
let wsUrl = "";
let ownerToken = "";
/** 同一个人在**自己另一个空间**里的 session：用来测"跨空间上送"。 */
let ownerOtherToken = "";
let memberToken = "";
let strangerToken = "";
let noteId = "";
let versionId = "";
/** 每次连接都要显式销毁；漏掉会把文档留在内存里，让后面的连接数断言失真。 */
const liveProviders: HocuspocusProvider[] = [];

const paraA = `协同段落甲 ${tag}`;const paraB = `协同段落乙 ${tag}`;
const noteTitle = `协同笔记 ${tag}`;
/**
 * 所有拒绝对客户端都只有这一个理由：`onAuthenticate` 抛的 message 只进服务端日志
 * （Hocuspocus 会读 error.reason，普通 Error 没有这个字段，于是落到它的默认值）。
 */
const PERMISSION_DENIED = "permission-denied";

async function waitFor(predicate: () => Promise<boolean> | boolean, what: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超过 ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

function once(emitter: HocuspocusProvider, event: string, what: string, timeoutMs = 12_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`等待「${what}」超过 ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(payload: any) {
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    }
    emitter.on(event, handler);
  });
}

function connect(token: string, name = documentNameForNote(noteId)) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: wsUrl, name, document: doc, token });
  liveProviders.push(provider);
  // `synced` 在构造之后、连接完成之前挂上才不漏；provider 的连接是异步的。
  // 失败路径（鉴权被拒）永远不会同步，这里预挂一个 catch，否则超时会留下
  // unhandled rejection 把整个测试文件带崩。
  const synced = once(provider, "synced", "同步完成").then(() => doc);
  synced.catch(() => {});
  return { doc, provider, synced };
}

function destroyProviders(): void {
  while (liveProviders.length) liveProviders.pop()?.destroy();
}

/** 库里那份快照解出来的正文块。用 Y.Doc 读，才是在读"服务端认定的事实源"。 */
async function storedBlocks(): Promise<string[]> {
  const rows = await sql`SELECT state FROM note_document_states WHERE note_id = ${noteId}`;
  if (!rows.length) return [];
  const doc = docFromSnapshot(rows[0].state as Uint8Array);
  const contents = projectNoteBlocks(doc).map((block) => block.content);
  doc.destroy();
  return contents;
}

async function projectedRows(): Promise<string[]> {
  const rows = await sql`
    SELECT nb.content FROM note_blocks nb WHERE nb.version_id = ${versionId} ORDER BY nb.ordinal
  `;
  return rows.map((row) => String(row.content));
}

function docContents(doc: Y.Doc): string[] {
  return projectNoteBlocks(doc).map((block) => block.content);
}

/** 以库里那份快照为起点的"本机文档"——真客户端离线时拿到的就是这个。 */
async function storedDoc(): Promise<Y.Doc> {
  const rows = await sql`SELECT state FROM note_document_states WHERE note_id = ${noteId}`;
  assert.equal(rows.length, 1, "笔记没有快照，本机文档无从起点");
  return docFromSnapshot(rows[0].state as Uint8Array);
}

/**
 * 本机相对库里那份的**增量**（不是整篇）。真客户端算的就是这个：以对方的 state vector
 * 为差集基准。用整篇来测会把"上送必须是增量"这条合同测成永远为真。
 */
async function incrementalUpdate(local: Y.Doc): Promise<string> {
  const server = await storedDoc();
  const update = Y.encodeStateAsUpdate(local, Y.encodeStateVector(server));
  server.destroy();
  return Buffer.from(update).toString("base64");
}

function uploadUpdate(token: string, update: string, id = noteId) {
  return app.inject({
    method: "POST",
    url: `/v2/notes/${id}/doc-update`,
    headers: { authorization: `Bearer ${token}` },
    payload: { update },
  });
}

before(async () => {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userOwner}, ${`note-collab-owner-${tag}@example.test`}, 'test-hash', 'owner'),
      (${userMember}, ${`note-collab-member-${tag}@example.test`}, 'test-hash', 'member'),
      (${userStranger}, ${`note-collab-stranger-${tag}@example.test`}, 'test-hash', 'member')
  `;
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES
      (${wsOwnerPersonal}, ${`collab-owner-personal-${tag}`}, ${userOwner}, 'personal'),
      (${wsMemberPersonal}, ${`collab-member-personal-${tag}`}, ${userMember}, 'personal'),
      (${wsStrangerPersonal}, ${`collab-stranger-personal-${tag}`}, ${userStranger}, 'personal'),
      (${wsCollab}, ${`collab-shared-${tag}`}, ${userOwner}, 'collaborative')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      (${wsOwnerPersonal}, ${userOwner}, 'owner'),
      (${wsMemberPersonal}, ${userMember}, 'owner'),
      (${wsStrangerPersonal}, ${userStranger}, 'owner'),
      (${wsCollab}, ${userOwner}, 'owner')
  `;

  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteRoutes);
  // 与 noteRoutes 平级：协同路由不吃 requireSession（见 collaboration.ts 的说明）。
  await app.register(noteCollaborationRoutes);
  // 必须真 listen：`app.inject` 不跑 WS 升级。
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || address === null) throw new Error("拿不到监听端口");
  wsUrl = `ws://127.0.0.1:${address.port}/note-doc`;

  ownerToken = (await issueSession(userOwner, wsCollab)).token;
  ownerOtherToken = (await issueSession(userOwner, wsOwnerPersonal)).token;

  // member 由真实 invite 流程产出，不直接 INSERT `workspace_members`。
  const invite = await createInvite(wsCollab, userOwner, { role: "member" });
  const bootstrap = await issueSession(userMember, wsMemberPersonal);
  const joined = await app.inject({
    method: "POST",
    url: "/auth/join-workspace",
    headers: { authorization: `Bearer ${bootstrap.token}` },
    payload: { inviteToken: invite.token },
  });
  assert.equal(joined.statusCode, 200, `消费邀请必须成功，实际 ${joined.statusCode}: ${joined.body}`);
  // switch-workspace 会撤销 previousToken，所以之后只能用返回的新 token。
  const switched = await app.inject({
    method: "POST",
    url: "/auth/switch-workspace",
    headers: { authorization: `Bearer ${bootstrap.token}` },
    payload: { workspaceId: wsCollab },
  });
  assert.equal(switched.statusCode, 200, `切换空间必须成功，实际 ${switched.statusCode}: ${switched.body}`);
  memberToken = switched.json().token as string;

  strangerToken = (await issueSession(userStranger, wsStrangerPersonal)).token;

  const created = await withWorkspaceTransaction({ workspaceId: wsCollab, userId: userOwner }, (tx) =>
    createNote(tx, wsCollab, userOwner, {
      title: noteTitle,
      blocks: [
        { type: "heading", content: noteTitle },
        { type: "paragraph", content: paraA },
        { type: "paragraph", content: paraB },
      ],
    }),
  );
  if (!created) throw new Error("createNote 返回 null：笔记没有当前版本");
  noteId = created.note.id;
  versionId = created.version.id;
});

after(async () => {
  destroyProviders();
  await closeNoteCollaboration().catch(() => {});
  for (const token of [ownerToken, ownerOtherToken, memberToken, strangerToken]) {
    if (token) await revokeSession(token).catch(() => {});
  }
  await app.close().catch(() => {});

  const workspaceIds = [wsCollab, wsOwnerPersonal, wsMemberPersonal, wsStrangerPersonal];
  const userIds = [userOwner, userMember, userStranger];
  // 删除顺序有硬约束（同 workspace-collab 那份）：踩错就静默攒脏数据。
  await sql`DELETE FROM note_document_states WHERE note_id = ${noteId}`;
  await sql`DELETE FROM note_blocks WHERE version_id IN (SELECT id FROM note_versions WHERE note_id = ${noteId})`;
  await sql`DELETE FROM note_versions WHERE note_id = ${noteId}`;
  await sql`DELETE FROM search_documents WHERE object_id = ${noteId}`;
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id = ANY(${userIds})`;
  await sql`DELETE FROM notes WHERE workspace_id = ANY(${workspaceIds})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ANY(${workspaceIds})`;
  await sql`DELETE FROM workspaces WHERE id = ANY(${workspaceIds})`;
  await sql`DELETE FROM users WHERE id = ANY(${userIds})`;

  const leftover = await sql`
    SELECT count(*)::int AS n FROM workspaces WHERE id = ANY(${workspaceIds}) OR name LIKE ${`%${tag}%`}
  `;
  assert.equal(leftover[0].n, 0, `夹具残留了 ${leftover[0].n} 个空间，teardown 顺序需要修`);
  const stuckDocs = await sql`SELECT count(*)::int AS n FROM note_document_states`;
  assert.equal(stuckDocs[0].n, 0, `残留了 ${stuckDocs[0].n} 行文档快照`);

  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

test("握手不带凭据：连得上，但一个字节正文都拿不到", async () => {
  // 这条钉的是"少了 requireSession 不等于没人看门"。v4 的 token 在 Auth 消息里，
  // 所以升级阶段没有闸；闸在鉴权之前是"服务端不发送任何正文"。
  const socket = new WebSocket(wsUrl);
  const received: MessageEvent[] = [];
  socket.addEventListener("message", (event) => received.push(event as MessageEvent));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WS 连接失败")));
    setTimeout(() => reject(new Error("WS 握手超时")), 5_000);
  });
  // 静默窗口：超过 debounce，也够任何误发的同步帧到达。
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(received.length, 0, "未鉴权的连接收到了服务端消息——正文可能在鉴权前就外流");
  socket.close();
});

test("token 无效：该文档被拒，理由是笼统的 permission-denied", async () => {
  // 客户端拿不到"token 不对 / 笔记不存在 / 不属于你这个空间"这三种区别——三种
  // 情况都回同一个理由（细节只进服务端日志）。这条断言就是在钉这个"不区分"。
  const { doc, provider } = connect("not-a-real-token");
  const failure = await once(provider, "authenticationFailed", "鉴权失败");
  assert.equal(failure.reason, PERMISSION_DENIED, `应回笼统理由，实际 ${JSON.stringify(failure)}`);
  assert.equal(docContents(doc).length, 0, "鉴权失败却拿到了笔记正文");
  assert.equal(provider.isAuthenticated, false);
  destroyProviders();
});

test("陌生空间、不存在的笔记：两条拒绝的理由一模一样", async () => {
  const foreign = connect(strangerToken);
  const foreignFailure = await once(foreign.provider, "authenticationFailed", "陌生空间被拒");
  assert.equal(foreign.provider.isAuthenticated, false);

  // 正向对照：必须真去探一篇"确实不存在"的笔记，否则上面那条拒绝可能只是
  // 因为 token 恰好有问题，测不到"存在性没泄露"。
  const inexistent = connect(ownerToken, documentNameForNote(randomUUID()));
  const inexistentFailure = await once(inexistent.provider, "authenticationFailed", "不存在的笔记被拒");

  assert.equal(
    foreignFailure.reason,
    inexistentFailure.reason,
    `跨空间探测的理由与不存在的笔记不同（${foreignFailure.reason} vs ${inexistentFailure.reason}），等于把"这篇笔记存在且属于某个空间"泄露给了探测方`,
  );
  assert.equal(foreignFailure.reason, PERMISSION_DENIED);
  destroyProviders();
});

test("owner 连上即拿到库里的正文；一篇笔记只有一份服务端文档", async () => {
  const first = connect(ownerToken);
  await first.synced;
  assert.deepEqual(docContents(first.doc), [noteTitle, paraA, paraB], "onLoadDocument 没把库里的块灌进来");

  const second = connect(ownerToken);
  await second.synced;
  assert.equal(collaborationLoad().documents, 1, "两条连接同一篇笔记却各持一份文档（文档名来自协议，不是 URL）");
  assert.equal(collaborationLoad().connections, 2, `连接数应为 2，实际 ${collaborationLoad().connections}`);
  assert.deepEqual(docContents(second.doc), [noteTitle, paraA, paraB]);
  destroyProviders();
  await waitFor(() => collaborationLoad().documents === 0, "文档卸载");
});

test("owner 的编辑：落 note_document_states、投影成 note_blocks，块数不变", async () => {
  const revisionBefore = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;
  const { doc, synced } = connect(ownerToken);
  // 必须先同步再改：在还空着的本地文档上写，等于提交整篇，正是 4.0 实测会复制块的形状。
  await synced;
  const edited = `${paraA}（owner 改过）`;
  editBlockContent(doc, 1, edited);

  await waitFor(async () => (await storedBlocks())[1] === edited, "文档快照写入编辑");
  await waitFor(async () => (await projectedRows())[1] === edited, "note_blocks 投影跟上编辑");

  const revisionAfter = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;
  assert.ok(
    Number(revisionAfter[0].revision) > Number(revisionBefore[0]?.revision ?? 0),
    `revision 必须递增（${revisionBefore[0]?.revision} → ${revisionAfter[0]?.revision}）`,
  );
  assert.equal((await projectedRows()).length, 3, "块数变了：整篇写入被用在了交互编辑上（4.0 实测会复制块）");
  destroyProviders();
  await waitFor(() => collaborationLoad().documents === 0, "文档卸载");
});

test("只读成员：知道自己只读、上送不落库，但仍能实时看到 owner 的编辑", async () => {
  const owner = connect(ownerToken);
  await owner.synced;
  const member = connect(memberToken);
  const authed = once(member.provider, "authenticated", "member 鉴权完成");
  authed.catch(() => {});
  await member.synced;

  // 判据来自服务端（`Authenticated("readonly")`），不是客户端自己声明。
  // 4.3/4.4 的编辑器禁用态就以这个为准。
  assert.equal((await authed).scope, "readonly", "member 应被判为只读");
  assert.equal(member.provider.authorizedScope, "readonly");

  const phantom = `${paraB}（成员偷偷改的）`;
  editBlockContent(member.doc, 2, phantom);

  // 超过 debounce 的一整轮：既够更新被广播给 owner，也够它落库。两处都没有，
  // 才说明"只读"挡的是写入本身，而不只是界面。
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.ok(!docContents(owner.doc).includes(phantom), "只读成员的更新被广播给了其他连接");
  assert.ok(!(await storedBlocks()).includes(phantom), "只读成员的更新进了文档快照");
  assert.ok(!(await projectedRows()).includes(phantom), "只读成员的更新进了 note_blocks");

  const fromOwner = `${paraA}（owner 后来的编辑）`;
  editBlockContent(owner.doc, 1, fromOwner);
  await waitFor(() => docContents(member.doc).includes(fromOwner), "只读成员收到 owner 的编辑");
  await waitFor(async () => (await projectedRows()).includes(fromOwner), "owner 的编辑落库");
  // 落的是整份快照，所以这一步同时证明那条被拒的更新从来没进过服务端文档；
  // 只在 3.5 秒处看"库里没有"是不够的——那个窗口里根本没有落盘发生。
  assert.ok(!(await storedBlocks()).includes(phantom), "被拒的只读更新留在服务端文档里，下一次落盘就会写进库");
  assert.equal((await projectedRows()).length, 3, "被拒的只读更新把服务端文档搞坏了（后续写入形状变了）");
  destroyProviders();
  await waitFor(() => collaborationLoad().documents === 0, "文档卸载");
});

test("HTTP 上送增量：一条 WS 都没建也能写（personal 与离线队列的口）", async () => {
  // 服务端这条路上没有"空间类型"分支——personal 从不建连，collaborative 没连上时
  // 也一样。所以"零连接"这条用例就是 personal 空间的服务端形状。
  assert.equal(collaborationLoad().connections, 0, "前一条用例没清干净，这条的结论会失真");
  const revisionBefore = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;

  const local = await storedDoc();
  const httpEdit = `${paraA}（HTTP 改的）`;
  editBlockContent(local, 1, httpEdit);
  const response = await uploadUpdate(ownerToken, await incrementalUpdate(local));
  assert.equal(response.statusCode, 200, `上送必须成功，实际 ${response.statusCode}: ${response.body}`);
  assert.ok(Number(response.json().revision) > 0, "响应没带 revision，客户端队列无法确认");

  await waitFor(async () => (await storedBlocks())[1] === httpEdit, "HTTP 增量落进快照");
  await waitFor(async () => (await projectedRows())[1] === httpEdit, "HTTP 增量投影进 note_blocks");
  assert.ok(
    Number((await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`)[0].revision) >
      Number(revisionBefore[0]?.revision ?? 0),
    "上送之后 revision 必须递增",
  );
  // 直连用完必须释放：留在内存里就是"没人看管的一份活文档"。
  await waitFor(() => collaborationLoad().documents === 0, "直连文档卸载");
  local.destroy();
});

test("同一条增量重放两次是幂等的：revision 不动、内容不变", async () => {
  // 离线队列会按序重发，服务端必须把重复的 update 当成没发生。
  const local = await storedDoc();
  const replay = `${paraB}（重放用）`;
  editBlockContent(local, 2, replay);
  const update = await incrementalUpdate(local);
  const response = await uploadUpdate(ownerToken, update);
  assert.equal(response.statusCode, 200);
  await waitFor(async () => (await storedBlocks())[2] === replay, "第一次上送落库");
  const revisionAfterFirst = response.json().revision as number;

  const second = await uploadUpdate(ownerToken, update);
  assert.equal(second.statusCode, 200, "重放不该报错，客户端无法据此判断要不要出队");
  assert.equal(
    Number(second.json().revision),
    revisionAfterFirst,
    `重放把 revision 从 ${revisionAfterFirst} 推到了 ${second.json().revision}（内容没变却算了一次写入）`,
  );
  local.destroy();
});

test("HTTP 增量与 WS 活文档合并：两边都看到对方，且不复制块", async () => {
  // 这条测的是"只有一份内存文档"。若 HTTP 那条路各自读快照→改→写回，它会用旧内容
  // 覆盖掉 WS 上还没落盘的那次编辑——正是审查里"静默覆盖"的形状。
  const { doc, provider, synced } = connect(ownerToken);
  await synced;
  const wsEdit = `${paraA}（WS 改的）`;
  editBlockContent(doc, 1, wsEdit);
  await waitFor(() => provider.unsyncedChanges === 0, "服务端确认收到 WS 编辑");

  const local = await storedDoc();
  const httpEdit = `${paraB}（HTTP 改的）`;
  editBlockContent(local, 2, httpEdit);
  const response = await uploadUpdate(ownerToken, await incrementalUpdate(local));
  assert.equal(response.statusCode, 200, `实际 ${response.statusCode}: ${response.body}`);

  await waitFor(() => docContents(doc).includes(httpEdit), "活文档收到 HTTP 上送的增量");
  await waitFor(async () => (await projectedRows()).includes(httpEdit), "HTTP 增量落库");
  const rows = await projectedRows();
  assert.ok(rows.includes(wsEdit), "HTTP 那条路用旧快照覆盖了 WS 的编辑");
  assert.equal(rows.length, 3, `块数从 3 变成 ${rows.length}（两条路合并时复制了块）`);
  local.destroy();
  destroyProviders();
  await waitFor(() => collaborationLoad().documents === 0, "文档卸载");
});

test("member 走 HTTP 上送同样被拒：403，库里没有它的内容", async () => {
  const local = await storedDoc();
  const denied = `${paraB}（成员想经 HTTP 改的）`;
  editBlockContent(local, 2, denied);
  const response = await uploadUpdate(memberToken, await incrementalUpdate(local));
  assert.equal(response.statusCode, 403, `只读判据必须同一条，实际 ${response.statusCode}: ${response.body}`);
  assert.ok(!(await storedBlocks()).includes(denied), "HTTP 口把只读拦在了门外但内容进了库");
  local.destroy();
});

test("同一个人从自己另一个空间上送：404，且库里一个字都没动", async () => {
  // 这条顶替的是 `content-workspace-transaction.test.ts` 里那条字符串计数保证：
  // 增量上送这条路不在路由体里开事务，所以"跨空间读不到"必须由真请求证明。
  // token 在**它自己的空间**里确实是 owner，所以 404 只能来自按空间收窄的那次查找。
  const local = await storedDoc();
  const foreign = `${paraA}（从别的空间上送）`;
  editBlockContent(local, 1, foreign);
  const before = await storedBlocks();

  const response = await uploadUpdate(ownerOtherToken, await incrementalUpdate(local));
  assert.equal(response.statusCode, 404, `跨空间上送必须按"不存在"处理，实际 ${response.statusCode}: ${response.body}`);
  assert.ok(!(await storedBlocks()).includes(foreign), "跨空间上送改了别人的正文");
  assert.deepEqual(await storedBlocks(), before, "被拒的上送动了快照");
  local.destroy();
});

test("非法或超限的增量：400 与 413 分得清", async () => {
  const malformed = await uploadUpdate(ownerToken, "这不是 base64!!");
  assert.equal(malformed.statusCode, 400, `非 base64 应回 400，实际 ${malformed.statusCode}`);

  const oversize = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
  const tooBig = await uploadUpdate(ownerToken, oversize);
  assert.equal(tooBig.statusCode, 413, `超尺寸应回 413，实际 ${tooBig.statusCode}: ${tooBig.body}`);
  assert.equal(tooBig.json().error, "update_too_large");
});

test("关停：debounce 窗口里的最后一次编辑必须落盘", async () => {
  // 这条测的是关停顺序（server.ts 里 flush 在 app.close() 之前）。
  // 反过来的话，最后 2 秒内的编辑会随连接一起丢掉——正是"静默销毁用户内容"。
  const { doc, provider, synced } = connect(ownerToken);
  await synced;
  const last = `${paraB}（关停前的最后一次编辑）`;
  editBlockContent(doc, 2, last);
  // 等服务端确认收到（`SyncStatus(true)`），否则这条用例测的是"消息还没到就被关了"，
  // 那是运气不是 flush。
  await waitFor(() => provider.unsyncedChanges === 0, "服务端确认收到更新");
  // 故意不等 debounce：立刻关停，靠 flushPendingStores 把它刷出来。
  await closeNoteCollaboration();
  assert.ok((await storedBlocks()).includes(last), "关停把 debounce 窗口里的编辑丢了");
  assert.ok((await projectedRows()).includes(last), "关停了但 note_blocks 没跟上");
  assert.equal(collaborationLoad().documents, 0);
  destroyProviders();
});
