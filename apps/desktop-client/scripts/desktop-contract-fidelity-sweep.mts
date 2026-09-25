// 桌面端 ↔ API 的合同保真扫描（只读）：拿主进程**同一个 schema** 去解**真实服务端**的响应体。
//
// 为什么值得留：2026-09-25 那条「伴星读页面的租约从来没续上过」就是这个形状——
// 网关用 publish 那份整快照 schema 去解只回两字段的 renew，解析 100% 失败，
// 而失败被一条静默 catch 咽掉，测试全绿、界面不红，症状只是「她偶尔读不到这一页」。
// 单测抓不到这一类（假响应照的是客户端想象的形状，不是服务端真实的形状），
// 只有把真服务端的响应体喂进真 schema 才说话。
//
// 判据分两栏：**HTTP 非 200 是这个探针的问题**（路径／参数猜错），
// 只有「200 且解不动」才是合同各想各的。末尾两条正控制必须都喊，否则上面那句不算数。
//
// 跑法（栈要在着）：
//   cd apps/desktop-client && export SWEEP_EMAIL=… SWEEP_PASSWORD=…   # 演示账号，见 scripts/companion-turn-e2e-verify.py
//   npx tsx scripts/desktop-contract-fidelity-sweep.mts
// 覆盖面只到**读面**：三个 schema 定义在网关文件内部（/health、/auth/me、/auth/workspaces）的不在此台，
// 写面（POST/PUT/DELETE 那 18 处）会改 dev 数据，故意不扫。
import {
  todayActivityV1Schema,} from "@ailearn/shared/activity-surface-contracts";
import {
  companionJourneyBootstrapSchema,} from "@ailearn/shared/companion-journey-contracts";
import {
  companionMemoryConflictListV1Schema,} from "@ailearn/shared/companion-memory-desktop-contracts";
import {
  companionAnswerModePreferenceV1Schema,
  companionVoicePreferenceV1Schema,} from "@ailearn/shared/companion-shell-contracts";
import {
  capabilityProjectionSchema,
  noteDocServerStateV1Schema,
  workspaceAiSettingsV1Schema,} from "@ailearn/shared/desktop-ipc-contracts";
import {
  desktopNoteListPageSchema,
  desktopSearchPageSchema,
  desktopSourceDetailSchema,
  desktopSourceListPageSchema,
  desktopSourceNotesPageSchema,} from "@ailearn/shared/desktop-surface-contracts";
import {
  learningObjectiveSurfaceV3Schema,
  objectiveListPageV3Schema,} from "@ailearn/shared/learning-objective-surface-contracts";
import {
  noteDetailV1Schema,} from "@ailearn/shared/note-projection-contracts";
import {
  reviewQueueV2Schema,} from "@ailearn/shared/review-queue-v2-contracts";
import {
  allWorkspacesStatsOverviewSchema,} from "@ailearn/shared/stats-overview-contracts";

const BASE = process.env.SWEEP_BASE ?? "http://127.0.0.1:4000";
const EMAIL = process.env.SWEEP_EMAIL ?? "";
const PASSWORD = process.env.SWEEP_PASSWORD ?? "";

const login = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json() as Promise<{ token?: string; ctx?: { workspaceId?: string } }>);
const token = login.token;
if (!token) {
  console.error("登录没拿到 token，扫描不作数");
  process.exit(2);
}
const workspaceId = login.ctx?.workspaceId ?? "";

async function probe(label: string, path: string, schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: (string | number | symbol)[]; message: string }[] } } }) {
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (error) {
    console.log(`  探针不通  ${label}  (${String(error).slice(0, 60)})`);
    return { status: -1, body: null };
  }
  if (status !== 200) {
    console.log(`  非 200(${status})  ${label}  ${path.slice(0, 60)}`);
    return { status, body };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    console.log(`  200 解得动  ${label}`);
  } else {
    const first = parsed.error?.issues[0];
    console.log(`  ★ 200 但解不动  ${label}  首个问题: ${(first?.path ?? []).join(".")} — ${first?.message ?? ""}`);
    console.log(`            响应体顶层键: ${Object.keys((body ?? {}) as object).slice(0, 12).join(", ")}`);
  }
  return { status, body };
}

