/**
 * OpenAI 协议 TTS/ASR 兼容层（可切换自定义模型）。
 *
 * 需求：TTS 需兼容接入自定义语音模型，即 OpenAI 协议的 TTS 与 ASR 接口。
 * 本模块实现 OpenAI 协议的标准端点形状，任何提供
 *   - POST /v1/audio/speech         （TTS：{ model, input, voice } → audio/mpeg）
 *   - POST /v1/audio/transcriptions （ASR：multipart file+model → { text }）
 * 的服务（SiliconFlow、OpenAI、自建 edge-tts 容器、任意兼容服务）都可接入。
 *
 * 使用方式：在配置中指定 provider 类型为 openai_compatible，并给出
 * baseUrl/model（见 voice-providers/index.ts 工厂）。
 */

export interface OpenAiCompatibleTtsOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAiCompatibleAsrOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAiCompatibleTtsResult {
  audio: Uint8Array;
  contentType: string;
  model: string;
  voice: string;
}

export interface OpenAiCompatibleAsrResult {
  text: string;
  model: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

import { DomainError } from "@ailearn/shared";

export class OpenAiCompatibleError extends DomainError {
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super({ name: "OpenAiCompatibleError", code, message, statusCode: status });
    this.status = status;
  }
}

/**
 * OpenAI 协议 TTS：POST {baseUrl}/v1/audio/speech。
 */
export async function openAiCompatibleTts(
  text: string,
  options: OpenAiCompatibleTtsOptions,
): Promise<OpenAiCompatibleTtsResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new OpenAiCompatibleError("INVALID_ARGUMENT", "TTS 文本为空");
  }
  const baseUrl = options.baseUrl;
  if (!baseUrl) {
    throw new OpenAiCompatibleError("MISSING_BASE_URL", "openai_compatible TTS 未配置 baseUrl（fail closed）");
  }
  const model = options.model ?? "edge-tts";
  const voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: text, voice }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new OpenAiCompatibleError(
      "NETWORK_ERROR",
      `OpenAI 协议 TTS 不可达：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new OpenAiCompatibleError("UPSTREAM_ERROR", `OpenAI 协议 TTS HTTP ${response.status}`, response.status);
  }
  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new OpenAiCompatibleError("EMPTY_AUDIO", "OpenAI 协议 TTS 返回空音频");
  }
  return { audio, contentType, model, voice };
}

/** 净化上传文件名：剔除控制字符/引号/换行（防 multipart 注入，security_review MEDIUM） */
function sanitizeUploadFilename(raw: string): string {
  const cleaned = raw.replace(/[\r\n"\u0000-\u001f]/g, "").trim();
  if (cleaned === "") return "audio-upload.mp3";
  if (cleaned.length > 120) return `audio-${cleaned.slice(-80)}`;
  return cleaned;
}

/**
 * OpenAI 协议 ASR：POST {baseUrl}/v1/audio/transcriptions（multipart）。
 */
export async function openAiCompatibleAsr(
  audioBuffer: Uint8Array,
  filename: string,
  options: OpenAiCompatibleAsrOptions,
): Promise<OpenAiCompatibleAsrResult> {
  const baseUrl = options.baseUrl;
  if (!baseUrl) {
    throw new OpenAiCompatibleError("MISSING_BASE_URL", "openai_compatible ASR 未配置 baseUrl（fail closed）");
  }
  const model = options.model ?? "FunAudioLLM/SenseVoiceSmall";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const safeFilename = sanitizeUploadFilename(filename);

  const boundary = `----OpenAiCompatBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const encoder = new TextEncoder();
  const modelField = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
  );
  const fileHeader = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const fileFooter = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    modelField.length + fileHeader.length + audioBuffer.length + fileFooter.length,
  );
  body.set(modelField, 0);
  body.set(fileHeader, modelField.length);
  body.set(audioBuffer, modelField.length + fileHeader.length);
  body.set(fileFooter, modelField.length + fileHeader.length + audioBuffer.length);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new OpenAiCompatibleError(
      "NETWORK_ERROR",
      `OpenAI 协议 ASR 不可达：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new OpenAiCompatibleError("UPSTREAM_ERROR", `OpenAI 协议 ASR HTTP ${response.status}`, response.status);
  }
  const data = (await response.json()) as { text?: string };
  if (typeof data.text !== "string" || data.text.trim() === "") {
    throw new OpenAiCompatibleError("EMPTY_TRANSCRIPT", "OpenAI 协议 ASR 返回空 transcript");
  }
  return { text: data.text.trim(), model };
}
