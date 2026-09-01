/**
 * Companion 对话流式/批量 delta 写库管线（2026-08-24 AI 设计审查 §4.4 拆分）。
 *
 * 自 companion-dialogue.ts 拆出：
 * - COMPANION_PROVIDER_OPTIONS：§9.5 provider 采样参数（编排器引用）；
 * - categorizeProviderFailure：首个 delta 前 provider 失败分类；
 * - runStreamingDialogue：真流式（chatCompletionStream）——delta 缓冲后按
 *   256-unit/50ms 节流写库（独立事务 + fence + NOTIFY），增量切 TTS 段；
 * - writeBatchedDeltas：非流式回退——全文取回后按批分块写 delta。
 *
 * fence 语义不变：run 被 cancel/supersede → 停止写入并返回 null/false；
 * 重试 fail-closed：首轮 delta 写入前发现残留 delta → 抛错不拼接错乱。
 */

import { sql } from "drizzle-orm";
import type { AIProvider } from "../lib/ai-provider.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import {
  splitCompanionTtsSegmentsIncremental,
  companionSegmentId,
  stripVoiceExpressionTags,
  extractVoiceEmotion,
  TTS_FIRST_SEGMENT_MIN_CHARS,
} from "../lib/tts-segments.ts";
import { applyDeterministicToneToSegments, createStreamToneInjector, resolveReplyToneEmotion } from "../lib/companion-tone.ts";
import { chunkTextIntoDeltas, DELTA_MAX_CODE_UNITS } from "./companion-dialogue-content.ts";
import { markCompanionRunFailed, isCompanionVoiceDialogueEnabled } from "./companion-dialogue-store.ts";
import type { ReadContext } from "./companion-dialogue-store.ts";

/** §9.5 P2 默认模型参数。
 *  2026-08-12+（15a 新反馈）：temperature 0.6 → 0.9（陪伴对话像真人、更随性，
 *  正确性其次）。
 *  2026-08-16（桌宠聊天风格优化）：temperature 0.9 → 1.0、maxTokens 600 → 700，
 *  让回复更活泼、更"有来有回"，同时保留足够长度说一句轻快的小尾巴。
 *  2026-08-24（AI 设计审查 §4.2）：temperature 1.0 → 0.9——V4 人格 prompt 已
 *  通过 few-shot 示例承载风格（移出标签全表），不再需要高温度补随机性；
 *  高温度 + 高约束是小模型顾此失彼的主因。 */
export const COMPANION_PROVIDER_OPTIONS = {
  temperature: 0.9,
  maxTokens: 700,
  responseFormat: "text" as const,
  // 2026-08-13（全链路诊断）：移除 disableThinking——flash 模型关思考后
  // 推理崩塌（用户反馈桌宠"蠢"，实测 9.11 vs 9.9 答错）。思考由平台
  // config enableThinking: true 显式开启；"伴星正在想" UI 已存在。
};

/** 首个 delta 前 provider 失败分类（§5.2 error event 的 recoverable）。 */
export function categorizeProviderFailure(err: unknown): string {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (/timeout|timed? ?out|abort/i.test(message)) return "PROVIDER_TIMEOUT";
  return "PROVIDER_UNAVAILABLE";
}

