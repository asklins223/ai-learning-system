/**
 * 念头（thought）生成器——念头管线切片①②③（2026-09-18 落地）。
 *
 * 设计：outputs/ai-伴星能力与主动性设计汇总-2026-09-18.md §四。
 * 素材层（复习到期 / 连续学习 / 惰性 / 记忆中的关系状态）
 *   → 念头库（assistant_thoughts 候选，打分 / grounding / 衰减）
 *   → 时机决策（沉默默认：静默时段 / 反馈降权 / 日预算 / 熟悉度门槛）
 *   → 表达（persona + 关系进 prompt，多候选挑一，grounding 校验）
 *   → 反馈回路（delivery 被 dismiss 的降权由 evaluateDismissalFeedback 承担；
 *     embedding 语义去重消灭"换着花样说同一句"）。
 *
 * 纯函数（buildDeterministicThoughts / parseThoughtCandidates / isDuplicateThought /
 * selectThoughtExpression / isWithinQuietHours[shared]）均可单测；DB/provider 只在
 * runCompanionThought 编排层出现。
 */

import { sql } from "drizzle-orm";
import { isFormalAnswerInProgress } from "../lib/formal-answer-signal.ts";
import { createHash } from "node:crypto";
import { companionLeakGateVersionV1 } from "@ailearn/shared/companion-leak-gates";
import type { WorkerTransaction } from "../db.ts";
import { readCompanionThoughtJobPayload } from "@ailearn/shared";
import {
  proactiveCadenceMs,
  type CompanionAvailabilityV1,
  type CompanionInterventionLevelV1,
  type CompanionQuietHours,
  POLICY_LIMITS,
  evaluateProactivePolicy,
} from "@ailearn/shared/companion-proactive-policy";
import { logger } from "../lib/logger.ts";
import { assertJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { createEmbeddingProvider } from "../lib/ai-provider.ts";
import {
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import {
  containsCompanionInternalToken,
  looksLikeJsonEnvelope,
  withoutQuotedNames,
  unwrapCompanionJsonEnvelope,
} from "./companion-dialogue-content.ts";
import { enqueueSystemEventDelivery } from "./companion-delivery-write.ts";
import { loadHereAndNow, renderHereAndNow } from "./companion-here-and-now.ts";
import { readStreakDays, resolveFactSpans } from "./companion-fact-spans.ts";
import type { JobPayload } from "./index.ts";

// ── 类型 ─────────────────────────────────────────────────────────────────

export interface ThoughtGrounding {
  readonly name: string;
  readonly entityRef: string;
}

export interface ThoughtCandidate {
  readonly source: "review_due" | "streak" | "inactivity" | "llm";
  readonly topic: string;
  readonly dedupeKey: string;
  readonly text: string;
  readonly urgency: number;
  readonly familiarityRequired: number;
  readonly grounding: readonly ThoughtGrounding[];
}

export interface ThoughtMaterial {
  readonly today: string;
  readonly readyReviews: number;
  /** 未来 12 小时内到期（含被用户推到期初）的复习条数。 */
  readonly dueSoonReviews: number;
  /**
   * 到期 / 将到期那两张卡**具体是哪一张**（卡片正面的提示语，最多三条）。
   *
   * 计数只该待在系统数据里，不该冒充她说的话——用户 2026-09-21 对着"新增学习卡 4 张；
   * 收录资料 1 份…"那句的原话是"这跟系统统计数据有什么区别？"。所以主动气泡从
   * "有 4 条复习到期了"改成「牛顿第二定律的比例关系」那张卡到点了：
   * **说不出是哪一张，就宁可不提**（没有实体时这两条规则直接不产候选，
   * 而不是退回成计数句）。
   */
  readonly dueReviewTitles: readonly string[];
  readonly soonDueTitles: readonly string[];
  readonly streakDays: number;
  readonly daysSinceLastLearning: number | null;
  readonly familiarity: number;
  readonly petName: string | null;
  readonly allowNudgeLearning: boolean;
  readonly allowPlayful: boolean;
  readonly catchphrase: string | null;
  /** 最近 7 天说过的公开文案（delivery + 念头），语义去重用。 */
  readonly recentlySaid: readonly string[];
  /**
   * 距上一次**例行主动开口**多少毫秒；从没开过为 null。
   *
   * 这是节奏的唯一输入（间隔按 `intervention_level` 取，见 shared 的
   * `PROACTIVE_CADENCE_MS`）。以前这里是一"最近 24h 被看见过的念头数"，
   * 配一个"一天 N 条"的额度——额度是错的控件，2026-09-21 删掉，理由写在
   * `companion-proactive-policy.ts` 的注释里。
   *
   * 量的是"说过"而不是"被看过"：两条气泡挤在 20 分钟内出现，无论用户看没看见都是吵。
   * 间隔最长 3 小时，所以一条没被看见的念头最多把她压住一个间隔，不会再出现
   * "三条僵尸占满一整天"那种事（§9.58）。
   */
  readonly msSinceLastRoutineCue: number | null;
  /** 最近 7 天已表达念头的 embedding（语义去重用）。 */
  readonly recentThoughtEmbeddings: readonly (readonly number[])[];
  /** 最近送达的 delivery 状态（新→旧，仅 displayed/acted/dismissed）。 */
  readonly recentDeliveryStates: readonly string[];
  /** 已有**已经说出口**（delivered/spent）念头的 dedupeKey：同一件事一天只提一次。 */
  readonly blockedDedupeKeys: ReadonlySet<string>;
  /**
   * 库里躺着但还没说出去的候选（status='candidate'）：key → id。
   * 必须是独立的一份而不是和 blocked 混在一起——被日预算/时机压住的念头正是
   * 下一次调度该送出去的那条；一旦和"说过的"同等对待，念头库就变成**一次性**的：
   * 生成那轮没送出去，之后就永远送不出去了（崩溃重试同理）。
   */
  readonly storedCandidates: ReadonlyMap<string, string>;
  /**
   * 环境事实块（here_and_now 渲染结果：本地时刻、正在学的东西、到期数、最近笔记）。
   * 念头的素材不能只有"到期复习/连续天数/熟悉度"三个数——用户 30 天没跑正式
   * 学习时这三项全为 0/空，模型无从下笔，于是整条管线静默产不出候选。
   */
  readonly facts: string | null;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const THOUGHT_LIMITS = {
  /** 候选/定稿文案长度上限（写入端即限制）。 */
  maxTextChars: 200,
  /** 表达层定稿长度上限（气泡一句话）。 */
  maxExpressionChars: 80,
  /** 每次调度最多表达的念头数（沉默默认：多数候选默默过期）。 */
  maxDeliveredPerRun: 1,
  // 这里没有任何"一天几条"的额度：例行主动的节奏是**间隔**，
  // 来自 shared 的 PROACTIVE_CADENCE_MS(intervention_level)，与 API 的
  // proactive-hook 同源。两处各写一份时，同一个"安静一点"在两条链路上
  // 会得到两个节奏（§9.19）。
  /** embedding 相似度超过该值视为重复（cosine，1 - 余弦距离）。 */
  embeddingDuplicateThreshold: 0.85,
  /** 字符 bigram Jaccard 超过该值视为重复（embedding 不可用时的降级）。 */
  bigramDuplicateThreshold: 0.6,
  /** 反馈降权：最近 3 条送达里 dismiss ≥2 → 本轮沉默（与 api proactive-policy 同规则）。 */
  feedbackWindowSize: 3,
  feedbackDismissLimit: 2,
  /** 念头有效期（候选 24h，送达 2h）。 */
  candidateTtlHours: 24,
  deliveredTtlHours: 2,
} as const;

// ── 纯函数层（可单测） ───────────────────────────────────────────────────

/**
 * 确定性规则直接产念头（切片②"先接时间模式 + 复习到期"）：
 * - review_due：有到期复习且近 24h 没提过；
 * - review_due_soon：12 小时内将要到期（含用户自己"稍后"推走的批次）——
 *   这条覆盖的是"还没到期但马上要到期"，是复习提醒里最有用的一档；只有
 *   review_due 的话，早上把所有卡"稍后"掉的人一整天都不会被提醒。
 * - streak：连续学习 ≥3 天（正向强化，温和）；
 * - inactivity：≥3 天没学习且有一点熟悉度才提（冷启动就该安静）。
 */
export function buildDeterministicThoughts(material: ThoughtMaterial): ThoughtCandidate[] {
  const out: ThoughtCandidate[] = [];
  if (material.readyReviews > 0 && material.allowNudgeLearning && material.dueReviewTitles[0]) {
    if (!material.blockedDedupeKeys.has(`review_due:${material.today}`)) {
      out.push({
        source: "review_due",
        topic: "review_due",
        dedupeKey: `review_due:${material.today}`,
        text: `「${material.dueReviewTitles[0]}」那张卡到点了，趁记忆还热，要不要过一遍？`,
        urgency: 70,
        familiarityRequired: 0.1,
        grounding: [],
      });
    }
  }
  if (material.dueSoonReviews > 0 && material.allowNudgeLearning && material.soonDueTitles[0]) {
    if (!material.blockedDedupeKeys.has(`review_due_soon:${material.today}`)) {
      out.push({
        source: "review_due",
        topic: "review_due_soon",
        dedupeKey: `review_due_soon:${material.today}`,
        text: `「${material.soonDueTitles[0]}」快到时间了，要不要提前扫一眼？`,
        urgency: 55,
        familiarityRequired: 0.1,
        grounding: [],
      });
    }
  }
  if (material.streakDays >= 3 && material.allowPlayful) {
    if (!material.blockedDedupeKeys.has(`streak:${material.today}`)) {
      out.push({
        source: "streak",
        topic: "streak",
        dedupeKey: `streak:${material.today}`,
        text: "这几天你一直没断过，这份节奏值得记一笔。",
        urgency: 30,
        familiarityRequired: 0.15,
        grounding: [],
      });
    }
  }
  if (
    material.daysSinceLastLearning !== null
    && material.daysSinceLastLearning >= 3
    && material.familiarity >= 0.2
    && material.allowNudgeLearning
  ) {
    if (!material.blockedDedupeKeys.has(`inactivity:${material.today}`)) {
      out.push({
        source: "inactivity",
        topic: "inactivity",
        dedupeKey: `inactivity:${material.today}`,
        text: "好几天没见了。不用有压力，从最小的一步开始就好。",
        urgency: 45,
        familiarityRequired: 0.2,
        grounding: [],
      });
    }
  }
  return out;
}

/**
 * 一个数字是不是"凭空多出来的"。
 *
 * 允许集是**服务端交给模型的那份事实**（`facts` + 材料里那几个计数 + 今天日期），
 * 也就是 prompt 里已经说过的那批数。归一化只去掉前导零（`09` ≡ `9`，日期与"连续第
 * 09 天"这类写法要对得上），不做子串匹配——子串会让 `26`/`20` 从年份 `2026` 里
 * "合法"出来，那正是这道闸要拦的东西。
 *
 * 两个调用点，两种允许集：**LLM 现编的候选**在 `parseThoughtCandidates` 里比这份事实
 * （那时还没有"原句"可参照）；**改写已有候选**只比候选原句自己——原句要么来自服务端
 * 模板（数字是 `material.dueSoonReviews` 这类算出来的），要么已经被前一道闸放行。
 * 两步合起来才封住：库里实测 `grounding` 对数字型候选恒为 `[]`（那条"12 小时里有 25
 * 条复习要到期"就是 `[]`），所以"必须命中实体名"对这类句子整条形同虚设，
 * 模型想把 25 改成 3 也没人管——而这句话**全部内容就是那个数**。
 *
 * 取舍与对话链路相反，这里可以严：命不中只是丢掉这个变体、回落到模板原句，
 * **代价是少一点花样，不是没有气泡**；那边拒绝等于用户拿不到回答，所以只能宽。
 */
function normalizeNumericToken(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}

function numericTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) out.add(normalizeNumericToken(match[0]));
  return out;
}

export function introducesUnverifiedNumbers(text: string, allowedSource: string): boolean {
  if (allowedSource.length === 0) return false;
  const allowed = numericTokens(allowedSource);
  for (const token of numericTokens(text)) {
    if (!allowed.has(token)) return true;
  }
  return false;
}

/** LLM 批量产念头（可选路径）：解析 JSON 数组，逐条消毒，失败返回空。 */
export function parseThoughtCandidates(
  raw: string,
  today: string,
  allowedNumbersSource = "",
): ThoughtCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { thoughts?: unknown[] })?.thoughts;
  if (!Array.isArray(list)) return [];
  const out: ThoughtCandidate[] = [];
  for (const item of list.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const raw = typeof record.text === "string" ? record.text.trim() : "";
    if (raw.length === 0) continue;
    // 念头文本会直接念给用户听，同样不能是 JSON 信封（见 companion-dialogue-content）。
    const text = unwrapCompanionJsonEnvelope(raw).trim();
    if (text.length === 0 || text.length > THOUGHT_LIMITS.maxTextChars) continue;
    if (containsCompanionInternalToken(text) || looksLikeJsonEnvelope(text)) continue;
    // **凭空数字在产出的这一步就丢**，不等到播报：播报前的改写校验拿"候选自己"当
    // 允许集（那是给改写用的），所以 LLM 现编的数字只有在这里才有人管。
    // prompt 里写着"不要把上面任何一条数字原样念出来"（那才是我们想要的表达），
    // 但一句没有执行的叮嘱等于没有——和 §9.24 那条"不许编数字"的 prompt 一样。
    if (introducesUnverifiedNumbers(text, `${today}\n${allowedNumbersSource}`)) {
      logger.warn(
        { topic: record.topic, text: text.slice(0, 60) },
        "companion thought candidate dropped: states a number the server never gave it",
      );
      continue;
    }
    const urgency = typeof record.urgency === "number" && Number.isFinite(record.urgency)
      ? Math.min(100, Math.max(0, Math.round(record.urgency)))
      : 25;
    out.push({
      source: "llm",
      topic: typeof record.topic === "string" && record.topic.length > 0 ? record.topic.slice(0, 40) : "llm",
      // 按内容而不是按序号去重：序号去重会让**同一天第二次调度**只剩"位置 1、2"
      // 可用——哪怕模型说了全新的话，只要它排在第 0 位就被当作重复丢掉，
      // 于是"每天越早越有机会说话，越晚越必然产不出候选"。
      dedupeKey: `llm:${today}:${createHash("sha1").update(text).digest("hex").slice(0, 10)}`,
      text,
      urgency,
      familiarityRequired: 0.2,
      grounding: [],
    });
  }
  return out;
}



