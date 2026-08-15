/**
 * 学习卡练习语音转写：本地优先 + 云端兜底（方案 16 §7.5）。
 *
 * 路由（与桌宠 P6 §13 同一合同，文件式）：
 * - 桌面端（window.asrAPI 可用）：静态兼容 + 真实性能探测通过 →
 *   本地 sherpa-onnx SenseVoice 识别（16kHz mono PCM）；
 * - 本地不可用/探测失败/识别失败 → 云端 /voice/transcribe（SiliconFlow
 *   SenseVoice，AI 协议已签署即视为已同意上传）；
 * - 浏览器（无 asrAPI）→ 直接云端。
 *
 * 永不注入演示文本：任何失败都向上抛错，由 UI 提示重录或换文字。
 */

import { createLocalAsrClient } from "../../companion-pet/voice/companion-asr-client";
import {
  buildStaticCompatInput,
} from "../../companion-pet/voice/companion-streaming-asr-runtime";
import { decideAsrRoute } from "../../companion-pet/voice/companion-asr-router";
import { downsampleTo16k } from "../../companion-pet/voice/companion-audio-worklet";
import { transcribePlain } from "@/lib/learning-companion/voice-api";

/** 内置性能探测测试音频（3s @16k 1kHz 正弦，与桌宠同款）。 */
export const BUILTIN_ASR_TEST_AUDIO: Float32Array = (() => {
  const length = 16000 * 3;
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    arr[i] = Math.sin((2 * Math.PI * 1000 * i) / 16000) * 0.05;
  }
  return arr;
})();

export interface VoiceTranscribeResult {
  text: string;
  route: "local_sensevoice" | "cloud_siliconflow";
}

/** Blob（webm/mp4/ogg）→ 16kHz mono Float32 PCM（本地模型输入）。 */
export async function decodeBlobTo16kPcm(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    // 单声道化：多声道取平均。
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) {
        sum += decoded.getChannelData(c)[i] ?? 0;
      }
      mono[i] = sum / Math.max(1, channels);
    }
    // 44.1k/48k → 16k（downsampleTo16k 内处理整数倍与线性插值）。
    return downsampleTo16k(mono, decoded.sampleRate);
  } finally {
    void audioContext.close();
  }
}

export interface LocalFirstTranscribeDeps {
  getCapability(): Promise<{ available: boolean; arch?: string | null }>;
  probe(testAudio: Float32Array): Promise<
    { ok: true; probe: { coldStartMs: number; warmRtf: number } } | { ok: false; error: string }
  >;
  recognize(pcm: Float32Array): Promise<
    { ok: true; text: string } | { ok: false; error: string; recoverable: boolean }
  >;
  decode(blob: Blob): Promise<Float32Array>;
  cloudTranscribe(blob: Blob): Promise<{ text: string }>;
  testAudio?: Float32Array;
}

function defaultDeps(): LocalFirstTranscribeDeps {
  const client = createLocalAsrClient();
  return {
    getCapability: () => client.getCapability(),
    probe: (testAudio) => client.probe(testAudio),
    recognize: (pcm) => client.recognize(pcm),
    decode: decodeBlobTo16kPcm,
    cloudTranscribe: (blob) => transcribePlain(blob, { language: "zh-CN" }),
    testAudio: BUILTIN_ASR_TEST_AUDIO,
  };
}

/**
 * 本地优先转写（依赖注入版本，可测）。本地失败抛错前先尝试云端；
 * 云端也失败才抛出。
 */
export async function transcribeVoiceLocalFirstWith(
  blob: Blob,
  deps: LocalFirstTranscribeDeps,
): Promise<VoiceTranscribeResult> {
  const capability = await deps.getCapability();

  if (capability.available) {
    // 静态兼容 + 真实探测（与桌宠同一 Gate：冷启动 ≤3s、warm RTF ≤0.5）。
    const staticInput = buildStaticCompatInput(
      capability.arch ?? undefined,
      true,
      true,
    );
    const probeResult = await deps.probe(deps.testAudio ?? BUILTIN_ASR_TEST_AUDIO);
    const route = probeResult.ok
      ? decideAsrRoute({
          staticInput,
          probe: {
            coldStartMs: probeResult.probe.coldStartMs,
            warmRtf: probeResult.probe.warmRtf,
            peakMemoryDeltaMB: 0,
            modelCrashed: false,
            sustainedSlow: false,
            modelLoadFailed: false,
          },
          siliconFlowAvailable: true,
          userConsentedCloud: true,
        })
      : "siliconflow_file";

    if (route === "local_streaming") {
      try {
        const pcm = await deps.decode(blob);
        const recognized = await deps.recognize(pcm);
        if (recognized.ok && recognized.text.trim()) {
          return { text: recognized.text.trim(), route: "local_sensevoice" };
        }
        // 本地识别空文本/失败 → 云端兜底（不抛）。
      } catch {
        // 解码失败（损坏音频等）→ 云端兜底（provider 会再次拒绝并返回明确错误）。
      }
    }
  }

  // 云端兜底（浏览器环境 / 本地 Gate 未过 / 本地识别失败）。
  const result = await deps.cloudTranscribe(blob);
  return { text: result.text.trim(), route: "cloud_siliconflow" };
}

/** 生产入口：window.asrAPI 本地优先，缺失时云端兜底。 */
export function transcribeVoiceLocalFirst(blob: Blob): Promise<VoiceTranscribeResult> {
  return transcribeVoiceLocalFirstWith(blob, defaultDeps());
}
