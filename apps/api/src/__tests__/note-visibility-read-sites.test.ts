/**
 * 笔记读点的可见性棘轮（批次 4.5）。
 *
 * 为什么必须有这一条：`notes` 的 RLS 本轮没重开，「仅自己可见」这条边界目前
 * **完全靠每个读点自己带上 `visibleNotesCondition`**。一个人漏写一处就是"列表挡住了、
 * 搜索没挡"那一类分裂——而那正是 2026-09-20 那份审查反复指出的东西。指望人记住
 * 27 个读点是不现实的，所以改成：新增一个读点而没有带上判据，CI 就红。
 *
 * 口径是"每个文件里：守卫出现次数 ≥ 读点次数 − 允许数"。允许数逐条写明理由，
 * 只能随着修好而变小；把允许数调大去迁就新代码，需要在这里解释为什么那一处不该按人筛。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const API_ROOT = new URL("..", import.meta.url).pathname;
const READ_PATTERNS = [
  /\bfrom\(notes\)/g,
  /\bquery\.notes\./g,
  // 大小写都要覆盖：`.innerJoin(notes,` 与 `.leftJoin(notes,` 如果被漏掉，
  // join 上带来的判据就会被算成"多余的守卫"，这条棘轮于是形同虚设
  // （第一版就是这样：删掉 activity 的一处判据仍然全绿）。
  /\b\w*[jJ]oin\(notes[,)]/g,
  /\bFROM\s+notes\b/gi,
];
const GUARD_TOKENS = [
  "visibleNotesCondition",
  "noteVisibleSqlText",
  "searchDocumentsVisibleSql",
  // 只按作者筛是同一句话的**更严**形式（onboarding 探针、里程碑判定只看自己的），
  // 所以它算带上判据，不算漏。
  "eq(notes.createdBy",
  // 作者判据（归属动作自己用）：能改这一列的人只有写下这篇的那个账号，比按人筛更严。
  "createdBy !== userId",
  // 索引正文里只收人人可见的那部分（objective 的标题来自 shared 笔记）。
  "eq(notes.shareScope",
];

/**
 * 系统级读点：这些位置没有"查看者"可言，也不该有。
 *
 * - `note/maintenance.ts`、`scripts/cleanup-soft-deleted-notes.ts`：定时物理清理，
 *   跨所有用户跑。带上按人判据反而会把已过期的私有笔记永久留在库里。
 * - `search/service.ts` 的前 3 处：`reindexWorkspaceSearch` 建索引与漂移检测。索引是
 *   全空间共用的一份数据，按某个人裁等于把他的视角烧进共用数据（下一次 owner 重索引，
 *   私有笔记连作者自己都搜不到）。发不发结果由查询侧那次 join 判，那一处有守卫。
 *   数字对不上时会红，改这里必须同步看 `search()` 里的那一次 join 还在不在。
 *
 * 这个数衡量的是"判据 token 抵不上的读点条数"，不是"有几处故意不按人筛"——一个 token
 * 可以服务多处（比如那段索引片段被查询与总数各用一次）。口径单调，所以新增读点不带判据
 * 一定红，删掉判据也一定红。
 * - `note/collaboration.ts` 的 1 处：`onStoreDocument` 落盘时按 noteId 取当前版本指针，
 *   不读正文；连接本身已在 `onAuthenticate` 按归属与空间拒过（那条有守卫）。
 */
const SYSTEM_LEVEL_READS: Record<string, number> = {
  // 定时清理与 CLI：跨所有用户跑，带上按人判据会把已过期的私有笔记永久留在库里。
  "modules/note/maintenance.ts": 1,
  "scripts/cleanup-soft-deleted-notes.ts": 1,
  // 建索引、索引清理与漂移检测三处：索引是全空间共用的一份，见 `search()` 里的 join。
  "modules/search/service.ts": 3,
  // `onAuthenticate` 按 `shareScope` + 空间拒连接，那是比"按人可见"更强的要求。
  "modules/note/collaboration.ts": 1,
  // `checkExportSize` 是体积保险丝，刻意取超集（见该处的注释）。
  "modules/export/service.ts": 1,
  // 写入过程中"这篇还在不在"的复查：把它按人筛会把一次并发删除变成对可见性不足的假报错。
  "modules/upload/upload-service.ts": 1,
};

/**
 * 目标读点的可见性棘轮（批次 4.5 最后一段）。
 *
 * 目标的 `concept_label` / `public_summary` / `objective_statement` 也是从笔记正文
 * 生成的，所以同一句话必须盖到这一层。判据走"目标 → 卡 → 笔记版本 → 笔记"，
 * 而不是"目标 → origins → 笔记"：dev 真实数据上量过，214 条 active 目标只有 43 条
 * 有 origin 行，按 origins 判等于给 80% 的目标发通行证；而 214/214 都有卡。
 */
