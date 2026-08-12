/**
 * 救火 6：Voice API 路由（审计 #5——Voice 只有接口无生产路由）。
 *
 * 端点（全部 requireSession）：
 * - POST /voice/tts  { text, voice? } → audio/mpeg（edge-tts 容器合成，真实朗读）
 * - POST /voice/transcribe：ASR 上传 → SiliconFlow → transcript
 *
 * 本文件打通「朗读」生产路径：cards 页 onReadAloud 调此端点返回 mp3，
 * 不再 console 桩。
 *
 * 安全（与 voice-service 对齐）：
 * - 文本经 assertSafeTtsInput 净化校验（SSML/URL/脚本拒绝）；
 * - 文本长度上限 2000（与 edge-tts 容器一致）；
 * - TTS provider 经 EDGE_TTS_BASE_URL 调 Docker 容器（带 X-Edge-TTS-Token）。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { Readable } from "node:stream";
import { requireSession } from "../identity/middleware.ts";
import { CompanionConversationError } from "../companion-conversation/turn-service.ts";
import { assertSafeTtsInput, DEFAULT_VOICE_PROFILE } from "./voice-service.ts";
import { edgeTtsSynthesize, edgeTtsSynthesizeStream, EdgeTtsError } from "./voice-providers/edge-tts.ts";
import { companionTtsRequestV1Schema, companionTtsStreamRequestV1Schema } from "@ailearn/shared";
import { siliconFlowTranscribe, SiliconFlowAsrError } from "./voice-providers/siliconflow-asr.ts";
import {
  COMPANION_RATE_LIMITS,
  companionRateLimit,
  companionRateLimitReply,
} from "../companion-conversation/companion-rate-limit.ts";

/** §6.10 Companion 语音限流（per (workspace,user)）。达限写 429 并返回 false。 */
function rateLimitVoice(reply: { code(statusCode: number): { send(body: unknown): unknown }; send(body: unknown): unknown }, requestId: string, key: string, limit: number, windowMs: number): boolean {
  const result = companionRateLimit({ key, limit, windowMs });
  if (result.allowed) return true;
  companionRateLimitReply(reply, requestId, result.retryAfterSeconds);
  return false;
}
import {
  synthesizeCompanionTtsSegment,
  transcribeCompanionDialogueAudio,
} from "./companion-voice-service.ts";

const ttsBodySchema = z.object({
  /** 净化题面纯文本（服务端再校验一次 SSML/URL/脚本） */
  text: z.string().min(1).max(2000),
  /** P3 legacy 朗读只允许已审核的固定 voice；扩展需新增 profile mapping。 */
  voice: z.literal("zh-CN-XiaoxiaoNeural").optional(),
});

const COMPANION_ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";

function multipartFieldValues(fields: Record<string, unknown> | undefined, name: string): unknown[] {
  const raw = fields?.[name];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => {
    if (value && typeof value === "object" && "value" in value) {
      return (value as { value?: unknown }).value;
    }
    return value;
  });
}

export function parseCompanionMultipartFields(fields: Record<string, unknown> | undefined):
  | { ok: true; language: "zh-CN"; durationMs: number }
  | { ok: false; message: string } {
  const keys = Object.keys(fields ?? {});
  // @fastify/multipart includes the selected file part in `part.fields` as
  // well as exposing it as `part.file`.  It is not a user-controlled scalar
  // contract field, but must be tolerated here or every correctly ordered
  // upload is rejected as `unknown multipart field: file`.
  const allowed = new Set(["purpose", "language", "durationMs", "file"]);
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown) return { ok: false, message: `unknown multipart field: ${unknown}` };

  const purposeValues = multipartFieldValues(fields, "purpose");
  const languageValues = multipartFieldValues(fields, "language");
  const durationValues = multipartFieldValues(fields, "durationMs");
  if (
    purposeValues.length !== 1 || purposeValues[0] !== "companion_dialogue" ||
    languageValues.length !== 1 || languageValues[0] !== "zh-CN" ||
    durationValues.length !== 1 || typeof durationValues[0] !== "string" ||
    !/^\d+$/.test(durationValues[0])
  ) {
    return { ok: false, message: "companion multipart requires purpose/language/durationMs" };
  }
  const durationMs = Number(durationValues[0]);
  if (!Number.isInteger(durationMs) || durationMs < 200 || durationMs > 60_000) {
    return { ok: false, message: "durationMs out of range" };
  }
  return { ok: true, language: "zh-CN", durationMs };
}

