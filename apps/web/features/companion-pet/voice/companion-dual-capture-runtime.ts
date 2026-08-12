/**
 * P6 §13：双路径录音运行时（renderer 侧接线层）。
 *
 * - 路径 A（本地识别）：AudioWorklet 采集 → BoundedAudioBuffer（48k 环形，
 *   16s 上限）→ 结束时 downsampler 输出 16k mono PCM 供本地 SenseVoice；
 * - 路径 B（云端副本）：MediaRecorder 有界副本由调用方（PetRuntimeProvider
 *   现有录音逻辑）继续负责，本模块不重复持有；
 * - 结束调用 getPcmForRecognition() 一次性取整段 PCM；本地识别失败时副本
 *   上传由上层 ASR 路由决定。
 *
 * 本模块只做采集与缓冲；ASR 路由决策（companion-asr-router）与上传由上层
 * 编排，保持单测纯净。
 */

import { defaultCaptureBuffer } from "./companion-audio-buffer.ts";
import { downsampleTo16k, registerAsrAudioWorklet } from "./companion-audio-worklet.ts";

export interface DualCaptureRuntimeOptions {
  /** 复用运行时 AudioContext（P3 语音已持有） */
  audioContext: AudioContext;
  /** getUserMedia 的麦克风流（AudioWorklet 输入源） */
  mediaStream: MediaStream;
  /** 采集到 PCM 时的统计回调（秒数累积，供 UI/状态机） */
  onAccumulatedSeconds?(seconds: number): void;
  /** 本地 16k 采样率常量 */
  targetSampleRate?: number;
}

export interface DualCaptureRuntimeV1 {
  start(): Promise<boolean>;
  stop(): void;
  /** 整段录音 → 16kHz mono Float32Array（无录音则为空数组） */
  getPcmForRecognition(): Float32Array;
  /** 累积的音频秒数 */
  getRecordedSeconds(): number;
  dispose(): void;
}

export function createDualCaptureRuntime(options: DualCaptureRuntimeOptions): DualCaptureRuntimeV1 {
  const audioContext = options.audioContext;
  // 下采样目标 16k（SenseVoice 输入）由 getPcmForRecognition 内固定。
  const buffer = defaultCaptureBuffer(audioContext.sampleRate, 16);
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let started = false;
  let recordedSeconds = 0;
  let pcmReady: Float32Array | null = null;

  const onWorkletMessage = (event: MessageEvent<{ pcm?: Float32Array }>): void => {
    const pcm = event.data?.pcm;
    if (!pcm || pcm.length === 0) return;
    buffer.push(pcm);
    recordedSeconds = buffer.availableSamples / audioContext.sampleRate;
    options.onAccumulatedSeconds?.(recordedSeconds);
  };

  return {
    async start(): Promise<boolean> {
      if (started) return true;
      const registered = await registerAsrAudioWorklet(audioContext);
      if (!registered) return false;
      try {
        sourceNode = audioContext.createMediaStreamSource(options.mediaStream);
        workletNode = new AudioWorkletNode(audioContext, "companion-asr-capture");
        workletNode.port.onmessage = onWorkletMessage;
        sourceNode.connect(workletNode);
        started = true;
        buffer.clear();
        recordedSeconds = 0;
        pcmReady = null;
        return true;
      } catch {
        // 采集图建立失败：清理节点，返回 false（上层走云端/文字降级）。
        sourceNode?.disconnect();
        workletNode?.disconnect();
        sourceNode = null;
        workletNode = null;
        return false;
      }
    },
    stop(): void {
      if (!started) return;
      started = false;
      // 冻结当前 PCM 供识别（48k 缓冲 → 16k 下采样）。
      const samples = buffer.readAll();
      pcmReady = downsampleTo16k(samples, audioContext.sampleRate);
      workletNode?.port.postMessage({ suspended: true });
      sourceNode?.disconnect();
      workletNode?.disconnect();
      sourceNode = null;
      workletNode = null;
      buffer.clear();
    },
    getPcmForRecognition(): Float32Array {
      return pcmReady ?? new Float32Array(0);
    },
    getRecordedSeconds(): number {
      return recordedSeconds;
    },
    dispose(): void {
      sourceNode?.disconnect();
      workletNode?.disconnect();
      sourceNode = null;
      workletNode = null;
      buffer.clear();
      pcmReady = null;
    },
  };
}