function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** pgvector 的文本形态 "[1,2,3]" → number[]；形状异常返回 null。 */
export function parseVectorText(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const parts = trimmed.slice(1, -1).split(",").map((value) => Number(value.trim()));
  if (parts.length === 0 || parts.some((value) => !Number.isFinite(value))) return null;
  return parts;
}

/**
 * 语义去重（切片①）：embedding 可用 → 与最近念头的 cosine 过阈值即重复；
 * 不可用 → 降级 bigram Jaccard（对最近说过的所有文案）。
 */
export function isDuplicateThought(
  candidateText: string,
  options: {
    readonly recentTexts: readonly string[];
    readonly recentEmbeddings: readonly (readonly number[])[];
    readonly candidateEmbedding: readonly number[] | null;
  },
): boolean {
  const candidateBigrams = bigrams(candidateText);
  for (const text of options.recentTexts) {
    if (text.trim() === candidateText.trim()) return true;
    if (jaccard(candidateBigrams, bigrams(text)) >= THOUGHT_LIMITS.bigramDuplicateThreshold) return true;
  }
  if (options.candidateEmbedding) {
    for (const embedding of options.recentEmbeddings) {
      if (cosineSimilarity(options.candidateEmbedding, embedding) >= THOUGHT_LIMITS.embeddingDuplicateThreshold) {
        return true;
      }
    }
  }
  return false;
}


