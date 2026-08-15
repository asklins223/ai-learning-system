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
import { withWorkspaceTransaction } from "../../db/client.ts";
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
  (text: string, voice: string): Promise<{ audio: Uint8Array | Buffer }>;
}

export async function synthesizeCompanionTtsSegment(args: {
  workspaceId: string;
  userId: string;
  ref: CompanionTtsSegmentRef;
  synthesize: TtsSynthesizeFn;
  voice?: string;
}): Promise<{ statusCode: number; audio?: Uint8Array; error?: { code: string; message: string } }> {
  // 第一阶段：事务内只做只读校验并取回文本（快路径，不持有长事务）。
  const staged = await withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx): Promise<{ text: string } | { statusCode: number; error: { code: string; message: string } }> => {
      const events = await tx.execute<{ payload: { segmentId: string; text: string } }>(
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
      if (event.payload.segmentId !== args.ref.segmentId) {
        return {
          statusCode: 400,
          error: { code: "INVALID_REQUEST", message: "segmentId mismatch" },
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
      return { text: event.payload.text };
    },
  );
  if ("error" in staged) {
    return staged;
  }
  // 第二阶段：事务外合成（edge-tts 外部 HTTP，默认 30s 超时）——避免在
  // DB 事务内同步调用外部服务导致长事务、连接池耗尽与锁放大。
  const result = await args.synthesize(staged.text, args.voice ?? "zh-CN-XiaoxiaoNeural");
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
    return {
      statusCode: 409,
      error: { code: "TURN_CANCELLED", message: "run is no longer playable" },
    };
  }
  return { statusCode: 200, audio: result.audio };
}
