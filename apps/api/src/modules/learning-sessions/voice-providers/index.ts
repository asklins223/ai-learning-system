/**
 * 语音 Provider 工厂：把真实 ASR/TTS 提供方适配为 voice-service 的可注入接口
 * （TtsProvider.synthesize / AsrProvider.transcribe）。
 *
 * 配置（环境变量）：
 * - ASR：
 *   - VOICE_ASR_PROVIDER=siliconflow（默认）→ SiliconFlow /v1/audio/transcriptions
 *   - VOICE_ASR_PROVIDER=openai_compatible → 自定义 OpenAI 协议 ASR
 *   - VOICE_ASR_BASE_URL / VOICE_ASR_MODEL / VOICE_ASR_API_KEY（openai_compatible 覆盖）
 * - TTS：
 *   - VOICE_TTS_PROVIDER=edge_tts（默认，Docker 容器）→ POST /v1/audio/speech
 *   - VOICE_TTS_PROVIDER=openai_compatible → 自定义 OpenAI 协议 TTS
 *   - EDGE_TTS_BASE_URL（容器地址） / VOICE_TTS_BASE_URL / VOICE_TTS_MODEL / VOICE_TTS_VOICE
 *
 * 安全：API key 缺省 fail closed；服务端错误细节不透出 UI（上层 friendly 错误映射）。
 */

import type {
  AsrProvider,
  AsrTranscriptionRequest,
  AsrTranscriptionResult,
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../voice-service.ts";
import { siliconFlowTranscribe } from "./siliconflow-asr.ts";
import { edgeTtsSynthesize } from "./edge-tts.ts";
import {
  openAiCompatibleAsr,
  openAiCompatibleTts,
} from "./openai-compatible.ts";

// ─── 类型 ────────────────────────────────────────────────────────────────

export type VoiceAsrProviderKind = "siliconflow" | "openai_compatible";
export type VoiceTtsProviderKind = "edge_tts" | "openai_compatible";

export interface VoiceProviderEnv {
  asrProvider?: string;
  asrBaseUrl?: string;
  asrModel?: string;
  asrApiKey?: string;
  ttsProvider?: string;
  ttsBaseUrl?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsApiKey?: string;
  edgeTtsBaseUrl?: string;
  /** 测试注入 fetch（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

/** 从环境变量读取 provider 配置（测试可注入 env 覆盖） */
export function resolveVoiceProviderEnv(env: NodeJS.ProcessEnv = process.env): VoiceProviderEnv {
  return {
    asrProvider: env.VOICE_ASR_PROVIDER ?? "siliconflow",
    asrBaseUrl: env.VOICE_ASR_BASE_URL,
    asrModel: env.VOICE_ASR_MODEL,
    asrApiKey: env.VOICE_ASR_API_KEY ?? env.SILICONFLOW_API_KEY,
    ttsProvider: env.VOICE_TTS_PROVIDER ?? "edge_tts",
    ttsBaseUrl: env.VOICE_TTS_BASE_URL,
    ttsModel: env.VOICE_TTS_MODEL,
    ttsVoice: env.VOICE_TTS_VOICE,
    ttsApiKey: env.VOICE_TTS_API_KEY,
    edgeTtsBaseUrl: env.EDGE_TTS_BASE_URL,
  };
}

// ─── ASR provider ────────────────────────────────────────────────────────

/** SiliconFlow ASR 适配为 AsrProvider（audioRef 由上层解析为字节 + 文件名） */
export interface AsrAudioSource {
  /** 音频字节（来自 transient 上传管线） */
  buffer: Uint8Array;
  /** 原始文件名（推断 MIME） */
  filename: string;
}

export function createAsrProvider(
  env: VoiceProviderEnv = resolveVoiceProviderEnv(),
  resolveAudio?: (request: AsrTranscriptionRequest) => Promise<AsrAudioSource>,
): AsrProvider {
  return {
    async transcribe(request: AsrTranscriptionRequest): Promise<AsrTranscriptionResult> {
      if (!resolveAudio) {
        throw new Error("ASR audio resolver 未注入（fail closed）");
      }
      const audio = await resolveAudio(request);
      if (env.asrProvider === "openai_compatible") {
        const result = await openAiCompatibleAsr(audio.buffer, audio.filename, {
          baseUrl: env.asrBaseUrl,
          apiKey: env.asrApiKey,
          model: env.asrModel ?? "FunAudioLLM/SenseVoiceSmall",
          fetchImpl: env.fetchImpl,
        });
        return {
          transcript: result.text,
          segments: [],
          lowConfidenceTokens: [],
          asrProvider: "openai_compatible",
          asrModel: result.model,
          asrVersion: "openai-compatible-v1",
        };
      }
      // 默认 siliconflow
      const result = await siliconFlowTranscribe(audio.buffer, audio.filename, {
        apiKey: env.asrApiKey,
        model: env.asrModel,
        baseUrl: env.asrBaseUrl,
        fetchImpl: env.fetchImpl,
      });
      return {
        transcript: result.text,
        segments: [],
        lowConfidenceTokens: [],
        asrProvider: "siliconflow",
        asrModel: env.asrModel ?? "FunAudioLLM/SenseVoiceSmall",
        asrVersion: "tele-speech-v1",
      };
    },
  };
}

// ─── TTS provider ────────────────────────────────────────────────────────

/** TTS 音频落盘解析器：把合成音频写入 transient 存储，返回 audioRef */
export interface TtsAudioSink {
  (audio: Uint8Array, contentType: string, request: TtsSynthesisRequest): Promise<{ audioRef: string; audioHash: string; expiresAt: string }>;
}

export function createTtsProvider(
  env: VoiceProviderEnv = resolveVoiceProviderEnv(),
  sink?: TtsAudioSink,
): TtsProvider {
  return {
    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      if (!sink) {
        throw new Error("TTS audio sink 未注入（fail closed）");
      }
      let audio: Uint8Array;
      let contentType = "audio/mpeg";
      // voiceProfile 是内部 profile id（companion-default-v1，仅上层 allowlist 校验），
      // 不能直传为 TTS voice id（review 阻塞 bug 修复）：provider voice 由
      // env.ttsVoice 或默认 zh-CN-XiaoxiaoNeural 决定。
      const ttsVoice = env.ttsVoice || "zh-CN-XiaoxiaoNeural";
      if (env.ttsProvider === "openai_compatible") {
        const result = await openAiCompatibleTts(request.text, {
          baseUrl: env.ttsBaseUrl,
          apiKey: env.ttsApiKey,
          model: env.ttsModel ?? "edge-tts",
          voice: ttsVoice,
          fetchImpl: env.fetchImpl,
        });
        audio = result.audio;
        contentType = result.contentType;
      } else {
        // 默认 edge_tts（Docker 容器）
        const result = await edgeTtsSynthesize(request.text, ttsVoice, {
          baseUrl: env.edgeTtsBaseUrl,
          fetchImpl: env.fetchImpl,
        });
        audio = result.audio;
        contentType = result.contentType;
      }
      const stored = await sink(audio, contentType, request);
      return {
        audioRef: stored.audioRef,
        audioHash: stored.audioHash,
        expiresAt: stored.expiresAt,
      };
    },
  };
}
