/**
 * B4 的**服务端那一半**在真 HTTP 上量一遍（界面那一半被"新建笔记写不进正文"挡住了）。
 *
 * 跑法（在 api 容器里，那里 `packages/shared` 是**挂载的最新源码**；宿主
 * `apps/api/node_modules/@ailearn/shared` 是 09-21 08:01 的旧快照副本，缺
 * `cardGenerationPracticeQuotaV1Schema`，在宿主上 import 投影函数会直接报错）：
 *
 *   docker compose -f docker-compose.dev.yml exec -T \
 *     -e OWNER_EMAIL=… -e OWNER_PASSWORD=… api \
 *     npx tsx /app/src/probes/tmp-b4-http-probe.mts
 *
 * 放在 `src/probes/` 下是故意的：新建文件不触发 tsx watch，不会为了一次探针把共享的
 * api 进程重启给别人添堵。
 *
 * 三件事都必须是真的：真登录、真打两个 GET、拿**桌面端那份合同**去过服务端的真实返回。
 * 从组件测试反推不算——B4 的缺陷形状正是"jsdom 绿、真链路静默降级"。
 *
 * 这里有个我一度搞反的地方，写下来免得下次再猜：`projectCardGenerationCandidatesV1` 是
 * **服务端**在 `routes.ts:211` 调的，HTTP 返回的已经是投影后的 V1（顶层带 `version`/`runId`，
 * 每张候选也带 `version`）。把这份返回再喂回那支投影函数，会因为 strict 合同"多认了一个
 * version 键"而报错——那是我把输出当输入喂，不是产品坏了。要验的是"桌面端合同接得住"，
 * 所以这里 parse 的是 `cardGenerationCandidateListV1Schema`。
 */
import { cardGenerationCandidateListV1Schema } from "@ailearn/shared/card-generation-desktop-contracts";

const BASE = process.env.B4_API_BASE ?? "http://127.0.0.1:4000";
const RUN_ID = process.env.B4_RUN_ID ?? "a118751a-702f-4489-8327-c1391a1d9204";

const login = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }),
});
if (login.status !== 200) {
  console.log(JSON.stringify({ fatal: "登录没通", status: login.status, body: (await login.text()).slice(0, 200) }));
  process.exit(2);
}
const auth = (await login.json()) as { token?: string };
if (!auth.token) { console.log(JSON.stringify({ fatal: "登录响应里没有 token" })); process.exit(2); }
const headers = { authorization: `Bearer ${auth.token}` };

const get = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const run = await get(`/v2/card-generation-runs/${RUN_ID}`);
const candidates = await get(`/v2/card-generation-runs/${RUN_ID}/candidates`);

const runData = (run.body ?? {}) as { status?: string; progress?: Record<string, number> | null; recovery?: unknown };
const listData = (candidates.body ?? {}) as {
  candidates?: Array<{
    candidateId: string; qualityState: string;
    isReviewReady: boolean; objective?: { publicSummary?: string }; front?: { prompt?: string };
    canonicalAnswer?: unknown; evidence?: unknown;
  }>;
};
const rows = listData.candidates ?? [];
const landed = rows.filter((c) => c.qualityState !== "failed" && c.qualityState !== "dropped");

let contractTitles: string[] = [];
let contractError: string | null = null;
const parsed = cardGenerationCandidateListV1Schema.safeParse(candidates.body);
if (parsed.success) {
  contractTitles = parsed.data.candidates.map((c) => c.objective.publicSummary);
} else {
  contractError = JSON.stringify(parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, keys: i.keys })));
}

const report = {
  runHttpStatus: run.status,
  runDataStatus: runData.status,
  progress: runData.progress ?? null,
  recoveryPresent: runData.recovery != null,
  candidatesHttpStatus: candidates.status,
  rowCount: rows.length,
  landedCount: landed.length,
  qualityStates: rows.map((c) => c.qualityState),
  landedHavePromptAndConcept: landed.every((c) => !!c.front?.prompt && !!c.objective?.publicSummary),
  // 判分内容与证据不该随列表下发：出现任何一个都说明"生成中那一屏"会漏答案。
  leakedAnswerFields: rows.filter((c) => c.canonicalAnswer != null || c.evidence != null).map((c) => c.candidateId),
  projectionError: contractError,
  projectedTitles: contractTitles,
};
console.log(JSON.stringify(report, null, 2));

const fails: string[] = [];
if (runData.status !== "authoring") fails.push(`前提不成立：run 不在 authoring（实为 ${String(runData.status)}）`);
if (candidates.status !== 200) fails.push("在制状态下候选列表读不到（HTTP 不是 200）");
if (landed.length === 0) fails.push("候选列表里一张 landed 都没有");
if (!report.landedHavePromptAndConcept) fails.push("landed 候选缺题面或概念名（B4 列表要显示的就是这两样）");
if (report.leakedAnswerFields.length > 0) fails.push(`列表把答案/证据一起下发了：${report.leakedAnswerFields.length} 张`);
if (contractError) fails.push(`桌面端合同接不住服务端的真实返回：${contractError}`);
console.log(fails.length ? "FAIL\n" + fails.join("\n") : "PASS");
process.exit(fails.length ? 1 : 0);
