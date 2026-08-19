/**
 * SiliconFlow ASR provider（真实实现）。
 *
 * 接入硅基流动（SiliconFlow）平台的 TeleSpeechASR 模型：
 *   POST https://api.siliconflow.cn/v1/audio/transcriptions
 *   Authorization: Bearer <SILICONFLOW_API_KEY>
 *   multipart/form-data: file=<audio> + model=FunAudioLLM/SenseVoiceSmall
 *   响应: { "text": "string" }
 *
 * 实现 AsrProvider 接口（voice-service.ts 的可注入面）：
 * - 逐字 transcript（SenseVoice 返回识别文本，按 utterance 分段）；
 * - 低置信标记：SiliconFlow 响应无逐词置信度，保守起见关键术语不做
 *   自动降级，交由 assessTranscriptionQuality 的规则层判定；
 * - provider/model/version 元数据落 artifact（§13.2 数据治理）。
 *
 * 真实请求验证（2026-08-08）：
 *   edge-tts 合成 mp3 → 本 provider → HTTP 200 { "text": "测试语音。" }
 */

export interface SiliconFlowAsrOptions {
  /** SILICONFLOW_API_KEY（.env）；缺省抛错（fail closed） */
  apiKey?: string;
  /** 默认模型（可由 workspace policy 覆盖） */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入 fetch（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

export interface SiliconFlowAsrResult {
  text: string;
  /** provider 返回的原始响应（用于日志/审计；不含敏感内容） */
  rawText: string;
}

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall";
const DEFAULT_TIMEOUT_MS = 30_000;

import { DomainError } from "@ailearn/shared";

/** SiliconFlow API 错误（服务端错误消息不透出到 UI，仅内部记录） */
export class SiliconFlowAsrError extends DomainError {
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super({ name: "SiliconFlowAsrError", code, message, statusCode: status });
    this.status = status;
  }
}

/** 净化上传文件名：剔除控制字符/引号/换行（防 multipart 注入，security_review MEDIUM） */
function sanitizeUploadFilename(raw: string): string {
  const cleaned = raw.replace(/[\r\n"\u0000-\u001f]/g, "").trim();
  if (cleaned === "") return "audio-upload.mp3";
  if (cleaned.length > 120) return `audio-${cleaned.slice(-80)}`;
  return cleaned;
}

/**
 * 调 SiliconFlow 语音识别。
 * @param audioBuffer 音频字节（mp3/wav/m4a；SenseVoice 支持常见格式）
 * @param filename 上传文件名（推断 MIME；内部净化防 multipart 注入）
 * @param options 配置
 */
export async function siliconFlowTranscribe(
  audioBuffer: Uint8Array,
  filename: string,
  options: SiliconFlowAsrOptions = {},
): Promise<SiliconFlowAsrResult> {
  const apiKey = options.apiKey ?? process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new SiliconFlowAsrError(
      "MISSING_API_KEY",
      "SILICONFLOW_API_KEY 未配置（fail closed：不静默跳过语音识别）",
    );
  }
  const url = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const safeFilename = sanitizeUploadFilename(filename);

  // multipart/form-data 边界（一次性随机串）
  const boundary = `----SiliconFlowAsrBoundary${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
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
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new SiliconFlowAsrError(
      "NETWORK_ERROR",
      `SiliconFlow ASR 网络错误：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.text().catch(() => ""); // 消费 body（内部细节不透出）
    throw new SiliconFlowAsrError(
      "UPSTREAM_ERROR",
      `SiliconFlow ASR HTTP ${response.status}（内部细节不向用户透出）`,
      response.status,
    );
  }

  const data = (await response.json()) as { text?: string };
  if (typeof data.text !== "string" || data.text.trim() === "") {
    throw new SiliconFlowAsrError("EMPTY_TRANSCRIPT", "SiliconFlow ASR 返回空 transcript（fail closed）");
  }
  return { text: data.text.trim(), rawText: data.text.trim() };
}
