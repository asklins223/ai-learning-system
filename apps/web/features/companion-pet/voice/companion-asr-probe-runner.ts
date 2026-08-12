/**
 * P6 §13：SenseVoice 真实性能探测执行器（纯逻辑 + 注入，可测）。
 *
 * 用内置 3–5s 测试音频跑真实模型，产出 ProbeResult 供 ASR 路由决策
 * （companion-asr-router）。合同 Gate：冷启动 ≤ 3s、warm RTF ≤ 0.5、
 * 峰值内存增量 ≤ 700MB；连续窗口 RTF > 0.8 或模型崩溃 → 降级。
 */

import type { ProbeResult } from "./companion-asr-router.ts";

export interface ProbeDeps {
  /** 冷启动加载模型，返回加载耗时 ms */
  loadModel(): Promise<number>;
  /** 识别一段 PCM，返回文本与耗时 ms */
  recognize(pcm: Float32Array): { text: string; elapsedMs: number };
  /** 当前进程内存用量（bytes；探测前调用一次作基线） */
  memoryBytes(): number;
  /** 内置测试音频（3–5s 16kHz mono PCM） */
  testAudio: Float32Array;
  /** warm 识别轮数（默认 3） */
  warmRounds?: number;
  /** 测试音频时长秒数（默认按 sampleRate 换算） */
  sampleRate?: number;
  /** 可选：模拟崩溃（测试用） */
  onCrash?: () => never;
}

export async function runSenseVoiceProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const warmRounds = deps.warmRounds ?? 3;
  const sampleRate = deps.sampleRate ?? 16000;
  const baselineMemory = deps.memoryBytes();
  let coldStartMs: number;
  try {
    coldStartMs = await deps.loadModel();
  } catch {
    return {
      coldStartMs: -1, warmRtf: -1, peakMemoryDeltaMB: -1,
      modelCrashed: false, sustainedSlow: false, modelLoadFailed: true,
    };
  }
  // warm 识别（RTF = 耗时 / 音频时长）
  let maxRtf = 0;
  let slowWindows = 0;
  const audioSeconds = deps.testAudio.length / sampleRate;
  for (let i = 0; i < warmRounds; i++) {
    let elapsedMs: number;
    try {
      elapsedMs = deps.recognize(deps.testAudio).elapsedMs;
    } catch {
      return {
        coldStartMs, warmRtf: -1, peakMemoryDeltaMB: -1,
        modelCrashed: true, sustainedSlow: false, modelLoadFailed: false,
      };
    }
    const rtf = audioSeconds > 0 ? elapsedMs / (audioSeconds * 1000) : -1;
    maxRtf = Math.max(maxRtf, rtf);
    if (rtf > 0.8) slowWindows += 1;
  }
  const peakMemoryDeltaMB = (deps.memoryBytes() - baselineMemory) / (1024 * 1024);
  return {
    coldStartMs,
    warmRtf: Math.round(maxRtf * 100) / 100,
    peakMemoryDeltaMB: Math.round(peakMemoryDeltaMB),
    modelCrashed: false,
    sustainedSlow: slowWindows >= 2, // 连续窗口恶化
    modelLoadFailed: false,
  };
}
