/**
 * P6 §13：renderer 侧本地 ASR client（经 typed preload 的 window.asrAPI）。
 *
 * - browser fallback / asrAPI 缺失 → capability { available: false }，
 *   上层走 siliconflow_file / text_only 降级；
 * - probe / recognize 的响应按 shared schema 校验（fail-closed）；
 * - 本模块不持有模型路径（main 侧 resolveAsrModelConfig 注入）。
 */

import {
  asrProbeResponseV1Schema,
  asrRecognizeResponseV1Schema,
  asrRuntimeCapabilityV1Schema,
  type AsrRuntimeCapabilityV1,
  type DesktopAsrApiV1,
} from "@ailearn/shared/companion-asr-contracts";

export interface LocalAsrClientV1 {
  getCapability(): Promise<AsrRuntimeCapabilityV1>;
  /** 性能探测：加载模型 + 内置测试音频；失败返回 { ok: false } */
  probe(testAudio: Float32Array): Promise<{ ok: true; probe: { coldStartMs: number; warmRtf: number } } | { ok: false; error: string }>;
  /** 识别一段 16kHz mono PCM；失败返回 { ok: false, recoverable } */
  recognize(
    pcm: Float32Array,
  ): Promise<{ ok: true; text: string; elapsedMs: number } | { ok: false; error: string; recoverable: boolean }>;
  /** 释放模型与 worker */
  dispose(): Promise<void>;
  /** 2026-08-12：录音前确保 macOS 麦克风权限（Electron 主进程 askForMediaAccess） */
  ensurePermission(): Promise<{ granted: boolean; status: string }>;
}

function readAsrApi(): DesktopAsrApiV1 | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { asrAPI?: DesktopAsrApiV1 }).asrAPI;
  return api ?? null;
}

export function createLocalAsrClient(api?: DesktopAsrApiV1): LocalAsrClientV1 {
  const resolved = api ?? readAsrApi();
  if (!resolved) {
    return {
      getCapability: async () => ({ available: false, reason: "no-electron" }),
      probe: async () => ({ ok: false, error: "local_asr_unavailable" }),
      recognize: async () => ({ ok: false, error: "local_asr_unavailable", recoverable: true }),
      dispose: async () => undefined,
      ensurePermission: async () => ({ granted: true, status: "browser" }),
    };
  }
  return {
    async getCapability() {
      const raw = await resolved.getCapability();
      const parsed = asrRuntimeCapabilityV1Schema.safeParse(raw);
      return parsed.success ? parsed.data : { available: false, reason: "no-electron" };
    },
    async probe(testAudio) {
      const raw = await resolved.probe(testAudio);
      const parsed = asrProbeResponseV1Schema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "invalid_asr_probe_response" };
      if (!parsed.data.ok) return { ok: false, error: parsed.data.error };
      return {
        ok: true,
        probe: {
          coldStartMs: parsed.data.probe.coldStartMs,
          warmRtf: parsed.data.probe.warmRtf,
        },
      };
    },
    async recognize(pcm) {
      const raw = await resolved.recognize(pcm, 16000);
      const parsed = asrRecognizeResponseV1Schema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "invalid_asr_recognize_response", recoverable: true };
      if (!parsed.data.ok) return { ok: false, error: parsed.data.error, recoverable: parsed.data.recoverable };
      return { ok: true, text: parsed.data.text, elapsedMs: parsed.data.elapsedMs };
    },
    async dispose() {
      await resolved.dispose();
    },
    async ensurePermission() {
      const raw = await resolved.ensurePermission();
      return { granted: raw.granted === true, status: raw.status };
    },
  };
}
