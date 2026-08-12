/**
 * P2 companion_dialogue Worker handler（03 合同 §8.1/§9，runbook 6.4 步骤 5-7）。
 *
 * 流程：
 * 1. 读 job payload 的 opaque runId（不携带任何 message 正文——runbook 步骤 5）；
 * 2. RLS 事务内读 run/conversation/最近 20 条消息（§9.3 输入顺序）；
 * 3. 非 active run（cancelled/superseded/failed）直接返回——§6.5「cancel 后
 *    Worker 迟到 delta/final 被拒绝」，不重复 provider 调用；
 * 4. text_generation provider 生成（§9.5 参数）；输出经长度/cue/泄露校验；
 * 5. 终态事务内：fence claim（run 仍 active 才可写）→ assistant message →
 *    assistant.status/assistant.delta/assistant.final events（§5.2 wire 语义，
 *    delta ≤2000 code unit）→ run succeeded（prompt_version/hash）→
 *    该 run 全部 event expires_at 原子改 finished_at+24h → NOTIFY。
 *
 * provider 失败：run failed + error event（recoverable 分类），job 重试时
 * run 已非 active → 快速返回，不重复花钱（首个 delta 前 crash 可安全重试）。
 */

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import {
  COMPANION_PERSONA_V1,
  COMPANION_PERSONA_V1_PROMPT_ID,
  COMPANION_PERSONA_V1_SHA256,
  canonicalJsonV1,
  classifyCompanionReplyEmotion,
  isEffectiveHardEvidence,
  sha256Utf8V1,
  type ChatMessage,
} from "@ailearn/shared";
import {
  buildActionClassifierInput,
  classifyDialogueAction,
  constructActionProposalInWorker,
  persistRouterDecision,
  readStoredRouterIntent,
  resolveAvailableIntentsInWorker,
  shouldRunActionClassifier,
  type RouterDecisionV1,
} from "./companion-dialogue-router.ts";
import { splitCompanionTtsSegments, companionSegmentId } from "../lib/tts-segments.ts";

export interface CompanionDialogueHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  leaseToken: string;
  signal: AbortSignal;
}

/** 与 turn-service 对齐的硬限额（03 §6.10）。 */
export const COMPANION_HARD_MAX_CHARS = 20_000;
/** §9.5 P2 默认模型参数。 */
const COMPANION_PROVIDER_OPTIONS = {
  temperature: 0.6,
  maxTokens: 600,
  responseFormat: "text" as const,
};
/** §5.2 assistant.delta 单块上限（code unit）。 */
const DELTA_MAX_CODE_UNITS = 2_000;

// ─── 03 合同 §5.2 确定性 character.cue 来源 ─────────────────────────────
// P2–P3 只允许以下确定性来源（turn accepted 由 API 侧 turn-service 负责，
// 本 handler 覆盖 thinking / final / error 三处）；emotion 与 intensity 均为
// 固定常量，不随文本变化——最终回复情绪由本地分类器（P4 bounded cue
// classifier 思路）在终态事务里产出，失败时回落以下默认值。
export const THINKING_CUE_PAYLOAD_V1 = {
  version: 1 as const,
  intent: "think",
  emotion: "curious",
  intensity: 0.35,
} as const;
export const FINAL_DEFAULT_CUE_PAYLOAD_V1 = {
  version: 1 as const,
  intent: "explain",
  emotion: "neutral",
  intensity: 0.3,
} as const;
export const ERROR_CUE_PAYLOAD_V1 = {
  version: 1 as const,
  intent: "uncertain",
  emotion: "concerned",
  intensity: 0.45,
} as const;
export type CharacterCueWirePayloadV1 =
  | typeof THINKING_CUE_PAYLOAD_V1
  | typeof FINAL_DEFAULT_CUE_PAYLOAD_V1
  | typeof ERROR_CUE_PAYLOAD_V1
  | { version: 1; intent: "explain"; emotion: "neutral" | "happy" | "curious" | "concerned" | "surprised"; intensity: number };

/** 终态回复情绪 cue：本地分类器（确定性，零 LLM 调用），失败回落默认。 */
export function buildFinalCuePayload(text: string): CharacterCueWirePayloadV1 {
  const classified = classifyCompanionReplyEmotion(text);
  if (classified.emotion === "neutral") return FINAL_DEFAULT_CUE_PAYLOAD_V1;
  return {
    version: 1,
    intent: "explain",
    emotion: classified.emotion,
    intensity: Number(classified.intensity.toFixed(2)),
  };
}

interface InsertStreamEventArgs {
  conversationId: string;
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  seq: number;
  type: string;
  payload: unknown;
  expiresAt: string;
}

