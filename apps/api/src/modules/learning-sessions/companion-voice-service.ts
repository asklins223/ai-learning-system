/**
 * P3 companion transcribe（§11.2）：PTT 半双工语音的 ASR 路径。
 *
 * - ffprobe 实测 duration（200..60000ms，超限 → VOICE_UNSUPPORTED_FORMAT，
 *   因 6.9 错误码枚举不含专用 TOO_SHORT/TOO_LONG）；
 * - ASR（provider 可注入 mock）→ transcript + sha256；
 * - 写 companion_voice_artifacts（status=pending，conversation/message/attached NULL，
 *   raw_audio_persisted=false，expires 24h）；P3-4 的 turn 事务将 FOR UPDATE 绑定 attached；
 * - 响应 §11.2：voiceArtifactId / transcriptSha256 / durationMs / expiresAt。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { companionVoiceSegmentReadyPayloadV2Schema } from "@ailearn/shared/companion-conversation-contracts";
import {
  COMPANION_TTS_PLAYBACK_REASON_TO_OUTCOME,
  type CompanionTtsPlaybackReason,
} from "@ailearn/shared/companion-voice-contracts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { CompanionConversationError } from "../companion-conversation/turn-service.ts";
import { probeAudioDurationMs } from "./ffprobe.ts";

export interface CompanionAsrProvider {
  transcribe(audio: Uint8Array, filename: string): Promise<{ text: string }>;
}

export interface CompanionTranscriptionResult {
  statusCode: number;
  body: {
    version: 1;
    voiceArtifactId: string;
    text: string;
    transcriptSha256: string;
    asrProvider: string;
    asrModel: string;
    language: string;
    durationMs: number;
    expiresAt: string;
  };
}

const ARTIFACT_TTL_MS = 3_600_000; // §11.2：pending provenance 默认 1h

export async function transcribeCompanionDialogueAudio(args: {
  workspaceId: string;
  userId: string;
  audio: Buffer;
  filename: string;
  asrProvider: CompanionAsrProvider;
  asrProviderName: string;
  asrModel: string;
  language?: string;
}): Promise<CompanionTranscriptionResult> {
  // 1. ffprobe duration 实测（§11.2：200..60000ms）
  const probe = await probeAudioDurationMs(args.audio);
  if (!probe.ok) {
    if (probe.reason === "too_short" || probe.reason === "too_long" || probe.reason === "no_duration") {
      throw new CompanionConversationError(
        "VOICE_UNSUPPORTED_FORMAT",
        415,
        `audio duration out of range (${probe.reason})`,
      );
    }
    throw new CompanionConversationError(
      "VOICE_UNSUPPORTED_FORMAT",
      415,
      "audio could not be probed (unsupported or corrupt)",
    );
  }

  // 2. ASR → transcript + sha256
  let text: string;
  try {
    const result = await args.asrProvider.transcribe(
      new Uint8Array(args.audio),
      args.filename,
    );
    text = result.text;
  } catch {
    throw new CompanionConversationError("PROVIDER_UNAVAILABLE", 502, "ASR provider failed");
  }
  text = text.trim();
  if (text.length === 0 || text.length > 4_000) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "ASR transcript is empty or too long");
  }
  const transcriptSha256 = sha256Utf8V1(text);

  // 3. 写 pending artifact（P3-4 turn 事务将 FOR UPDATE 绑定 attached）
  const artifactId = randomUUID();
  const expiresAt = new Date(Date.now() + ARTIFACT_TTL_MS);
  await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO companion_voice_artifacts
          (id, workspace_id, user_id, conversation_id, message_id, status,
           transcript_sha256, asr_provider, asr_model, language, duration_ms,
           raw_audio_persisted, expires_at)
        VALUES
          (${artifactId}, ${args.workspaceId}, ${args.userId}, NULL, NULL, 'pending',
           ${transcriptSha256}, ${args.asrProviderName}, ${args.asrModel},
           ${args.language ?? "zh-CN"}, ${probe.durationMs},
           false, ${expiresAt.toISOString()})
      `);
    },
  );

  return {
    statusCode: 201,
    body: {
      version: 1,
      voiceArtifactId: artifactId,
      text,
      transcriptSha256,
      asrProvider: args.asrProviderName,
      asrModel: args.asrModel,
      language: args.language ?? "zh-CN",
      durationMs: probe.durationMs,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

/**
 * §11.3 Companion TTS 合成（strict ref）：
 * - 请求只含 ref（conversationId/runId/generation/ordinal/segmentId），不含正文与 voice id；
 * - RLS scope 内重读 voice.segment.ready 事件，验证 run/generation/ordinal/segmentId 与
 *   profile 完全匹配；
 * - run 状态必须是 running 或 succeeded（cancel_requested/cancelled/superseded/failed
 *   全部拒绝——迟到/已取消的段不再合成）；
 * - 合成文本只来自事件中的净化可见文本（不可由客户端任意指定）。
 */
