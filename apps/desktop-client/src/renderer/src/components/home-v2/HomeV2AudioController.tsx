import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomStore } from "../../app/room-store";
import {
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { useHomeProjectionInvalidation } from "../../app/home-projection";
import { shouldRunHomeV2Ambient } from "./home-v2";
import { setHomeV2VoiceLevel } from "../../app/companion-voice-level";
import {
  isCompanionSpeechActive,
  setCompanionVoiceHost,
  stopCompanionSpeech,
} from "../../app/companion-voice-playback";
import {
  companionMouthTarget,
  smoothCompanionMouthLevel,
} from "../../app/companion-mouth-meter";
import type {
  CompanionVoicePlaybackOutcomeRequestV1,
  CompanionVoiceSpeakSegmentRequestV2,
} from "@ailearn/shared/companion-voice-contracts";

type HomeV2SoundKind = "page" | "footstep" | "magic" | "success";

export type HomeV2VoiceRequest = {
  readonly text: string;
  readonly reason: "cue" | "touch";
};

/**
 * Frozen audio tuning for the cottage.
 *
 * Every deliberate sound must sit inside the band a laptop or desktop speaker can
 * actually reproduce. The first revision of this file used a 165 Hz rumble for
 * the wind and a 92 Hz sine for footsteps: both are below the useful output of
 * ordinary speakers, which made two of the four planned sounds inaudible in
 * practice. `HOME_V2_AUDIBLE_FLOOR_HZ` is the regression floor, and the tuning
 * table below is asserted against it by tests.
 */
export const HOME_V2_AUDIBLE_FLOOR_HZ = 220;

export const HOME_V2_AUDIO_TUNING = Object.freeze({
  ambient: Object.freeze({
    bandHz: 520,
    bandQ: 0.55,
    lowpassHz: 1_900,
    gain: 0.03,
    gustHz: 0.07,
    gustDepth: 0.28,
    fadeSeconds: 0.7,
    seconds: 3,
  }),
  page: Object.freeze({ highpassHz: 650, gain: 0.032, seconds: 0.11 }),
  footstep: Object.freeze({
    tapHz: 1_150,
    tapQ: 1.1,
    bodyFromHz: 150,
    bodyToHz: 95,
    tapGain: 0.05,
    bodyGain: 0.042,
    seconds: 0.13,
  }),
  magic: Object.freeze({
    fromHz: 420,
    toHz: 690,
    shimmerFromHz: 630,
    shimmerToHz: 980,
    gain: 0.028,
    shimmerGain: 0.012,
    seconds: 0.3,
  }),
  success: Object.freeze({ notesHz: [660, 880, 990] as const, gain: 0.022, noteSeconds: 0.27, intervalSeconds: 0.1 }),
  voice: Object.freeze({
    cooldownMs: 6_000,
    failureBackoffMs: 60_000,
    analyserFftSize: 256,
    analyserSmoothing: 0.82,
  }),
});

type HomeV2AudioGraph = {
  readonly context: AudioContext;
  readonly ambientGain: GainNode;
  readonly noise: AudioBufferSourceNode;
  readonly gust: OscillatorNode;
};

type VoicePlayback = {
  readonly source: AudioBufferSourceNode;
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array;
  frame: number;
  /** 播完或被 stopVoicePlayback 打断时收尾，让等待这次播放的人一定拿到结果。 */
  readonly settle: () => void;
};

function whiteNoise(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, Math.round(context.sampleRate * seconds)), context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Wind is a wide band of moving air, not a sub-bass rumble: band-passed noise in
 * the low-mid band with a very slow gust on top.
 */
function buildAmbientGraph(): HomeV2AudioGraph {
  const tuning = HOME_V2_AUDIO_TUNING.ambient;
  const context = new AudioContext();
  const noise = context.createBufferSource();
  const band = context.createBiquadFilter();
  const air = context.createBiquadFilter();
  const ambientGain = context.createGain();
  const gust = context.createOscillator();
  const gustDepth = context.createGain();

  noise.buffer = whiteNoise(context, tuning.seconds);
  noise.loop = true;
  band.type = "bandpass";
  band.frequency.value = tuning.bandHz;
  band.Q.value = tuning.bandQ;
  air.type = "lowpass";
  air.frequency.value = tuning.lowpassHz;
  ambientGain.gain.value = 0;

  gust.type = "sine";
  gust.frequency.value = tuning.gustHz;
  gustDepth.gain.value = tuning.gain * tuning.gustDepth;

  noise.connect(band).connect(air).connect(ambientGain).connect(context.destination);
  gust.connect(gustDepth).connect(ambientGain.gain);
  noise.start();
  gust.start();
  return { context, ambientGain, noise, gust };
}

function decayEnvelope(
  gain: GainNode,
  context: AudioContext,
  peak: number,
  seconds: number,
): void {
  const now = context.currentTime;
  gain.gain.setValueAtTime(Math.max(0.0001, peak), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
}

function playNoiseTap(
  context: AudioContext,
  destination: AudioNode,
  options: { readonly hz: number; readonly q: number; readonly gain: number; readonly seconds: number },
): void {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = whiteNoise(context, options.seconds);
  filter.type = "bandpass";
  filter.frequency.value = options.hz;
  filter.Q.value = options.q;
  decayEnvelope(gain, context, options.gain, options.seconds);
  source.connect(filter).connect(gain).connect(destination);
  source.start(context.currentTime);
  source.stop(context.currentTime + options.seconds);
}

function playTransient(graph: HomeV2AudioGraph, kind: HomeV2SoundKind): void {
  const { context } = graph;
  const now = context.currentTime;

  if (kind === "success") {
    // A short, soft three-note arrival cue; the evidence and Companion line
    // carry the meaning, so this remains optional and never blocks results.
    const tuning = HOME_V2_AUDIO_TUNING.success;
    tuning.notesHz.forEach((frequency, index) => {
      const start = now + index * tuning.intervalSeconds;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(tuning.gain, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tuning.noteSeconds);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + tuning.noteSeconds + 0.01);
    });
    return;
  }

  if (kind === "page") {
    // Paper is broadband air: a filtered noise burst with a fast decay.
    const tuning = HOME_V2_AUDIO_TUNING.page;
    const sampleCount = Math.round(context.sampleRate * tuning.seconds);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * (1 - index / sampleCount);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = "highpass";
    filter.frequency.value = tuning.highpassHz;
    decayEnvelope(gain, context, tuning.gain, tuning.seconds);
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
    source.stop(now + tuning.seconds + 0.01);
    return;
  }

  if (kind === "footstep") {
    // A step on wood reads as a mid-band tap plus a short body thump. Both
    // components stay inside the reproducible band.
    const tuning = HOME_V2_AUDIO_TUNING.footstep;
    playNoiseTap(context, context.destination, {
      hz: tuning.tapHz,
      q: tuning.tapQ,
      gain: tuning.tapGain,
      seconds: tuning.seconds,
    });
    const body = context.createOscillator();
    const gain = context.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(tuning.bodyFromHz, now);
    body.frequency.exponentialRampToValueAtTime(tuning.bodyToHz, now + tuning.seconds);
    decayEnvelope(gain, context, tuning.bodyGain, tuning.seconds);
    body.connect(gain).connect(context.destination);
    body.start(now);
    body.stop(now + tuning.seconds);
    return;
  }

  const tuning = HOME_V2_AUDIO_TUNING.magic;
  const glow = context.createOscillator();
  const shimmer = context.createOscillator();
  const glowGain = context.createGain();
  const shimmerGain = context.createGain();
  glow.type = "triangle";
  glow.frequency.setValueAtTime(tuning.fromHz, now);
  glow.frequency.exponentialRampToValueAtTime(tuning.toHz, now + tuning.seconds);
  shimmer.type = "triangle";
  shimmer.frequency.setValueAtTime(tuning.shimmerFromHz, now);
  shimmer.frequency.exponentialRampToValueAtTime(tuning.shimmerToHz, now + tuning.seconds);
  decayEnvelope(glowGain, context, tuning.gain, tuning.seconds);
  decayEnvelope(shimmerGain, context, tuning.shimmerGain, tuning.seconds);
  glow.connect(glowGain).connect(context.destination);
  shimmer.connect(shimmerGain).connect(context.destination);
  glow.start(now);
  shimmer.start(now);
  glow.stop(now + tuning.seconds);
  shimmer.stop(now + tuning.seconds);
}

function decodeBase64Audio(context: AudioContext, base64: string): Promise<AudioBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return context.decodeAudioData(bytes.buffer);
}