const OBJECTIVE_READ_PATTERNS = [
  /\bfrom\(learningObjectivesV2\)/g,
  /\bfrom\(learningObjectiveRevisionsV2\)/g,
  /\b\w*[jJ]oin\(learningObjectivesV2[,)]/g,
  /\b\w*[jJ]oin\(learningObjectiveRevisionsV2[,)]/g,
  /\bFROM\s+learning_objectives_v2\b/gi,
  /\bFROM\s+learning_objective_revisions_v2\b/gi,
];
const OBJECTIVE_GUARD_TOKENS = [
  "visibleObjectivesCondition",
  // 更严的形式：只放自己写的笔记那一条，或按人筛过的卡。
  "eq(learningObjectivesV2.createdBy",
  "visibleCardsCondition",
  "visibleNotesCondition",
];
/**
 * 系统级 / 非展示读点。口径与上面两条一样：数的是"判据 token 抵不上的读点条数"，
 * 只能随着修好而变小。
 */
const OBJECTIVE_SYSTEM_LEVEL_READS: Record<string, number> = {
  // 生成与激活侧：调用方刚提交的那一批的闭环（能走到这里说明这篇笔记对他可读），
  // 以及按 objectiveId 精确取一行的 CAS。
  "modules/card-generation-v2/activation-service.ts": 7,
  "modules/card-generation-v2/target-snapshot-adapter.ts": 2,
  "modules/card-generation-v2/card-service.ts": 5,
  // 练习与复习：排程/回合本身就是按人的行（RLS + user_id），这里读的是"自己要做什么"，
  // 不是把目标的正文广播给别人。
  "modules/learning-runs/run-service.ts": 3,
  "modules/learning-runs/run-processing-tick.ts": 2,
  "modules/review/service.ts": 3,
  // 排程"这条目标还有没有能做的卡"的多态判定：只回答是/否，不返回任何文字。
  "modules/review/consumer-eligibility.ts": 1,
  // 目标自己的附属记录：origin 的增删与历史，都按 objectiveId 精确取。
  "modules/learning-objectives/origin-service.ts": 1,
  "modules/learning-objectives/origin-migration.ts": 1,
  "modules/learning-objectives/history-route-service.ts": 2,
  // 搜索索引是全空间共用的一份，按某个人裁会把他的视角烧进共用数据（见 notes 那条
  // 同样的理由）；目标这一侧的出口按同一套口径判。
  "modules/search/service.ts": 1,
  // `checkExportSize` 的体积保险丝，刻意取超集。
  "modules/export/service.ts": 2,
  // 游标行：只取 createdAt / id 定位分页，不返回任何文字。
  "modules/learning-objectives/surface-service.ts": 1,
};

/**
 * 抹掉注释内容但**保住行号**：直接删掉整行会让报出来的 `file:line` 对不上源码，
 * 而这条测试存在的意义就是告诉人来修——行号错了就没人修。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "integration-tests") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 卡片读点的可见性棘轮（批次 4.5 收尾）。
 *
 * 卡是从笔记正文抽出来的（`front` 是题面、`public_summary` 是一句摘要），所以
 * 「仅自己可见」的笔记只要生成过卡，正文就还有一条路能到别人手里。`visibleCardsCondition`
 * 把那扇门关上；这一条保证以后新增的卡读点不会悄悄不带上它。
 *
 * 判据不是"所有卡读点都要筛"，而是"**往外返回正文列的**要筛"。只取 `cardId` 的（跳转
 * 目标还在不在）、只取 `noteVersionId` 的（回填来源）、按 `cardId` 做 CAS 的（调用方
 * 自己刚发起的生成意图）都不返回内容，所以进豁免清单，并在那里写明理由。
 *
 * `learning_cards_v2` 的 `public_summary` / `front` 两列就是"内容"的判据：一次读点如果
 * 整行 `select()`，也算取内容（整行必然带上这两列）。
 */