export interface CompanionTtsSegmentRef {
  conversationId: string;
  runId: string;
  generation: number;
  ordinal: number;
  segmentId: string;
}

export interface TtsSynthesizeFn {
  (text: string, voice: string): Promise<{ audio: Uint8Array | Buffer; engine?: "qwen" | "edge" }>;
}

/**
 * 合成失败时，调用方可以把"倒下去的是哪个引擎"挂在异常上。
 *
 * 为什么挂在异常上而不是返回值：失败路径没有返回值。为什么这个信息必须留痕：
 * `companion_tts_outcomes.engine` 以前只在成功时写，于是报表里
 * `edge n=13 ok=13 failed=0` 与全库 3 条 `EdgeTtsError` 的失败**同时成立**——
 * 按引擎分档的那行读数结构上看不见失败，而它正是"该不该换引擎/换音色"的判据。
 */
export interface CompanionTtsFailure {
  ttsEngine?: "qwen" | "edge";
}

/**
 * 落一条 `stage='synth'` 的合成结果（0246）。
 *
 * **审计永远不能影响音频**：写不进去只 warn，不抛、不改返回值。抽成导出函数是因为
 * 它现在有两个调用点——常规合成（合成完就记）与预热命中（合成发生在预热那一刻，
 * 客户端来取时才记，读数从缓存里带回来）。两处必须同一张表、同一个形状。
 */