/** 流式 flush 阈值：≥256 code unit 或每 50ms 定时落库一批 delta。 */
export const STREAM_FLUSH_CHARS = 256;
export const STREAM_FLUSH_INTERVAL_MS = 50;
/** 流式空闲超时：provider 持续无增量超过该时长视为卡死（abort + failed）。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface StreamDialogueArgs {
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
export async function runStreamingDialogue(args: StreamDialogueArgs): Promise<{ content: string } | null> {
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
  // 2026-08-24（AI 设计审查 §4.2，二轮重构）：流式注入器只负责逐 delta 清洗
  // 幻觉标签；语气注入上移到切段后的 emitSegments（逐段注入 + 全文情绪判定）。
  const toneInjector = createStreamToneInjector((d) => { buffer += d; });
  // 15b：字幕般流式 TTS——delta 写库后增量切段（完整句立即成段下发）
  const voiceEnabled = isCompanionVoiceDialogueEnabled();
  let ttsState: import("../lib/tts-segments.ts").IncrementalTtsState = { rest: "", sentCount: 0, sentChars: 0 };
  // 累计的原始流式文本（注入器只清洗 sink 入参，不改 delta）——供逐段
  // 语气注入做全文情绪判定；幻觉标签由 resolveReplyToneEmotion 内部剥离。
  let streamedRawSoFar = "";
  /**
   * 15b：把切出的段发 voice.segment.ready。PERF：整个批次在单个 workspace 事务内
   * 完成——fence 校验一次、next_event_seq 一次递增 N、多行 INSERT 一次、
   * NOTIFY 一次（原实现每段一个独立事务 = N 次 DB round-trip）。fence 拒绝即停
   * （与逐段语义一致：run 已终态时不再写后续段）。
   */
  const emitSegments = async (rawSegs: import("../lib/tts-segments.ts").CompanionTtsSegment[]): Promise<boolean> => {
    if (rawSegs.length === 0) return true;
    // 2026-08-24（二轮重构）：确定性语气层统一在段下发前应用——全文
    // （streamedRawSoFar）判情绪，逐段注句首控制标签 + 净化幻觉标签；
    // 注入改变段文本，textSha256 重算后再派生 segmentId。
    const segs = applyDeterministicToneToSegments(
      rawSegs.map((seg) => ({ ordinal: seg.ordinal, text: seg.text, textSha256: seg.textSha256 })),
      resolveReplyToneEmotion(streamedRawSoFar),
    );
    return withWorkerWorkspaceTransaction(
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
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + ${segs.length}
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const startSeq = Number(counters[0].next_event_seq) - segs.length;
        const rows = segs.map((seg, i) => {
          const emotion = extractVoiceEmotion(seg.text) ?? undefined;
          return sql`(
            ${read.conversationId}, ${startSeq + i}, ${ctx.workspaceId}, ${read.userId},
            ${read.runId}, ${read.generation}, ${read.accountEpoch},
            'voice.segment.ready',
            ${JSON.stringify({
              segmentId: companionSegmentId(read.runId, read.generation, seg.ordinal, seg.textSha256),
              ordinal: seg.ordinal,
              text: seg.text,
              textSha256: seg.textSha256,
              ...(emotion ? { emotion } : {}),
            })},
            ${expiresAt}
          )`;
        });
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES ${sql.join(rows, sql`, `)}
        `);
        await notifyCompanionEvent(tx, startSeq + segs.length - 1);
        return true;
      },
    );
  };

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
      let writtenThisFlush = "";
      while (buffer.length > 0) {
        // §5.2：delta 单条 ≤2000 code unit。provider 单次 onDelta 可能给出
        // 超过阈值的文本，必须分块，不能整块写库。
        let textDelta = buffer.slice(0, DELTA_MAX_CODE_UNITS);
        // 2026-08-25（AI 设计审计修复）：已知控制类标签会经流式注入器放行
        // 进入 buffer，而 stripVoiceExpressionTags 只能剥「完整出现在单块
        // 内」的标签——若 2000-unit 切块边界恰切进标签内部（块尾 "...[sa"、
        // 下块 "d]"），两块各自匹配不到模式，碎片漏进展示文本。把边界回退到
        // 尾部最后一个未闭合 "[" 之前，让标签整体留给下一块（与注入器的
        // 扣留同款策略；真实标签最长十余字符，回退上限远大于此）。整块都是
        // 未闭合片段时等下一个 delta 再切，保证前进性。
        const openIdx = textDelta.lastIndexOf("[");
        if (openIdx > 0 && !textDelta.includes("]", openIdx)) {
          if (textDelta.length - openIdx <= 48) textDelta = textDelta.slice(0, openIdx);
        }
        if (textDelta.length === 0) break;
        buffer = buffer.slice(textDelta.length);
        // 15b 二期：双文本管线——入库/展示剥离情感与富语言标签（displayDelta），
        // raw（textDelta）保留给 TTS 增量切段（标签只在朗读文本中生效）。
        // appendFrom 按展示版累计（前端按 appendFrom 拼接展示文本）。
        const displayDelta = stripVoiceExpressionTags(textDelta);
        const appendFrom = streamedChars;
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
                 ${JSON.stringify({ appendFrom, textDelta: displayDelta })}, ${expiresAt})
            `);
            await notifyCompanionEvent(tx, deltaSeq);
            return true;
          },
        );
        if (written) {
          streamedChars += displayDelta.length;
          writtenThisFlush += textDelta;
        } else {
          cancelDetected = true;
          buffer = "";
          return;
        }
      }
      // 15b：本批 delta 写库完成 → 增量切段（完整句立即成段下发）
      if (voiceEnabled && writtenThisFlush.length > 0 && !cancelDetected) {
        // 15b 二期（问题2 修复）：首段提前触发（≥14 字即切，不等完整句），
        // 声音在文字流式生成中就开始合成/播放，与气泡文字感官同步。
        const inc = splitCompanionTtsSegmentsIncremental(writtenThisFlush, ttsState, false, {
          firstSegmentMinChars: TTS_FIRST_SEGMENT_MIN_CHARS,
        });
        ttsState = inc.next;
        if (inc.segments.length > 0) {
          const ok = await emitSegments(inc.segments);
          if (!ok) cancelDetected = true;
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
        toneInjector.push(delta);
        streamedRawSoFar += delta;
        if (buffer.length >= STREAM_FLUSH_CHARS) requestFlush();
        resetIdle();
      },
    );
    clearInterval(flushTimer);
    if (idleTimer) clearTimeout(idleTimer);
    toneInjector.flush();
    await flush(); // 收尾剩余 buffer；等待任何在途写入完成
    if (cancelDetected) return null;
    // 15b：final flush——未完成句强制成段（最后一个 voice.segment.ready 在
    // assistant.final 之前下发，前端收到后即可结束播放队列）。
    if (voiceEnabled) {
      const inc = splitCompanionTtsSegmentsIncremental("", ttsState, true);
      if (inc.segments.length > 0) {
        await emitSegments(inc.segments);
      }
    }
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
export async function writeBatchedDeltas(args: BatchedDeltasArgs): Promise<boolean> {
  const { assistantText, ctx, read, expiresAt, notifyCompanionEvent } = args;
  const streamDeltas = chunkTextIntoDeltas(assistantText, 256);
  // 每事务批量写入多个 delta，减少事务/DB round-trip 开销；
  // 保留 fence + 数量级幂等续写语义，并在批次间保留 50ms 节流。
  const DELTAS_PER_TX = 4;
  for (let i = 0; i < streamDeltas.length; i += DELTAS_PER_TX) {
    const batch = streamDeltas.slice(i, i + DELTAS_PER_TX);
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
        // 一次性递增 next_event_seq 为整个批次分配连续 seq
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + ${batch.length}
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const endSeq = Number(counters[0].next_event_seq) - 1;
        const startSeq = endSeq - batch.length + 1;
        // 多行批量 INSERT
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES ${sql.join(batch.map((delta, j) => sql`(
            ${read.conversationId}, ${startSeq + j}, ${ctx.workspaceId}, ${read.userId},
            ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.delta',
            ${JSON.stringify(delta)}, ${expiresAt}
          )`), sql`, `)}
        `);
        for (let j = 0; j < batch.length; j++) {
          await notifyCompanionEvent(tx, startSeq + j);
        }
        return true;
      },
    );
    if (!written) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
