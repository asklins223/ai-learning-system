/**
 * P2 companion_dialogue Worker handler（03 合同 §8.1/§9，runbook 6.4 步骤 5-7）。
 *
 * 2026-08-24（AI 设计审查 §4.4 拆分）：本文件自 1600+ 行巨型文件重构为编排层，
 * 职责拆分：
 * - content   → ./companion-dialogue-content.ts（输出校验/markdown 剥离/
 *               delta 分块/persona 组装/确定性 cue——纯函数层）；
 * - store     → ./companion-dialogue-store.ts（事件写入/run failed 投影/
 *               grounded-tutor DB 读取/记忆任务入队/feature flags）；
 * - streaming → ./companion-dialogue-streaming.ts（真流式与批量回退管线、
 *               provider 采样参数、失败分类）。
 * 本文件只保留 run 编排：read → router → memory context → fence claim →
 * generate（流式/批量）→ TTS 段（非流式路径）→ 终态事务。
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

import { randomUUID } from "node:crypto";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { createProvider, createEmbeddingProvider, type AIProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import {
  COMPANION_PERSONA_V4_PROMPT_ID,
  COMPANION_PERSONA_V4_SHA256,
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
import { splitCompanionTtsSegmentsIncremental, companionSegmentId, extractVoiceEmotion } from "../lib/tts-segments.ts";
import { applyDeterministicToneToSegments, resolveReplyToneEmotion } from "../lib/companion-tone.ts";
import { assembleCompanionContext, type ContextAssemblyResult } from "./companion-context-orchestrator.ts";
import {
  THINKING_CUE_PAYLOAD_V1,
  buildFinalCuePayload,
  buildCompanionPersonaMessages,
  validateCompanionOutput,
  textOfCompanionBlocks,
  parsePageContext,
  GROUNDED_TUTOR_COMPANION_PROMPT,
} from "./companion-dialogue-content.ts";
import {
  type CompanionDialogueHandlerContext,
  type ReadContext,
  insertStreamEvent,
  emitCompanionTtsSegment,
  markCompanionRunFailed,
  readGroundedTutorContext,
  isActiveRun,
  isCompanionDialogueEnabled,
  isCompanionVoiceDialogueEnabled,
  isCompanionMemoryContextEnabled,
  enqueueCompanionMemoryJobs,
  GROUNDED_TUTOR_PROMPT_ID,
  computeGroundedTutorPromptSha256,
} from "./companion-dialogue-store.ts";
import {
  COMPANION_PROVIDER_OPTIONS,
  categorizeProviderFailure,
  writeBatchedDeltas,
  runStreamingDialogue,
} from "./companion-dialogue-streaming.ts";

export {
  // 纯函数层（测试与外部消费沿用原导入路径）
  buildCompanionPersonaMessages,
  buildFinalCuePayload,
  chunkTextIntoDeltas,
} from "./companion-dialogue-content.ts";
export {
  COMPANION_HARD_MAX_CHARS,
  DELTA_MAX_CODE_UNITS,
  validateCompanionOutput,
  stripCompanionMarkdown,
  textOfCompanionBlocks,
} from "./companion-dialogue-content.ts";
export {
  COMPANION_PROVIDER_OPTIONS,
  categorizeProviderFailure,
} from "./companion-dialogue-streaming.ts";
// 兼容导出：旧版单文件公开导出的 interface（拆分时移入 store，此处保持
// 原导入路径可用——文档 §4.4「对外导出符号不变」）。
export type { CompanionDialogueHandlerContext } from "./companion-dialogue-store.ts";

const groundedTutorPromptSha256 = computeGroundedTutorPromptSha256(GROUNDED_TUTOR_COMPANION_PROMPT);

// ─── run 编排 ─────────────────────────────────────────────────────────────

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
        // §3.5：记忆检索由 Context Orchestrator 统一负责（向量/keyword fallback）。
        // read 阶段不再直接"取最近 30 条记忆"——当记忆上下文功能关闭时回退空记忆，
        // 开启时由后续 assembleCompanionContext 阶段检索填充。
        const activeMemories: { kind: string; content: string }[] = [];
        const petProfileRows = await tx.execute<{
          name: string;
          speaking_style: string;
          personality_tags: unknown;
          examples: unknown;
        }>(sql`
          SELECT name, speaking_style, personality_tags, examples
          FROM pet_profiles
          WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${run.user_id}
          LIMIT 1
        `);
        const petProfileRow = petProfileRows[0];
        const petProfile = petProfileRow
          ? {
              name: petProfileRow.name,
              speakingStyle: petProfileRow.speaking_style,
              personalityTags: Array.isArray(petProfileRow.personality_tags)
                ? petProfileRow.personality_tags.map(String)
                : [],
              examples: Array.isArray(petProfileRow.examples)
                ? (petProfileRow.examples as Array<{ text?: unknown }>)
                    .map((e) => ({ text: String(e.text ?? "") }))
                    .filter((e) => e.text.length > 0)
                : [],
            }
          : null;
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
          activeMemories,
          petProfile,
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

  // ── 22 方案：Context Orchestrator 检索长期记忆（非 grounded_tutor）──
  let memoryContext: ContextAssemblyResult = {
    activeMemories: read.activeMemories,
    memoryRefs: [],
    retrievalMode: "keyword_fallback",
    usedMemoryIds: [],
  };
  if (isCompanionMemoryContextEnabled() && !read.groundedTutorContext) {
    try {
      const embeddingProvider = await createEmbeddingProvider(read.userId, govCtx);
      memoryContext = await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        (tx) => assembleCompanionContext(
          tx,
          { workspaceId: ctx.workspaceId, userId: read.userId },
          {
            userText: read.userText,
            recentMessages: read.recentMessages,
            provider: embeddingProvider,
            runId: read.runId,
            groundedTutorContext: read.groundedTutorContext,
            // §9.2.2：按页面类型推导 currentScope（card/learning_run/review → task）。
            pageContext: read.pageContext,
          },
        ),
      );
      read.activeMemories = memoryContext.activeMemories;
    } catch (err) {
      // 检索失败不阻塞对话：保留 read 阶段已读取的旧记忆作为兜底。
      logger.warn({ jobId: ctx.id, runId: read.runId, err }, "companion memory context assembly skipped");
      memoryContext = {
        activeMemories: read.activeMemories,
        memoryRefs: [],
        retrievalMode: "keyword_fallback",
        usedMemoryIds: [],
      };
    }
  }

  const messages = buildCompanionPersonaMessages({
    userText: read.userText,
    recentMessages: read.recentMessages,
    pageContext: read.pageContext,
    groundedTutorContext: read.groundedTutorContext,
    activeMemories: read.activeMemories,
    petProfile: read.petProfile,
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
  // 15b：是否走了真流式（delta 过程已增量发段；非流式需在 validate 后全量切段）
  let streamedPath = false;
  // 15b 二期：provider 原始输出（含情感/富语言标签）——非流式路径 validate
  // 会剥离标签，TTS 切段必须用这份 raw（标签只活在朗读管道）。
  let ttsRawText: string | null = null;
  if (typeof provider.chatCompletionStream === "function") {
    streamedPath = true;
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
    // 2026-08-24：流式路径的幻觉标签清洗已在 delta 管线内完成（见
    // createStreamToneInjector），语气注入在切段时逐段应用。
    ttsRawText = streamed.content;
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
    // 2026-08-24（AI 设计审查 §4.2）：确定性语气层——模型不再输出标签
    // （V4 已禁止方括号标记）。切段后逐段注入句首控制标签（情绪按全文判）
    // 并净化幻觉标签；展示/入库文本不受影响（已剥全部标签）。
    ttsRawText = rawText;
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

  // 15b（字幕般流式 TTS）：非流式路径没有 delta 过程——validate 后全量切段、
  // 在终态事务前逐个下发（流式路径已在 delta 过程中增量发完，此处跳过）。
  // 15b 二期：切段输入用 ttsRawText（含标签），assistantText 已剥离标签。
  if (!streamedPath && isCompanionVoiceDialogueEnabled()) {
    const inc = splitCompanionTtsSegmentsIncremental(
      ttsRawText ?? assistantText,
      { rest: "", sentCount: 0, sentChars: 0 },
      true,
    );
    // 2026-08-24：确定性语气层——全文判情绪，逐段注标签 + 净化幻觉标签。
    // 注入会改变段文本，textSha256 重算后再派生 segmentId。
    const toned = applyDeterministicToneToSegments(
      inc.segments.map((seg) => ({ ordinal: seg.ordinal, text: seg.text, textSha256: seg.textSha256 })),
      resolveReplyToneEmotion(ttsRawText ?? assistantText),
    );
    for (const seg of toned) {
      const ok = await emitCompanionTtsSegment({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        conversationId: read.conversationId,
        expiresAt,
        segmentId: companionSegmentId(read.runId, read.generation, seg.ordinal, seg.textSha256),
        ordinal: seg.ordinal,
        text: seg.text,
        textSha256: seg.textSha256,
        emotion: extractVoiceEmotion(seg.text) ?? undefined,
        notifyCompanionEvent,
      });
      if (!ok) break;
    }
  }

  // ── 阶段 3c：终态事务（message + final + run succeeded） ──
  // 15b：TTS 段已在 delta 过程（流式）或 validate 后（非流式）逐个下发完毕，
  // 终态事务不再携带 segments——事件布局变为 final @ eventStart、cue @ +1、
  // action.proposed @ +2。
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

        // 事件布局：final @ eventStart，character.cue @ +1，action.proposed @ +2
        //（15b：TTS 段已前置于 delta 过程/validate 后，终态事务不再含 segments）。
        const eventCount = 2 + (willPropose ? 1 : 0); // final + cue + action.proposed
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
        // action.proposed 事件 seq = eventStart + 2（final + cue 之后；15b 起
        // 终态事务不含 segments）。
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
            eventSeq: eventStart + 2,
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
               ...(memoryContext.memoryRefs.length > 0
                 ? { memoryRefs: memoryContext.memoryRefs }
                 : {}),
             })}, ${expiresAt})
        `);

        // §11.3 voice.segment.ready（15b：已在 delta 过程/validate 后逐个下发，
        // 终态事务不再写段事件；此处仅保留 cue 与 action.proposed）。

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
          seq: eventStart + 1,
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
              prompt_version = ${read.groundedTutorContext ? GROUNDED_TUTOR_PROMPT_ID : COMPANION_PERSONA_V4_PROMPT_ID},
              prompt_hash = ${read.groundedTutorContext ? groundedTutorPromptSha256 : COMPANION_PERSONA_V4_SHA256},
              finished_at = now()
          WHERE id = ${read.runId}
        `);

        // 22 方案：终态事务内异步入队记忆提取/摘要任务。
        await enqueueCompanionMemoryJobs(tx, {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          conversationId: read.conversationId,
          messageSeq,
        });

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
    // §10.5 关系状态：对话成功完成一次 turn，familiarity +0.01（上限 1）、
    // interaction_count +1、刷新 last_active_at。独立事务 + 失败静默：
    // 关系状态是弱事实，绝不影响对话主链路（迁移 0178 前该 UPDATE 无权限也安全跳过）。
    try {
      await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        async (tx) => {
          await tx.execute(sql`
            UPDATE pet_profiles
            SET familiarity = LEAST(familiarity + 0.01, 1),
                interaction_count = interaction_count + 1,
                last_active_at = now(),
                updated_at = now()
            WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${read.userId}
          `);
        },
      );
    } catch (err) {
      logger.debug({ runId: read.runId, err }, "companion relationship bump skipped");
    }
  } catch (err) {
    // 写阶段失败：终态事务回滚，但前面已落库的 delta 仍然存在；显式
    // 投影 failed/error，避免 job retry/dead-letter 后 run 永久停在 running。
    logger.warn({ jobId: ctx.id, runId, err }, "companion_dialogue write phase failed");
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", true, "companion response commit failed");
    throw err;
  }
}

// ─── 兼容导出（拆分前本文件的公共符号；实现已移至对应模块） ───────────────

// 03 合同 §5.2 确定性 character.cue 来源（常量本体在 content 模块）。
export {
  THINKING_CUE_PAYLOAD_V1,
  FINAL_DEFAULT_CUE_PAYLOAD_V1,
  ERROR_CUE_PAYLOAD_V1,
  type CharacterCueWirePayloadV1,
} from "./companion-dialogue-content.ts";
