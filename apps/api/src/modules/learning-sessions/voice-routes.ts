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
 * 安全：
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
import { setCompanionSegmentWarmHook } from "../companion-conversation/companion-events.ts";
import { assertSafeTtsInput, DEFAULT_VOICE_PROFILE } from "./voice-tts-policy.ts";
import { edgeTtsSynthesizeStream, EdgeTtsError } from "./voice-providers/edge-tts.ts";
import { stripVoiceExpressionTags } from "@ailearn/shared/voice-expression-tags";
import { qwenTtsSynthesizeStreamForUser, QwenTtsError } from "./voice-providers/qwen-tts.ts";
import { loadTtsEngineConfig } from "./voice-providers/tts-config.ts";
import { synthesizeTtsBytes } from "./voice-providers/tts-engine.ts";
import { takeWarmCompanionSegment, warmCompanionSegment } from "./companion-tts-warm.ts";
import { resolveTtsSelection, type ResolvedTtsSelection } from "./voice-providers/tts-preference.ts";
import {
  getStoredVoicePreference,
  setVoicePreference,
} from "../companion-shell/service.ts";
import {
  companionVoicePreferencePatchV1Schema,
} from "@ailearn/shared";
import { companionTtsStreamRequestV1Schema } from "@ailearn/shared";
import {
  companionVoicePlaybackOutcomeRequestV1Schema,
  companionVoiceSpeakSegmentRequestV2Schema,
} from "@ailearn/shared/companion-voice-contracts";
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
  recordCompanionTtsSynthOutcome,
  synthesizeCompanionTtsSegment,
  recordCompanionTtsPlaybackOutcome,
  transcribeCompanionDialogueAudio,
} from "./companion-voice-service.ts";