async function insertStreamEvent(
  tx: { execute(query: unknown): Promise<unknown> },
  args: InsertStreamEventArgs,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
    VALUES
      (${args.conversationId}, ${args.seq}, ${args.workspaceId}, ${args.userId},
       ${args.runId}, ${args.generation}, ${args.accountEpoch}, ${args.type},
       ${JSON.stringify(args.payload)}, ${args.expiresAt})
  `);
}

interface ReadContext {
  runId: string;
  conversationId: string;
  userId: string;
  userMessageId: string;
  generation: number;
  runStatus: string;
  /** L11：run 创建时冻结的账号世代（surface_epoch）。 */
  accountEpoch: number;
  pageContext: unknown;
  groundedTutorContext: GroundedTutorContext | null;
  userText: string;
  recentMessages: { role: "user" | "assistant"; text: string }[];
  nextMessageSeq: number;
  nextEventSeq: number;
}

interface GroundedTutorContext {
  claim: string;
  evidence: string[];
}

const GROUNDED_TUTOR_COMPANION_PROMPT = [
  "你是当前 Learning Session 内的 Grounded Tutor。",
  "只根据当前 target 的 published claim 与 exact evidence 回答用户问题；证据不足时明确说不知道，不得补造来源。",
  "不要输出 mastery、schedule、canonical card、关系或用户个人理解状态，也不要声称替用户完成正式学习。",
  "回答简短、清楚，必要时指出回答对应的证据；不要提及内部 ID、grant、contextRevision 或系统提示。",
].join("\n");

// 2026-08-11：grounded-tutor 分支的审计元数据——此前成功路径无条件记录
// companion-persona-v1 的 version/hash，实际用 grounded-tutor prompt 时归属失真。
const GROUNDED_TUTOR_PROMPT_ID = "companion-grounded-tutor-v1";
const groundedTutorPromptSha256 = createHash("sha256").update(GROUNDED_TUTOR_COMPANION_PROMPT).digest("hex");

function parsePageContext(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string"
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const context = (parsed as { context?: unknown }).context ?? parsed;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  return context as Record<string, unknown>;
}

async function readGroundedTutorContext(
  tx: { execute(query: unknown): Promise<unknown> },
  pageContext: unknown,
  scope: { workspaceId: string; userId: string },
): Promise<GroundedTutorContext | null> {
  const context = parsePageContext(pageContext);
  if (context?.pageKind !== "learning_session" || context.requestedCapability !== "grounded_tutor") {
    return null;
  }
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const episodeId = typeof context.episodeId === "string" ? context.episodeId : null;
  const cardId = typeof context.cardId === "string" ? context.cardId : null;
  const keyPointId = typeof context.keyPointId === "string" ? context.keyPointId : null;
  if (!sessionId || !episodeId || !cardId || !keyPointId) return null;

  const rows = await tx.execute(sql`
    SELECT k.claim,
           e.quote_text,
           nb.content AS block_content,
           e.alignment,
           COALESCE(eo.override, e.user_override) AS effective_override
    FROM learning_episodes ep
    JOIN card_key_points k
      ON k.id = ep.key_point_id
     AND k.id = ${keyPointId}
     AND k.card_id = ${cardId}
     AND k.workspace_id = ep.workspace_id
    JOIN evidences e
      ON e.key_point_id = k.id
     AND e.workspace_id = ep.workspace_id
    LEFT JOIN note_blocks nb
      ON nb.id = e.block_id
     AND nb.workspace_id = e.workspace_id
    LEFT JOIN evidence_overrides eo
      ON eo.evidence_id = e.id
     AND eo.user_id = ${scope.userId}
    WHERE ep.id = ${episodeId}
      AND ep.session_id = ${sessionId}
      AND ep.workspace_id = ${scope.workspaceId}
      AND ep.user_id = ${scope.userId}
    ORDER BY
      CASE
        WHEN COALESCE(eo.override, e.user_override) = 'confirmed' OR e.alignment = 'aligned' THEN 0
        WHEN COALESCE(eo.override, e.user_override) = 'downgraded' OR e.alignment = 'soft' THEN 1
        ELSE 2
      END,
      e.alignment_score DESC
    LIMIT 8
  `) as Array<{
    claim: string | null;
    quote_text: string;
    block_content: string | null;
    alignment: string;
    effective_override: string | null;
  }>;
  const valid = rows.filter((row) => isEffectiveHardEvidence(row.alignment, row.effective_override));
  const claim = rows[0]?.claim?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!claim || valid.length === 0) return null;
  const evidence = valid
    .map((row) => row.block_content?.trim() || row.quote_text.trim())
    .filter((value) => value.length > 0)
    .slice(0, 5)
    .map((value) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 1_200));
  return evidence.length > 0 ? { claim: claim.slice(0, 800), evidence } : null;
}

// ─── 纯函数（可单测） ─────────────────────────────────────────────────────

/** §9.3 组装 persona 输入（system 固定 prompt + 结构化 user message）。 */
export function buildCompanionPersonaMessages(input: {
  userText: string;
  recentMessages: { role: "user" | "assistant"; text: string }[];
  pageContext: unknown;
  workspacePolicy: { sendToExternal: boolean; piiDetection: boolean } | null;
  groundedTutorContext?: GroundedTutorContext | null;
}): ChatMessage[] {
  const boundedRecent = input.recentMessages
    .slice(0, 20)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 12_000) }));
  let pageContext: string | null = null;
  if (input.pageContext != null) {
    const canonical = canonicalJsonV1(input.pageContext);
    pageContext = canonical.length > 2_000 ? canonical.slice(0, 2_000) : canonical;
  }
  const userContent = {
    version: 1,
    workspacePolicy: input.workspacePolicy ?? { sendToExternal: false, piiDetection: true },
    recentMessages: boundedRecent,
    pageContext: input.groundedTutorContext ? null : pageContext,
    currentMessage: input.userText.slice(0, 4_000),
    ...(input.groundedTutorContext ? { groundedTarget: input.groundedTutorContext } : {}),
  };
  return [
    { role: "system", content: input.groundedTutorContext ? GROUNDED_TUTOR_COMPANION_PROMPT : COMPANION_PERSONA_V1 },
    { role: "user", content: canonicalJsonV1(userContent) },
  ];
}

/** §5.2 assistant.delta 分块：appendFrom 非负、每块 1..2000 code unit。 */
export function chunkTextIntoDeltas(
  text: string,
  max = DELTA_MAX_CODE_UNITS,
): { appendFrom: number; textDelta: string }[] {
  const out: { appendFrom: number; textDelta: string }[] = [];
  let from = 0;
  while (from < text.length) {
    const end = Math.min(from + max, text.length);
    out.push({ appendFrom: from, textDelta: text.slice(from, end) });
    from = end;
  }
  return out;
}

/** §9.2/§5.2 输出校验：长度硬限额 + 内部 token 泄露拒绝。 */
export function validateCompanionOutput(
  text: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty_output" };
  if (trimmed.length > COMPANION_HARD_MAX_CHARS) {
    return { ok: false, reason: "output_too_long" };
  }
  // 模型不得输出内部 route/reason/cue/provider/prompt/tool 参数（§9.2）。
  const leakPattern =
    /(companion-persona-v1|character\.cue|"cue"|reason\s*id|tool\s*param|promptVersion|"route"\s*:)/i;
  if (leakPattern.test(trimmed)) return { ok: false, reason: "internal_token_leak" };
  return { ok: true, text: trimmed };
}

/** 从 blocks 提取纯文本（与 turn-service 的 textOfBlocks 语义一致）。 */
export function textOfCompanionBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
      ? String((b as { text?: unknown }).text ?? "")
      : ""))
    .join("");
}

// ─── DB 编排 ──────────────────────────────────────────────────────────────

function isActiveRun(status: string): boolean {
  return status === "accepted" || status === "running";
}

export async function runCompanionDialogue(
  ctx: CompanionDialogueHandlerContext,
): Promise<void> {
  const payload = ctx.payload as { runId?: string };
  const runId = payload.runId;
  if (!runId) throw new Error("companion_dialogue payload 缺 runId");
  if (ctx.signal.aborted) throw new Error("companion_dialogue aborted");

  // ── 阶段 1：读（RLS 事务） ────────────────────────────────────────────
  let read: ReadContext | null = null;
  try {
    read = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: ctx.requestedBy },
      async (tx) => {
        const runRows = await tx.execute<{
          id: string; conversation_id: string; user_id: string; generation: number;
          status: string; page_context: unknown; user_message_id: string;
          account_epoch: string | number | null;
        }>(sql`
          SELECT id, conversation_id, user_id, generation, status, page_context, user_message_id, account_epoch
          FROM companion_turn_runs WHERE id = ${runId}
        `);
        const run = runRows[0];
        if (!run) return null; // RLS 已 scope；run 不存在/属其他 workspace → 无副作用
        const convRows = await tx.execute<{
          next_message_seq: string; next_event_seq: string;
        }>(sql`
          SELECT next_message_seq, next_event_seq
          FROM companion_conversations WHERE id = ${run.conversation_id}
        `);
        const conv = convRows[0];
        if (!conv) return null;
        const userRows = await tx.execute<{ blocks: unknown }>(sql`
          SELECT blocks FROM companion_messages
          WHERE conversation_id = ${run.conversation_id}
            AND id = ${run.user_message_id}
          ORDER BY seq DESC LIMIT 1
        `);
        const userText = userRows[0] ? textOfCompanionBlocks(userRows[0].blocks) : "";
        const historyRows = await tx.execute<{ role: string; blocks: unknown }>(sql`
          SELECT role, blocks FROM companion_messages
          WHERE conversation_id = ${run.conversation_id}
            AND id <> ${run.user_message_id}
          ORDER BY seq DESC LIMIT 20
        `);
        const recentMessages = historyRows
          .slice()
          .reverse()
          .map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            text: textOfCompanionBlocks(m.blocks),
          }));
        const groundedTutorContext = await readGroundedTutorContext(
          tx,
          run.page_context,
          { workspaceId: ctx.workspaceId, userId: run.user_id },
        );
        return {
          runId: run.id,
          conversationId: run.conversation_id,
          userId: run.user_id,
          userMessageId: run.user_message_id,
          generation: run.generation,
          runStatus: run.status,
          accountEpoch: Number(run.account_epoch ?? 0),
          pageContext: run.page_context,
          groundedTutorContext,
          userText,
          recentMessages,
          nextMessageSeq: Number(conv.next_message_seq),
          nextEventSeq: Number(conv.next_event_seq),
        };
      },
    );
  } catch (err) {
    logger.warn({ jobId: ctx.id, runId, err }, "companion_dialogue read phase failed");
    throw err;
  }
  if (!read) return; // run 已删/非本 workspace——job 成功无副作用

  const parsedPageContext = parsePageContext(read.pageContext);
  if (parsedPageContext?.pageKind === "learning_session"
    && parsedPageContext.requestedCapability === "grounded_tutor"
    && !read.groundedTutorContext) {
    await markCompanionRunFailed(read, ctx.workspaceId, "ACTION_STALE", false, "grounded tutor evidence unavailable");
    throw new Error("grounded tutor evidence unavailable");
  }

  // ── 阶段 2：provider（非 active run → 不重复调用） ───────────────────
  if (!isActiveRun(read.runStatus)) {
    logger.info({ runId, status: read.runStatus }, "companion run 非 active，跳过 provider");
    return;
  }
  if (!isCompanionDialogueEnabled()) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, "feature disabled");
    throw new Error("COMPANION_DIALOGUE_V1_ENABLED is false — companion dialogue disabled");
  }

  const govCtx = await resolveAIGovernanceContext(ctx.workspaceId, read.userId);
  if (!govCtx.consentOk) {
    await markCompanionRunFailed(
      read,
      ctx.workspaceId,
      "AI_CONSENT_REQUIRED",
      false,
      "workspace AI consent required",
    );
    throw new AIConsentRequiredError();
  }
  const textRes = resolveProviderForTask(govCtx, "companion_dialogue");
  const provider = createProvider(textRes.providerName, textRes.providerConfig);

  // ── P5 §9.4 Dialogue Router（classifier 在 persona generation 之前）──
  // 三态：casual_chat / learning_question（lexeme 不命中或 classifier 判
  // none → 走 persona 文字回复；grounded-tutor 分支承接 learning_question）
  // 与 learning_action（lexeme 命中 + classifier confidence≥0.90 + available
  // → 写 router 字段，供 API proposal 构造）。classifier 失败永远回落 none，
  // 不影响正文回复；decision 只写一次（retry 复用，不重新分类）。
  let routerDecision: RouterDecisionV1 | null = null;
  try {
    const groundedTutorRequested =
      parsedPageContext?.pageKind === "learning_session"
      && parsedPageContext.requestedCapability === "grounded_tutor";
    const availableIntents = await resolveAvailableIntentsInWorker({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      groundedTutorRequested,
    });
    if (shouldRunActionClassifier(read.userText, availableIntents)) {
      const classifierInput = buildActionClassifierInput(read.userText, availableIntents);
      routerDecision = await classifyDialogueAction(
        provider,
        classifierInput,
        availableIntents,
        ctx.signal,
      );
      const persisted = await persistRouterDecision({
        runId: read.runId,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        generation: read.generation,
        decision: routerDecision,
        contextRevision: null,
        payloadHash: null,
      });
      if (!persisted) {
        // §9.4 retry 复用：decision 已存在（上次 persist 后 crash/重试），
        // 读回已冻结的 router_intent，不得用本次重新分类结果覆盖。
        const stored = await readStoredRouterIntent({
          runId: read.runId,
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          generation: read.generation,
        });
        if (stored) {
          routerDecision = stored;
        } else {
          routerDecision = null;
        }
      }
    }
  } catch (err) {
    // §9.4：classifier 内部异常不影响正文回复；仅记录，不 fail run。
    logger.warn({ jobId: ctx.id, runId: read.runId, err }, "companion action router skipped");
    routerDecision = null;
  }

  const messages = buildCompanionPersonaMessages({
    userText: read.userText,
    recentMessages: read.recentMessages,
    pageContext: read.pageContext,
    groundedTutorContext: read.groundedTutorContext,
    workspacePolicy: {
      sendToExternal: govCtx.policy.sendToExternal,
      piiDetection: govCtx.policy.piiDetection,
    },
  });

  // ── 阶段 2a：fence claim + assistant.status（provider 调用前）─────────
  // 让客户端尽早进入 thinking；run 已被 cancel/supersede 时不调用 provider。
  // §8.2：真流式——provider.chatCompletionStream 存在时 delta 边生成边写库
  // （50ms/256-unit 节流 flush，独立事务 + fence + NOTIFY，cancel 中断
  // provider）；缺失时回退 chatCompletion + 分批写（模拟流式节奏）。
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();

  const notifyCompanionEvent = async (tx: { execute(q: unknown): Promise<unknown> }, seq: number): Promise<void> => {
    await tx.execute(sql`
      UPDATE companion_turn_runs
      SET last_event_seq = ${seq}, updated_at = now()
      WHERE id = ${read.runId}
    `);
    await tx.execute(sql`
      SELECT pg_notify('ailearn_companion_events_v1',
                       ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq })})
    `);
  };

  const claimed = await withWorkerWorkspaceTransaction(
    { workspaceId: ctx.workspaceId, userId: read.userId },
    async (tx) => {
      const claimedRow = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = ${read.runId} AND status IN ('accepted', 'running')
          AND generation = ${read.generation}
        RETURNING id
      `);
      if (!claimedRow[0]) {
        logger.info({ runId: read.runId }, "companion run 已被 cancel/supersede，丢弃迟到输出");
        return false;
      }
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 2
        WHERE id = ${read.conversationId}
        RETURNING next_event_seq
      `);
      const statusSeq = Number(counters[0].next_event_seq) - 2;
      const cueSeq = Number(counters[0].next_event_seq) - 1;
      await insertStreamEvent(tx, {
        conversationId: read.conversationId,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        seq: statusSeq,
        type: "assistant.status",
        payload: { status: "thinking", safeLabel: "思考中" },
        expiresAt,
      });
      // §5.2 确定性来源：thinking → think/curious/0.35（与 status 同事务原子下发）。
      await insertStreamEvent(tx, {
        conversationId: read.conversationId,
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        seq: cueSeq,
        type: "character.cue",
        payload: { cue: THINKING_CUE_PAYLOAD_V1 },
        expiresAt,
      });
      await notifyCompanionEvent(tx, cueSeq);
      return true;
    },
  );
  if (!claimed) return;

  // ── 阶段 2b：真实流式（或回退分批） ───────────────────────────────────
  let assistantText: string;
  if (typeof provider.chatCompletionStream === "function") {
    const streamed = await runStreamingDialogue({
      provider: provider as AIProvider & { chatCompletionStream: NonNullable<AIProvider["chatCompletionStream"]> },
      messages,
      ctx,
      read,
      expiresAt,
      notifyCompanionEvent,
    });
    if (!streamed) return; // 已 cancel/supersede，无输出
    assistantText = streamed.content;
  } else {
    // 回退：非流式 chatCompletion + 分批写 delta（保持既有 fence/幂等语义）
    let rawText: string;
    try {
      const result = await runWithAbortBudget(
        (signal) => provider.chatCompletion(messages, COMPANION_PROVIDER_OPTIONS, signal),
        ctx.signal,
        resolveProviderCallTimeout("companion_dialogue"),
        (lateError) => logger.warn(
          { jobId: ctx.id, err: lateError },
          "companion provider settled after its call budget expired",
        ),
      );
      rawText = result.content;
    } catch (err) {
      const code = categorizeProviderFailure(err);
      await markCompanionRunFailed(read, ctx.workspaceId, code, true, "provider unavailable");
      throw err;
    }
    const validatedFallback = validateCompanionOutput(rawText);
    if (!validatedFallback.ok) {
      await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, validatedFallback.reason);
      throw new Error(`companion output validation failed: ${validatedFallback.reason}`);
    }
    assistantText = validatedFallback.text;
    let batched: boolean;
    try {
      batched = await writeBatchedDeltas({
        assistantText,
        ctx,
        read,
        expiresAt,
        notifyCompanionEvent,
      });
    } catch (err) {
      await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", true, "companion delta write failed");
      throw err;
    }
    if (!batched) return; // 已 cancel
  }

  // 真流式路径的全文校验（生成完成后统一执行；失败保留已写 delta，fail closed）
  const validated = validateCompanionOutput(assistantText);
  if (!validated.ok) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, validated.reason);
    throw new Error(`companion output validation failed: ${validated.reason}`);
  }
  assistantText = validated.text;

  // ── 阶段 3c：终态事务（message + final + segments + run succeeded） ──
  const ttsSegments = isCompanionVoiceDialogueEnabled()
    ? splitCompanionTtsSegments(assistantText).map((seg) => ({
      ...seg,
      segmentId: companionSegmentId(read.runId, read.generation, seg.ordinal, seg.textSha256),
    }))
    : [];
  const assistantMessageId = randomUUID();
  const blocks = [{ type: "text", text: assistantText }];
  // contentSha256 在 proposal 路径下会随 action_ref 追加而更新（见下）。
  let contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const textSha256 = sha256Utf8V1(assistantText);
  // P5 §8.3 步骤 5：router 命中 action 时，final 事务同事务落 proposal +
  // action.proposed 事件 + assistant message action_ref block。action.proposed
  // 需要一个额外 event seq，故 eventCount 视命中情况 +1。
  const routerAction = routerDecision && routerDecision.intent !== "none" ? routerDecision.intent : null;
  const willPropose = routerAction === "resume_current" || routerAction === "start_short";
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: read.userId },
      async (tx) => {
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
            AND generation = ${read.generation}
          RETURNING id
        `);
        if (!alive[0]) return;

        // 事件布局：final @ eventStart，segments @ +1..+n，character.cue @ +n+1，
        // action.proposed @ +n+2（P4 bounded cue：本地分类器，零 LLM 调用）。
        const eventCount = 2 + ttsSegments.length + (willPropose ? 1 : 0); // final + cue + segments + action.proposed
        const counters = await tx.execute<{ next_message_seq: string; next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1,
              next_event_seq = next_event_seq + ${eventCount},
              last_message_at = now()
          WHERE id = ${read.conversationId}
          RETURNING next_message_seq, next_event_seq
        `);
        const next = counters[0];
        if (!next) throw new Error("conversation counter update returned no row");
        const messageSeq = Number(next.next_message_seq) - 1;
        const eventStart = Number(next.next_event_seq) - eventCount;

        await tx.execute(sql`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
          VALUES (${assistantMessageId}, ${ctx.workspaceId}, ${read.userId},
                  ${read.conversationId}, ${messageSeq}, 'assistant', 'text',
                  ${JSON.stringify(blocks)}, ${read.runId}, ${contentSha256})
        `);

        // P5 §8.3 步骤 5：同事务构造 proposal（worker 侧，与 API 菜单路径同构）。
        // action.proposed 事件 seq = eventStart + 1 + ttsSegments.length（final 之后）。
        let proposedAction: Awaited<ReturnType<typeof constructActionProposalInWorker>> = null;
        if (willPropose) {
          proposedAction = await constructActionProposalInWorker({
            workspaceId: ctx.workspaceId,
            userId: read.userId,
            conversationId: read.conversationId,
            runId: read.runId,
            generation: read.generation,
            accountEpoch: read.accountEpoch,
            userMessageId: read.userMessageId,
            intent: routerAction as "resume_current" | "start_short",
            eventSeq: eventStart + 2 + ttsSegments.length,
            tx: tx as never,
          });
          if (proposedAction) {
            // assistant message 加 action_ref block（§3.3：恰好一个 action_ref，
            // kind='action'）；content_sha256 须与最终 blocks 一致。
            const finalBlocks = [
              ...blocks,
              { type: "action_ref", proposalId: proposedAction.proposalId },
            ];
            contentSha256 = sha256Utf8V1(canonicalJsonV1(finalBlocks));
            await tx.execute(sql`
              UPDATE companion_messages
              SET blocks = ${JSON.stringify(finalBlocks)},
                  kind = 'action',
                  content_sha256 = ${contentSha256}
              WHERE id = ${assistantMessageId}
            `);
            // §9.4：proposal 构造成功后回填 router 审计字段（payload hash）。
            await tx.execute(sql`
              UPDATE companion_turn_runs
              SET router_payload_hash = ${proposedAction.payloadSha256}
              WHERE id = ${read.runId} AND generation = ${read.generation}
            `);
          } else {
            // proposal 未插入（候选消失 / 已有 pending）：归还预留的
            // action.proposed seq，避免 next_event_seq 空洞（§5.2 连续性）。
            await tx.execute(sql`
              UPDATE companion_conversations
              SET next_event_seq = next_event_seq - 1
              WHERE id = ${read.conversationId}
            `);
          }
        }

        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES
            (${read.conversationId}, ${eventStart}, ${ctx.workspaceId}, ${read.userId},
             ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.final',
             ${JSON.stringify({
               messageId: assistantMessageId,
               textLength: assistantText.length,
               textSha256,
               messageContentSha256: contentSha256,
             })}, ${expiresAt})
        `);

        // §11.3 voice.segment.ready（final 之后；text 为净化后的稳定可见文本）
        for (let i = 0; i < ttsSegments.length; i += 1) {
          const seg = ttsSegments[i];
          await insertStreamEvent(tx, {
            conversationId: read.conversationId,
            workspaceId: ctx.workspaceId,
            userId: read.userId,
            runId: read.runId,
            generation: read.generation,
            accountEpoch: read.accountEpoch,
            seq: eventStart + 1 + i,
            type: "voice.segment.ready",
            payload: {
              segmentId: seg.segmentId,
              ordinal: seg.ordinal,
              text: seg.text,
              textSha256: seg.textSha256,
            },
            expiresAt,
          });
        }

        // 终态回复情绪 cue：本地确定性分类器（soullink MessageReactionClassifier
        // 思路迁移）从全文分类 emotion；中性/空文本回落 explain/neutral/0.30。
        // 分类失败不可能抛错（纯函数），故无需额外兜底分支。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: eventStart + 1 + ttsSegments.length,
          type: "character.cue",
          payload: { cue: buildFinalCuePayload(assistantText) },
          expiresAt,
        });

        // run 终态 + prompt 元数据（§9.1：promptVersion 与 hash 一起写入）
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET status = 'succeeded',
              assistant_message_id = ${assistantMessageId},
              provider_id = ${provider.id},
              model_id = ${provider.modelId},
              prompt_version = ${read.groundedTutorContext ? GROUNDED_TUTOR_PROMPT_ID : COMPANION_PERSONA_V1_PROMPT_ID},
              prompt_hash = ${read.groundedTutorContext ? groundedTutorPromptSha256 : COMPANION_PERSONA_V1_SHA256},
              finished_at = now()
          WHERE id = ${read.runId}
        `);

        // 终态事务：该 run 全部 event 的 expires_at 原子改为 finished_at+24h
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);

        // §5.4 PostgreSQL wake-up（payload 只含 conversationId/maxSeq）。
        // proposal 未插入时预留 seq 已归还，实际事件数 = eventCount - 1。
        const insertedEventCount = eventCount - (willPropose && !proposedAction ? 1 : 0);
        const maxSeq = eventStart + insertedEventCount - 1;
        await notifyCompanionEvent(tx, maxSeq);
        logger.info(
          { runId: read.runId, messageId: assistantMessageId, seq: messageSeq },
          "companion dialogue run succeeded",
        );
      },
    );
  } catch (err) {
    // 写阶段失败：终态事务回滚，但前面已落库的 delta 仍然存在；显式
    // 投影 failed/error，避免 job retry/dead-letter 后 run 永久停在 running。
    logger.warn({ jobId: ctx.id, runId, err }, "companion_dialogue write phase failed");
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", true, "companion response commit failed");
    throw err;
  }
}

/** 首个 delta 前 provider 失败分类（§5.2 error event 的 recoverable）。 */
function categorizeProviderFailure(err: unknown): string {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (/timeout|timed? ?out|abort/i.test(message)) return "PROVIDER_TIMEOUT";
  return "PROVIDER_UNAVAILABLE";
}

function isCompanionDialogueEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
}

function isCompanionVoiceDialogueEnabled(): boolean {
  return process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true";
}

/** run failed + error event（fence：仅 active run 可写终态；cancel/supersede 后零写入）。 */
async function markCompanionRunFailed(
  read: ReadContext,
  workspaceId: string,
  code: string,
  recoverable: boolean,
  reason: string,
): Promise<void> {
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId, userId: read.userId },
      async (tx) => {
        // fence：只有 run 仍 active 才标记 failed（已被 cancel/supersede → 不写 error event，
        // turn.cancelled 已由 cancel 路径负责）。
        const claimed = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'failed', error_code = ${code}, finished_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
          RETURNING id
        `);
        if (!claimed[0]) return;
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + 2
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const next = counters[0];
        if (!next) return;
        const seq = Number(next.next_event_seq) - 2;
        const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq,
          type: "error",
          payload: {
            code,
            message: reason.slice(0, 240),
            recoverable,
            requestId: read.runId,
          },
          expiresAt,
        });
        // §5.2 确定性来源：安全错误 → uncertain/concerned/0.45（与 error 同事务原子下发）。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: seq + 1,
          type: "character.cue",
          payload: { cue: ERROR_CUE_PAYLOAD_V1 },
          expiresAt,
        });
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET last_event_seq = ${seq + 1}, updated_at = now()
          WHERE id = ${read.runId}
        `);
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);
        await tx.execute(sql`
          SELECT pg_notify('ailearn_companion_events_v1',
                           ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq + 1 })})
        `);
        logger.warn({ runId: read.runId, code, reason }, "companion run marked failed");
      },
    );
  } catch (err) {
    logger.warn({ runId: read.runId, err }, "markCompanionRunFailed failed");
  }
}

// ─── §8.2 真流式辅助 ─────────────────────────────────────────────────────

/** 流式 flush 阈值：≥256 code unit 或每 50ms 定时落库一批 delta。 */
const STREAM_FLUSH_CHARS = 256;
const STREAM_FLUSH_INTERVAL_MS = 50;
/** 流式空闲超时：provider 持续无增量超过该时长视为卡死（abort + failed）。 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

interface StreamDialogueArgs {
  provider: AIProvider & { chatCompletionStream: NonNullable<AIProvider["chatCompletionStream"]> };
  messages: unknown[];
  ctx: { workspaceId: string; signal?: AbortSignal };
  read: ReadContext;
  expiresAt: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}

/**
 * §8.2 真流式：调用 provider.chatCompletionStream，onDelta 缓冲后按
 * 256-unit/50ms 节流写库（独立事务 + fence + NOTIFY）。
 *
 * - fence 失败（run 被 cancel/supersede）→ abort provider 流并停止（M7：
 *   cancel 真正中断 provider 调用，不再烧完整次生成）；
 * - 重试 fail-closed：首个 delta 写入前若该 run 已有 delta（上一轮崩溃
 *   残留、内容不确定）→ 抛错放弃，不拼接错乱；
 * - 空闲 60s 无增量 → abort → 由 catch 标记 failed（可重试）；
 * - 返回 null 表示 run 已取消/被 supersede（无输出，调用方直接结束）。
 */
async function runStreamingDialogue(args: StreamDialogueArgs): Promise<{ content: string } | null> {
  const { provider, messages, ctx, read, expiresAt, notifyCompanionEvent } = args;
  const localAbort = new AbortController();
  const onParentAbort = () => {
    if (!localAbort.signal.aborted) {
      localAbort.abort(ctx.signal?.reason instanceof Error ? ctx.signal.reason : new Error("parent aborted"));
    }
  };
  ctx.signal?.addEventListener("abort", onParentAbort, { once: true });

  let buffer = "";
  let streamedChars = 0;
  let flushPromise: Promise<void> | null = null;
  let flushError: unknown = null;
  let streamHasDeltas = false;
  let cancelDetected = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!localAbort.signal.aborted) localAbort.abort(new Error("companion stream idle timeout"));
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  resetIdle();

  const flush = async (): Promise<void> => {
    if (flushError) throw flushError;
    if (flushPromise) return flushPromise;
    if (buffer.length === 0) return;
    flushPromise = (async () => {
      while (buffer.length > 0) {
        // §5.2：delta 单条 ≤2000 code unit。provider 单次 onDelta 可能给出
        // 超过阈值的文本，必须分块，不能整块写库。
        const textDelta = buffer.slice(0, DELTA_MAX_CODE_UNITS);
        const appendFrom = streamedChars;
        buffer = buffer.slice(textDelta.length);
        const written = await withWorkerWorkspaceTransaction(
          { workspaceId: ctx.workspaceId, userId: read.userId },
          async (tx) => {
            const alive = await tx.execute<{ id: string }>(sql`
              UPDATE companion_turn_runs
              SET status = 'running', updated_at = now()
              WHERE id = ${read.runId} AND status IN ('accepted', 'running')
                AND generation = ${read.generation}
              RETURNING id
            `);
            if (!alive[0]) {
              cancelDetected = true;
              return false;
            }
            // 重试 fail-closed：只在本次 provider stream 的第一批 delta 前
            // 检查上一轮是否留下了残余；同一次真实 stream 的后续 flush
            // 必须允许继续追加 delta。
            if (!streamHasDeltas) {
              const countRows = await tx.execute<{ n: string }>(sql`
                SELECT count(*)::int AS n FROM companion_stream_events
                WHERE conversation_id = ${read.conversationId}
                  AND run_id = ${read.runId} AND type = 'assistant.delta'
              `);
              if (Number(countRows[0].n) > 0) {
                throw new Error("companion stream resume not supported; run already has deltas");
              }
              streamHasDeltas = true;
            }
            const counters = await tx.execute<{ next_event_seq: string }>(sql`
              UPDATE companion_conversations
              SET next_event_seq = next_event_seq + 1
              WHERE id = ${read.conversationId}
              RETURNING next_event_seq
            `);
            const deltaSeq = Number(counters[0].next_event_seq) - 1;
            await tx.execute(sql`
              INSERT INTO companion_stream_events
                (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
              VALUES
                (${read.conversationId}, ${deltaSeq}, ${ctx.workspaceId}, ${read.userId},
                 ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.delta',
                 ${JSON.stringify({ appendFrom, textDelta })}, ${expiresAt})
            `);
            await notifyCompanionEvent(tx, deltaSeq);
            return true;
          },
        );
        if (written) {
          streamedChars += textDelta.length;
        } else {
          cancelDetected = true;
          buffer = "";
          return;
        }
      }
    })().catch((err) => {
      flushError = err;
      throw err;
    }).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  };
  const requestFlush = (): void => {
    void flush().catch((err) => {
      // A background flush must not become an unhandled rejection. Abort the
      // provider so the main stream path observes the same write failure and
      // projects a terminal error instead of committing a partial final.
      if (!localAbort.signal.aborted) {
        localAbort.abort(err instanceof Error ? err : new Error("companion stream write failed"));
      }
    });
  };
  const flushTimer = setInterval(() => {
    requestFlush();
  }, STREAM_FLUSH_INTERVAL_MS);

  try {
    const { content } = await provider.chatCompletionStream(
      messages as Parameters<typeof provider.chatCompletionStream>[0],
      COMPANION_PROVIDER_OPTIONS,
      localAbort.signal,
      (delta) => {
        buffer += delta;
        if (buffer.length >= STREAM_FLUSH_CHARS) requestFlush();
        resetIdle();
      },
    );
    clearInterval(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    await flush(); // 收尾剩余 buffer；等待任何在途写入完成
    if (cancelDetected) return null;
    return { content };
  } catch (err) {
    clearInterval(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    // 已取消/被 supersede：cancel 路径已处理 run 状态，静默结束。
    if (cancelDetected || (localAbort.signal.aborted && ctx.signal?.aborted)) return null;
    const code = categorizeProviderFailure(err);
    await markCompanionRunFailed(read, ctx.workspaceId, code, true, "provider streaming unavailable");
    throw err;
  } finally {
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
}

interface BatchedDeltasArgs {
  assistantText: string;
  ctx: { workspaceId: string };
  read: ReadContext;
  expiresAt: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}

/**
 * 回退路径：provider 无 chatCompletionStream 时，一次取回全文后按
 * 256-unit/50ms 分批写 delta（保留 fence + 数量级幂等续写语义）。
 */
async function writeBatchedDeltas(args: BatchedDeltasArgs): Promise<boolean> {
  const { assistantText, ctx, read, expiresAt, notifyCompanionEvent } = args;
  const streamDeltas = chunkTextIntoDeltas(assistantText, 256);
  for (let i = 0; i < streamDeltas.length; i += 1) {
    const written = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: read.userId },
      async (tx) => {
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
            AND generation = ${read.generation}
          RETURNING id
        `);
        if (!alive[0]) return false;
        const countRows = await tx.execute<{ n: string }>(sql`
          SELECT count(*)::int AS n FROM companion_stream_events
          WHERE conversation_id = ${read.conversationId}
            AND run_id = ${read.runId} AND type = 'assistant.delta'
        `);
        const writtenDeltaCount = Number(countRows[0].n);
        if (writtenDeltaCount >= streamDeltas.length) return true;
        if (writtenDeltaCount !== i) {
          throw new Error(`companion delta stream desync: written=${writtenDeltaCount} expected=${i}`);
        }
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + 1
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const deltaSeq = Number(counters[0].next_event_seq) - 1;
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES
            (${read.conversationId}, ${deltaSeq}, ${ctx.workspaceId}, ${read.userId},
             ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.delta',
             ${JSON.stringify(streamDeltas[i])}, ${expiresAt})
        `);
        await notifyCompanionEvent(tx, deltaSeq);
        return true;
      },
    );
    if (!written) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
