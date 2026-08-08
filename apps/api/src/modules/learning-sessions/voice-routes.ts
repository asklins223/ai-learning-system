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

  // POST /voice/transcribe：ASR（后续接线点——multipart 上传管线 + SiliconFlow）。
  app.post("/voice/transcribe", { preHandler: [requireSession] }, async (_req, reply) => {
    return reply.code(501).send({
      error: "not_implemented_yet",
      message: "ASR 上传端点接线中：需要 transient 音频存储 + SiliconFlow 调用（救火 6 后续）",
    });
  });
}
