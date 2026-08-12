/**
 * P6 §13：edge-tts 客户端流式播放运行时（renderer 侧接线层）。
 *
 * - StreamPlaybackController（纯逻辑，已有测试）驱动；
 * - sink.play：Web Audio（AudioContext + AudioBufferSourceNode）播放解码音频；
 * - fetcher：POST /voice/tts/stream（每稳定句一条独立 HTTP 流，chunked）；
 * - barge-in：abort fetch + 停播放器 + 清队 + 递增 audio fence；
 * - 段失败：onSegmentFailed → 上层降级纯文字（不启用本地 TTS）。
 *
 * 播放格式：edge-tts 默认 MP3；用 Web Audio decodeAudioData 解码后播放。
 */

import { StreamPlaybackController, type StreamSegment, type StreamPlaybackSink } from "./companion-stream-player.ts";

export interface StreamPlaybackRuntimeOptions {
  audioContext: AudioContext;
  /** TTS 端点（默认 /api/voice/tts/stream；Fastify 实际 route 无 /api 前缀） */
  streamUrl?: string;
  csrfToken?: string | null;
  /** 2026-08-12（伴星语音设置）：edge-tts 音色 ShortName；空 = 服务端默认 */
  voice?: string;
  /** 2026-08-12（伴星语音设置）：语速（"-30%" | "+0%" | "+30%"） */
  rate?: string;
  /** 2026-08-12（伴星语音设置）：段间额外停顿 ms（默认 0 = 无缝） */
  segmentGapMs?: number;
  /** 播报回调（口型/电平） */
  onAudioLevel?(level: number): void;
  onSegmentFailed?(segment: StreamSegment, code: string): void;
  onSegmentDone?(segment: StreamSegment): void;
}

export interface StreamPlaybackRuntimeV1 {
  enqueue(segment: StreamSegment): void;
  /** barge-in：abort + 停 + 清队 + fence */
  bargeIn(): void;
  /** 打断后恢复空闲（下一次 enqueue 自动开始） */
  clearBarged(): void;
  dispose(): void;
}

export function createStreamPlaybackRuntime(options: StreamPlaybackRuntimeOptions): StreamPlaybackRuntimeV1 {
  const streamUrl = options.streamUrl ?? "/api/voice/tts/stream";
  let analyser: AnalyserNode | null = null;
  let activeSource: AudioBufferSourceNode | null = null;
  let audioFence = 0; // 每次 barge-in 递增，拒绝迟到的播放完成回调

  const sink: StreamPlaybackSink = {
    async play(chunk: Uint8Array, _segment: StreamSegment): Promise<void> {
      const fence = audioFence;
      const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      const decoded = await options.audioContext.decodeAudioData(arrayBuffer);
      if (fence !== audioFence) {
        // 2026-08-12（TTS 无声修复）：此前条件含 `|| !activeSource`——
        // activeSource 初始为 null 且在此之后才赋值，首次播放必抛
        // stale_playback → 每个语音段都静默失败（"正在播报"但无声）。
        // activeSource 仅用于 stop() 时停当前源，不能作为播放许可判断。
        throw new Error("stale_playback");
      }
      const source = options.audioContext.createBufferSource();
      source.buffer = decoded;
      const gain = options.audioContext.createGain();
      source.connect(gain);
      if (analyser) {
        gain.connect(analyser);
        analyser.connect(options.audioContext.destination);
      } else {
        gain.connect(options.audioContext.destination);
      }
      activeSource = source;
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
      activeSource = null;
    },
    stop(): void {
      audioFence += 1;
      activeSource?.stop();
      activeSource = null;
    },
    onSegmentFailed: (segment, code) => options.onSegmentFailed?.(segment, code),
    onSegmentDone: (segment) => options.onSegmentDone?.(segment),
  };

  const controller = new StreamPlaybackController(
    sink,
    async (segment, signal) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "audio/mpeg" };
      if (options.csrfToken) headers["x-csrf-token"] = options.csrfToken;
      const response = await fetch(streamUrl, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          version: 1,
          runId: segment.runId,
          generation: segment.generation,
          ordinal: segment.ordinal,
          segmentId: segment.segmentId,
          text: segment.text,
          // 2026-08-12（伴星语音设置）：音色/语速随请求下发（服务端有默认）。
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.rate ? { rate: options.rate } : {}),
        }),
        signal,
        cache: "no-store",
      });
      return response;
    },
    options.segmentGapMs ?? 0,
  );

  // 播放电平监控（口型/呼吸联动）：挂一个 analyser 到 destination 前。
  if (typeof options.audioContext.createAnalyser === "function") {
    analyser = options.audioContext.createAnalyser();
    analyser.fftSize = 256;
    if (options.onAudioLevel) {
      const levels = new Uint8Array(analyser.frequencyBinCount);
      // 2026-08-12（状态面审计 P2-2）：保存 rAF handle——此前 dispose 只
      // 断开 analyser，rAF 循环靠可选链继续 60fps 永久空转（每次能力切换
      // 留一个死循环，且持续回调 onAudioLevel）。
      let rafHandle: number | null = null;
      let disposed = false;
      const sample = (): void => {
        if (disposed) return;
        analyser?.getByteTimeDomainData(levels);
        let peak = 0;
        for (let i = 0; i < levels.length; i += 1) {
          const v = Math.abs(levels[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        options.onAudioLevel?.(peak);
        rafHandle = requestAnimationFrame(sample);
      };
      rafHandle = requestAnimationFrame(sample);
      return {
        enqueue: (segment) => controller.enqueue(segment),
        bargeIn: () => controller.bargeIn(),
        clearBarged: () => controller.clearBarged(),
        dispose(): void {
          // 2026-08-12 review：disposed 标志短路——回调内同步 dispose 时
          // cancel 的可能是已执行帧的 id，标志确保后续帧不再调度。
          disposed = true;
          controller.bargeIn();
          if (rafHandle !== null) cancelAnimationFrame(rafHandle);
          rafHandle = null;
          analyser?.disconnect();
          analyser = null;
        },
      };
    }
  }

  return {
    enqueue: (segment) => controller.enqueue(segment),
    bargeIn: () => controller.bargeIn(),
    clearBarged: () => controller.clearBarged(),
    dispose(): void {
      controller.bargeIn();
      analyser?.disconnect();
      analyser = null;
    },
  };
}
