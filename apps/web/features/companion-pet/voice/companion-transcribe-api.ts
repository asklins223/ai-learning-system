/**
 * P6 §13：云端文件转写 API（/voice/transcribe）。
 *
 * - P3 文件式路径与 P6 streaming 的 siliconflow_file 降级共用；
 * - API Key 始终留服务端（Electron 不持有）；上传前一次性告知由上层负责；
 * - 返回文本 + 服务端 Voice Artifact provenance；本地 ASR 成功后不调用本模块。
 */

import { getCsrfToken } from "@/lib/api";

export interface TranscribeCompanionAudioOptions {
  blob: Blob;
  durationMs: number;
  uploadId: string;
  signal?: AbortSignal;
}

export type TranscribeCompanionAudioResult =
  | { ok: true; text: string; voiceArtifactId: string; transcriptSha256: string }
  | { ok: false; error: string };

export async function transcribeCompanionAudio(
  options: TranscribeCompanionAudioOptions,
): Promise<TranscribeCompanionAudioResult> {
  const extension = options.blob.type.includes("mp4")
    ? "m4a"
    : options.blob.type.includes("ogg")
      ? "ogg"
      : "webm";
  const form = new FormData();
  // Fastify multipart 只暴露出现在 file part 之前的字段——固定 Companion
  // 契约保持可见，避免静默回落到 legacy learning-session ASR 分支。
  form.append("purpose", "companion_dialogue");
  form.append("language", "zh-CN");
  form.append("durationMs", String(options.durationMs));
  form.append("file", options.blob, `companion-${options.uploadId}.${extension}`);
  const csrfToken = getCsrfToken();
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    credentials: "same-origin",
    ...(csrfToken ? { headers: { "x-csrf-token": csrfToken } } : {}),
    body: form,
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => null)) as {
    version?: number;
    text?: string;
    voiceArtifactId?: string;
    transcriptSha256?: string;
    asrProvider?: string;
    asrModel?: string;
    language?: string;
    durationMs?: number;
    expiresAt?: string;
    error?: string;
  } | null;
  if (
    !response.ok ||
    body?.version !== 1 ||
    !body.text?.trim() ||
    !body.voiceArtifactId ||
    !body.transcriptSha256 ||
    body.asrProvider !== "siliconflow" ||
    body.asrModel !== "FunAudioLLM/SenseVoiceSmall" ||
    body.language !== "zh-CN" ||
    !(typeof body?.durationMs === "number" && Number.isInteger(body.durationMs) && body.durationMs >= 200 && body.durationMs <= 60_000) ||
    !body.expiresAt
  ) {
    return { ok: false, error: body?.error ?? "ASR_FAILED" };
  }
  return {
    ok: true,
    text: body.text,
    voiceArtifactId: body.voiceArtifactId,
    transcriptSha256: body.transcriptSha256,
  };
}