/**
 * "数字 + 统计量词"这一种形状。与抽取器里 `isVolatileStatisticMemory` 用的是同一个
 * 判别式（那边防的是统计进长期记忆，这边防的是统计进气泡），量词表刻意不含"以内/每"
 * 这类用户自己说出口的偏好（"每次练习约 10 分钟"是她的话，不是系统读数）。
 */
const STATISTIC_QUANTITY_TEST = /\d+(?:\.\d+)?\s*(分钟|小时|天|周|张|篇|项|次|条|题|%)/;

/**
 * 名字里的数字不算读数：判形状之前先洗掉 `「…」` / `《…》` 里的内容
 * （`withoutQuotedNames`，与记忆抽取那条判据共用）。
 *
 * 不这么做会造出一个**漏报**：一张标题写着「背 3 条法律」的卡，模板句是
 * 「背 3 条法律」那张卡到点了…，会被这道闸当成"统计读数"永久拦掉——于是这张卡
 * 再也提醒不了，而日志只会说"被统计闸拦了"，没人往漏报上想。
 */
export function readsOutStatistics(text: string): boolean {
  return STATISTIC_QUANTITY_TEST.test(withoutQuotedNames(text));
}

/**
 * 例行主动开口的时机判定（四条闸的**唯一实现处**，纯函数）。
 *
 * 抽出来有两个原因：
 * 1. 这四条以前直接写在 handler 里，改任何一条都要连 job + DB 才知道它到底拦没拦，
 *    而"拦错方向"（该拦的没拦、不该拦的拦了）在读日志上根本看不出来；
 * 2. 顺序本身是语义——勿扰优先于静默时段，两条都命中时报错了没人会发现。
 *
 * 「勿扰」这一条是这次新加的：以前只有 api 的 proactive-hook 认 `presence`，
 * 念头管线连这一列都没读，所以 HUD 上那个开关对"她主动开口"完全无效
 * （设置存在、界面能改、其中一条链路不听——和 §9.61 那四套节奏是同一种病）。
 */
export interface RoutineCueTimingInput {
  readonly availability: CompanionAvailabilityV1;
  readonly quietHours: CompanionQuietHours | null;
  readonly now: Date;
  readonly recentDeliveryStates: readonly string[];
  readonly interventionLevel: CompanionInterventionLevelV1;
  readonly msSinceLastRoutineCue: number | null;
  /**
   * **这个空间**是否被静音（`companion_room_profiles.proactive_muted`，0266）。
   *
   * 审查 4.4：主动触达按 (ws,user) 各自产生，而开关只有账号级——一个人在两个空间
   * 就会同时收到两边的"她想跟你说话"，只能靠把整个伴星关掉来止血。
   * 这一条排在最前面：它是用户对**这个房间**的显式决定，比账号级的时段与节奏更具体。
   */
  readonly spaceMuted: boolean;
  /** 这个人在这个空间里有一条正式测评正在作答（doc 34 L12）。 */
  readonly formalAnswerInProgress: boolean;
}

export type RoutineCueTimingReason =
  | "allowed" | "space_muted" | "availability" | "quiet_hours" | "formal_answer_in_progress"
  | "dismissal_feedback" | "dedupe_recent" | "cadence" | "expired";

