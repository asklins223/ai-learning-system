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
 * selectThoughtExpression / isWithinQuietHoursLocal）均可单测；DB/provider 只在
 * runCompanionThought 编排层出现。
 */

import { sql } from "drizzle-orm";
import { readJobPayloadString } from "@ailearn/shared";
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
import { looksLikeJsonEnvelope, unwrapCompanionJsonEnvelope } from "./companion-dialogue-content.ts";
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
  readonly streakDays: number;
  readonly daysSinceLastLearning: number | null;
  readonly familiarity: number;
  readonly petName: string | null;
  readonly allowNudgeLearning: boolean;
  readonly allowPlayful: boolean;
  readonly catchphrase: string | null;
  /** 最近 7 天说过的公开文案（delivery + 念头），语义去重用。 */
  readonly recentlySaid: readonly string[];
  /** 最近 24h 已送达的念头数（日预算）。 */
  readonly deliveredToday: number;
  /** 最近 7 天已表达念头的 embedding（语义去重用）。 */
  readonly recentThoughtEmbeddings: readonly (readonly number[])[];
  /** 最近送达的 delivery 状态（新→旧，仅 displayed/acted/dismissed）。 */
  readonly recentDeliveryStates: readonly string[];
  /** 已有未过期念头的 dedupeKey（同 key 不重复生成）。 */
  readonly activeDedupeKeys: ReadonlySet<string>;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