/**
 * Audio is created only inside a trusted user gesture and stays silent in tasks.
 * It is also the single owner of companion voice playback, so the ambient bed,
 * the interface transients and speech share one context, one mute gate and one
 * amplitude channel for the Live2D mouth.
 */
export function HomeV2AudioController() {
  const [unlocked, setUnlocked] = useState(false);
  const graphRef = useRef<HomeV2AudioGraph | null>(null);
  const voiceRef = useRef<VoicePlayback | null>(null);
  const mouthLevelRef = useRef(0);
  const mouthReleaseFrameRef = useRef(0);
  const voiceRequestGenerationRef = useRef(0);
  const lastVoiceRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const voiceFailureAtRef = useRef(0);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const surface = useRoomStore((state) => state.surface);
  const windowState = useRoomStore((state) => state.windowState);
  const invalidation = useHomeProjectionInvalidation();
  const workspaceEpochRef = useRef(invalidation.workspaceEpoch);
  workspaceEpochRef.current = invalidation.workspaceEpoch;
  const audibleRef = useRef(false);

  const stopVoicePlayback = useCallback((immediate = true) => {
    const playback = voiceRef.current;
    voiceRef.current = null;
    activePlaybackRef.current = null;
    window.cancelAnimationFrame(mouthReleaseFrameRef.current);
    if (!playback) {
      if (immediate) {
        mouthLevelRef.current = 0;
        setHomeV2VoiceLevel(0);
      }
      return;
    }
    cancelAnimationFrame(playback.frame);
    try {
      playback.source.stop();
    } catch {
      // Already stopped: nothing to release.
    }
    playback.source.disconnect();
    playback.analyser.disconnect();
    if (immediate) {
      mouthLevelRef.current = 0;
      setHomeV2VoiceLevel(0);
    } else {
      let previousAt = performance.now();
      const release = (at: number) => {
        const next = smoothCompanionMouthLevel(mouthLevelRef.current, 0, at - previousAt);
        previousAt = at;
        mouthLevelRef.current = next;
        setHomeV2VoiceLevel(next);
        if (next > 0.01) mouthReleaseFrameRef.current = window.requestAnimationFrame(release);
        else {
          mouthLevelRef.current = 0;
          setHomeV2VoiceLevel(0);
        }
      };
      mouthReleaseFrameRef.current = window.requestAnimationFrame(release);
    }
    // 等待这次播放的人必须拿到结果，否则它会一直以为自己还在播。
    playback.settle();
  }, []);

  /**
   * 播一段已经解码好的语音，按帧回报进度。
   *
   * 这是全应用唯一的语音播放出口：环境音、界面音效、伴星台词都走同一个
   * AudioContext 和同一条振幅通道。喊停永远由 stopVoicePlayback 统一处理，
   * 所以 cue 与对话台词天然互斥——谁抢到谁播，被抢的那个立刻拿到 resolve。
   */
  const playVoiceBuffer = useCallback(async (
    buffer: AudioBuffer,
    onProgress: (fraction: number) => void,
  ): Promise<void> => {
    const graph = graphRef.current;
    if (!graph || !userInitiatedAudibleRef.current) {
      return;
    }
    await graph.context.resume();
    if (graphRef.current !== graph || !userInitiatedAudibleRef.current) return;
    stopVoicePlayback();
    return new Promise<void>((resolve) => {
      const source = graph.context.createBufferSource();
      const analyser = graph.context.createAnalyser();
      const tuning = HOME_V2_AUDIO_TUNING.voice;
      analyser.fftSize = tuning.analyserFftSize;
      analyser.smoothingTimeConstant = tuning.analyserSmoothing;
      source.buffer = buffer;
      source.connect(analyser).connect(graph.context.destination);
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = graph.context.currentTime;
      activePlaybackRef.current = { context: graph.context, startedAt, duration: buffer.duration };
      let previousMeterAt = performance.now();
      const playback: VoicePlayback = { source, analyser, samples, frame: 0, settle: () => resolve() };
      const meter = (at: number) => {
        if (voiceRef.current !== playback) return;
        analyser.getFloatTimeDomainData(samples);
        const target = companionMouthTarget(samples);
        const level = smoothCompanionMouthLevel(mouthLevelRef.current, target, at - previousMeterAt);
        previousMeterAt = at;
        mouthLevelRef.current = level;
        setHomeV2VoiceLevel(level);
        const elapsed = graph.context.currentTime - startedAt;
        onProgress(buffer.duration > 0 ? Math.min(1, elapsed / buffer.duration) : 1);
        playback.frame = requestAnimationFrame(meter);
      };
      playback.frame = requestAnimationFrame(meter);
      source.onended = () => {
        if (voiceRef.current !== playback) return;
        stopVoicePlayback(false);
      };
      voiceRef.current = playback;
      source.start();
    });
  }, [stopVoicePlayback]);

  useEffect(() => {
    const unlock = (event: Event) => {
      if (!event.isTrusted || graphRef.current) return;
      try {
        const graph = buildAmbientGraph();
        graphRef.current = graph;
        void graph.context.resume().catch(() => undefined);
        setUnlocked(true);
      } catch {
        // Audio is progressive enhancement; the room and controls stay usable.
      }
    };
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      const graph = graphRef.current;
      graphRef.current = null;
      graph?.gust.stop();
      graph?.noise.stop();
      void graph?.context.close().catch(() => undefined);
    };
  }, []);

  const audible = shouldRunHomeV2Ambient({
    unlocked,
    masterMuted,
    surfaceOpen: Boolean(surface),
    windowVisible: windowState === "visible" && !document.hidden,
  });
  audibleRef.current = audible;

  /**
   * 用户主动发起的对话语音走独立闸门：同样的解锁/静音/可见性条件，但**不含**
   * `surfaceOpen`。任务页静音是为了不让环境音打扰专注；而用户点一下亲口问出来的
   * 回复是他主动要的反馈，不是"主动输出"——这与 §2026-09-16 裁决 3 里"按页静音只
   * 抑制主动输出、不阻断用户主动触发的互动"是同一条线。
   */
  const userInitiatedAudible = shouldRunHomeV2Ambient({
    unlocked,
    masterMuted,
    surfaceOpen: false,
    windowVisible: windowState === "visible" && !document.hidden,
  });
  const userInitiatedAudibleRef = useRef(false);
  /**
   * 正在播的那一段的**音频时钟读数**（方案 29 §14.11 修复 ⑤）。
   *
   * 字幕要的是"现在念到哪了"，而这个问题的唯一正确答案在音频时钟里
   * （`AudioContext.currentTime`）——不是 rAF 采样的最后值：窗口不可见/被遮挡时
   * rAF 会被节流甚至停住，采样值冻住而声音照走，字幕立刻与声音脱开。
   */
  const activePlaybackRef = useRef<{ context: AudioContext; startedAt: number; duration: number } | null>(null);
  userInitiatedAudibleRef.current = userInitiatedAudible;

  const synthesizeVoice = useCallback(async (text: string): Promise<AudioBuffer> => {
    const speakApi = window.ailearn?.companion?.voice?.speak;
    const graph = graphRef.current;
    if (!speakApi || !graph) throw new Error("语音通道还没准备好");
    const response = await speakApi.call(window.ailearn.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request: { version: 1, text },
    });
    return decodeBase64Audio(graph.context, unwrapGatewayResult(response).audioBase64);
  }, []);

  const synthesizeVoiceSegment = useCallback(async (request: CompanionVoiceSpeakSegmentRequestV2): Promise<AudioBuffer> => {
    const speakApi = window.ailearn?.companion?.voice?.speakSegment;
    const graph = graphRef.current;
    if (!speakApi || !graph) throw new Error("语音通道还没准备好");
    const response = await speakApi.call(window.ailearn.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request,
    });
    return decodeBase64Audio(graph.context, unwrapGatewayResult(response).audioBase64);
  }, []);

  /**
   * 一段音频的结局上报（0247）。不 await、不 unwrap、不抛——**上报反噬朗读**是
   * 比"少一行统计"严重得多的失败，所以这里把所有异常咽掉。
   */
  const reportSegmentOutcome = useCallback((request: CompanionVoicePlaybackOutcomeRequestV1): void => {
    const reportApi = window.ailearn?.companion?.voice?.reportPlaybackOutcome;
    if (!reportApi) return;
    void reportApi.call(window.ailearn.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request,
    }).catch(() => undefined);
  }, []);

  /**
   * 此刻的播放位置 0..1；没有在播返回 null。
   *
   * 从音频时钟现算（不是缓存上一次 rAF 的值）：这是"字幕跟着声音走"的唯一可靠来源。
   */
  const voiceProgress = useCallback((): number | null => {
    const active = activePlaybackRef.current;
    if (!active || !(active.duration > 0)) return null;
    const elapsed = active.context.currentTime - active.startedAt;
    if (!Number.isFinite(elapsed)) return null;
    return Math.min(1, Math.max(0, elapsed / active.duration));
  }, []);

  // 把音频出口交给伴星台词播放服务：它只管排队与计时，解码、播放、振幅仍在这里，
  // 全应用因此只有一个 AudioContext 和一条嘴型通道。
  useEffect(() => {
    setCompanionVoiceHost({
      audible: () => userInitiatedAudibleRef.current,
      synthesize: synthesizeVoice,
      synthesizeSegment: synthesizeVoiceSegment,
      play: playVoiceBuffer,
      progress: voiceProgress,
      stop: stopVoicePlayback,
      reportSegmentOutcome,
    });
    return () => setCompanionVoiceHost(null);
  }, [playVoiceBuffer, stopVoicePlayback, synthesizeVoice, synthesizeVoiceSegment, reportSegmentOutcome, voiceProgress]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const now = graph.context.currentTime;
    graph.ambientGain.gain.cancelScheduledValues(now);
    if (!audible) graph.ambientGain.gain.setValueAtTime(0, now);
    if (!userInitiatedAudible) {
      voiceRequestGenerationRef.current += 1;
      stopVoicePlayback();
      void graph.context.suspend().catch(() => undefined);
      return;
    }
    void graph.context.resume()
      .then(() => {
        if (graphRef.current !== graph) return;
        const resumedAt = graph.context.currentTime;
        graph.ambientGain.gain.cancelScheduledValues(resumedAt);
        graph.ambientGain.gain.setValueAtTime(0, resumedAt);
        if (audibleRef.current) {
          graph.ambientGain.gain.linearRampToValueAtTime(
            HOME_V2_AUDIO_TUNING.ambient.gain,
            resumedAt + HOME_V2_AUDIO_TUNING.ambient.fadeSeconds,
          );
        }
      })
      .catch(() => undefined);
  }, [audible, stopVoicePlayback, userInitiatedAudible]);

  useEffect(() => {
    const play = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: HomeV2SoundKind }>).detail?.kind;
      const graph = graphRef.current;
      const allowed = kind === "success" ? userInitiatedAudibleRef.current : audibleRef.current;
      if (!graph || !allowed || !kind) return;
      playTransient(graph, kind);
    };
    window.addEventListener("ailearn:home-v2-sound", play);
    return () => window.removeEventListener("ailearn:home-v2-sound", play);
  }, []);

  useEffect(() => {
    const speak = (event: Event) => {
      const detail = (event as CustomEvent<Partial<HomeV2VoiceRequest>>).detail;
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      const graph = graphRef.current;
      const tuning = HOME_V2_AUDIO_TUNING.voice;
      if (!text || !graph || !audibleRef.current) return;
      // A voice cue is a progressive enhancement, never a queue: a newer line
      // replaces the one being spoken instead of stacking behind it.
      const now = Date.now();
      if (voiceFailureAtRef.current && now - voiceFailureAtRef.current < tuning.failureBackoffMs) return;
      const previous = lastVoiceRef.current;
      if (previous.text === text && now - previous.at < tuning.cooldownMs) return;
      // 回复朗读优先（2026-09-19）：用户主动问出来的那条回复是他要的反馈，提示音是背景。
      // 背景抢掉正在念的回复，听感上就是"气泡回来了却没发音"——所以正在念的时候，
      // 这次提示音直接丢弃（不排队、也不打断），连请求都不发。
      if (isCompanionSpeechActive()) return;
      const requestGeneration = ++voiceRequestGenerationRef.current;
      // 提示音和对话台词共用同一路音频：没有回复在念时，提示音先到就先占住。
      stopVoicePlayback();
      stopCompanionSpeech();
      lastVoiceRef.current = { text, at: now };

      const speakApi = window.ailearn?.companion?.voice?.speak;
      if (!speakApi) return;
      void speakApi.call(window.ailearn.companion.voice, {
        meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
        request: { version: 1, text },
      })
        .then(async (response) => {
          if (requestGeneration !== voiceRequestGenerationRef.current) return;
          const result = unwrapGatewayResult(response);
          const active = graphRef.current;
          if (!active || !audibleRef.current || graphRef.current !== active) return;
          const buffer = await decodeBase64Audio(active.context, result.audioBase64);
          if (
            requestGeneration !== voiceRequestGenerationRef.current
            || graphRef.current !== active
            || !audibleRef.current
          ) return;
          await playVoiceBuffer(buffer, () => undefined);
        })
        .catch((error: unknown) => {
          if (requestGeneration !== voiceRequestGenerationRef.current) return;
          // Speech is optional: a missing engine, an expired session or a
          // rejected contract must leave the room silent and fully usable.
          voiceFailureAtRef.current = Date.now();
          void gatewayErrorMessage(error);
          setHomeV2VoiceLevel(0);
        });
    };

    window.addEventListener("ailearn:home-v2-speak", speak);
    return () => {
      window.removeEventListener("ailearn:home-v2-speak", speak);
      voiceRequestGenerationRef.current += 1;
      stopVoicePlayback();
    };
  }, [playVoiceBuffer, stopVoicePlayback]);

  return null;
}
