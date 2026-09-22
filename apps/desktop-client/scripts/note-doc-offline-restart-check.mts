/**
 * 断网可编辑 + 跨进程重启后按序交清（决定 7 的那半，此前只有单元证据）。
 *
 * 跑法（三个**独立进程**，中间进程真的死掉，才算"跨过重启"）：
 *   node --experimental-strip-types scripts/note-doc-offline-restart-check.mts seed
 *   node --experimental-strip-types scripts/note-doc-offline-restart-check.mts offline
 *   node --experimental-strip-types scripts/note-doc-offline-restart-check.mts restart
 *
 * 为什么分三个进程而不是一个里跑三段：要证的正是"欠的增量不留在内存里过夜"
 * （`note-doc-cache-store` 那句注释）。同一进程里 restore 自己的内存态是恒绿的。
 * 反向对照同样要跑一次：`offline` 之后把 `/tmp/note-doc-offline-cache-v1.json` 删掉再
 * `restart`，它必须喊"盘上没有那一份"——不然这条量的是别的什么东西。
 *
 * 它按个人空间的真实路径走：那里按门控**不建长连接**，写入就是
 * "取起点 → 差分 → 上送 HTTP"，网络断在第 3 步之后。
 *
 * 2026-09-22 第一次跑的输出：`{queued:20}` → 新进程 `pending=20` → 交完之后
 * 20 条全在、顺序按 1..20 递增、仍是 1 块、队列清空。删盘那份则如实报"没落盘"。
 * 造的三篇量测笔记用产品的两步删除清掉了（`DELETE /notes/:id` 再 `/permanent`；
 * 直接打 `/permanent` 会 404——它只处理已在回收站里的那篇）。
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DesktopGateway } from "/Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/main/desktop-gateway.ts";
import {
  FileNoteDocCacheStore,
  type NoteDocCacheEntryV1,
} from "/Users/asklins/Documents/asklins_workspace/study/apps/desktop-client/src/main/note-doc-cache-store.ts";

const ROOT = "/Users/asklins/Documents/asklins_workspace/study";
for (const line of readFileSync(`${ROOT}/.env`, "utf8").split("\n")) {
  const match = /^(AILEARN_DESKTOP_[A-Z_]+|AILEARN_DOMAIN_SCHEMA_REVISION|DESKTOP_API_ORIGIN|DESKTOP_DEPLOYMENT_CONFIG_REVISION)=(.*)$/.exec(line);
  if (match) process.env[match[1]] = match[2].trim();
}
const API = "http://127.0.0.1:4000";
const STATE_FILE = "/tmp/note-doc-offline-check.json";
const CACHE_FILE = "/tmp/note-doc-offline-cache-v1.json";
const EDITS = 20;

const cache = new FileNoteDocCacheStore(CACHE_FILE);
const readState = () => JSON.parse(readFileSync(STATE_FILE, "utf8")) as { noteId: string; userId: string; workspaceId: string; stamp: string };

async function newGateway() {
  const gateway = new DesktopGateway(process.env as NodeJS.ProcessEnv);
  await gateway.connect();
  await gateway.login("owner@ailearn.local", "ailearn_owner");
  const session = await gateway.getSession();
  if (!session.workspace) throw new Error("没有会话空间");
  return { gateway, userId: session.user?.userId ?? "", workspaceId: session.workspace.workspaceId };
}

const phase = process.argv[2];

if (phase === "seed") {
  rmSync(CACHE_FILE, { force: true });
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const login = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@ailearn.local", password: "ailearn_owner" }) }).then((r) => r.json());
  const created = await fetch(`${API}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ title: `离线量测 ${stamp}`, blocks: [{ type: "paragraph", content: `起点 ${stamp}` }] }),
  }).then((r) => r.json());
  const noteId = created?.note?.id ?? created?.note?.noteId;
  if (!noteId) throw new Error(`建笔记失败：${JSON.stringify(created)}`);
  writeFileSync(STATE_FILE, JSON.stringify({ noteId, userId: login.ctx.userId, workspaceId: login.ctx.workspaceId, stamp }));
  console.log(`建好一篇：${noteId}（个人空间，按门控本来就不建长连接）`);
  process.exit(0);
}

if (phase === "offline") {
  const state = readState();
  const { gateway, userId, workspaceId } = await newGateway();
  // 起点必须先取到：没有共同祖先就造不出增量（这是"断网可编辑"成立的前提边界）。
  const start = await gateway.getNoteDocState(state.noteId);
  console.log(`起点到手（${start.blocks.length} 块，归属 ${start.shareScope}），现在断网`);
  const realFetch = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v2/notes/")) { blocked += 1; throw new TypeError("fetch failed"); }
    return realFetch(input as never, init as never);
  }) as typeof fetch;

  const receipts: string[] = [];
  for (let i = 1; i <= EDITS; i += 1) {
    // 累计式：每一次都是在上一篇之上**追加**一句（这才是"离线期间改了 20 次"）。
    // 早先版本每次传的是"起点｜离线第i条"整段替换，那是要 CRDT 删掉前 19 句，
    // 它删得对——那次跑的 19 条"丢了"量的不是产品，是我自己的喂法。
    const blocks = [{ type: "paragraph", content: `起点 ${state.stamp}` + Array.from({ length: i }, (_, k) => `｜离线第${k + 1}条`).join("") }];
    try {
      const receipt = await gateway.syncNoteDocBlocks(state.noteId, blocks, undefined);
      receipts.push(receipt.via);
    } catch (error) {
      receipts.push(`throw:${(error as { code?: string }).code ?? "?"}`);
    }
    await cache.set({ subjectId: userId, workspaceId, noteId: state.noteId }, {
      ...(gateway.noteDocLocalSnapshot(state.noteId) as Omit<NoteDocCacheEntryV1, "epochAtRest" | "updatedAt">),
      epochAtRest: 1,
      updatedAt: new Date().toISOString(),
    } as NoteDocCacheEntryV1);
  }
  globalThis.fetch = realFetch;
  const tally = receipts.reduce<Record<string, number>>((acc, via) => { acc[via] = (acc[via] ?? 0) + 1; return acc; }, {});
  const snapshot = gateway.noteDocLocalSnapshot(state.noteId);
  console.log(`断网写了 ${EDITS} 次：`, JSON.stringify(tally), `（被挡掉的请求 ${blocked} 个）`);
  console.log(`盘上那一份：pending=${snapshot?.pending.length} 条，docState=${snapshot?.docState.length ?? 0} 字符`);
  // 进程在这里结束 = 真重启：内存里那份就此消失。
  process.exit(0);
}

if (phase === "restart") {
  const state = readState();
  const { gateway, userId, workspaceId } = await newGateway();
  const entry = await cache.get({ subjectId: userId, workspaceId, noteId: state.noteId });
  if (!entry) { console.log(">>> 盘上没有那一份：断网期间欠的增量没落盘"); process.exit(1); }
  console.log(`接回盘上那份：pending=${entry.pending.length} 条`);
  gateway.restoreNoteDocLocal(state.noteId, {
    docState: entry.docState,
    pending: entry.pending,
    revision: entry.revision,
    savedAt: entry.savedAt,
    shareScope: entry.shareScope,
  });
  await gateway.flushNoteDocPending(state.noteId);
  const after = await gateway.getNote(state.noteId, "request-after-flush");
  const content = after.currentVersion.blocks.map((block) => block.content).join("\n");
  const missing = Array.from({ length: EDITS }, (_, i) => i + 1).filter((i) => !content.includes(`离线第${i}条`));
  console.log(`交完之后服务端：${after.currentVersion.blocks.length} 块 / ${content.length} 字`);
  console.log(missing.length === 0 ? `>>> ${EDITS} 条离线改动全部落库，顺序完整` : `>>> 少了 ${missing.length} 条：${missing.join(",")}`);
  console.log("顺序检查（每条的先后）:", (() => {
    const positions = Array.from({ length: EDITS }, (_, i) => content.indexOf(`离线第${i + 1}条`));
    return positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])) ? "按 1..20 递增 ✅" : `位置乱序：${positions.join(",")}`;
  })());
  const rest = await gateway.getNoteDocState(state.noteId);
  console.log(`队列清空：pending=${gateway.noteDocLocalSnapshot(state.noteId)?.pending.length ?? "n/a"}（起点现在是 ${rest.blocks.length} 块）`);
  process.exit(0);
}

console.log("phase = seed | offline | restart");