export function evaluateRoutineCueTiming(input: RoutineCueTimingInput): {
  allow: boolean;
  reason: RoutineCueTimingReason;
  detail: Record<string, unknown>;
} {
  // 这里**不再自己判任何一条**：全部交给 `evaluateProactivePolicy`（doc 34 L12 收形）。
  // 之前两边的形状是"策略函数写了、管线里另有一份"，缺的两格补进管线之后就变成
  // 同一件事有两个来源——正是本文批评的东西。
  // 本函数只剩两件本分的活：把料取到的字段摆成策略要的入参，以及把决策翻回
  // 管线自己的 reason/detail 词汇（detail 是给那行 silent 日志用的排查线索）。
  const recentShownCount = input.recentDeliveryStates.filter(
    (state) => state === "displayed",
  ).length;
  const decision = evaluateProactivePolicy({
    availability: input.availability,
    interventionLevel: input.interventionLevel,
    formalAnswerInProgress: input.formalAnswerInProgress,
    msSinceLastShown: input.msSinceLastRoutineCue,
    recentShownCount,
    // 念头这条路上没有"单条提示过期"的概念：每次都按未过期交进去，
    // 过期判定留在 triggered 那一支（到点提醒的 2 小时窗口由 0238/0270 自己管）。
    expired: false,
    spaceMuted: input.spaceMuted,
    quietHours: input.quietHours,
    recentDeliveryStates: input.recentDeliveryStates,
    kind: "routine",
    now: input.now.getTime(),
  });
  const reason: RoutineCueTimingReason =
    decision.reasonCode === "dnd" || decision.reasonCode === "offline"
      ? "availability"
      : decision.reasonCode === "cooldown"
        ? "cadence"
        : decision.reasonCode;
  return {
    allow: decision.allow,
    reason,
    detail:
      reason === "cadence"
        ? {
          interventionLevel: input.interventionLevel,
          msSinceLastRoutineCue: input.msSinceLastRoutineCue,
          cadenceMs: proactiveCadenceMs(input.interventionLevel),
        }
        : reason === "dedupe_recent"
          ? { recentShownCount, limit: POLICY_LIMITS.dedupeWindowLimit }
          : reason === "availability"
            ? { availability: input.availability }
            : reason === "dismissal_feedback"
              ? { recentStates: input.recentDeliveryStates }
              : {},
  };
}

/** 表达校验（切片③）：长度 / 内部 token 泄露 / grounding 命中 / 改写不许改数字。 */
export function validateThoughtExpression(
  text: string,
  grounding: readonly ThoughtGrounding[],
  allowedSource = "",
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > THOUGHT_LIMITS.maxExpressionChars) return false;
  if (containsCompanionInternalToken(trimmed)) return false;
  // 统计形状（数字 + 量词）不进气泡：实机 2026-09-21 探针跑出来的 LLM 候选原句是
  // "明天九点记得复习消防路线哦。今晚这42分钟学得很扎实…"——
  // 那个 42 分钟**是环境块里的真值**，所以 `introducesUnverifiedNumbers` 放它过了，
  // 但它仍然是系统读数，不是她开口的方式（用户口径：不报数字）。
  // 数字只允许留在**名字里**（《IndexTTS 2.5》、第 3 章），所以判的是形状不是数值。
  if (readsOutStatistics(trimmed)) return false;
  // grounding 非空时必须命中至少一个实体名——"不许说不存在的事"。
  if (grounding.length > 0) {
    const hit = grounding.some((entity) => entity.name.length > 0 && trimmed.includes(entity.name));
    if (!hit) return false;
  }
  if (allowedSource.length > 0 && introducesUnverifiedNumbers(trimmed, allowedSource)) return false;
  return true;
}

/** 多候选挑一（切片③）：按序返回第一个通过校验的变体；全部失败返回 null（兜底用原文案）。 */
export function selectThoughtExpression(
  candidates: readonly string[],
  grounding: readonly ThoughtGrounding[],
  allowedSource = "",
): string | null {
  for (const candidate of candidates) {
    if (validateThoughtExpression(candidate, grounding, allowedSource)) return candidate.trim();
  }
  return null;
}

