import { sql } from "drizzle-orm";
import { learningRunAssistanceConsequenceV1 } from "@ailearn/shared/learning-run-contracts";
import type { WorkerTransaction } from "../db.ts";

/**
 * 读数由服务端填充（P2，39b §9.4；39d W2-5）：她只写键，真值在下发前由服务端渲染。
 *
 * 原事故是"编数"：她一句"本周你学了 107 分钟"（真值 154），而上下文里根本没有这个数——
 * 事后闸只能救回一次，并且要先付一步假话（话是流式说出口的）。同一类还有念头链的
 * "还有 25 项复习在排队"（那是真值，但它是她**抄**出来的：抄错就是编）。
 *
 * 做法照抄本项目已验证过的形状（日记「她只给编号，真货由服务端带」，`companion-daily-summary`）：
 *   - 回合开始产出一个**目录** `{ key → 值 }`，进 prompt 的是目录**本身**；
 *   - 她写 `{{f:key}}`，服务端在下发前渲染成值；未知键**丢那半句、留正文**并 warn；
 *   - 没被问到的键**根本不在目录里** ⇒ "没问就不要报数"从"叮嘱＋形状闸"变成
 *     **她没有可报错的对象**（39b §9.2）。
 *
 * 做完之后她正文里的数字只有三种来源：① 服务端目录；② 用户自己说的话；③ 名字里的数字。
 *
 * 一处一个来源：目录里的值就是 `readLearningStats`（工具与环境块共用那份）与念头链
 * 素材里已经算好的那几个数，本模块**不另开查询**。
 */

/** 目录里允许出现的键，以及各自的量词（问句判据与产出对齐用同一份，见 `askableFactSpanKeys`）。 */
export const FACT_SPAN_KEYS = {
  today_minutes: { quantifiers: ["分钟", "小时"], label: "今天学了多久" },
  week_minutes: { quantifiers: ["分钟", "小时"], label: "本周学了多久" },
  due_count: { quantifiers: ["项", "个", "条"], label: "到期复习几项" },
  card_count: { quantifiers: ["张"], label: "活跃卡片几张" },
  // 39b §9.4 列了五个键，这里多一个 `note_count`：回放里 G1 唯一那条 still-leak 就是
  // 「我知道你笔记库里有 11 篇」（笔记数）——没有这个键，那条声明在新机制下**无值可填**，
  // 闸就删不掉。值本来就在同一份统计里（`readLearningStats.noteCount`），不增查询。
  note_count: { quantifiers: ["篇"], label: "笔记几篇" },
  streak_days: { quantifiers: ["天"], label: "连续学习几天" },
  /**
   * 后果告知（39d W2-4 #14）。它**不是读数**，所以量词集是空的——`askable` 恒真：
   * 用户没问数字，她也该知道"给提示会把这一题降成练习"。真值来自合同
   * （`learningRunAssistanceConsequenceV1`），不是这里手写的一句。
   */
  assistance_consequence: { quantifiers: [], label: "看提示的后果" },
} as const;

export type FactSpanKey = keyof typeof FACT_SPAN_KEYS;

export type FactSpanValues = Partial<Record<FactSpanKey, string>>;

/**
 * 用户这一轮问到的键（39b §9.4：「`askable` 由用户输入决定（有没有疑问词＋量词的组合）」）。
 *
 * 判得保守是设计的一部分：漏了的代价是她改用具体说法（"今天学得不多"）而不是报错；
 * 误判的代价是把"没问也报数"重新请回来——那是刚赶出去的缺陷。所以要求**疑问词与量词
 * 同时出现**，且分钟类还要带上时间范围（今天/本周），否则"学了 1 小时好累"这种陈述句
 * 也会被当成问句。
 */