export async function recordCompanionTtsSynthOutcome(args: {
  workspaceId: string;
  userId: string;
  ref: CompanionTtsSegmentRef;
  outcome: "ok" | "rejected" | "failed";
  durationMs: number;
  errorCode?: string;
  engine?: string;
  bytes?: number;
}): Promise<void> {
  try {
    await withWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO companion_tts_outcomes
            (workspace_id, user_id, conversation_id, run_id, segment_id, ordinal,
             outcome, error_code, engine, duration_ms, bytes)
          VALUES
            (${args.workspaceId}, ${args.userId}, ${args.ref.conversationId}, ${args.ref.runId},
             ${args.ref.segmentId}, ${args.ref.ordinal}, ${args.outcome},
             ${args.errorCode ? args.errorCode.slice(0, 80) : null},
             ${args.engine ?? null}, ${args.durationMs}, ${args.bytes ?? null})
        `);
      },
    );
  } catch (error) {
    logger.warn(
      { err: error, runId: args.ref.runId, ordinal: args.ref.ordinal },
      "companion tts outcome could not be recorded; audio path unaffected",
    );
  }
}

export async function synthesizeCompanionTtsSegment(args: {
  workspaceId: string;
  userId: string;
  ref: CompanionTtsSegmentRef;
  synthesize: TtsSynthesizeFn;
  voice?: string;
  /**
   * 服务端预热时传 true：**先不落 `companion_tts_outcomes`**，把这一次的读数带回去，
   * 等客户端真的来取（命中缓存）时再由路由记一笔（方案 29 §14.11 修复 ③）。
   *
   * 为什么必须这样：那张表里 `stage='synth'` 的含义是"字节交给了客户端"，报表的
   * "音频已交付却零上报"就是靠它减 `stage='playback'` 算出来的。预热会在**没人要**
   * 的情况下合成（回合被打断、客户端关着），若照记不误，这些段会变成一条永远没有
   * 结局的"给了音频却没响"——把这条最锋利的读数重新变成假故障。
   */
  deferOutcome?: boolean;
}): Promise<{
  statusCode: number;
  audio?: Uint8Array;
  error?: { code: string; message: string };
  /** `deferOutcome` 时带回这一次合成的读数，供命中缓存的那条路补记。 */
  deferred?: { durationMs: number; engine?: "qwen" | "edge"; bytes: number };
}> {
  const startedAt = Date.now();
  /**
   * 逐段落一条合成结果（0246，方案 29 §4.9）。**审计永远不能影响音频**：写不进去
   * 只 warn，不抛、不改返回值。
   *
   * 这张表要回答的是以前只能靠用户复述的问题——"她经常没声音"到底是
   * 没生成事件、被拒（回合已取消/合同不符）、还是引擎失败，各占多少、等了多久。
   */
  const recordOutcome = async (
    outcome: "ok" | "rejected" | "failed",
    extra: { errorCode?: string; engine?: string; bytes?: number } = {},
  ): Promise<void> => {
    // 预热路径先不记账：等客户端真来取（命中缓存）时由路由补记，
    // 否则"没人要的合成"会变成一条没有结局的"给了音频却没响"。
    if (args.deferOutcome) return;
    await recordCompanionTtsSynthOutcome({
      workspaceId: args.workspaceId,
      userId: args.userId,
      ref: args.ref,
      outcome,
      durationMs: Date.now() - startedAt,
      ...extra,
    });
  };
  // 第一阶段：事务内只做只读校验并取回文本（快路径，不持有长事务）。
  const staged = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx): Promise<{ text: string } | { statusCode: number; error: { code: string; message: string } }> => {
      const events = await tx.execute<{ payload: unknown }>(
        sql`
          SELECT payload
          FROM companion_stream_events
          WHERE conversation_id = ${args.ref.conversationId}
            AND run_id = ${args.ref.runId}
            AND generation = ${args.ref.generation}
            AND type = 'voice.segment.ready'
            AND payload->>'ordinal' = ${String(args.ref.ordinal)}
          LIMIT 1
        `,
      );
      const event = events[0];
      if (!event) {
        return {
          statusCode: 404,
          error: { code: "NOT_FOUND", message: "voice segment not found" },
        };
      }
      const parsedPayload = companionVoiceSegmentReadyPayloadV2Schema.safeParse(event.payload);
      if (!parsedPayload.success) {
        return {
          statusCode: 409,
          error: { code: "UNSUPPORTED_CONTRACT", message: "voice segment contract is invalid" },
        };
      }
      if (parsedPayload.data.segmentId !== args.ref.segmentId) {
        return {
          statusCode: 400,
          error: { code: "INVALID_REQUEST", message: "segmentId mismatch" },
        };
      }
      if (sha256Utf8V1(parsedPayload.data.synthesisText) !== parsedPayload.data.synthesisTextSha256) {
        return {
          statusCode: 409,
          error: { code: "UNSUPPORTED_CONTRACT", message: "voice segment digest mismatch" },
        };
      }
      const runs = await tx.execute<{ status: string }>(
        sql`SELECT status FROM companion_turn_runs WHERE id = ${args.ref.runId}`,
      );
      const status = runs[0]?.status;
      // running/succeeded 之外（含 cancel_requested/cancelled/superseded/failed）一律拒绝
      if (status !== "running" && status !== "succeeded") {
        return {
          statusCode: 409,
          error: { code: "TURN_CANCELLED", message: "run is not playable" },
        };
      }
      return { text: parsedPayload.data.synthesisText };
    },
  );
  if ("error" in staged) {
    await recordOutcome("rejected", { errorCode: staged.error.code });
    return staged;
  }
  // 第二阶段：事务外合成（edge-tts 外部 HTTP，默认 30s 超时）——避免在
  // DB 事务内同步调用外部服务导致长事务、连接池耗尽与锁放大。
  //
  // 引擎失败以前**直接往外抛**：companion 分支的路由没有 try/catch，于是客户端
  // 收到的是 500 而不是可降级的 TTS_FAILED（普通朗读分支有这个 catch），
  // 表现为"她突然不出声"且没有任何原因。现在按 §4.9 的 fail-open 收在这里：
  // 记一条 failed、返回 502 + 静态文案，客户端照既有逻辑降级纯文字。
  let synthesized: { audio: Uint8Array | Buffer; engine?: "qwen" | "edge" };
  try {
    synthesized = await args.synthesize(staged.text, args.voice ?? "zh-CN-XiaoxiaoNeural");
  } catch (error) {
    await recordOutcome("failed", {
      errorCode: error instanceof Error ? error.constructor.name : "unknown",
      engine: (error as (Error & CompanionTtsFailure) | undefined)?.ttsEngine,
    });
    logger.warn({ err: error, runId: args.ref.runId, ordinal: args.ref.ordinal }, "companion tts synthesis failed");
    return { statusCode: 502, error: { code: "TTS_FAILED", message: "语音合成失败（降级纯文字）" } };
  }
  // A user/system cancellation can win while the provider is synthesizing.
  // Re-check immediately before returning bytes so a late TTS response cannot
  // be played after the run has become cancelled/superseded.
  const finalStatus = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const runs = await tx.execute<{ status: string }>(
        sql`SELECT status FROM companion_turn_runs WHERE id = ${args.ref.runId}`,
      );
      return runs[0]?.status ?? null;
    },
  );
  if (finalStatus !== "running" && finalStatus !== "succeeded") {
    await recordOutcome("rejected", { errorCode: "TURN_CANCELLED" });
    return {
      statusCode: 409,
      error: { code: "TURN_CANCELLED", message: "run is no longer playable" },
    };
  }
  await recordOutcome("ok", {
    engine: synthesized.engine,
    bytes: synthesized.audio.byteLength,
  });
  return {
    statusCode: 200,
    audio: synthesized.audio,
    ...(args.deferOutcome
      ? { deferred: { durationMs: Date.now() - startedAt, engine: synthesized.engine, bytes: synthesized.audio.byteLength } }
      : {}),
  };
}

/**
 * 客户端播完（或没能播）一段之后回来的那一句（0247）。
 *
 * 为什么值得单开一条写路径：`stage='synth'` 那一半能证明的边界就是"字节交给了客户端"。
 * 而"她经常没声音"里的两类只有客户端知道——字节到了但等太久被跳过、以及解码/播放
 * 失败。以前这两个原因在渲染进程里记着却没有任何地方收。
 *
 * **上报永远不能影响朗读**：调用方 fire-and-forget，这里不抛错、不重试，写不进去只 warn。
 * 也不校验 segmentId 是否真存在：那要多一次 DB 往返去保护一张只描述用户自己行为的表，
 * 而 RLS 的 WITH CHECK 已经把行锁死在"本人的 workspace + user"里，最坏情况是他给自己的
 * 统计注水。
 */
export async function recordCompanionTtsPlaybackOutcome(args: {
  workspaceId: string;
  userId: string;
  ref: CompanionTtsSegmentRef;
  reason: CompanionTtsPlaybackReason;
  durationMs?: number;
}): Promise<void> {
  const outcome = COMPANION_TTS_PLAYBACK_REASON_TO_OUTCOME[args.reason];
  try {
    await withWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO companion_tts_outcomes
            (workspace_id, user_id, conversation_id, run_id, segment_id, ordinal,
             outcome, error_code, duration_ms, stage)
          VALUES
            (${args.workspaceId}, ${args.userId}, ${args.ref.conversationId}, ${args.ref.runId},
             ${args.ref.segmentId}, ${args.ref.ordinal}, ${outcome},
             ${args.reason}, ${args.durationMs ?? null}, 'playback')
          -- 弱网重试/页面刷新后补报会重发同一段；"这一段播过"不该变成三条。
          ON CONFLICT (run_id, segment_id) WHERE stage = 'playback' DO NOTHING
        `);
      },
    );
  } catch (error) {
    logger.warn(
      { err: error, runId: args.ref.runId, ordinal: args.ref.ordinal },
      "companion playback outcome could not be recorded; speech path unaffected",
    );
  }
}
