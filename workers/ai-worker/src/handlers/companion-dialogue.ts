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
import { loadHereAndNow, renderHereAndNow } from "./companion-here-and-now.ts";
import { createProvider, createEmbeddingProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import {
  CompanionStreamStoppedError,
  createCompanionStreamDelivery,
  reconcileStreamedText,
} from "./companion-dialogue-stream.ts";
import {
  AIConsentRequiredError,
  createGovernedEmbeddingProvider,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import {
  COMPANION_PERSONA_V5_PROMPT_ID,
  COMPANION_PERSONA_V5_SHA256,
  type PetPersonaPresetBoundaries,
  type PetProfileActiveness,
} from "@ailearn/shared";
import { runCompanionAgentLoop } from "./companion-agent-runtime.ts";
import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import {
  companionSegmentId,
  splitCommittedDisplaySegments,
  type CompanionDisplaySegmentState,
} from "../lib/tts-segments.ts";
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
  unwrapCompanionJsonEnvelope,
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

/**
 * 用户"停止"后至少留下多少字才算值得留档（2026-09-19）。
 *
 * 与"太短不念"同一口径：一两句寒暄都没说完就停下（如"好"、"嗯我"），
 * 留在历史里是噪音而不是记录。可调，集中在这里改。
 */
const COMPANION_CANCELLED_MIN_CHARS = 12;

/**
 * 一轮**失败**之后，把她已经下发给客户端的部分留档（2026-09-19）。
 *
 * 与"用户按停止"那条留档对称：取消路径早就留了 `kind='cancelled'` 的部分记录，
 * 而失败路径此前只写 `error` 事件、**不写消息**——于是气泡里她已经说过的那半句，
 * 在收尾的一瞬间从对话历史里彻底消失（用户看到的是"内容没了"，历史里连这条都查不到）。
 *
 * 三条护栏：
 * - 只在 run 的真实终态是 `failed` 时落（`assistant_message_id IS NULL` 同时保证幂等：
 *   同一个 run 的重试/多次失败收尾不会插出第二条）；用户取消走 `cancelled` 路径，
 *   supersede 走新回合，都不在这里落。
 * - 太短不落（与取消同一个阈值）——碎片是噪音，不是记录。
 * - 不写 `assistant.final` / `character.cue`:事件侧由 `error` 收尾，一个回合出现两个
 *   "结束"会让客户端状态机打架。
 *
 * 落的是**已下发的可见前缀**（`deliveredText`），也就是用户真的看到过的那段字。
 */
/**
 * 失败兜底话术（方案 29 §4.9：fail-open，绝不空白）。
 *
 * 抱怨 #4「经常性的出现输出不了东西了」的直接来源：任何一道校验判失败时，
 * 旧实现只写一条 `error` 事件就 throw，而 `persistFailedPartial` 在"一个字都没
 * 下发"时**直接放弃落消息**——于是界面上什么都没有，像她突然不理人。
 *
 * 三条轮换（按 runId 确定性取，同一轮重投不会换话，也不会连着两轮一模一样）。
 * 口径：只承认"这句没成"并邀请重试，**不编造任何内容、不虚构已完成的事**，
 * 也不暴露 provider / prompt / 错误码。
 */
const COMPANION_FAILURE_FALLBACK_LINES = [
  "诶，这句我没组织好，你再跟我说一次？",
  "刚刚那句话卡住了，我没听清，你再说一遍嘛。",
  "我走神了一下下，这条没答上来，你重新问我一次？",
] as const;

/** 按 runId 确定性挑一句（同一 run 重投得到同一句，避免话术来回跳）。 */
export function pickCompanionFailureFallbackLine(runId: string): string {
  let hash = 0;
  for (const ch of runId) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  return COMPANION_FAILURE_FALLBACK_LINES[hash % COMPANION_FAILURE_FALLBACK_LINES.length];
}

export async function persistFailedPartial(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  runId: string;
  deliveredText: string;
}): Promise<boolean> {
  // fail-open：已经说出来的半句优先保留；连半句都没有时，落一句诚实的兜底话，
  // 而不是让用户面对空白（旧实现在这里 `return false`，界面什么都不显示）。
  const delivered = args.deliveredText.trim();
  const text = delivered.length >= COMPANION_CANCELLED_MIN_CHARS
    ? delivered
    : pickCompanionFailureFallbackLine(args.runId);
  const blocks = [{ type: "text" as const, text, emotion: resolveReplyToneEmotion(text) }];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const messageId = randomUUID();
  try {
    return await withWorkerWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        // 先锁住"这一轮确实失败了、且还没留过档"。用 SELECT ... FOR UPDATE 而不是
        // 先写 assistant_message_id：那是指向 companion_messages 的**立即**外键，
        // 消息行还没插进去就回填，整笔事务会被 FK 打回（取消路径踩过这个坑）。
        const claimed = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_turn_runs
          WHERE id = ${args.runId} AND status = 'failed' AND assistant_message_id IS NULL
          FOR UPDATE
        `);
        if (!claimed[0]) return false;
        const counters = await tx.execute<{ next_message_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1, last_message_at = now()
          WHERE id = ${args.conversationId}
          RETURNING next_message_seq
        `);
        const seqRow = counters[0];
        if (!seqRow) return false;
        await tx.execute(sql`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
          VALUES (${messageId}, ${args.workspaceId}, ${args.userId},
                  ${args.conversationId}, ${Number(seqRow.next_message_seq) - 1},
                  'assistant', 'error',
                  ${JSON.stringify(blocks)}, ${args.runId}, ${contentSha256})
        `);
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET assistant_message_id = ${messageId}, updated_at = now()
          WHERE id = ${args.runId}
        `);
        return true;
      },
    );
  } catch (err) {
    // 留档是"别把用户看过的字弄丢"的补救，不是主链路：它失败不该盖掉真正的失败原因。
    logger.warn({ runId: args.runId, err }, "companion failed-partial retention skipped");
    return false;
  }
}

/** 活跃度三档白名单（与 `PetProfileActiveness` 同源）。 */
const ACTIVENESS_VALUES = new Set<string>(["quiet", "moderate", "active"]);

/**
 * boundaries 是 jsonb，库里可能是 null / 数组 / 任意对象。只认"纯对象且键值合法"
 * 的形状，其余一律当没设置——这个对象会被渲染进 system prompt，不能原样透传。
 */
function isPetBoundaryObject(value: unknown): value is PetPersonaPresetBoundaries {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const boolKeys = ["allowPlayful", "allowNudgeLearning", "allowVoiceTags"];
  const known = new Set([...boolKeys, "catchphrase"]);
  if (!Object.keys(record).every((key) => known.has(key))) return false;
  if (!boolKeys.every((key) => record[key] === undefined || typeof record[key] === "boolean")) return false;
  return record.catchphrase === undefined || record.catchphrase === null || typeof record.catchphrase === "string";
}

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
        // kind 必须一起取，历史装配不能只看 role：
        //   - `role='system'` 的系统注记不是对话轮次，映射成 "user" 会让模型以为
        //     那是用户说的话；
        //   - `kind='cancelled'`（用户按了停止）与 `kind='error'`（这一轮失败）都是
        //     "她说到一半"的半截话，进上下文会让下一轮顺着断句续写。它们的读者是人，不是模型。
        const historyRows = await tx.execute<{ role: string; kind: string; blocks: unknown }>(sql`
          SELECT role, kind, blocks FROM companion_messages
          WHERE conversation_id = ${run.conversation_id}
            AND id <> ${run.user_message_id}
            AND kind NOT IN ('cancelled', 'error')
          ORDER BY seq DESC LIMIT 20
        `);
        const recentMessages = historyRows
          .slice()
          .reverse()
          .filter((m) => m.role !== "system")
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
          activeness: string | null;
          boundaries: unknown;
        }>(sql`
          SELECT name, speaking_style, personality_tags, examples, activeness, boundaries
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
              // 活跃度与边界进对话链路（方案 29 §3.3，抱怨 #2）。取值按契约白名单
              // 收窄，不认识的写 null——宁可当"没设置"也不要把她导向一个不存在的档。
              activeness: ACTIVENESS_VALUES.has(String(petProfileRow.activeness ?? ""))
                ? (petProfileRow.activeness as PetProfileActiveness)
                : null,
              boundaries: isPetBoundaryObject(petProfileRow.boundaries)
                ? petProfileRow.boundaries
                : null,
            }
          : null;
        const groundedTutorContext = await readGroundedTutorContext(
          tx,
          run.page_context,
          { workspaceId: ctx.workspaceId, userId: run.user_id },
        );
        // 环境快照跑在**同一个** RLS 读事务里：它是一组常量级聚合 SQL，另开事务
        // 只会多一次往返，而且脱离这里的作用域边界（方案 29 §4.1）。
        const hereAndNow = renderHereAndNow(await loadHereAndNow(tx, {
          workspaceId: ctx.workspaceId,
          userId: run.user_id,
          conversationId: run.conversation_id,
          pageContext: run.page_context,
          userText,
        }));
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
          hereAndNow,
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
    // 交互对话关思考：整段取回语义下思考 token 全算进用户等待（见 withThinkingDisabled）。
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    ctx.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口 logAICall——
    // 此前全仓零生产调用，而 DEFAULT_AI_DATA_POLICY.auditLogging 默认为 true，
    // 等于审计/成本记录完全空转。只写元数据，不写内容。
    { userId: read.userId, operation: "companion_agent", jobId: ctx.id },
  );
  // 思考档备用 provider（2026-09-19 退化回复闸）：主链路关思考时，网关/模型退化
  // 窗口会把答案缩成一两个词且自我复制进历史。agent loop 检测到退化答案时用它
  // 原样重跑一次取更长者（见 runCompanionAgentLoop 的退化回复闸）。
  const thinkingProvider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx,
    ctx.workspaceId,
    { userId: read.userId, operation: "companion_agent", jobId: ctx.id },
  );
  /**
   * 跨模型兜底 provider（方案 29 §9.6 / B8）。
   *
   * 同档思考重试治不了 provider 侧的退化：实测主模型 tokenrhythm/qwen3.8-flash
   * 会高频返回"一词 + finish=stop"的半截话（近 3 小时 21/32 条不足 6 字，且没有
   * maxTokens 截断日志），连着两次都退化时重跑同样会退化。所以兜底必须换**模型**，
   * 最好连 provider 一起换。未配置 companion_fallback 时为 null，loop 跳过这一级。
   */
  const fallbackProvider = govCtx.companionFallbackProviderName
    && govCtx.companionFallbackProviderConfig
    ? createGovernedProvider(
      createProvider(
        govCtx.companionFallbackProviderName,
        govCtx.companionFallbackProviderConfig,
      ),
      govCtx,
      ctx.workspaceId,
      { userId: read.userId, operation: "companion_agent_fallback", jobId: ctx.id },
    )
    : undefined;

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
    hereAndNow: read.hereAndNow,
    petProfile: read.petProfile,
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

  // ── 阶段 2b：统一 Agent loop（每一步真实流式下发） ────────────────────
  // 普通闲聊由 provider 以空工具列表单步完成；带 Skill 的请求在运行时内
  // 进行有限步工具循环。**每一步**（含带工具的那几步）的 provider 增量都经
  // 交付管线实时下发（稳定前缀 + 增量校验 + 边生成边落库），不再等全文取回后
  // 再补写 delta。带工具的一步在调用工具前说的开场白会作为正文的一部分保留
  // （见 runCompanionAgentLoop 的 visibleSegments）。
  let voiceSegmentState: CompanionDisplaySegmentState = { cursor: 0, sentCount: 0 };
  let voiceSegmentsEnabled = isCompanionVoiceDialogueEnabled();
  const emitVisibleVoiceSegments = async (visibleText: string, isFinal: boolean): Promise<void> => {
    if (!voiceSegmentsEnabled) return;
    const split = splitCommittedDisplaySegments(visibleText, voiceSegmentState, isFinal);
    voiceSegmentState = split.next;
    if (split.segments.length === 0) return;
    const emotion = resolveReplyToneEmotion(visibleText);
    const cue = buildFinalCuePayload(visibleText);
    const toned = applyDeterministicToneToSegments(
      split.segments.map((segment) => ({
        ordinal: segment.ordinal,
        text: segment.displayText,
        textSha256: sha256Utf8V1(segment.displayText),
      })),
      emotion,
      read.petProfile?.boundaries?.allowVoiceTags !== false,
    );
    try {
      const written = await emitCompanionTtsSegments({
        workspaceId: ctx.workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        conversationId: read.conversationId,
        expiresAt,
        notifyCompanionEvent,
        segments: split.segments.map((segment, index) => {
          const synthesis = toned[index];
          const synthesisText = synthesis?.text ?? segment.displayText;
          const synthesisTextSha256 = synthesis?.textSha256 ?? sha256Utf8V1(synthesisText);
          return {
            version: 2 as const,
            segmentId: companionSegmentId(read.runId, read.generation, segment.ordinal, synthesisTextSha256),
            ordinal: segment.ordinal,
            displayText: segment.displayText,
            displayStart: segment.displayStart,
            displayEnd: segment.displayEnd,
            synthesisText,
            synthesisTextSha256,
            cue,
          };
        }),
      });
      if (!written) voiceSegmentsEnabled = false;
    } catch (error) {
      // 语音是渐进增强；事件写入失败不能把已经安全提交的文字回复一起判失败。
      voiceSegmentsEnabled = false;
      logger.warn({ err: error, runId: read.runId }, "companion voice segment emission disabled for turn");
    }
  };
  const streamingDelivery = createCompanionStreamDelivery({
    ctx,
    read,
    expiresAt,
    notifyCompanionEvent,
    onVisibleCommitted: async (_committed, visibleText) => emitVisibleVoiceSegments(visibleText, false),
  });
  let assistantText: string;
  let ttsRawText: string | null = null;
  let agentResult;
  try {
    agentResult = await runCompanionAgentLoop({
      ctx,
      read,
      provider,
      thinkingProvider,
      fallbackProvider,
      // 活跃度决定退化闸的字数线（方案 29 §9.17）：不传就等于忽略用户的设置。
      activeness: read.petProfile?.activeness ?? null,
      // 图片能不能出境是**账号级政策**，不是她这一轮可以自己争取的东西：
      // 关着的时候读图工具既不下发也不会执行，她看不见就不会答应去看。
      toolConstraints: { visionEnabled: govCtx.policy.sendImageContent === true },
      baseMessages: messages,
      expiresAt,
      continuationProposalId,
      onProviderDelta: (delta) => streamingDelivery.onRawDelta(delta),
      handlerStartedAtMs,
    });
  } catch (err) {
    // 预算耗尽（步数/工具数/执行时间）是确定性失败：标记 recoverable=false，
    // 队列侧同时按不可重试处理，避免空转重投（见 isNonRetryableError）。
    const budgetExceeded = err instanceof CompanionAgentBudgetExceededError;
    // 交付管线主动叫停（增量校验命中泄露/超限、fence 失联）：同样不可重试——
    // 重投不会让"泄露"消失。已下发的部分必然是最终文本的前缀，客户端按 error 收尾。
    const streamStopped = err instanceof CompanionStreamStoppedError;
    await markCompanionRunFailed(
      read,
      ctx.workspaceId,
      budgetExceeded ? "AGENT_BUDGET_EXCEEDED" : "INTERNAL_ERROR",
      !budgetExceeded && !streamStopped,
      budgetExceeded
        ? "companion agent budget exceeded"
        : streamStopped
          ? `companion stream stopped: ${streamingDelivery.failureReason() ?? "delivery pipeline"}`.slice(0, 240)
          : "companion agent execution failed",
    );
    // 她已经说出来的那半句不能随失败一起消失（2026-09-19）。
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw err;
  }
  if (agentResult.status === "waiting_for_confirmation") {
    // 等用户确认：本轮不写 assistant.final（终态消息由确认后的续跑产出）。
    // 但**必须把已下发的稳定前缀落库关门**（④-b）：带工具的一步现在也会流式，
    // 这一步可能正是提议确认的那一步，开场白已经发给客户端——不 finish 的话
    // 压在节流窗口里的尾巴永远写不出去，客户端草稿会缺一截。
    const flushed = await streamingDelivery.finish();
    if (!flushed.ok) {
      logger.warn(
        { runId: read.runId, reason: flushed.reason },
        "companion stream flush failed on a waiting-for-confirmation turn",
      );
    } else {
      await emitVisibleVoiceSegments(flushed.text, true);
    }
    return;
  }
  // 上游解包（2026-09-18）：个别轮次 provider 会把回复包成 JSON 信封，
  // TTS 朗读文本与校验/落库文本都必须用剥离后的版本。
  ttsRawText = unwrapCompanionJsonEnvelope(agentResult.text);

  // 信任边界：流式期间每个 flush 前都已跑过增量校验（长度/泄露），这里收尾；
  // 校验失败在此终结：已投递的稳定前缀仍在（它是最终文本的前缀），run 按失败收尾。
  const streamed = await streamingDelivery.finish();
  if (!streamed.ok) {
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, streamed.reason);
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error(`companion stream validation failed: ${streamed.reason}`);
  }
  // 全文校验（markdown/标签净化、信封拒绝）必须对完整文本成立；已下发的稳定前缀
  // 必须是最终文本的前缀，否则两条路径漂移——宁可判失败，也不给客户端一个
  // 前后不一致的回复。
  const validated = reconcileStreamedText({
    delivered: streamed.text,
    validated: validateCompanionOutput(ttsRawText),
  });
  if (!validated.ok) {
    // 诊断（2026-09-19）：流式前缀与全文净化不一致时，必须能一眼看出差在哪——
    // 只记长度与首个差异点 + 两小段上下文，不整段落日志。
    if (validated.reason === "stream_full_text_diverged") {
      const deliveredText = streamed.text;
      const finalText = validateCompanionOutput(ttsRawText);
      const finalValue = finalText.ok ? finalText.text : "";
      let divergeAt = 0;
      while (
        divergeAt < deliveredText.length
        && divergeAt < finalValue.length
        && deliveredText[divergeAt] === finalValue[divergeAt]
      ) {
        divergeAt += 1;
      }
      logger.warn(
        {
          runId: read.runId,
          deliveredChars: deliveredText.length,
          finalChars: finalValue.length,
          divergeAt,
          deliveredExcerpt: deliveredText.slice(Math.max(0, divergeAt - 12), divergeAt + 12),
          finalExcerpt: finalValue.slice(Math.max(0, divergeAt - 12), divergeAt + 12),
        },
        "companion streamed prefix diverged from validated text",
      );
    }
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, validated.reason);
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error(`companion output validation failed: ${validated.reason}`);
  }
  // delta 与终态 assistant message 使用同一份净化文本（markdown/标签剥离后），
  // 否则客户端流式渲染的内容与 assistant.final 指向的消息不一致。
  assistantText = validated.text;
  if (streamingDelivery.deliveredChars() === 0) {
    // 没走成流式（provider 无流式实现 / 信封守卫 / 空流）：回退到整段补写 delta，
    // 事件布局与 2026-09-18 之后的实现完全一致。
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
  } else if (!(await streamingDelivery.writeTail(assistantText))) {
    // 已下发内容与终态文本必须逐字对齐（appendFrom 的基准就是下发长度）。
    await markCompanionRunFailed(read, ctx.workspaceId, "INTERNAL_ERROR", false, "delta_stream_diverged");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw new Error("companion streamed text diverged from validated text");
  }
  // 强制刷新最后一个未闭合句。已经在增量阶段发出的区间由 cursor 保证不会重复。
  await emitVisibleVoiceSegments(assistantText, true);

  // ── 阶段 3c：终态事务（message + final + run succeeded） ──
  // 15b：TTS 段已在 delta 过程（流式）或 validate 后（非流式）逐个下发完毕，
  // 终态事务不再携带 segments——事件布局变为 final @ eventStart、cue @ +1、
  // character.cue @ +1。
  const assistantMessageId = randomUUID();
  // 情绪接表情（2026-09-18）：语气层分类结果随消息落库，渲染层据此驱动 Live2D。
  const replyEmotion = resolveReplyToneEmotion(assistantText);
  // 工具带出的跳转块跟在正文之后（方案 29 §4.8）。正文仍是**第一个块**：
  // 按 `blocks[0].text` 取正文的老读法（含下一轮装配 prompt）不受影响，
  // 而 `textOfCompanionBlocks` 只认 text/code/citation，nav 不会污染模型上下文。
  const blocks = [
    { type: "text", text: assistantText, emotion: replyEmotion },
    ...agentResult.blocks.slice(0, 31),
  ];
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
        if (!alive[0]) {
          // fence 未命中：run 已不是 active（cancelled / superseded / 并发终态已收尾）。
          //
          // 用户按了"停止"时，气泡里**已经出现过**的字必须留下来——否则取消一发生，
          // 这段内容就从历史里彻底消失（迟到的 assistant.final 被 fence 拒绝，而
          // companion_messages 只在 final 时写入）。这里是全仓**唯一**写 assistant
          // 消息的地方，对话与 agent 两条链路都汇到这里，所以补这一处即可覆盖两者。
          //
          // 落库判据用一条原子 UPDATE：只有 run 的真实终态是 'cancelled' 才留档。
          //   - `superseded`（被用户的新提问顶掉）不落：那一轮由新回合接替，落碎片是噪音；
          //   - 太短不落：1–2 字的碎片进历史是噪音，不是记录（阈值见常量）。
          // 顺带回填 assistant_message_id，让"这条消息属于哪轮 run"在数据里成立。
          if (assistantText.trim().length >= COMPANION_CANCELLED_MIN_CHARS) {
            // 先锁住"确属取消、且还没留过档"的那一行。**不能**先回填
            // `assistant_message_id`：它是指向 `companion_messages` 的立即外键，
            // 消息行还没插就回填会被 FK 打回、整笔终态事务回滚——留档会一声不响地
            // 从未发生过（实机库里 9 个 cancelled run、0 条 cancelled 消息）。
            const cancelled = await tx.execute<{ id: string }>(sql`
              SELECT id FROM companion_turn_runs
              WHERE id = ${read.runId} AND status = 'cancelled' AND assistant_message_id IS NULL
              FOR UPDATE
            `);
            if (cancelled[0]) {
              const partialCounters = await tx.execute<{ next_message_seq: string }>(sql`
                UPDATE companion_conversations
                SET next_message_seq = next_message_seq + 1, last_message_at = now()
                WHERE id = ${read.conversationId}
                RETURNING next_message_seq
              `);
              const partialSeqRow = partialCounters[0];
              if (partialSeqRow) {
                // blocks 与 contentSha256 直接复用成功路径算好的那份：两条路径
                // 必须是同一套散列口径，否则同一段文本在库里有两个 contentSha256。
                // 不写 assistant.final / character.cue：run 已是终态，事件侧由 cancel
                // 那条 turn.cancelled 收尾——一个回合出现两个"结束"会让客户端状态机打架。
                await tx.execute(sql`
                  INSERT INTO companion_messages
                    (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
                  VALUES (${assistantMessageId}, ${ctx.workspaceId}, ${read.userId},
                          ${read.conversationId}, ${Number(partialSeqRow.next_message_seq) - 1},
                          'assistant', 'cancelled',
                          ${JSON.stringify(blocks)}, ${read.runId}, ${contentSha256})
                `);
                await tx.execute(sql`
                  UPDATE companion_turn_runs
                  SET assistant_message_id = ${assistantMessageId}, updated_at = now()
                  WHERE id = ${read.runId}
                `);
              }
            }
          }
          return;
        }

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
              prompt_version = ${read.groundedTutorContext ? GROUNDED_TUTOR_PROMPT_ID : COMPANION_PERSONA_V5_PROMPT_ID},
              prompt_hash = ${read.groundedTutorContext ? groundedTutorPromptSha256 : COMPANION_PERSONA_V5_SHA256},
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
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw err;
  }
}
