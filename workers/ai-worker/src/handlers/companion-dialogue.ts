/**
 * companion_agent Worker handler（03 合同 §8.1/§9，runbook 6.4 步骤 5-7）。
 *
 * 2026-08-24（AI 设计审查 §4.4 拆分）：本文件自 1600+ 行巨型文件重构为编排层，
 * 职责拆分：
 * - content   → ./companion-dialogue-content.ts（输出校验/markdown 剥离/
 *               delta 分块/persona 组装/确定性 cue——纯函数层）；
 * - store     → ./companion-dialogue-store.ts（事件写入/run failed 投影/
 *               grounded-tutor DB 读取/记忆任务入队/feature flags）；
 * - delta 管线 → ./companion-dialogue-deltas.ts（批量 delta 写库、
 *               provider 采样参数、失败分类）。
 * 本文件只保留 run 编排：read → memory context → fence claim →
 * bounded Agent loop → TTS 段 → 终态事务。
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
import { createProvider, createEmbeddingProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedEmbeddingProvider,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import {
  COMPANION_PERSONA_V4_PROMPT_ID,
  COMPANION_PERSONA_V4_SHA256,
} from "@ailearn/shared";
import { runCompanionAgentLoop } from "./companion-agent-runtime.ts";
import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { splitCompanionTtsSegmentsIncremental, companionSegmentId } from "../lib/tts-segments.ts";
import { extractVoiceEmotion } from "@ailearn/shared/voice-expression-tags";
import { applyDeterministicToneToSegments, resolveReplyToneEmotion } from "../lib/companion-tone.ts";
import {
  assembleCompanionContext,
  buildCompanionMemoryQuery,
  type ContextAssemblyResult,
} from "./companion-context-orchestrator.ts";
import { isCompanionMemoryVectorEnabled } from "./companion-memory-vector.ts";
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
  emitCompanionTtsSegments,
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
  writeBatchedDeltas,
} from "./companion-dialogue-deltas.ts";

const groundedTutorPromptSha256 = computeGroundedTutorPromptSha256(GROUNDED_TUTOR_COMPANION_PROMPT);

/** LearningRun 是正式学习页，缺证据时必须 fail closed。 */
export function isGroundedTutorRequestedPageContext(
  pageContext: Record<string, unknown> | null,
): boolean {
  return pageContext?.pageKind === "learning_run"
    && pageContext.requestedCapability === "grounded_tutor";
}

// ─── run 编排 ─────────────────────────────────────────────────────────────

