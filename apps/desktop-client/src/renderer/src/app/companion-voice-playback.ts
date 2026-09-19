import { gatewayErrorMessage } from "./desktop-client";
import {
  COMPANION_SPEECH_FEED_INITIAL,
  splitForSpeech,
  splitForSpeechIncremental,
  type CompanionSpeechFeedState,
  type CompanionSpeechSegment,
} from "./companion-speech-segments";

/**
 * 伴星台词播放服务（2026-09-18）。
 *
 * 回复要"边念边现字"，所以文本显现与语音播放必须共用同一条时间线。这里的做法
 * 是把一段回复切段（见 companion-speech-segments）、逐段合成、逐段播放，并在每
 * 段开口时广播一次进度；气泡只是订阅进度，不自己猜节奏。
 *
 * 本模块不碰音频硬件：解码与播放由音频宿主（HomeV2AudioController）注入。这样
 * 全应用仍然只有一个 AudioContext 和一条振幅通道——两路同时写嘴型参数会让口型
 * 抖动。
 */

export interface CompanionVoiceHost {
  /** 现在能不能出声（未解锁 / 静音 / 窗口不可见时为 false）。 */
  readonly audible: () => boolean;
  /** 合成一段文本并解码成可播放的 buffer；失败时抛错。 */
  readonly synthesize: (text: string) => Promise<AudioBuffer>;
  /**
   * 播放到结束；期间按播放进度回调 0..1（调用方会自行节流）。播完 resolve，
   * 被 stop() 打断时也 resolve——打断由 generation 判定，不靠异常。
   */
  readonly play: (buffer: AudioBuffer, onProgress: (fraction: number) => void) => Promise<void>;
  /** 立刻停掉当前播放。 */
  readonly stop: () => void;
}

export type CompanionSpeechPhase = "speaking" | "finished" | "stopped" | "failed";

export interface CompanionSpeechProgress {
  readonly planId: string;
  readonly phase: CompanionSpeechPhase;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  /**
   * 气泡此刻应露出的字数（映射回原文）。音频按播放进度推进这个数字，所以文字是
   * 真的跟着她在说，而不是整段弹出——短回复只有一两句，按段跳会看不出流式。
   */
  readonly visibleChars: number;
  readonly failure?: string;
}

export interface CompanionSpeechHandle {
  readonly planId: string;
  /**
   * `voice` = 音频驱动；`silent` = 播不了，由调用方按阅读节奏自行推进。
   * 两者不会同时发生，任何时刻只有一个地方在推进文本。
   */
  readonly mode: "voice" | "silent";
  readonly segments: readonly CompanionSpeechSegment[];
  readonly segmentCount: number;
  stop(): void;
}

let host: CompanionVoiceHost | null = null;
let generation = 0;
let sequence = 0;
let activePlanId: string | null = null;
const listeners = new Set<(progress: CompanionSpeechProgress) => void>();

/** 播放进度的广播节流：逐帧广播会带着 React 一起 60Hz 重渲气泡。 */
const PROGRESS_INTERVAL_MS = 80;

function emit(progress: CompanionSpeechProgress): void {
  for (const listener of listeners) listener(progress);
}

export function setCompanionVoiceHost(next: CompanionVoiceHost | null): void {
  host = next;
  if (!next) stopCompanionSpeech();
}