const ASK_PATTERNS: Record<FactSpanKey, RegExp[]> = {
  today_minutes: [
    /(今天|今日)[^。！？]{0,12}(多久|多长时间|多少|几)[^。！？]{0,6}(分钟|小时)/,
    /(今天|今日)[^。！？]{0,6}(学|复习|读|看)[^。！？]{0,6}(多久|多长时间|多少)/,
  ],
  week_minutes: [
    /(这周|本周|这个星期|最近|这一阵)[^。！？]{0,12}(多久|多长时间|多少|几)[^。！？]{0,6}(分钟|小时)/,
    /(这周|本周|这个星期)[^。！？]{0,6}(学|复习|读|看了?)[^。！？]{0,6}(多久|多长时间|多少)/,
  ],
  due_count: [
    /(多少|几个|几条|几项|几)[^。！？]{0,6}(项|个|条)?[^。！？]{0,4}(到期|该复习|要复习)/,
    /(到期|复习)[^。！？]{0,8}(多少|几个|几条|几项)/,
  ],
  card_count: [/(多少|几)[^。！？]{0,4}(卡|卡片|学习卡)/],
  // 「几篇」在句尾时后面没有名词（"我笔记有几篇"），所以量词本身也算落点。
  note_count: [/(多少|几)[^。！？]{0,4}(笔记|篇)/],
  streak_days: [/(连续|连着|坚持)[^。！？]{0,6}(多少|几天|几)/],
  // 空数组是**故意的**：这一格不吃问句（见上面那条注释的"恒真"），
  // 由 `askableFactSpanKeys` 无条件放行；写进这里就等于把它退回"先问到才配说"。
  assistance_consequence: [],
};

export function askableFactSpanKeys(userText: string | undefined): FactSpanKey[] {
  const always: FactSpanKey[] = ["assistance_consequence"];
  if (typeof userText !== "string" || userText.length === 0) return always;
  const asked = (Object.keys(ASK_PATTERNS) as FactSpanKey[])
    .filter((key) => ASK_PATTERNS[key].some((pattern) => pattern.test(userText)));
  return [...new Set([...asked, ...always])];
}

/**
 * 连续学习天数（"她主动开口"与"用户问"两条链**共用这一份**）。
 *
 * 判据与念头链原来那段一字不差：取最近 14 条日记（新→旧），`learningRunsCompleted`
 * 或 `learningRunsCreated` 大于 0 就接着数，遇到一天没有就停。抽出来是因为它现在有两个
 * 消费者（事实目录与念头素材），两处各写一遍就会出现"她说连续 3 天、念头说连续 4 天"。
 */