const CARD_READ_PATTERNS = [/\bfrom\(learningCardsV2\)/g, /\bFROM\s+learning_cards_v2\b/gi];
const CARD_GUARD_TOKENS = ["visibleCardsCondition", "visibleNotesCondition", "eq(notes.createdBy"];
const CARD_SYSTEM_LEVEL_READS: Record<string, number> = {
  // 跳转目标可用性：只回答"这张卡还在不在"，取的是 `cardId` 一列。
  "modules/learning-runs/run-service.ts": 1,
  // 回填 `learning_objective_origins_v2`：取的是 `noteVersionId`，不回给任何人正文。
  "modules/learning-objectives/origin-migration.ts": 1,
  // 目标表面：从卡上只取 `cardId` / 两个 revision / `sourceLabel`（激活时写死为 null），
  // 题面与摘要都不从这里出去。
  "modules/learning-objectives/surface-service.ts": 4,
  // 星图 v3 的 objective→cardId 映射，同上。
  "modules/understanding-v3/topology-repository.ts": 2,
  // 生成侧：按 `cardId` 做 CAS（调用方自己刚提交的激活意图），以及截断告警里的总数。
  // 能走到这里的笔记已经过 `generation-run-service` 的按人判。
  "modules/card-generation-v2/activation-service.ts": 2,
  "modules/card-generation-v2/target-snapshot-adapter.ts": 1,
  // 取 `cardId` 的反查两处 + 截断告警的总数一处（v2 星图那一版）。
  "modules/understanding/projection-read-service.ts": 4,
  // 伴星"打开这张卡"的跳转：只把 cardId 换成 objectiveId，正文不从这条路出来
  // （到了目标页仍要过上面那些读点）。
  "modules/companion-conversation/learning-action-bridge.ts": 1,
  // `checkExportSize` 是体积保险丝，刻意取超集（与笔记那一处同一个理由）。
  "modules/export/service.ts": 1,
};

/**
 * `forward` 是"判据最远可以离读点几行"。默认 12 够一条普通查询；
 * 目标那一层的几个站点中间夹着 `leftJoin(...)` 与一长串 select 列，
 * 判据落在 13-18 行外，所以那一族单独放宽到 18 —— 仍然是"同一条查询内"，
 * 不是文件级计数（文件级计数的害处见上面那条注释）。
 */
function unguarded(
  file: string,
  rel: string,
  patterns: RegExp[],
  tokens: string[],
  forward = 12,
): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const lines = source.split("\n");
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index ?? 0).split("\n").length - 1;
      // 判据通常在 `where(and(...))` 里，紧跟读点之后；往前几行覆盖 join 条件写在
      // 上方的写法。窗口太宽会退化成"文件级计数"，所以只取 ±12 行。
      const window = lines.slice(Math.max(0, line - 4), line + forward).join("\n");
      if (tokens.some((token) => window.includes(token))) continue;
      out.push(`${rel}:${line + 1} (${match[0]})`);
    }
  }
  return out;
}

test("每一处笔记读点都就近带上可见性判据（或有写明理由的系统级豁免）", () => {
  // 按"这一处读点附近有没有判据"判，不按整个文件计数：第一版按文件计数时，
  // activity 里删掉一处判据仍然全绿——同一个文件里别处的判据把它蒙过去了。
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  const files = sourceFiles(join(API_ROOT, "modules")).concat(sourceFiles(join(API_ROOT, "scripts")));
  for (const file of files) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, READ_PATTERNS, GUARD_TOKENS);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的笔记读点没带可见性判据（或判据离得太远）：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "系统级豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("返回正文的卡片读点都带上「跟着来源笔记判」", () => {
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  for (const file of sourceFiles(join(API_ROOT, "modules"))) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = CARD_SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, CARD_READ_PATTERNS, CARD_GUARD_TOKENS);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处卡读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的卡片读点没带可见性判据：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "卡片豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("返回正文的目标读点都带上「跟着来源笔记判」", () => {
  const offenders: string[] = [];
  const staleExemptions: string[] = [];
  for (const file of sourceFiles(join(API_ROOT, "modules"))) {
    const rel = relative(API_ROOT, file).split("\\").join("/");
    const allowance = OBJECTIVE_SYSTEM_LEVEL_READS[rel] ?? 0;
    const misses = unguarded(file, rel, OBJECTIVE_READ_PATTERNS, OBJECTIVE_GUARD_TOKENS, 18);
    if (misses.length > allowance) {
      offenders.push(`${rel}: ${misses.length} 处目标读点没带判据，豁免只给了 ${allowance} 个 → ${misses.join(", ")}`);
    }
    if (allowance > misses.length) {
      staleExemptions.push(`${rel}: 豁免写了 ${allowance} 个，实际只有 ${misses.length} 处没带判据——调下来`);
    }
  }
  assert.deepEqual(offenders, [], "新增的目标读点没带可见性判据：\n" + offenders.join("\n"));
  assert.deepEqual(staleExemptions, [], "目标豁免比实际需要的多（棘轮只能缩短）：\n" + staleExemptions.join("\n"));
});

test("豁免清单里的文件确实存在（防止改名后豁免悬空）", () => {
  for (const rel of [...Object.keys(SYSTEM_LEVEL_READS), ...Object.keys(OBJECTIVE_SYSTEM_LEVEL_READS)]) {
    assert.equal(statSync(join(API_ROOT, rel)) !== null, true, `${rel} 已经不在了，豁免要删`);
  }
});