export function subscribeCompanionSpeech(listener: (progress: CompanionSpeechProgress) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function stopCompanionSpeech(): void {
  const planId = activePlanId;
  if (planId === null) return;
  activePlanId = null;
  generation += 1;
  host?.stop();
  emit({ planId, phase: "stopped", segmentIndex: -1, segmentCount: 0, visibleChars: 0 });
}

/**
 * 现在能不能出声（宿主没装、未解锁、静音、窗口不可见都算不能）。
 *
 * 给"创建会话那一刻还不可出声、终态时已经可以了"这条路径用：那时应该换一次性台词
 * （`speakCompanionLine`），而不是让整轮静默。
 */
export function isCompanionVoiceAudible(): boolean {
  return host?.audible() ?? false;
}

/**
 * 伴星台词播放服务现在是否正在念一句（2026-09-19）。
 *
 * 主动提示音（`ailearn:home-v2-speak`）用它让路：用户主动问出来的回复是他要的反馈，
 * 提示音是背景——背景抢掉正在念的回复，听感上就是"气泡里没发音"。
 */
export function isCompanionSpeechActive(): boolean {
  return activePlanId !== null;
}

interface SpeechRun {
  readonly planId: string;
  readonly runGeneration: number;
  readonly host: CompanionVoiceHost;
  readonly segments: readonly CompanionSpeechSegment[];
  readonly totalChars: number;
}

async function runSpeech(run: SpeechRun): Promise<void> {
  const { segments } = run;
  let pendingIndex = -1;
  let pending: Promise<AudioBuffer> | null = null;

  const synthesize = (index: number): Promise<AudioBuffer> => {
    const promise = run.host.synthesize(segments[index].text);
    // 预取失败会在用到它的那一轮被 await 到；先挂个空 handler 免得变成未处理拒绝。
    promise.catch(() => undefined);
    return promise;
  };

  try {
    for (let index = 0; index < segments.length; index += 1) {
      if (run.runGeneration !== generation) return;

      const prefetched = pendingIndex === index ? pending : null;
      pending = null;
      pendingIndex = -1;

      const current = prefetched ?? synthesize(index);
      // 当前段已经发出去了，紧接着把下一段也发出去：合成有网络往返，串行等会在段间留空档。
      if (index + 1 < segments.length) {
        pendingIndex = index + 1;
        pending = synthesize(index + 1);
      }

      let buffer: AudioBuffer;
      try {
        buffer = await current;
      } catch (error) {
        // 预取失败就对这一段即时重发；本来就不是预取的失败则照常抛出。
        if (current !== prefetched) throw error;
        buffer = await synthesize(index);
      }
      if (run.runGeneration !== generation) return;

      const visibleAt = (index: number, fraction: number): number => {
        const start = index === 0 ? 0 : segments[index - 1].endIndex;
        const span = segments[index].endIndex - start;
        const clamped = Math.min(1, Math.max(0, fraction));
        // 至少露一个字：气泡要立刻有内容，空节点不会渲染，用户会觉得她没说话。
        return Math.min(segments[index].endIndex, start + Math.max(1, Math.floor(clamped * span)));
      };

      emit({
        planId: run.planId,
        phase: "speaking",
        segmentIndex: index,
        segmentCount: segments.length,
        visibleChars: visibleAt(index, 0),
      });
      let lastProgressAt = 0;
      await run.host.play(buffer, (fraction) => {
        if (run.runGeneration !== generation) return;
        const now = Date.now();
        // 逐帧回调会带着 React 一起 60Hz 重渲；80ms 的步进看起来依然是连续打字的。
        if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        emit({
          planId: run.planId,
          phase: "speaking",
          segmentIndex: index,
          segmentCount: segments.length,
          visibleChars: visibleAt(index, fraction),
        });
      });
      if (run.runGeneration !== generation) return;
    }
    activePlanId = null;
    emit({
      planId: run.planId,
      phase: "finished",
      segmentIndex: segments.length - 1,
      segmentCount: segments.length,
      visibleChars: run.totalChars,
    });
  } catch (error) {
    if (run.runGeneration !== generation) return;
    activePlanId = null;
    emit({
      planId: run.planId,
      phase: "failed",
      segmentIndex: -1,
      segmentCount: segments.length,
      visibleChars: 0,
      failure: gatewayErrorMessage(error),
    });
  }
}

/**
 * 流式台词的播放会话（2026-09-19）：文本边生成边喂进来，完整句一到就开念。
 *
 * 与 `speakCompanionLine` 的区别只在"什么时候有文本"：会话先建、文本后到，
 * 因此不能像固定数组那样一次性切段，而是用增量切段保持"已合成/已播出的段不再
 * 重切"。计划一旦被新的台词/停止打断，循环按 generation 退出。
 */
export interface CompanionSpeechSession {
  readonly planId: string;
  /** voice = 有音频在推；silent = 播不了，调用方自己推进文本。 */
  readonly mode: "voice" | "silent";
  /** 累积文本（全量）推进：新出现的完整句进入合成队列。 */
  feed(text: string): void;
  /** 生成结束：把尾巴强制成段并收尾。 */
  finish(text: string): void;
  stop(): void;
}

interface CompanionSpeechQueue {
  readonly segments: CompanionSpeechSegment[];
  finished: boolean;
  wake: (() => void) | null;
}

async function runQueuedSpeech(args: {
  planId: string;
  runGeneration: number;
  host: CompanionVoiceHost;
  queue: CompanionSpeechQueue;
}): Promise<void> {
  const { queue } = args;
  let playedCount = 0;
  let previousEnd = 0;
  let prefetched: { text: string; buffer: Promise<AudioBuffer> } | null = null;
  const visibleAt = (segment: CompanionSpeechSegment, fraction: number): number => {
    const span = Math.max(1, segment.endIndex - previousEnd);
    const clamped = Math.min(1, Math.max(0, fraction));
    return Math.min(segment.endIndex, previousEnd + Math.max(1, Math.floor(clamped * span)));
  };
  try {
    for (;;) {
      if (args.runGeneration !== generation) return;
      const segment = queue.segments.shift();
      if (!segment) {
        if (queue.finished) break;
        await new Promise<void>((resolve) => { queue.wake = resolve; });
        continue;
      }
      const wasPrefetched = prefetched !== null && prefetched.text === segment.text;
      const current = wasPrefetched ? prefetched!.buffer : args.host.synthesize(segment.text);
      prefetched = null;
      // 当前段已经排上队了，紧接着把下一段也发出去：合成有网络往返，
      // 串行等会在段间留空档（服务端按用户串行，提前发不增加并发压力）。
      const upcoming = queue.segments[0];
      if (upcoming) {
        const promise = args.host.synthesize(upcoming.text);
        promise.catch(() => undefined);
        prefetched = { text: upcoming.text, buffer: promise };
      }
      let buffer: AudioBuffer;
      try {
        buffer = await current;
      } catch (error) {
        // 预取失败对这一段即时重发；本来就不是预取的失败照常抛出。
        if (!wasPrefetched) throw error;
        buffer = await args.host.synthesize(segment.text);
      }
      if (args.runGeneration !== generation) return;

      emit({
        planId: args.planId,
        phase: "speaking",
        segmentIndex: playedCount,
        segmentCount: playedCount + 1 + queue.segments.length,
        visibleChars: visibleAt(segment, 0),
      });
      let lastProgressAt = 0;
      await args.host.play(buffer, (fraction) => {
        if (args.runGeneration !== generation) return;
        const now = Date.now();
        if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        emit({
          planId: args.planId,
          phase: "speaking",
          segmentIndex: playedCount,
          segmentCount: playedCount + 1 + queue.segments.length,
          visibleChars: visibleAt(segment, fraction),
        });
      });
      if (args.runGeneration !== generation) return;
      previousEnd = segment.endIndex;
      playedCount += 1;
    }
    activePlanId = null;
    emit({
      planId: args.planId,
      phase: "finished",
      segmentIndex: playedCount - 1,
      segmentCount: playedCount,
      visibleChars: previousEnd,
    });
  } catch (error) {
    if (args.runGeneration !== generation) return;
    activePlanId = null;
    emit({
      planId: args.planId,
      phase: "failed",
      segmentIndex: -1,
      segmentCount: playedCount,
      visibleChars: 0,
      failure: gatewayErrorMessage(error),
    });
  }
}

/** 开始一句流式台词：先建会话，文本用 feed 推进。新的台词取代正在念的那句。 */
export function beginCompanionSpeechLine(): CompanionSpeechSession {
  stopCompanionSpeech();
  const planId = `speech-${(sequence += 1)}`;
  const activeHost = host;
  const mode: "voice" | "silent" = activeHost && activeHost.audible() ? "voice" : "silent";
  const queue: CompanionSpeechQueue = { segments: [], finished: false, wake: null };
  let feedState: CompanionSpeechFeedState = COMPANION_SPEECH_FEED_INITIAL;
  let stopped = false;

  const push = (text: string, isFinal: boolean): void => {
    if (stopped) return;
    const split = splitForSpeechIncremental(text, feedState, isFinal);
    feedState = split.next;
    if (split.segments.length === 0) return;
    queue.segments.push(...split.segments);
    const wake = queue.wake;
    queue.wake = null;
    wake?.();
  };

  if (mode === "voice" && activeHost) {
    activePlanId = planId;
    void runQueuedSpeech({ planId, runGeneration: generation, host: activeHost, queue });
  }

  return {
    planId,
    mode,
    feed(text: string): void {
      push(text, false);
    },
    finish(text: string): void {
      push(text, true);
      queue.finished = true;
      const wake = queue.wake;
      queue.wake = null;
      wake?.();
    },
    stop(): void {
      stopped = true;
      queue.finished = true;
      const wake = queue.wake;
      queue.wake = null;
      wake?.();
      if (activePlanId === planId) stopCompanionSpeech();
    },
  };
}

/**
 * 念一句伴星台词。返回 null 表示没有可念的内容。新的台词会取代正在念的那句——
 * 语音是提示，不是队列。
 */
export function speakCompanionLine(text: string): CompanionSpeechHandle | null {
  const segments = splitForSpeech(text);
  if (segments.length === 0) return null;
  const totalChars = text.trim().length;
  const planId = `speech-${(sequence += 1)}`;

  stopCompanionSpeech();

  const activeHost = host;
  if (!activeHost || !activeHost.audible()) {
    return { planId, mode: "silent", segments, segmentCount: segments.length, stop: () => undefined };
  }

  activePlanId = planId;
  const runGeneration = generation;
  void runSpeech({ planId, runGeneration, host: activeHost, segments, totalChars });
  return {
    planId,
    mode: "voice",
    segments,
    segmentCount: segments.length,
    stop: () => {
      if (activePlanId === planId) stopCompanionSpeech();
    },
  };
}

/** 测试用：清掉宿主、订阅者与在途计划。 */
export function resetCompanionVoicePlayback(): void {
  activePlanId = null;
  generation += 1;
  host = null;
  listeners.clear();
}