const ttsBodySchema = z.object({
  /** 净化题面纯文本（服务端再校验一次 SSML/URL/脚本） */
  text: z.string().min(1).max(2000),
  /** 朗读只允许已审核的固定 voice；扩展需新增 profile mapping。 */
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

/**
 * 一段的合成（qwen WS 优先 + edge 兜底）。
 *
 * 抽成模块级函数是因为它现在有**两个**调用点：客户端按需来取（`POST /voice/tts`
 * 的 companion 分支），以及服务端预热（`companion-tts-warm`）。两处必须逐字同一个
 * 实现——否则音色、降级链、失败归因会在两条路径上分叉，而"同一个问题在两个地方
 * 得到两个答案"正是这份方案一直在拆的东西。
 *
 * 语气/富语言标签是 qwen-audio 专属能力：qwen 原样传入（确定性语气层注入的
 * `[excited]` 等控制标签由它理解），edge 合成前在引擎内剥离。
 *
 * "倒下去的是哪个引擎"必须带回去：失败没有返回值，所以挂在异常上（见
 * CompanionTtsFailure）。判据用现成的信号——qwen 失败时一定先回调 onQwenFallback，
 * 回调响过就说明最后尝试的是 edge。不带这一笔的话 `companion_tts_outcomes.engine`
 * 只在成功时有值，报表里 "edge failed=0" 会和真实的 EdgeTtsError 同时成立。
 */
async function synthesizeCompanionSegmentBytes(args: {
  text: string;
  voice: string;
  selection: ResolvedTtsSelection;
  queueKey: string;
  log: { warn: (obj: unknown, msg: string) => void };
  ordinal: number;
}): Promise<{ audio: Uint8Array; engine: "qwen" | "edge" }> {
  let attempted: "qwen" | "edge" = "qwen";
  try {
    const r = await synthesizeTtsBytes({
      text: args.text,
      edgeVoice: args.voice,
      queueKey: args.queueKey,
      selection: args.selection,
      onQwenFallback: (error) => {
        attempted = "edge";
        args.log.warn({ err: error, ordinal: args.ordinal }, "qwen tts failed; falling back to edge-tts");
      },
    });
    return { audio: r.audio, engine: r.engine };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ttsEngine: attempted });
  }
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
      // 15b：TTS 引擎选择——请求显式 engine 优先，缺省用 config tts.engine（默认 qwen）。
      const engine = parsed.data.engine ?? loadTtsEngineConfig().engine;
      if (engine === "qwen") {
        const cfg = loadTtsEngineConfig().qwen;
        if (!cfg.workspaceId) {
          // 未配置业务空间 ID：不再直接 502，降级 edge（qwen 缺配置不该让语音消失）。
          req.log.warn("qwen tts workspaceId missing; falling back to edge-tts");
        } else {
          try {
            const result = await qwenTtsSynthesizeStreamForUser(
              `${req.session.workspaceId}:${req.session.userId}`,
              parsed.data.text,
              {
                workspaceId: cfg.workspaceId,
                apiKey: process.env.DASHSCOPE_API_KEY ?? "",
                model: cfg.model,
                // qwen 音色固定走 config（前端 voice 是 edge 音色，不混用）。
                voice: cfg.voice,
                format: cfg.format,
                sampleRate: cfg.sampleRate,
                // 15b 二期：指令控制（高质量声音描述，config tts.qwen.instruction）
                instruction: cfg.instruction,
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
            req.raw.on("close", () => nodeStream.destroy()); // 打断 → 关闭上游 WS
            return;
          } catch (err) {
            // 响应头尚未发出：qwen 任务失败（WS 抖动/限流）降级 edge 重合成，
            // 客户端拿到的仍是一段完整音频（2026-09-19 语音链路兜底）。
            req.log.warn({ err }, "qwen tts stream failed before headers; falling back to edge-tts");
          }
        }
      }
      // 2026-08-13（引擎兼容）：情感/富语言标签是 qwen-audio 专属能力——
      // edge-tts 会把 `[excited]` 等标签当普通文字朗读，合成前必须剥离。
      // （emotion 字段仍由 worker 解析下发，Live2D 表情与引擎无关。）
      const edgeText = stripVoiceExpressionTags(parsed.data.text);
      const result = await edgeTtsSynthesizeStream(
        edgeText,
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
      if (err instanceof EdgeTtsError || err instanceof QwenTtsError) {
        return reply.code(502).send({
          error: "TTS_FAILED", code: "TTS_FAILED",
          message: "语音合成失败（降级纯文字）", recoverable: true,
        });
      }
      throw err;
    }
  });

  // POST /voice/tts：朗读（TTS 合成 → mp3），经 edge-tts Docker 容器。
  // ─── 音色偏好与试听（设置 → 语音与伴星）───────────────────────────────
  //
  // 正文语音**不接受**请求体指定 engine/voice：那等于任何一段语音的实际音色由
  // 客户端说了算，也守不住"两个人听到的是同一身"。正文只按"这个账号存着什么"来选。

  /**
   * 合成侧解析当前账号该用哪一身。
   *
   * 读失败退回 config 默认而不是抛错：语音比"这一句恰好是用户选的那身"更要紧，
   * 一次库抖动不该让伴星没声音。设置页的读法故意不一样（见下面 GET，那里出错要
   * 让人看见并重试，不能把默认值演成用户的选择）。
   */
  async function resolveSelectionForSynthesis(
    session: { workspaceId: string; userId: string },
    log: { warn: (obj: unknown, msg: string) => void },
  ): Promise<ResolvedTtsSelection> {
    const cfg = loadTtsEngineConfig();
    try {
      const { stored } = await getStoredVoicePreference(session.userId, session.workspaceId);
      return resolveTtsSelection(stored, cfg);
    } catch (err) {
      log.warn({ err }, "tts voice preference unavailable; using config default");
      return resolveTtsSelection(null, cfg);
    }
  }

  /**
   * 段预热（方案 29 §14.11 修复 ③）：服务端把段事件推给客户端**之前**就把合成发出去。
   *
   * 为什么值得：合成原来只由客户端发起，于是"这一段该用什么声音"要等一个来回才开始算。
   * 预热让客户端来取时命中缓存（同一段仍然只合成一次，见 companion-tts-warm 的三条不变量）。
   *
   * 为什么挂在 SSE 上：那是服务端唯一"知道又有一段文本了"的时刻，而且它在推流之前。
   * 注册式而不是让 SSE 侧 import 本模块——那会成环（本模块已经反向依赖它）。
   */
  setCompanionSegmentWarmHook((scope, notices) => {
    void (async () => {
      // 一身到底：同一批段共用一次偏好解析（逐段读库既慢又可能在半途换音色）。
      const selection = await resolveSelectionForSynthesis(scope, app.log);
      for (const notice of notices) {
        warmCompanionSegment({
          userId: scope.userId,
          segmentId: notice.segmentId,
          run: () => synthesizeCompanionTtsSegment({
            workspaceId: scope.workspaceId,
            userId: scope.userId,
            ref: {
              conversationId: notice.conversationId,
              runId: notice.runId,
              generation: notice.generation,
              ordinal: notice.ordinal,
              segmentId: notice.segmentId,
            },
            // deferOutcome：预热先不落合成结果，等客户端真来取时补记（见 warm 模块注释）。
            deferOutcome: true,
            synthesize: (text, voice) => synthesizeCompanionSegmentBytes({
              text,
              voice,
              selection,
              queueKey: `${scope.workspaceId}:${scope.userId}`,
              log: app.log,
              ordinal: notice.ordinal,
            }),
          }),
        });
      }
    })().catch((err) => {
      app.log.debug({ err: err instanceof Error ? err.message : String(err) }, "companion tts warm batch failed");
    });
  });

  // GET /voice/preference — 这个账号的引擎与音色（未设置时回 config 默认并标 explicit:false）。
  app.get("/voice/preference", { preHandler: [requireSession] }, async (req) => {
    const session = req.session!;
    const { stored, updatedAt } = await getStoredVoicePreference(session.userId, session.workspaceId);
    const selection = resolveTtsSelection(stored, loadTtsEngineConfig());
    return {
      version: 1,
      engine: selection.engine,
      voice: selection.engine === "qwen" ? selection.qwenVoice : selection.edgeVoice,
      explicit: selection.explicit,
      updatedAt: selection.explicit ? updatedAt : null,
    };
  });

  // PATCH /voice/preference — 保存选择。engine 与 voice 的搭配由合同层白名单把关。
  app.patch("/voice/preference", { preHandler: [requireSession] }, async (req) => {
    const body = parseBody(app, companionVoicePreferencePatchV1Schema, req.body);
    const session = req.session!;
    await setVoicePreference(session.userId, session.workspaceId, body.engine, body.voice);
    return {
      version: 1,
      engine: body.engine,
      voice: body.voice,
      explicit: true,
      updatedAt: new Date().toISOString(),
    };
  });

  // Companion branch（§11.3）：请求含 conversationId/runId/...（strict ref）时，重读
  // voice.segment.ready 事件验证后合成；普通朗读请求直接走固定 profile。
  app.post("/voice/tts", { preHandler: [requireSession] }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw === "object" && raw !== null && "conversationId" in raw) {
      if (rejectDisabledCompanionVoice(reply, "COMPANION_VOICE_DIALOGUE_V1_ENABLED")) return;
      const parsed = companionVoiceSpeakSegmentRequestV2Schema.safeParse(raw);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST", code: "INVALID_REQUEST",
          message: parsed.error.issues.map((i) => i.path.join(".")).join(","),
        });
      }
      const session = req.session!;
      // 这一整轮分段朗读用同一身：逐段重读偏好会让一次回复里的各段音色不一致
      // （中途另一次会话改了设置就会出现），听起来像她忽男忽女。
      if (!rateLimitVoice(reply, req.id, `${session.workspaceId}:${session.userId}:tts`, COMPANION_RATE_LIMITS.ttsPerMinute.limit, COMPANION_RATE_LIMITS.ttsPerMinute.windowMs)) return;
      // 预热命中就直接给字节：这一段已经在服务端合成过（或正在合成），**不再合成第二遍**。
      // 命中只影响"谁来等这一次合成"，不影响鉴权、限流与审计（预热那条路自己记过 outcome）。
      const warmed = await takeWarmCompanionSegment(parsed.data.segmentId);
      if (warmed && warmed.statusCode === 200 && warmed.audio) {
        // 预热那一刻没记账（那时还没人要这段音频）。现在客户端真的来取了，
        // 才补一条 `stage='synth'`：耗时/引擎/字节数从缓存里带回来，读数不失真。
        await recordCompanionTtsSynthOutcome({
          workspaceId: session.workspaceId,
          userId: session.userId,
          ref: {
            conversationId: parsed.data.conversationId,
            runId: parsed.data.runId,
            generation: parsed.data.generation,
            ordinal: parsed.data.ordinal,
            segmentId: parsed.data.segmentId,
          },
          outcome: "ok",
          durationMs: warmed.deferred?.durationMs ?? 0,
          engine: warmed.deferred?.engine,
          bytes: warmed.deferred?.bytes,
        });
        return reply
          .type("audio/mpeg")
          .header("Cache-Control", "no-store")
          .send(Buffer.from(warmed.audio));
      }
      const selection = await resolveSelectionForSynthesis(session, req.log);
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
        synthesize: (text, voice) => synthesizeCompanionSegmentBytes({
          text,
          voice,
          selection,
          queueKey: `${session.workspaceId}:${session.userId}`,
          log: req.log,
          ordinal: parsed.data.ordinal,
        }),
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
    // 2026-09 后端审查修复：普通朗读此前**完全没有限流**（只有 companion
    // 分支有），任何已认证用户可无界驱动共享 edge-tts 容器的合成调用，挤占
    // 所有用户的语音通道。与 companion 分支/transcribe/tts-stream 保持一致。
    if (!rateLimitVoice(reply, req.id, `${req.session!.workspaceId}:${req.session!.userId}:tts`, COMPANION_RATE_LIMITS.ttsPerMinute.limit, COMPANION_RATE_LIMITS.ttsPerMinute.windowMs)) return;
    // 净化校验（拒绝 SSML/URL/
    // 隐藏提示/非法 voice profile；DEFAULT_VOICE_PROFILE 通过 allowlist）。
    assertSafeTtsInput(body.text, DEFAULT_VOICE_PROFILE);
    try {
      // 2026-09-19 语音链路改造：普通朗读也走「qwen WS 优先 + edge 兜底」——
      // 此前硬编码 edge 容器 HTTP（实测每段 2.3–2.5s），桌面伴星的语音完全
      // 够不着 qwen WebSocket 引擎。
      const result = await synthesizeTtsBytes({
        text: body.text,
        edgeVoice: body.voice ?? "zh-CN-XiaoxiaoNeural",
        queueKey: `${req.session!.workspaceId}:${req.session!.userId}`,
        selection: await resolveSelectionForSynthesis(req.session!, req.log),
        onQwenFallback: (error) => req.log.warn({ err: error }, "qwen tts failed; falling back to edge-tts"),
      });
      return reply
        .type(result.contentType)
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

  // POST /voice/tts/playback-outcome：客户端把"这一段到底播没播成"送回 0246 那张表。
  //
  // 为什么单独一个端点而不是塞进 /voice/tts 的响应：合成请求那一侧永远不知道自己被
  // 等超时了没有（客户端的截止先到时，服务端还在合成），而"她经常没声音"要能回答，
  // 缺的正是这一句。上报失败不影响朗读（客户端只 fire-and-forget），但结果体仍要按
  // 合同返回——客户端拿它判定这一段的账有没有记上。
  app.post("/voice/tts/playback-outcome", { preHandler: [requireSession] }, async (req, reply) => {
    // 判定方向别写反：这个 helper 在**功能开着**时返回 false。写成 `!helper()` 的
    // 话处理器会在任何校验之前 `return;`，而 Fastify 把"返回 undefined"当成
    // **200 空响应**——实机就是这样静默吞掉了每一条上报，表里一行都没有，接口却全绿。
    if (rejectDisabledCompanionVoice(reply, "COMPANION_VOICE_DIALOGUE_V1_ENABLED")) return;
    const parsed = companionVoicePlaybackOutcomeRequestV1Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST", code: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => i.path.join(".")).join(","),
      });
    }
    const session = req.session!;
    // 与合成同一配额：一段一条，重试多出来的那几条本来也该被同一扇门挡住。
    if (!rateLimitVoice(reply, req.id, `${session.workspaceId}:${session.userId}:tts`, COMPANION_RATE_LIMITS.ttsPerMinute.limit, COMPANION_RATE_LIMITS.ttsPerMinute.windowMs)) return;
    await recordCompanionTtsPlaybackOutcome({
      workspaceId: session.workspaceId,
      userId: session.userId,
      ref: {
        conversationId: parsed.data.conversationId,
        runId: parsed.data.runId,
        generation: parsed.data.generation,
        ordinal: parsed.data.ordinal,
        segmentId: parsed.data.segmentId,
      },
      // 只传 reason：outcome 的映射在 service 里一处完成（两个字段都由客户端报，
      // 就会造出 reason/outcome 互相矛盾的行）。
      reason: parsed.data.reason,
      durationMs: parsed.data.durationMs,
    });
    return reply.code(200).send({ version: 1, recorded: true });
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
    // review nit：mimetype 校验（拒绝非音频，防伪装上传）
    const mimetype = part.mimetype ?? "";
    if (mimetype !== "" && !/^(audio|application\/octet-stream)/.test(mimetype)) {
      // PERF-B4/N1 修复：早返回前排空 multipart 的 body 流，避免请求体未读完
      // 导致连接无法干净 keep-alive 复用 / socket 挂起。
      part.file.resume();
      return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE", code: "UNSUPPORTED_MEDIA_TYPE", message: `不支持的内容类型 ${mimetype}` });
    }
    // review should-fix（防御性）：流读阶段超限同样抛 FST_REQ_FILE_TOO_LARGE——
    // 整块读取纳入同一 try/catch 转 413（非 500）。
    // 轻微·19（round-4）：音频整体入内存经 Buffer.concat 组装。保持现状并标注——
    // ① hard 10MB/请求 + 60s 速率上限使内存峰值有界（~2× 体积）；
    // ② audioMagicMatchesDeclaration 需完整 buffer 做 magic-byte 校验，且对象存储
    // 上传需一次性 body；改流式消费需在上传中途校验 magic 并处理"已上传一半但类型
    // 不匹配"的回滚，复杂度与风险明显高于受 10MB 上限约束的整块读。故维持整块读。
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
    // P3：purpose=companion_dialogue → §11.2 Companion 分支（ffprobe duration 实测 +
    // pending voice artifact + §11.2 响应）；缺省 voice_transcription 走既有朗读路径。
    let purpose = "voice_transcription";
    try {
      const values = multipartFieldValues(fields, "purpose");
      if (values.length > 1 || (values.length === 1 && typeof values[0] !== "string")) {
        return reply.code(400).send({ error: "INVALID_REQUEST", code: "INVALID_REQUEST", message: "invalid purpose field" });
      }
      if (values.length === 1) purpose = values[0] as string;
    } catch {
      // purpose 字段解析异常 → voice_transcription
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