type AudioMagicKind = "wav" | "webm" | "ogg" | "mp4" | "mpeg";

function audioMagicKind(audio: Buffer): AudioMagicKind | null {
  if (audio.length >= 12 && audio.toString("ascii", 0, 4) === "RIFF" && audio.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (audio.length >= 4 && audio.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (audio.length >= 4 && audio.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (audio.length >= 8 && audio.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (audio.length >= 3 && audio.toString("ascii", 0, 3) === "ID3") return "mpeg";
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return "mpeg";
  return null;
}

export function audioMagicMatchesDeclaration(audio: Buffer, filename: string, mimetype: string): boolean {
  const kind = audioMagicKind(audio);
  if (!kind) return false;
  const normalizedMime = mimetype.split(";", 1)[0].toLowerCase();
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (normalizedMime === "application/octet-stream") {
    return (
      (kind === "wav" && extension === "wav") ||
      (kind === "webm" && extension === "webm") ||
      (kind === "ogg" && (extension === "ogg" || extension === "oga")) ||
      (kind === "mpeg" && (extension === "mp3" || extension === "mpeg")) ||
      (kind === "mp4" && (extension === "mp4" || extension === "m4a"))
    );
  }
  if (normalizedMime === "audio/wav" || normalizedMime === "audio/x-wav") return kind === "wav";
  if (normalizedMime === "audio/webm") return kind === "webm";
  if (normalizedMime === "audio/ogg") return kind === "ogg";
  if (normalizedMime === "audio/mpeg" || normalizedMime === "audio/mp3") return kind === "mpeg";
  if (normalizedMime === "audio/mp4" || normalizedMime === "audio/x-m4a") return kind === "mp4";
  return normalizedMime.startsWith("audio/");
}

function rejectDisabledCompanionVoice(reply: { code(statusCode: number): { send(body: unknown): unknown } }, flag: string): boolean {
  if (
    process.env.COMPANION_DIALOGUE_V1_ENABLED === "true" &&
    process.env[flag] === "true"
  ) return false;
  reply.code(404).send({
    version: 1,
    error: "NOT_FOUND",
    message: "not found",
    recoverable: false,
  });
  return true;
}

export async function voiceRoutes(app: FastifyInstance) {
  // P6 §13 POST /voice/tts/stream：句子级流式 TTS（chunked 透传，边收边播）。
  // 每稳定句一条独立流；generation/segmentId/ordinal 由客户端维持；打断时
  // 客户端 abort HTTP（上游连接中断）并递增 audio fence。
  app.post("/voice/tts/stream", { preHandler: [requireSession] }, async (req, reply) => {
    if (rejectDisabledCompanionVoice(reply, "COMPANION_STREAMING_VOICE_V1_ENABLED")) return;
    if (!rateLimitVoice(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:tts`, COMPANION_RATE_LIMITS.ttsPerMinute.limit, COMPANION_RATE_LIMITS.ttsPerMinute.windowMs)) return;
    const parsed = companionTtsStreamRequestV1Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST", code: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => i.path.join(".")).join(","),
      });
    }
    try {
      assertSafeTtsInput(parsed.data.text, DEFAULT_VOICE_PROFILE);
    } catch {
      return reply.code(400).send({
        error: "INVALID_REQUEST", code: "INVALID_REQUEST",
        message: "unsafe tts input",
      });
    }
    try {
      const result = await edgeTtsSynthesizeStream(
        parsed.data.text,
        parsed.data.voice ?? "",
        {
          baseUrl: process.env.EDGE_TTS_BASE_URL,
          // 2026-08-12（伴星语音设置）：语速随请求下发（服务端有默认）。
          ...(parsed.data.rate ? { rate: parsed.data.rate } : {}),
        },
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
        "Transfer-Encoding": "chunked",
      });
      const nodeStream = Readable.fromWeb(result.stream as unknown as import("node:stream/web").ReadableStream);
      nodeStream.on("error", () => reply.raw.destroy());
      nodeStream.pipe(reply.raw);
      req.raw.on("close", () => nodeStream.destroy()); // 打断 → abort 上游
    } catch (err) {
      if (err instanceof EdgeTtsError) {
        return reply.code(502).send({
          error: "TTS_FAILED", code: "TTS_FAILED",
          message: "edge-tts 流式合成失败（降级纯文字）", recoverable: true,
        });
      }
      throw err;
    }
  });

  // POST /voice/tts：朗读（TTS 合成 → mp3），经 edge-tts Docker 容器。
  // Companion branch（§11.3）：请求含 conversationId/runId/...（strict ref）时，重读
  // voice.segment.ready 事件验证后合成；否则走 legacy 朗读分支。
  app.post("/voice/tts", { preHandler: [requireSession] }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw === "object" && raw !== null && "conversationId" in raw) {
      if (rejectDisabledCompanionVoice(reply, "COMPANION_VOICE_DIALOGUE_V1_ENABLED")) return;
      const parsed = companionTtsRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST", code: "INVALID_REQUEST",
          message: parsed.error.issues.map((i) => i.path.join(".")).join(","),
        });
      }
      const session = req.session!;
      if (!rateLimitVoice(reply, req.id, `${session.workspaceId}:${session.userId}:tts`, COMPANION_RATE_LIMITS.ttsPerMinute.limit, COMPANION_RATE_LIMITS.ttsPerMinute.windowMs)) return;
      const result = await synthesizeCompanionTtsSegment({
        workspaceId: session.workspaceId,
        userId: session.userId,
        ref: {
          conversationId: parsed.data.conversationId,
          runId: parsed.data.runId,
          generation: parsed.data.generation,
          ordinal: parsed.data.ordinal,
          segmentId: parsed.data.segmentId,
        },
        synthesize: (text, voice) =>
          edgeTtsSynthesize(text, voice, { baseUrl: process.env.EDGE_TTS_BASE_URL }),
      });
      if (result.statusCode !== 200) {
        return reply.code(result.statusCode).send(result.error);
      }
      return reply
        .type("audio/mpeg")
        .header("Cache-Control", "no-store")
        .send(Buffer.from(result.audio as Uint8Array));
    }
    const body = parseBody(app, ttsBodySchema, req.body);
    // 净化校验（与 voice-service 的 assertSafeTtsInput 同语义：拒绝 SSML/URL/
    // 隐藏提示/非法 voice profile；DEFAULT_VOICE_PROFILE 通过 allowlist）。
    assertSafeTtsInput(body.text, DEFAULT_VOICE_PROFILE);
    try {
      const result = await edgeTtsSynthesize(body.text, body.voice ?? "zh-CN-XiaoxiaoNeural", {
        baseUrl: process.env.EDGE_TTS_BASE_URL,
      });
      return reply
        .type("audio/mpeg")
        .header("Cache-Control", "no-store")
        .send(Buffer.from(result.audio));
    } catch (err) {
      if (err instanceof EdgeTtsError) {
        // 只透出 code + 静态 message：EdgeTtsError.message 不含内部配置，
        // 但仍统一走静态文案，杜绝未来错误细节意外进入响应体。
        return reply.code(502).send({ error: err.code, message: "语音合成服务暂不可用，请稍后重试" });
      }
      throw err;
    }
  });

  // POST /voice/transcribe：ASR（救火 6b——multipart 音频上传 → SiliconFlow 识别）。
  // 请求：multipart/form-data，字段 file=<音频>（mp3/wav/m4a；SenseVoice 支持）。
  // 响应：{ text, asrProvider, asrModel }（逐字 transcript；ASR 失败 → 4xx/5xx fail closed）。
  app.post("/voice/transcribe", { preHandler: [requireSession] }, async (req, reply) => {
    if (!rateLimitVoice(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:asr`, COMPANION_RATE_LIMITS.asrPerMinute.limit, COMPANION_RATE_LIMITS.asrPerMinute.windowMs)) return;
    if (!rateLimitVoice(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:asr:hour`, COMPANION_RATE_LIMITS.asrPerHour.limit, COMPANION_RATE_LIMITS.asrPerHour.windowMs)) return;
    let part;
    try {
      part = await req.file();
    } catch (err) {
      // review should-fix：server.ts 全局 multipart fileSize=10MB——超限在
      // req.file()/流读抛 FST_REQ_FILE_TOO_LARGE；转 413 而非 500。
      const code = err instanceof Error ? (err as { code?: string }).code : undefined;
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE", message: "音频超过 10MB 上限" });
      }
      throw err;
    }
    if (part === undefined) {
      return reply.code(400).send({ error: "MISSING_AUDIO_FILE", code: "MISSING_AUDIO_FILE", message: "缺少 file 字段（音频）" });
    }
    const fields = part.fields as Record<string, unknown> | undefined;
    // 正式学习 branch 兼容历史请求：只有 Companion branch 采用严格字段合同。
    let language = "zh-CN";
    try {
      const values = multipartFieldValues(fields, "language");
      if (values.length === 1 && typeof values[0] === "string") language = values[0];
    } catch {
      // 字段解析异常——用缺省 language
    }
    // review nit：mimetype 校验（拒绝非音频，防伪装上传）
    const mimetype = part.mimetype ?? "";
    if (mimetype !== "" && !/^(audio|application\/octet-stream)/.test(mimetype)) {
      return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE", code: "UNSUPPORTED_MEDIA_TYPE", message: `不支持的内容类型 ${mimetype}` });
    }
    // review should-fix（防御性）：流读阶段超限同样抛 FST_REQ_FILE_TOO_LARGE——
    // 整块读取纳入同一 try/catch 转 413（非 500）。
    let audio: Buffer;
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of part.file) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
      audio = Buffer.concat(chunks);
    } catch (err) {
      const code = err instanceof Error ? (err as { code?: string }).code : undefined;
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "AUDIO_TOO_LARGE", code: "AUDIO_TOO_LARGE", message: "音频超过 10MB 上限" });
      }
      throw err;
    }
    if (audio.length === 0) {
      return reply.code(400).send({ error: "EMPTY_AUDIO", code: "EMPTY_AUDIO", message: "音频内容为空（fail closed）" });
    }
    const filename = part.filename || "audio-upload.mp3";
    if (!audioMagicMatchesDeclaration(audio, filename, mimetype || "audio/mpeg")) {
      return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE", code: "UNSUPPORTED_MEDIA_TYPE", message: "音频格式或 magic bytes 不匹配" });
    }
    // language 为日志元数据（SenseVoice 自动检测语言，无需传给 provider）
    void language;

    // P3：purpose=companion_dialogue → §11.2 Companion 分支（ffprobe duration 实测 +
    // pending voice artifact + §11.2 响应）；缺省 learning_session 走既有朗读路径。
    let purpose = "learning_session";
    try {
      const values = multipartFieldValues(fields, "purpose");
      if (values.length > 1 || (values.length === 1 && typeof values[0] !== "string")) {
        return reply.code(400).send({ error: "INVALID_REQUEST", code: "INVALID_REQUEST", message: "invalid purpose field" });
      }
      if (values.length === 1) purpose = values[0] as string;
    } catch {
      // purpose 字段解析异常 → learning_session
    }
    if (purpose === "companion_dialogue") {
      if (rejectDisabledCompanionVoice(reply, "COMPANION_VOICE_DIALOGUE_V1_ENABLED")) return;
      const companionFields = parseCompanionMultipartFields(fields);
      if (!companionFields.ok) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          code: "INVALID_REQUEST",
          message: companionFields.message,
        });
      }
      try {
        const result = await transcribeCompanionDialogueAudio({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          audio,
          filename,
          asrProvider: {
            transcribe: (buf, fn) => siliconFlowTranscribe(buf, fn, {
              apiKey: process.env.SILICONFLOW_API_KEY,
            }),
          },
          asrProviderName: "siliconflow",
          asrModel: COMPANION_ASR_MODEL,
          language: companionFields.language,
        });
        return reply
          .code(result.statusCode)
          .header("Cache-Control", "no-store")
          .send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({
            version: 1,
            error: err.code,
            message: err.message,
            recoverable: true,
            requestId: req.id,
          });
        }
        throw err;
      }
    }

    try {
      const result = await siliconFlowTranscribe(new Uint8Array(audio), filename, {
        apiKey: process.env.SILICONFLOW_API_KEY,
      });
      return reply.send({
        text: result.text,
        asrProvider: "siliconflow",
        asrModel: process.env.VOICE_ASR_MODEL ?? "FunAudioLLM/SenseVoiceSmall",
      });
    } catch (err) {
      if (err instanceof SiliconFlowAsrError) {
        // 只透出 code + 静态文案：SiliconFlowAsrError.message 可能含 provider
        // 网络细节/端点，不透出（与 edge-tts 分支同一 security 约定）。
        // code 字段必须携带：客户端 friendlyVoiceError 只按 data.code 归一化
        // （review 2026-08-12：502 缺 code → ASR 失败全落默认文案）。
        return reply.code(502).send({ error: err.code, code: err.code, message: "语音转写服务暂不可用，请稍后重试" });
      }
      throw err;
    }
  });
}