/** 表达 prompt（切片③）：persona + 关系状态 + 当下事实 + 最近说过的话一起进。 */
export function buildExpressionPrompt(args: {
  petName: string | null;
  familiarity: number;
  allowPlayful: boolean;
  allowNudgeLearning: boolean;
  catchphrase: string | null;
  /** 环境事实块（含本地时刻）——主动开口的措辞要贴当下（早上/深夜不该同一句）。 */
  facts: string | null;
  thoughtText: string;
  groundingNames: readonly string[];
  recentlySaid: readonly string[];
}): string {
  const lines = [
    `你是学习桌宠${args.petName ? `「${args.petName}」` : ""}。基于下面这条"念头"写一句主动开口的话。`,
    `念头：${args.thoughtText}`,
    args.facts ? `你知道的当下（可以据此措辞，但不要照念数字）：\n${args.facts}` : "",
    `关系熟悉度：${args.familiarity.toFixed(2)}（0 刚认识，1 很熟）。刚认识就自来熟比机械更假——熟悉度低就写得克制、短。`,
    `风格允许：玩趣=${args.allowPlayful ? "可以" : "不要"}；催学习=${args.allowNudgeLearning ? "可以" : "不要"}。`,
    ...(args.catchphrase ? [`口头禅（可自然融入，不强求）：${args.catchphrase}`] : []),
    ...(args.groundingNames.length > 0 ? [`这句话必须提到：${args.groundingNames.join("、")}（不许提别的事物名）。`] : []),
    ...(args.recentlySaid.length > 0 ? [`最近说过的话（不要重复、不要换着花样说同一句）：\n- ${args.recentlySaid.slice(0, 5).join("\n- ")}`] : []),
    "要求：≤80 字，一句自然中文，不出现 ID/系统词/引号外的格式。返回 JSON：{\"variants\":[\"…\",\"…\",\"…\"]}，给出 3 个候选。",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── 编排层 ───────────────────────────────────────────────────────────────

/**
 * 未过期念头按"说过 / 还没说出口"分流（入参须按 created_at DESC）。
 *
 * 同一个 dedupe_key 可能有多行（表上没有唯一约束）：说过的以最先遇到的为准，
 * 待送候选取**最新**那行（更早的通常是同一次生成的重复行）。
 */
export function splitActiveThoughts(
  rows: readonly { dedupe_key: string; status: string; id: string }[],
): Pick<ThoughtMaterial, "blockedDedupeKeys" | "storedCandidates"> {
  const blockedDedupeKeys = new Set<string>();
  const storedCandidates = new Map<string, string>();
  for (const row of rows) {
    const key = String(row.dedupe_key);
    if (row.status === "candidate") {
      if (!storedCandidates.has(key)) storedCandidates.set(key, row.id);
      continue;
    }
    blockedDedupeKeys.add(key);
    storedCandidates.delete(key);
  }
  return { blockedDedupeKeys, storedCandidates };
}

interface MaterialRow extends Record<string, unknown> {
  ready_reviews: number;
  due_soon_reviews: number;
  /** 到期/将到期的**具体是哪两张卡**（卡片正面提示语，各最多三条）。 */
  due_titles: string[] | null;
  soon_titles: string[] | null;
  familiarity: number;
  speaking_style: string | null;
  personality_tags: string[] | null;
  boundaries: Record<string, unknown> | null;
  catchphrase: string | null;
  pet_name: string | null;
  days_since_last_learning: number | null;
  ms_since_last_cue: number | null;
}

/**
 * 候选入念库那一发 INSERT 的**唯一**落点。单独拎出来不是为了好看：`leak_gate_version`
 * （39d #28）今天只有这一处写它的地方，而它要有库级证据——写在大 handler 深处的那条语句
 * 没有任何用例跑得动（念头链路要 job＋模型），拎出来才能让用例用真的 SQL 钉住它。
 */
export async function insertThoughtCandidateV1(
  tx: WorkerTransaction,
  actor: { workspaceId: string; userId: string },
  candidate: ThoughtCandidate,
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO assistant_thoughts
      (workspace_id, user_id, source, topic, dedupe_key, text, grounding,
       status, urgency, familiarity_required, expires_at, leak_gate_version)
    VALUES
      (${actor.workspaceId}, ${actor.userId}, ${candidate.source}, ${candidate.topic}, ${candidate.dedupeKey},
       ${candidate.text}, ${JSON.stringify(candidate.grounding)}::jsonb,
       'candidate', ${candidate.urgency}, ${candidate.familiarityRequired},
       now() + (${THOUGHT_LIMITS.candidateTtlHours} * interval '1 hour'),
       ${companionLeakGateVersionV1()})
    RETURNING id
  `);
  return (Array.isArray(rows) ? rows : [])[0]?.id ?? null;
}

export async function runCompanionThought(job: JobPayload): Promise<void> {
  const { userId } = readCompanionThoughtJobPayload(job.payload);
  await assertJobLease(job);

  // ── 阶段 1：素材收集（独立 RLS 事务） ────────────────────────────────
  const material = await withJobTransaction(job, async (tx) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await tx.execute<MaterialRow>(sql`
      SELECT
        (SELECT count(*)::int FROM review_schedules
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND status = 'pending' AND next_review_at <= now()
          AND (user_deferred_until IS NULL OR user_deferred_until <= now())) AS ready_reviews,
        (SELECT count(*)::int FROM review_schedules
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND status = 'pending'
          AND coalesce(user_deferred_until, next_review_at) > now()
          AND coalesce(user_deferred_until, next_review_at) <= now() + interval '12 hours') AS due_soon_reviews,
        (SELECT COALESCE(familiarity, 0) FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS familiarity,
        (SELECT speaking_style FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS speaking_style,
        (SELECT personality_tags FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS personality_tags,
        (SELECT boundaries FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS boundaries,
        (SELECT boundaries->>'catchphrase' FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS catchphrase,
        (SELECT name FROM pet_profiles
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1) AS pet_name,
        (SELECT extract(day FROM now() - max(created_at))::int FROM learning_runs
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}) AS days_since_last_learning,
        -- 上一次例行主动开口距今多少毫秒。delivered 与 spent 都算（spent = 用户点开过，
        -- 更是"她说过话了"）。只回看 6 小时：最长间隔是 3 小时，再老的读数用不上，
        -- 也别为了一个用不上的数去扫全表。
        (SELECT (extract(epoch FROM now() - max(delivered_at)) * 1000)::int
           FROM assistant_thoughts
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
            AND status IN ('delivered', 'spent')
            AND delivered_at > now() - interval '6 hours') AS ms_since_last_cue
    `);
    const row = ((Array.isArray(rows) ? rows : [])[0] ?? {}) as Partial<MaterialRow>;

    // 「是哪一张」而不是「有几条」：主动气泡要能点出一个具体对象，
    // 否则宁可不提（计数句是系统统计，不是她说的话）。
    // 连的是 `c.objective_id = s.subject_id`——`review_schedules.subject_type='card'`
    // 只是历史别名，列里存的是 objectiveId（方案 29 §9.48）。
    const titleRows = await tx.execute<Pick<MaterialRow, "due_titles" | "soon_titles">>(sql`
      SELECT
        (SELECT coalesce(array_agg(t.cue), '{}') FROM (
          SELECT nullif(btrim(c.front->>'cue'), '') AS cue
          FROM review_schedules s
          JOIN learning_cards_v2 c
            ON c.objective_id = s.subject_id AND c.workspace_id = s.workspace_id
           AND c.lifecycle = 'active'
          WHERE s.workspace_id = ${job.workspaceId} AND s.user_id = ${userId}
            AND s.status = 'pending' AND s.next_review_at <= now()
            AND (s.user_deferred_until IS NULL OR s.user_deferred_until <= now())
            AND nullif(btrim(c.front->>'cue'), '') IS NOT NULL
          ORDER BY s.next_review_at LIMIT 3) t) AS due_titles,
        (SELECT coalesce(array_agg(t.cue), '{}') FROM (
          SELECT nullif(btrim(c.front->>'cue'), '') AS cue
          FROM review_schedules s
          JOIN learning_cards_v2 c
            ON c.objective_id = s.subject_id AND c.workspace_id = s.workspace_id
           AND c.lifecycle = 'active'
          WHERE s.workspace_id = ${job.workspaceId} AND s.user_id = ${userId}
            AND s.status = 'pending'
            AND coalesce(s.user_deferred_until, s.next_review_at) > now()
            AND coalesce(s.user_deferred_until, s.next_review_at) <= now() + interval '12 hours'
            AND nullif(btrim(c.front->>'cue'), '') IS NOT NULL
          ORDER BY coalesce(s.user_deferred_until, s.next_review_at) LIMIT 3) t) AS soon_titles
    `);
    const titleRow = ((Array.isArray(titleRows) ? titleRows : [])[0] ?? {}) as
      Partial<Pick<MaterialRow, "due_titles" | "soon_titles">>;

    const recentSaidRows = await tx.execute<{ text: string }>(sql`
      SELECT text FROM (
        SELECT payload_ref->>'text' AS text, created_at FROM assistant_deliveries
        WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND kind = 'system_event' AND created_at > now() - interval '7 days'
        UNION ALL
        SELECT text, created_at FROM assistant_thoughts
        WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND status IN ('delivered', 'spent') AND created_at > now() - interval '7 days'
      ) said ORDER BY created_at DESC LIMIT 20
    `);

    const feedbackRows = await tx.execute<{ state: string }>(sql`
      SELECT state FROM assistant_deliveries
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        AND kind = 'system_event'
        AND state IN ('displayed', 'acted', 'dismissed')
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 3
    `);

    const activeKeysRows = await tx.execute<{ dedupe_key: string; status: string; id: string }>(sql`
      SELECT dedupe_key, status, id FROM assistant_thoughts
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        AND status IN ('candidate', 'delivered', 'spent')
        AND expires_at > now()
      ORDER BY created_at DESC
    `);

    const embeddingRows = await tx.execute<{ embedding: string }>(sql`
      SELECT embedding::text AS embedding FROM assistant_thoughts
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        AND status IN ('delivered', 'spent')
        AND embedding IS NOT NULL
        AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 30
    `);

    const accountRows = await tx.execute<{
      quiet_hours: Record<string, unknown> | null;
      intervention_level: string | null;
      presence: { presence?: "online" | "dnd" | "offline" } | null;
    }>(sql`
      SELECT quiet_hours, intervention_level, presence FROM user_companion_account_state
      WHERE user_id = ${userId} LIMIT 1
    `);

    // 空间级打扰开关（0266）：账号级总开关之外，"这个房间要不要出声"。
    // 缺行按不静音——房间档案没建过时不该默认闭嘴。
    const roomProfileRows = await tx.execute<{ proactive_muted: boolean }>(sql`
      SELECT proactive_muted FROM companion_room_profiles
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId} LIMIT 1
    `);

    // 正式作答进行中（doc 34 L12 缺的最后一格）。判据在 `lib/formal-answer-signal.ts`
    // ——语音投递那条路现在也读同一个来源，不再各写一份 SQL。
    const formalRunRows = await isFormalAnswerInProgress(tx, {
      workspaceId: job.workspaceId,
      userId,
    }) ? [{ one: 1 }] : [];

    // 环境事实块与对话侧同源（同一份 SQL、同一个 RLS 事务）：她主动开口时知道的
    // 世界，必须和被动回答时知道的是同一个。
    const hereAndNow = await loadHereAndNow(tx, {
      workspaceId: job.workspaceId,
      userId,
      conversationId: null,
    });

    // 连续学习天数：与"用户问"那条链**共用同一份判据**（39d W2-5 抽出去的那份），
    // 两处各写一遍就会出现"她说连续 3 天、气泡说连续 4 天"。
    const streakDays = await readStreakDays(tx, { workspaceId: job.workspaceId, userId });

    const boundaries = (row.boundaries ?? {}) as Record<string, unknown>;
    const quietHours = accountRows[0]?.quiet_hours as CompanionQuietHours | null;
    // 没有账号行时按 moderate 处理：未知不等于"最多"，也不等于"静音"。
    const rawLevel = accountRows[0]?.intervention_level;
    const interventionLevel: CompanionInterventionLevelV1 =
      rawLevel === "quiet" || rawLevel === "active" || rawLevel === "moderate" ? rawLevel : "moderate";
    // `presence` 可以是 NULL（这一列只有 HUD 上那个开关会写，没动过就是空）。
    // "没设过"不等于"勿扰"，所以缺省按在线；但用户一旦显式设了勿扰/离线，
    // 这条链路必须听——以前它连这一列都没读。
    const availability: CompanionAvailabilityV1 = accountRows[0]?.presence?.presence ?? "online";
    // 空间级静音（0266）。缺行按 false：房间档案还没建过时不该默认闭嘴。
    const spaceMuted = roomProfileRows[0]?.proactive_muted === true;
    const formalAnswerInProgress = formalRunRows.length > 0;

    return {
      today,
      readyReviews: Number(row.ready_reviews ?? 0),
      dueReviewTitles: (titleRow.due_titles ?? []).map((value) => String(value)).slice(0, 3),
      soonDueTitles: (titleRow.soon_titles ?? []).map((value) => String(value)).slice(0, 3),
      dueSoonReviews: Number(row.due_soon_reviews ?? 0),
      streakDays,
      daysSinceLastLearning: row.days_since_last_learning != null ? Number(row.days_since_last_learning) : null,
      familiarity: Number(row.familiarity ?? 0),
      petName: row.pet_name ?? null,
      allowNudgeLearning: boundaries.allowNudgeLearning !== false,
      allowPlayful: boundaries.allowPlayful !== false,
      catchphrase: typeof row.catchphrase === "string" ? row.catchphrase : null,
      msSinceLastRoutineCue: row.ms_since_last_cue == null ? null : Number(row.ms_since_last_cue),
      recentlySaid: (Array.isArray(recentSaidRows) ? recentSaidRows : [])
        .map((entry) => String(entry.text ?? ""))
        .filter((text) => text.length > 0),
      recentDeliveryStates: (Array.isArray(feedbackRows) ? feedbackRows : []).map((entry) => String(entry.state)),
      ...splitActiveThoughts(Array.isArray(activeKeysRows) ? activeKeysRows : []),
      recentThoughtEmbeddings: (Array.isArray(embeddingRows) ? embeddingRows : [])
        .map((entry) => parseVectorText(String(entry.embedding ?? "")))
        .filter((values): values is number[] => values !== null),
      quietHours,
      interventionLevel,
      availability,
      spaceMuted,
      formalAnswerInProgress,
      facts: renderHereAndNow(hereAndNow),
    } satisfies ThoughtMaterial & {
      quietHours: CompanionQuietHours | null;
      interventionLevel: CompanionInterventionLevelV1;
      availability: CompanionAvailabilityV1;
      spaceMuted: boolean;
      formalAnswerInProgress: boolean;
    };
  });

  const {
    quietHours,
    interventionLevel,
    availability,
    spaceMuted,
    formalAnswerInProgress,
    ...thoughtMaterial
  } = material;

  // 每一次调度都留一行结局。沉默本身是对的（"沉默默认"是设计），但**沉默且无日志**
  // 等于这个功能不存在——抱怨 #8 的排查过程里，这条管线跑完就是 "job ok"，
  // 没有任何地方说明它为什么什么都没说。
  const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
    logger.info({ jobId: job.id, outcome, ...extra }, "companion thought outcome");
  };

  // ── 时机决策：沉默是默认（四条闸见 `evaluateRoutineCueTiming`）─────────
  // 全部排在**任何模型调用之前**：以前最后一条是"一天 N 条"的额度，而且写在
  // 候选生成之后——于是"今天已经说满"的那些调度照样白烧一次 LLM 才闭嘴。
  const timing = evaluateRoutineCueTiming({
    availability,
    quietHours,
    now: new Date(),
    recentDeliveryStates: thoughtMaterial.recentDeliveryStates,
    interventionLevel,
    msSinceLastRoutineCue: thoughtMaterial.msSinceLastRoutineCue,
    spaceMuted,
    formalAnswerInProgress,
  });
  if (!timing.allow) {
    finish("silent", { reason: timing.reason, ...timing.detail });
    return;
  }

  // ── 阶段 2：候选念头（确定性规则打底，不足 3 条再让模型补） ───────────
  // 授权/治理上下文两处调用完全一样，合并成一个工厂：consent 不通过时抛错走
  // 各自的 catch，而不是静默跳过（静默跳过 = 上面那条 warn 日志也不会出现）。
  const thoughtProvider = async () => {
    const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
    if (!govCtx.consentOk) throw new Error("ai_consent_denied");
    const textRes = resolveProviderForTask(govCtx, "companion_agent");
    return createGovernedProvider(
      createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
      govCtx,
      job.workspaceId,
      { userId, operation: "companion_thought", jobId: job.id, dataCategories: ["user_answer"] },
    );
  };

  let candidates = buildDeterministicThoughts(thoughtMaterial);
  const llmGap = candidates.length < 3 ? 3 - candidates.length : 0;
  if (llmGap > 0) {
    try {
      const provider = await thoughtProvider();
      const prompt = [
        `你是学习桌宠${thoughtMaterial.petName ? `「${thoughtMaterial.petName}」` : ""}。基于事实生成 ${llmGap} 条"主动开口的念头"候选——就是你没被问、但想主动说一句的话。`,
        thoughtMaterial.facts ? `你知道的当下：\n${thoughtMaterial.facts}` : "",
        `关系数据：到期复习 ${thoughtMaterial.readyReviews} 条；12 小时内将要到期 ${thoughtMaterial.dueSoonReviews} 条；连续学习 ${thoughtMaterial.streakDays} 天；熟悉度 ${thoughtMaterial.familiarity.toFixed(2)}（0 刚认识，1 很熟）。`,
        `风格允许：玩趣=${thoughtMaterial.allowPlayful ? "可以" : "不要"}；催学习=${thoughtMaterial.allowNudgeLearning ? "可以" : "不要"}。`,
        "不要为了说话而编造事实，也不要把上面任何一条数字原样念出来。",
        ...(thoughtMaterial.recentlySaid.length > 0 ? [`最近说过（不要重复、不要换着花样说同一句）：\n- ${thoughtMaterial.recentlySaid.slice(0, 5).join("\n- ")}`] : []),
        "要求：每条 ≤80 字、中文、不出现 ID/系统词。返回 JSON：{\"thoughts\":[{\"text\":\"…\",\"urgency\":0-100,\"topic\":\"…\"}]}",
      ].filter(Boolean).join("\n");
      const raw = await runWithAbortBudget(
        (signal) => provider.chatCompletion(
          [{ role: "user", content: prompt }],
          { temperature: 0.9, maxTokens: 500, responseFormat: "json_object" },
          signal,
        ),
        undefined,
        resolveProviderCallTimeout("companion_thought"),
      );
      const content = typeof (raw as { content?: unknown })?.content === "string" ? (raw as { content: string }).content : "";
      candidates = [...candidates, ...parseThoughtCandidates(
        content,
        thoughtMaterial.today,
        // 只有**服务端真的交给模型**的那些数可以出现在念头里。
        `${thoughtMaterial.facts ?? ""}
到期复习 ${thoughtMaterial.readyReviews}；12 小时内到期 ${thoughtMaterial.dueSoonReviews}；连续学习 ${thoughtMaterial.streakDays}；熟悉度 ${thoughtMaterial.familiarity.toFixed(2)}`,
      )];
    } catch (err) {
      logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, "companion thought llm batch failed; deterministic only");
    }
  }
  if (candidates.length === 0) {
    finish("silent", { reason: "no_candidates", factsIncluded: thoughtMaterial.facts !== null });
    return;
  }

  // ── 阶段 3：念头库落库（多数候选默默过期） + 挑选 + 表达 + 去重 ──────
  const eligible = candidates
    .filter((candidate) => !thoughtMaterial.blockedDedupeKeys.has(candidate.dedupeKey))
    .filter((candidate) => thoughtMaterial.familiarity >= candidate.familiarityRequired)
    .sort((a, b) => b.urgency - a.urgency);
  if (eligible.length === 0) {
    finish("silent", {
      reason: "all_candidates_gated",
      generated: candidates.length,
      dedupeFiltered: candidates.filter((c) => thoughtMaterial.blockedDedupeKeys.has(c.dedupeKey)).length,
      familiarity: thoughtMaterial.familiarity,
    });
    return;
  }

  // 候选先入念库（24h TTL）：被预算/时机压住的念头留档，大多数会被 expires 收走。
  // 已经在库里、还没说出口的（上一轮被预算压住 / 上一轮在这之后崩溃）复用原行，
  // 不重复插入也不跳过——否则念头库每轮都是全新的一次性样品。
  const candidateIds = new Map<string, string>();
  const toInsert = eligible.filter((candidate) => {
    const storedId = thoughtMaterial.storedCandidates.get(candidate.dedupeKey);
    if (!storedId) return true;
    candidateIds.set(candidate.dedupeKey, storedId);
    return false;
  });
  if (toInsert.length > 0) {
    await withJobTransaction(job, async (tx) => {
      for (const candidate of toInsert) {
        const id = await insertThoughtCandidateV1(tx, { workspaceId: job.workspaceId, userId }, candidate);
        if (id) candidateIds.set(candidate.dedupeKey, id);
      }
    });
  }

  // 节奏已经在阶段 1 之前判过了（`cadence`），这里没有第二道额度：
  // 一次调度最多送 `maxDeliveredPerRun` 条，同一件事由 dedupeKey 挡着。
  //
  // 表达升级（切片③）：多候选挑一 + grounding 校验，模板兜底。
  let embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>> = null;
  try {
    embeddingProvider = await createEmbeddingProvider();
  } catch {
    embeddingProvider = null;
  }

  for (const candidate of eligible.slice(0, 3)) {
    const thoughtId = candidateIds.get(candidate.dedupeKey);
    if (!thoughtId) continue;
    let expression = selectThoughtExpression([candidate.text], candidate.grounding) ?? candidate.text;
    try {
      const provider = await thoughtProvider();
      const raw = await runWithAbortBudget(
        (signal) => provider.chatCompletion(
          [{ role: "user", content: buildExpressionPrompt({
            petName: thoughtMaterial.petName,
            familiarity: thoughtMaterial.familiarity,
            allowPlayful: thoughtMaterial.allowPlayful,
            allowNudgeLearning: thoughtMaterial.allowNudgeLearning,
            catchphrase: thoughtMaterial.catchphrase,
            facts: thoughtMaterial.facts,
            thoughtText: candidate.text,
            groundingNames: candidate.grounding.map((entity) => entity.name),
            recentlySaid: thoughtMaterial.recentlySaid,
          }) }],
          { temperature: 0.9, maxTokens: 400, responseFormat: "json_object" },
          signal,
        ),
        undefined,
        resolveProviderCallTimeout("companion_thought"),
      );
      const content = typeof (raw as { content?: unknown })?.content === "string" ? (raw as { content: string }).content : "";
      const parsed = JSON.parse(content) as { variants?: unknown };
      const variants = Array.isArray(parsed?.variants)
        ? parsed.variants.filter((value): value is string => typeof value === "string")
        : [];
      const picked = selectThoughtExpression(variants, candidate.grounding, candidate.text);
      if (picked) expression = picked;
    } catch (err) {
      logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, "companion thought expression llm failed; template fallback");
    }

    // P2（39d W2-5）：气泡**没有读数目录**（她主动开口时没人在问），所以占位符一律
    // 按"目录外的键"处理——丢掉那半句、正文照留。不渲染的话用户会看到 `{{f:...}}`。
    const spanResolved = resolveFactSpans(expression, {});
    if (spanResolved.dropped.length > 0) {
      logger.warn(
        { jobId: job.id, dropped: spanResolved.dropped.length },
        "companion thought referenced fact spans; proactive bubbles have no catalog",
      );
    }
    expression = spanResolved.text;
    if (expression.trim().length === 0) {
      await withJobTransaction(job, async (tx) => {
        await tx.execute(sql`
          UPDATE assistant_thoughts SET status = 'suppressed', updated_at = now()
          WHERE id = ${thoughtId}
        `);
      });
      continue;
    }

    // 送达前最后一道：定稿句子仍然是"数字 + 量词"的读数，这条就不送。
    // 必须在这里判，不能只靠 `validateThoughtExpression`：那条管的是**改写**，
    // 而改写被拒时兜底就是候选原句本身（上面那句 `?? candidate.text`），
    // 实机 2026-09-21 的"今晚这42分钟学得很扎实"正是从这条缝里过去的。
    if (readsOutStatistics(expression)) {
      logger.info(
        { jobId: job.id, topic: candidate.topic },
        "companion thought dropped as statistics read-out",
      );
      await withJobTransaction(job, async (tx) => {
        await tx.execute(sql`
          UPDATE assistant_thoughts SET status = 'suppressed', updated_at = now()
          WHERE id = ${thoughtId}
        `);
      });
      continue;
    }

    // 语义去重（切片①）：embedding 优先，bigram 降级。
    let candidateEmbedding: number[] | null = null;
    if (embeddingProvider) {
      try {
        // `job.signal` 与上面 chatCompletion 同一口径：不给的话一次挂住的 embed
        // 只能等 transport 的 300 秒总超时，而本 handler 的预算只有 110 秒、租约 120 秒
        // ——整轮会带着已付过费的前两个候选一起超时重投。
        candidateEmbedding = await embeddingProvider.embed(expression, job.signal);
      } catch {
        candidateEmbedding = null;
      }
    }
    if (isDuplicateThought(expression, {
      recentTexts: thoughtMaterial.recentlySaid,
      recentEmbeddings: thoughtMaterial.recentThoughtEmbeddings,
      candidateEmbedding,
    })) {
      logger.info({ jobId: job.id, topic: candidate.topic }, "companion thought dropped as duplicate");
      await withJobTransaction(job, async (tx) => {
        await tx.execute(sql`
          UPDATE assistant_thoughts SET status = 'suppressed', updated_at = now()
          WHERE id = ${thoughtId}
        `);
      });
      continue;
    }

    // ── 阶段 4：表达定稿 + 送达 ─────────────────────────────────────────
    const delivered = await withJobTransaction(job, async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE assistant_thoughts
        SET status = 'delivered', text = ${expression},
            embedding = ${candidateEmbedding ? `[${candidateEmbedding.map((value) => value.toFixed(6)).join(",")}]` : null}::vector,
            delivered_at = now(),
            expires_at = now() + (${THOUGHT_LIMITS.deliveredTtlHours} * interval '1 hour'),
            updated_at = now()
        WHERE id = ${thoughtId} AND status = 'candidate'
        RETURNING id
      `);
      const confirmedId = (Array.isArray(updated) ? updated : [])[0]?.id;
      if (!confirmedId) return false;

      // 送达：复用 assistant_deliveries 的展示通道（气泡从 home projection 读）。
      // 序列锁 + NOTIFY 都在 enqueueSystemEventDelivery 里，别再在这里手写一遍。
      return enqueueSystemEventDelivery(tx, {
        workspaceId: job.workspaceId,
        userId,
        systemEventId: `thought:${confirmedId}`,
        text: expression,
        ttlHours: THOUGHT_LIMITS.deliveredTtlHours,
      });
    });
    if (delivered) {
      finish("delivered", { topic: candidate.topic, thoughtId, chars: expression.length });
      return; // 每次调度最多送 1 条：沉默默认。
    }
  }
  finish("silent", { reason: "no_candidate_survived", eligible: eligible.length });
}