const fixed: [string, string, never][] = [  ["auth/capabilities/v1", "/auth/capabilities/v1", capabilityProjectionSchema as never],
  ["me/ai-settings", "/me/ai-settings", workspaceAiSettingsV1Schema as never],
  ["answer-mode-preference", "/me/companion/answer-mode-preference", companionAnswerModePreferenceV1Schema as never],
  ["voice/preference", "/voice/preference", companionVoicePreferenceV1Schema as never],
  ["memory/conflicts", "/companion/memory/conflicts", companionMemoryConflictListV1Schema as never],
  ["journey/bootstrap", "/companion/journey/bootstrap", companionJourneyBootstrapSchema as never],
  ["activity/today", `/activity/today?workspaceId=${workspaceId}`, todayActivityV1Schema as never],
  ["stats/overview/all", "/stats/overview/all", allWorkspacesStatsOverviewSchema as never],
  ["reviews/v2/queue", "/reviews/v2/queue", reviewQueueV2Schema as never],
  ["sources(list)", "/sources", desktopSourceListPageSchema as never],
  ["notes(list)", "/notes", desktopNoteListPageSchema as never],
  ["objectives(list)", "/v2/learning-objectives", objectiveListPageV3Schema as never],
  ["search", "/search?q=IndexTTS", desktopSearchPageSchema as never],
];
console.log("== 无 id 的那一批 ==");
const results: Record<string, { status: number; body: unknown }> = {};
for (const [label, path, schema] of fixed) results[label] = await probe(label, path, schema);

console.log("\n== 从上面拿真 id 的那一批 ==");
const sourceId = ((results["sources(list)"].body as { items?: { id: string }[] })?.items ?? [])[0]?.id;
const noteId = ((results["notes(list)"].body as { items?: { id: string }[] })?.items ?? [])[0]?.id;
const objectiveItems = ((results["objectives(list)"].body as { items?: Record<string, unknown>[] })?.items ?? []);
const objectiveFirst = objectiveItems[0] ?? {};
if (objectiveItems.length) console.log(`  目标条目第一个的键: ${Object.keys(objectiveFirst).slice(0, 10).join(", ")}`);
const objectiveId = (objectiveFirst.objectiveId ?? objectiveFirst.id ?? undefined) as string | undefined;
if (sourceId) {
  await probe("sources/:id", `/sources/${sourceId}`, desktopSourceDetailSchema as never);
  await probe("sources/:id/notes", `/sources/${sourceId}/notes`, desktopSourceNotesPageSchema as never);
} else console.log("  拿不到 source id，这一档没扫到");
if (noteId) {
  await probe("v2/notes/:id", `/v2/notes/${noteId}`, noteDetailV1Schema as never);
  await probe("v2/notes/:id/doc-state", `/v2/notes/${noteId}/doc-state`, noteDocServerStateV1Schema as never);
} else console.log("  拿不到 note id，这一档没扫到");
console.log(`  objectives(list) 顶层键: ${Object.keys((results["objectives(list)"].body ?? {}) as object).join(", ")}；条数: ${JSON.stringify(Object.values((results["objectives(list)"].body ?? {}) as Record<string, unknown>).map((v) => Array.isArray(v) ? v.length : null).filter((n) => n !== null))}`);
if (objectiveId) {
  await probe("objectives/:id", `/v2/learning-objectives/${objectiveId}`, learningObjectiveSurfaceV3Schema as never);
} else console.log("  拿不到 objective id，这一档没扫到");

// ── 判据自证：这轮"全都解得动"只有在判据真能喊的时候才有意义 ──────────────
console.log("\n== 正控制（判据必须喊） ==");
const probeRes = await fetch(`${BASE}/voice/preference`, { headers: { authorization: `Bearer ${token}` } });
const probeBody = await probeRes.json();
const wrong = reviewQueueV2Schema.safeParse(probeBody);
console.log(wrong.success
  ? "  × 正控制失败：拿错 schema 也解得动 ⇒ 上面那句「全都解得动」不算数"
  : `  ✓ 换错 schema 会红（首个问题: ${(wrong.error?.issues[0]?.path ?? []).join(".")}）`);
const missing = await fetch(`${BASE}/sources/00000000-0000-0000-0000-000000000000`, { headers: { authorization: `Bearer ${token}` } });
console.log(missing.status >= 400
  ? `  ✓ 非 200 那一栏分得开（不存在的 id → ${missing.status}）`
  : `  × 非 200 栏没被 exercised（拿到 ${missing.status}）`);
console.log(`  注：三个只在网关内部定义的 schema（/health、/auth/me、/auth/workspaces）这轮没扫。`);