export const THOUGHT_LIMITS = {
  /** 候选/定稿文案长度上限（写入端即限制）。 */
  maxTextChars: 200,
  /** 表达层定稿长度上限（气泡一句话）。 */
  maxExpressionChars: 80,
  /** 每次调度最多表达的念头数（沉默默认：多数候选默默过期）。 */
  maxDeliveredPerRun: 1,
  /** 每用户每天最多送达的念头数。 */
  maxDeliveredPerDay: 2,
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
 * - streak：连续学习 ≥3 天（正向强化，温和）；
 * - inactivity：≥3 天没学习且有一点熟悉度才提（冷启动就该安静）。
 */
export function buildDeterministicThoughts(material: ThoughtMaterial): ThoughtCandidate[] {
  const out: ThoughtCandidate[] = [];
  if (material.readyReviews > 0 && material.allowNudgeLearning) {
    if (!material.activeDedupeKeys.has(`review_due:${material.today}`)) {
      out.push({
        source: "review_due",
        topic: "review_due",
        dedupeKey: `review_due:${material.today}`,
        text: `有 ${material.readyReviews} 条复习到期了，趁记忆还热，要过一遍吗？`,
        urgency: 70,
        familiarityRequired: 0.1,
        grounding: [],
      });
    }
  }
  if (material.streakDays >= 3 && material.allowPlayful) {
    if (!material.activeDedupeKeys.has(`streak:${material.today}`)) {
      out.push({
        source: "streak",
        topic: "streak",
        dedupeKey: `streak:${material.today}`,
        text: `连续 ${material.streakDays} 天都有学习，这份节奏值得记一笔。`,
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
    if (!material.activeDedupeKeys.has(`inactivity:${material.today}`)) {
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

/** LLM 批量产念头（可选路径）：解析 JSON 数组，逐条消毒，失败返回空。 */
export function parseThoughtCandidates(raw: string, today: string): ThoughtCandidate[] {
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
    if (containsInternalToken(text) || looksLikeJsonEnvelope(text)) continue;
    const urgency = typeof record.urgency === "number" && Number.isFinite(record.urgency)
      ? Math.min(100, Math.max(0, Math.round(record.urgency)))
      : 25;
    out.push({
      source: "llm",
      topic: typeof record.topic === "string" && record.topic.length > 0 ? record.topic.slice(0, 40) : "llm",
      dedupeKey: `llm:${today}:${out.length}`,
      text,
      urgency,
      familiarityRequired: 0.2,
      grounding: [],
    });
  }
  return out;
}

/** 内部 token 泄露检测（与 api validateCompanionOutput 同类语义）。 */
export function containsInternalToken(text: string): boolean {
  return /(companion-persona-v\d+|character\.cue|"cue"|reason\s*id|tool\s*param|promptVersion|"route"\s*:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.test(text);
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
 * 反馈降权（切片①反馈回路）：最近 3 条送达里 dismiss ≥2 → 本轮沉默。
 * 与 api proactive-policy.evaluateDismissalFeedback 同规则（worker 侧独立副本，
 * 两侧都有测试钉住）。
 */
export function shouldStaySilentForFeedback(states: readonly string[]): boolean {
  const recent = states.slice(0, THOUGHT_LIMITS.feedbackWindowSize);
  const dismissed = recent.filter((state) => state === "dismissed").length;
  return dismissed >= THOUGHT_LIMITS.feedbackDismissLimit;
}

/** 静默时段（与 api proactive-hook.isWithinQuietHours 同语义：HH:MM + 跨午夜环绕）。 */
export function isWithinQuietHoursLocal(
  quietHours: { startLocal: string; endLocal: string; timezone: string },
  now: Date,
): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: quietHours.timezone,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    const current = hour * 60 + minute;
    const parse = (value: string): number | null => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
      if (!match) return null;
      return Number(match[1]) * 60 + Number(match[2]);
    };
    const start = parse(quietHours.startLocal);
    const end = parse(quietHours.endLocal);
    if (start === null || end === null) return false;
    if (start === end) return true;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
  } catch {
    return true; // fail closed：解析失败宁可不打扰
  }
}

/** 表达校验（切片③ grounding）：长度 / 内部 token / 实体必须命中。 */
export function validateThoughtExpression(
  text: string,
  grounding: readonly ThoughtGrounding[],
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > THOUGHT_LIMITS.maxExpressionChars) return false;
  if (containsInternalToken(trimmed)) return false;
  // grounding 非空时必须命中至少一个实体名——"不许说不存在的事"。
  if (grounding.length > 0) {
    const hit = grounding.some((entity) => entity.name.length > 0 && trimmed.includes(entity.name));
    if (!hit) return false;
  }
  return true;
}

/** 多候选挑一（切片③）：按序返回第一个通过校验的变体；全部失败返回 null（兜底用原文案）。 */
export function selectThoughtExpression(
  candidates: readonly string[],
  grounding: readonly ThoughtGrounding[],
): string | null {
  for (const candidate of candidates) {
    if (validateThoughtExpression(candidate, grounding)) return candidate.trim();
  }
  return null;
}

/** 表达 prompt（切片③）：persona + 关系状态 + 最近说过的话一起进。 */
export function buildExpressionPrompt(args: {
  petName: string | null;
  familiarity: number;
  allowPlayful: boolean;
  allowNudgeLearning: boolean;
  catchphrase: string | null;
  thoughtText: string;
  groundingNames: readonly string[];
  recentlySaid: readonly string[];
}): string {
  const lines = [
    `你是学习桌宠${args.petName ? `「${args.petName}」` : ""}。基于下面这条"念头"写一句主动开口的话。`,
    `念头：${args.thoughtText}`,
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

interface MaterialRow extends Record<string, unknown> {
  ready_reviews: number;
  familiarity: number;
  speaking_style: string | null;
  personality_tags: string[] | null;
  boundaries: Record<string, unknown> | null;
  catchphrase: string | null;
  pet_name: string | null;
  days_since_last_learning: number | null;
  delivered_today: number;
}

export async function runCompanionThought(job: JobPayload): Promise<void> {
  const userId = readJobPayloadString(job.payload, "userId");
  if (!userId) throw new Error("companion_thought payload 缺 userId");
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
        (SELECT count(*)::int FROM assistant_thoughts
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND status = 'delivered' AND delivered_at > now() - interval '24 hours') AS delivered_today
    `);
    const row = ((Array.isArray(rows) ? rows : [])[0] ?? {}) as Partial<MaterialRow>;

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

    const activeKeysRows = await tx.execute<{ dedupe_key: string }>(sql`
      SELECT dedupe_key FROM assistant_thoughts
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        AND status IN ('candidate', 'delivered', 'spent')
        AND expires_at > now()
    `);

    const embeddingRows = await tx.execute<{ embedding: string }>(sql`
      SELECT embedding::text AS embedding FROM assistant_thoughts
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        AND status IN ('delivered', 'spent')
        AND embedding IS NOT NULL
        AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 30
    `);

    const accountRows = await tx.execute<{ quiet_hours: Record<string, unknown> | null }>(sql`
      SELECT quiet_hours FROM user_companion_account_state
      WHERE user_id = ${userId} LIMIT 1
    `);

    // 连续学习天数：取最近 14 条日记（新→旧），learningRunsCompleted>0 连续计数。
    const streakRows = await tx.execute<{ date: string; runs: number }>(sql`
      SELECT date, COALESCE((facts->>'learningRunsCompleted')::int, 0)
        + COALESCE((facts->>'learningRunsCreated')::int, 0) AS runs
      FROM companion_daily_summaries
      WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
      ORDER BY date DESC LIMIT 14
    `);
    let streakDays = 0;
    for (const entry of (Array.isArray(streakRows) ? streakRows : [])) {
      if (Number(entry.runs) > 0) streakDays += 1;
      else break;
    }

    const boundaries = (row.boundaries ?? {}) as Record<string, unknown>;
    const quietHours = accountRows[0]?.quiet_hours as { startLocal: string; endLocal: string; timezone: string } | null;

    return {
      today,
      readyReviews: Number(row.ready_reviews ?? 0),
      streakDays,
      daysSinceLastLearning: row.days_since_last_learning != null ? Number(row.days_since_last_learning) : null,
      familiarity: Number(row.familiarity ?? 0),
      petName: row.pet_name ?? null,
      allowNudgeLearning: boundaries.allowNudgeLearning !== false,
      allowPlayful: boundaries.allowPlayful !== false,
      catchphrase: typeof row.catchphrase === "string" ? row.catchphrase : null,
      deliveredToday: Number(row.delivered_today ?? 0),
      recentlySaid: (Array.isArray(recentSaidRows) ? recentSaidRows : [])
        .map((entry) => String(entry.text ?? ""))
        .filter((text) => text.length > 0),
      recentDeliveryStates: (Array.isArray(feedbackRows) ? feedbackRows : []).map((entry) => String(entry.state)),
      activeDedupeKeys: new Set(
        (Array.isArray(activeKeysRows) ? activeKeysRows : []).map((entry) => String(entry.dedupe_key)),
      ),
      recentThoughtEmbeddings: (Array.isArray(embeddingRows) ? embeddingRows : [])
        .map((entry) => parseVectorText(String(entry.embedding ?? "")))
        .filter((values): values is number[] => values !== null),
      quietHours,
    } satisfies ThoughtMaterial & { quietHours: typeof quietHours };
  });

  const { quietHours, ...thoughtMaterial } = material;

  // ── 时机决策：沉默是默认 ─────────────────────────────────────────────
  // 1) 静默时段（fail closed）；2) 反馈降权；3) 日预算。
  if (quietHours && isWithinQuietHoursLocal(quietHours, new Date())) {
    logger.info({ jobId: job.id }, "companion thought skipped: quiet hours");
    return;
  }
  if (shouldStaySilentForFeedback(thoughtMaterial.recentDeliveryStates)) {
    logger.info({ jobId: job.id }, "companion thought suppressed: dismissal feedback");
    return;
  }

  // ── 阶段 2：候选念头（确定性规则 + 可选 LLM 批量） ───────────────────
  let candidates = buildDeterministicThoughts(thoughtMaterial);
  const enableLlm = process.env.COMPANION_THOUGHTS_LLM === "true";
  if (enableLlm && candidates.length < 3) {
    try {
      const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
      if (govCtx.consentOk) {
        const textRes = resolveProviderForTask(govCtx, "companion_agent");
        const provider = createGovernedProvider(
          createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
          govCtx,
          job.workspaceId,
          { userId, operation: "companion_thought", jobId: job.id },
        );
        const prompt = [
          `你是学习桌宠${thoughtMaterial.petName ? `「${thoughtMaterial.petName}」` : ""}。基于事实生成 1-3 条"主动开口的念头"候选。`,
          `事实：到期复习 ${thoughtMaterial.readyReviews} 条；连续学习 ${thoughtMaterial.streakDays} 天；距上次学习 ${thoughtMaterial.daysSinceLastLearning ?? "未知"} 天；熟悉度 ${thoughtMaterial.familiarity.toFixed(2)}。`,
          `风格允许：玩趣=${thoughtMaterial.allowPlayful ? "可以" : "不要"}；催学习=${thoughtMaterial.allowNudgeLearning ? "可以" : "不要"}。`,
          ...(thoughtMaterial.recentlySaid.length > 0 ? [`最近说过（不要重复）：\n- ${thoughtMaterial.recentlySaid.slice(0, 5).join("\n- ")}`] : []),
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
        candidates = [...candidates, ...parseThoughtCandidates(content, thoughtMaterial.today)];
      }
    } catch (err) {
      logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, "companion thought llm batch failed; deterministic only");
    }
  }
  if (candidates.length === 0) return;

  // ── 阶段 3：念头库落库（多数候选默默过期） + 挑选 + 表达 + 去重 ──────
  const eligible = candidates
    .filter((candidate) => !thoughtMaterial.activeDedupeKeys.has(candidate.dedupeKey))
    .filter((candidate) => thoughtMaterial.familiarity >= candidate.familiarityRequired)
    .sort((a, b) => b.urgency - a.urgency);
  if (eligible.length === 0) return;

  // 候选先入念库（24h TTL）：被预算/时机压住的念头留档，大多数会被 expires 收走。
  const candidateIds = new Map<string, string>();
  await withJobTransaction(job, async (tx) => {
    for (const candidate of eligible) {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO assistant_thoughts
          (workspace_id, user_id, source, topic, dedupe_key, text, grounding,
           status, urgency, familiarity_required, expires_at)
        VALUES
          (${job.workspaceId}, ${userId}, ${candidate.source}, ${candidate.topic}, ${candidate.dedupeKey},
           ${candidate.text}, ${JSON.stringify(candidate.grounding)}::jsonb,
           'candidate', ${candidate.urgency}, ${candidate.familiarityRequired},
           now() + (${THOUGHT_LIMITS.candidateTtlHours} * interval '1 hour'))
        RETURNING id
      `);
      const id = (Array.isArray(rows) ? rows : [])[0]?.id;
      if (id) candidateIds.set(candidate.dedupeKey, id);
    }
  });

  // 日预算（沉默默认）：今天已送达 ≥2 条 → 本轮只入念库，不再表达。
  if (material.deliveredToday >= THOUGHT_LIMITS.maxDeliveredPerDay) {
    logger.info({ jobId: job.id }, "companion thought skipped: daily budget (candidates stored)");
    return;
  }

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
    if (enableLlm) {
      try {
        const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
        if (govCtx.consentOk) {
          const textRes = resolveProviderForTask(govCtx, "companion_agent");
          const provider = createGovernedProvider(
            createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
            govCtx,
            job.workspaceId,
            { userId, operation: "companion_thought", jobId: job.id },
          );
          const raw = await runWithAbortBudget(
            (signal) => provider.chatCompletion(
              [{ role: "user", content: buildExpressionPrompt({
                petName: thoughtMaterial.petName,
                familiarity: thoughtMaterial.familiarity,
                allowPlayful: thoughtMaterial.allowPlayful,
                allowNudgeLearning: thoughtMaterial.allowNudgeLearning,
                catchphrase: thoughtMaterial.catchphrase,
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
          const picked = selectThoughtExpression(variants, candidate.grounding);
          if (picked) expression = picked;
        }
      } catch (err) {
        logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, "companion thought expression llm failed; template fallback");
      }
    }

    // 语义去重（切片①）：embedding 优先，bigram 降级。
    let candidateEmbedding: number[] | null = null;
    if (embeddingProvider) {
      try {
        candidateEmbedding = await embeddingProvider.embed(expression);
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
            embedding = ${candidateEmbedding ? `[${candidateEmbedding.map((value) => value.toFixed(6)).join(",")}]::vector` : null},
            delivered_at = now(),
            expires_at = now() + (${THOUGHT_LIMITS.deliveredTtlHours} * interval '1 hour'),
            updated_at = now()
        WHERE id = ${thoughtId} AND status = 'candidate'
        RETURNING id
      `);
      const confirmedId = (Array.isArray(updated) ? updated : [])[0]?.id;
      if (!confirmedId) return false;

      // 送达：复用 assistant_deliveries 的展示通道（气泡从 home projection 读）。
      const payloadRef = JSON.stringify({
        kind: "system_event",
        systemEventId: `thought:${confirmedId}`,
        text: expression,
      });
      await tx.execute(sql`
        INSERT INTO assistant_deliveries
          (assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref, expires_at)
        SELECT NULL, ${job.workspaceId}, ${userId},
               COALESCE(MAX(inbox_sequence), 0) + 1,
               ${`thought:${confirmedId}`}, 'queued', 'system_event',
               ${payloadRef}::jsonb, now() + (${THOUGHT_LIMITS.deliveredTtlHours} * interval '1 hour')
        FROM assistant_deliveries
        WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
        ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
      `);
      return true;
    });
    if (delivered) {
      logger.info({ jobId: job.id, topic: candidate.topic }, "companion thought delivered");
      return; // 每次调度最多送 1 条：沉默默认。
    }
  }
}
