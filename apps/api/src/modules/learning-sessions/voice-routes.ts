/**
 * 救火 6：Voice API 路由（审计 #5——Voice 只有接口无生产路由）。
 *
 * 端点（全部 requireSession）：
 * - POST /voice/tts  { text, voice? } → audio/mpeg（edge-tts 容器合成，真实朗读）
 * - POST /voice/transcribe（后续：ASR 上传 → SiliconFlow → transcript，501 接线点）
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
import { requireSession } from "../identity/middleware.ts";
import { assertSafeTtsInput, DEFAULT_VOICE_PROFILE } from "./voice-service.ts";
import { edgeTtsSynthesize, EdgeTtsError } from "./voice-providers/edge-tts.ts";
import { siliconFlowTranscribe, SiliconFlowAsrError } from "./voice-providers/siliconflow-asr.ts";

const ttsBodySchema = z.object({
  /** 净化题面纯文本（服务端再校验一次 SSML/URL/脚本） */
  text: z.string().min(1).max(2000),
  /** 可选 voice（edge-tts id；缺省 env.ttsVoice / zh-CN-XiaoxiaoNeural） */
  voice: z.string().min(1).max(64).optional(),
});

export async function voiceRoutes(app: FastifyInstance) {
  // POST /voice/tts：朗读（TTS 合成 → mp3），经 edge-tts Docker 容器。
  app.post("/voice/tts", { preHandler: [requireSession] }, async (req, reply) => {
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
        return reply.code(502).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // POST /voice/transcribe：ASR（救火 6b——multipart 音频上传 → SiliconFlow 识别）。
  // 请求：multipart/form-data，字段 file=<音频>（mp3/wav/m4a；SenseVoice 支持）。
  // 响应：{ text, asrProvider, asrModel }（逐字 transcript；ASR 失败 → 4xx/5xx fail closed）。
  app.post("/voice/transcribe", { preHandler: [requireSession] }, async (req, reply) => {
    const part = await req.file();
    if (part === undefined) {
      return reply.code(400).send({ error: "MISSING_AUDIO_FILE", message: "缺少 file 字段（音频）" });
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of part.file) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const audio = Buffer.concat(chunks);
    if (audio.length === 0) {
      return reply.code(400).send({ error: "EMPTY_AUDIO", message: "音频内容为空（fail closed）" });
    }
    // 音频大小上限 25MB（SenseVoice 常见输入）
    if (audio.length > 25 * 1024 * 1024) {
      return reply.code(413).send({ error: "AUDIO_TOO_LARGE", message: "音频超过 25MB 上限" });
    }
    const filename = part.filename || "audio-upload.mp3";
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
        return reply.code(502).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