/** 这一轮有没有一题正等着答（活动 run 的活动任务）。 */
async function hasAnswerableTask(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT r.id
    FROM learning_runs r
    JOIN learning_tasks t ON t.id = r.active_task_id
    WHERE r.workspace_id = ${scope.workspaceId}
      AND r.user_id = ${scope.userId}
      AND r.phase IN ('preparing', 'active', 'assessing', 'checkpoint', 'committing', 'paused')
      AND t.status = 'active'
    ORDER BY r.created_at DESC
    LIMIT 1
  `);
  return rows.length > 0;
}

export async function readStreakDays(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<number> {
  const rows = await tx.execute<{ date: string; runs: number }>(sql`
    SELECT date, COALESCE((facts->>'learningRunsCompleted')::int, 0)
      + COALESCE((facts->>'learningRunsCreated')::int, 0) AS runs
    FROM companion_daily_summaries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    ORDER BY date DESC LIMIT 14
  `);
  let streakDays = 0;
  for (const entry of Array.isArray(rows) ? rows : []) {
    if (Number(entry.runs) > 0) streakDays += 1;
    else break;
  }
  return streakDays;
}

/**
 * 这一轮的目录（值＋块）。**没有可报的键就返回 null**——不发明空块、也不留下空目录。
 *
 * 值一律来自调用方已经读到的那些数（`stats` 就是 `readLearningStats` 那一份，念头链
 * 传它自己素材里那两个），本函数只额外读一个 `streak_days`（它没人在算，且只在被问到
 * 时才读）。
 */
export async function loadFactSpans(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  keys: readonly FactSpanKey[],
  stats: { todayMinutes?: number; weekMinutes?: number; dueReviews?: number; activeCards?: number; noteCount?: number } | null,
): Promise<{ values: FactSpanValues; block: string | null } | null> {
  if (keys.length === 0) return null;
  const streakDays = keys.includes("streak_days") ? await readStreakDays(tx, scope) : null;
  // 后果这一格只在"这一轮真的有一题在答"时进目录：没有活动任务就没有可降级的对象，
  // 硬塞一句"看提示会降成练习"就是对她念一条此刻不成立的规则。
  const consequence = keys.includes("assistance_consequence")
    ? (await hasAnswerableTask(tx, scope) ? learningRunAssistanceConsequenceV1() : null)
    : null;
  const values = pickFactSpanValues({
    assistance_consequence: consequence,
    today_minutes: stats?.todayMinutes,
    week_minutes: stats?.weekMinutes,
    due_count: stats?.dueReviews,
    card_count: stats?.activeCards,
    note_count: stats?.noteCount,
    streak_days: streakDays,
  }, keys);
  const block = renderFactSpansBlock(values);
  return block ? { values, block } : null;
}

/** 只保留有值的键（值缺失 = 这个键这一轮算不出来，不能进目录）。 */
export function pickFactSpanValues(
  source: Partial<Record<FactSpanKey, number | string | null | undefined>>,
  keys: readonly FactSpanKey[],
): FactSpanValues {
  const out: FactSpanValues = {};
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    out[key] = typeof value === "number" ? String(value) : String(value);
  }
  return out;
}

/**
 * 目录块。**只列键与值，不写额外说明**——她已经有一条通用规则（C 层前言）告诉她
 * "要报读数就写 `{{f:key}}`"，这里再写一遍只会把同一句话堆两遍。
 */
export function renderFactSpansBlock(values: FactSpanValues): string | null {
  const keys = Object.keys(values) as FactSpanKey[];
  if (keys.length === 0) return null;
  return [
    "<fact_spans>",
    ...keys.map((key) => `${key} = ${values[key]}`),
    "</fact_spans>",
  ].join("\n");
}

const PLACEHOLDER = /\{\{\s*f:\s*([a-z_]{2,40})\s*\}\}/g;
/** 任何形如 `{{…` 的残留（含未闭合）：出现即说明她写了目录之外的东西。 */
const ANY_PLACEHOLDER = /\{\{/;
/** 句子切分：把"要丢的那半句"界定在句内，不牵连别的正文。 */
const CLAUSE = /[^。！？!?；;\n]*[。！？!?；;\n]?/g;

export interface FactSpanResolution {
  readonly text: string;
  /** 被丢掉的半句（原文），留给调用方记日志——静默丢弃会让"她怎么少说了一句"无法复盘。 */
  readonly dropped: string[];
}

/**
 * 渲染她正文里的 `{{f:key}}`。
 *
 * - 已知键 → 换成目录里的值（**逐字**，不做任何二次加工）；
 * - 未知键、未闭合的残留 → **丢掉那一句、其余正文照留**（日记那条策略）；
 * - 目录为空时同理：她这一轮没有可报的键，写了就丢。
 */
export function resolveFactSpans(text: string, values: FactSpanValues): FactSpanResolution {
  if (!ANY_PLACEHOLDER.test(text)) return { text, dropped: [] };
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const clause of text.match(CLAUSE) ?? []) {
    if (clause.length === 0) continue;
    if (!ANY_PLACEHOLDER.test(clause)) {
      kept.push(clause);
      continue;
    }
    let bad = false;
    const resolved = clause.replace(PLACEHOLDER, (_match, key: string) => {
      const value = (values as Record<string, string | undefined>)[key];
      if (value === undefined) {
        bad = true;
        return "";
      }
      return value;
    });
    // 未闭合的残留（`{{f:today` 或 `{{`）在 replace 之后仍然在 ⇒ 一样丢。
    if (bad || ANY_PLACEHOLDER.test(resolved)) {
      dropped.push(clause.trim());
      continue;
    }
    kept.push(resolved);
  }
  return { text: kept.join("").trim(), dropped };
}

/**
 * 流式专用：把结尾**没写完**的那段占位符扣住不下发（`…今天学了{{f:today_min`）。
 *
 * 不扣住的话用户会先看到半个标记、下一拍再看到它变成数字；`sanitizeCompanionVisibleText`
 * 对供应商控制符用的就是同一个办法（`withholdProviderControlTail`）。
 */
export function withholdPartialFactSpanTail(text: string): string {
  const open = text.lastIndexOf("{{");
  if (open < 0) return text;
  const close = text.indexOf("}}", open);
  return close < 0 ? text.slice(0, open) : text;
}