export async function runCompanionDialogue(
  ctx: CompanionDialogueHandlerContext,
): Promise<void> {
  // job 超时（runWithAbortTimeout）在进入 handler 前就已开始计时；Agent loop 用
  // 这个起点把 run 预算夹在 handler abort 之内（见 runCompanionAgentLoop）。
  const handlerStartedAtMs = Date.now();
  const payload = ctx.payload as { runId?: string; proposalId?: string };
  const runId = payload.runId;
  const continuationProposalId = typeof payload.proposalId === "string" ? payload.proposalId : undefined;
  if (!runId) throw new Error("companion_agent payload 缺 runId");
  if (ctx.signal.aborted) throw new Error("companion_agent aborted");

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
    logger.warn({ jobId: ctx.id, runId, err }, "companion_agent read phase failed");
    throw err;
  }
  if (!read) return; // run 已删/非本 workspace——job 成功无副作用

  const parsedPageContext = parsePageContext(read.pageContext);
  if (isGroundedTutorRequestedPageContext(parsedPageContext) && !read.groundedTutorContext) {
    await markCompanionRunFailed(read, ctx.workspaceId, "ACTION_STALE", false, "grounded tutor evidence unavailable");
    throw new Error("grounded tutor evidence unavailable");
  }

  // ── 阶段 2：provider（非 active run → 不重复调用） ───────────────────
  if (!isActiveRun(read.runStatus) && !(continuationProposalId && read.runStatus === "waiting_for_confirmation")) {
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
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx,
    ctx.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口 logAICall——
    // 此前全仓零生产调用，而 DEFAULT_AI_DATA_POLICY.auditLogging 默认为 true，
    // 等于审计/成本记录完全空转。只写元数据，不写内容。
    { userId: read.userId, operation: "companion_agent", jobId: ctx.id },
  );

  // ── 22 方案：Context Orchestrator 检索长期记忆（非 grounded_tutor）──
  let memoryContext: ContextAssemblyResult = {
    activeMemories: read.activeMemories,
    memoryRefs: [],
    retrievalMode: "keyword_fallback",
    usedMemoryIds: [],
  };
  if (isCompanionMemoryContextEnabled() && !read.groundedTutorContext) {
    try {
      const rawEmbeddingProvider = await createEmbeddingProvider(govCtx);
      const embeddingProvider = rawEmbeddingProvider
        ? createGovernedEmbeddingProvider(rawEmbeddingProvider, govCtx, ctx.workspaceId)
        : null;
      // embedding 是外部 HTTP 往返（常态数百 ms，超时可达数秒）。放在
      // withWorkerWorkspaceTransaction 内会让 RLS 事务在整个往返期间独占连接，
      // 高峰期把连接池反压到所有 job 类型。查询文本与向量先在事务外算好：
      // null = 已尝试且失败 → 事务内直接降级 keyword（绝不在事务内重试外部调用）。
      let queryEmbedding: number[] | null = null;
      if (embeddingProvider && isCompanionMemoryVectorEnabled()) {
        try {
          queryEmbedding = await embeddingProvider.embed(
            buildCompanionMemoryQuery({
              userText: read.userText,
              recentMessages: read.recentMessages,
            }),
          );
        } catch (err) {
          logger.warn(
            { jobId: ctx.id, runId: read.runId, err },
            "companion memory query embedding failed; using keyword fallback",
          );
          queryEmbedding = null;
        }
      }
      memoryContext = await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        (tx) => assembleCompanionContext(
          tx,
          { workspaceId: ctx.workspaceId, userId: read.userId },
          {
            userText: read.userText,
            recentMessages: read.recentMessages,
            provider: embeddingProvider,
            queryEmbedding,
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
        WHERE id = ${read.runId}
          AND (
            status IN ('accepted', 'running')
            OR (status = 'waiting_for_confirmation' AND waiting_proposal_id = ${continuationProposalId ?? null})
          )
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

  // ── 阶段 2b：统一 Agent loop ─────────────────────────────────────────
  // 普通闲聊由 provider 以空工具列表单步完成；带 Skill 的请求在运行时内
  // 进行有限步工具循环。这里保留原有批量 delta/TTS/终态投影管线。
  let assistantText: string;
  let ttsRawText: string | null = null;
  let agentResult;
  try {
    agentResult = await runCompanionAgentLoop({
      ctx,
      read,
      provider,
      baseMessages: messages,
      expiresAt,
      continuationProposalId,
      handlerStartedAtMs,
    });
  } catch (err) {
    // 预算耗尽（步数/工具数/执行时间）是确定性失败：标记 recoverable=false，
    // 队列侧同时按不可重试处理，避免空转重投（见 isNonRetryableError）。
    const budgetExceeded = err instanceof CompanionAgentBudgetExceededError;
    await markCompanionRunFailed(
      read,
      ctx.workspaceId,
      budgetExceeded ? "AGENT_BUDGET_EXCEEDED" : "INTERNAL_ERROR",
      !budgetExceeded,
      budgetExceeded ? "companion agent budget exceeded" : "companion agent execution failed",
    );
    throw err;
  }
  if (agentResult.status === "waiting_for_confirmation") return;
  ttsRawText = agentResult.text;

  // 信任边界：全文校验必须先于任何对外可见的写入。delta 是实时下发给客户端
  // 并入库的内容，先写后验等于让泄露检测/长度限额沦为"事后门"——校验失败
  // （internal_token_leak / output_too_long）不会撤回已投递的 delta。
  // 校验失败在此终结：零 delta 落库，客户端只看到 error 事件。
  const validated = validateCompanionOutput(agentResult.text);
  if (!validated.ok) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, validated.reason);
    throw new Error(`companion output validation failed: ${validated.reason}`);
  }
  // delta 与终态 assistant message 使用同一份净化文本（markdown/标签剥离后），
  // 否则客户端流式渲染的内容与 assistant.final 指向的消息不一致。
  assistantText = validated.text;
  try {
    const batched = await writeBatchedDeltas({
      assistantText,
      ctx,
      read,
      expiresAt,
      notifyCompanionEvent,
    });
    if (!batched) return;
  } catch (err) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", true, "companion delta write failed");
    throw err;
  }

  // 15b（字幕般流式 TTS）：validate 后全量切段、在终态事务前逐个下发。
  // 15b 二期：切段输入用 ttsRawText（含标签），assistantText 已剥离标签。
  if (isCompanionVoiceDialogueEnabled()) {
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
    await emitCompanionTtsSegments({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      runId: read.runId,
      generation: read.generation,
      accountEpoch: read.accountEpoch,
      conversationId: read.conversationId,
      expiresAt,
      notifyCompanionEvent,
      segments: toned.map((seg) => ({
        segmentId: companionSegmentId(read.runId, read.generation, seg.ordinal, seg.textSha256),
        ordinal: seg.ordinal,
        text: seg.text,
        textSha256: seg.textSha256,
        emotion: extractVoiceEmotion(seg.text) ?? undefined,
      })),
    });
  }

  // ── 阶段 3c：终态事务（message + final + run succeeded） ──
  // 15b：TTS 段已在 delta 过程（流式）或 validate 后（非流式）逐个下发完毕，
  // 终态事务不再携带 segments——事件布局变为 final @ eventStart、cue @ +1、
  // character.cue @ +1。
  const assistantMessageId = randomUUID();
  const blocks = [{ type: "text", text: assistantText }];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const textSha256 = sha256Utf8V1(assistantText);
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

        // 事件布局：final @ eventStart，character.cue @ +1
        //（15b：TTS 段已前置于 delta 过程/validate 后，终态事务不再含 segments）。
        const eventCount = 2; // final + cue
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
        // 终态事务不再写段事件；此处仅保留 cue）。

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
        // waiting_proposal_id 必须一并清空：run 已终结，残留的挂起指针会让"仍在
        // 等待确认"的判据在终态 run 上继续成立（续跑与回收扫描都会被它误导）。
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET status = 'succeeded',
              assistant_message_id = ${assistantMessageId},
              waiting_proposal_id = NULL,
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
        const maxSeq = eventStart + eventCount - 1;
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
    logger.warn({ jobId: ctx.id, runId, err }, "companion_agent write phase failed");
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", true, "companion response commit failed");
    throw err;
  }
}
