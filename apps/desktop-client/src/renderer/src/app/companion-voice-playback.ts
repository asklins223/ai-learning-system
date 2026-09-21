import { gatewayErrorMessage } from "./desktop-client";
import type {
  CompanionVoicePlaybackOutcomeRequestV1,
  CompanionVoiceSpeakSegmentRequestV2,
} from "@ailearn/shared/companion-voice-contracts";
import type { CharacterCuePayloadV1 } from "@ailearn/shared/companion-conversation-contracts";
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
  /** Agent 正文通过服务端签发的片段引用合成；renderer 不提交正文。 */
  readonly synthesizeSegment: (ref: CompanionVoiceSpeakSegmentRequestV2) => Promise<AudioBuffer>;
  /**
   * 播放到结束；期间按播放进度回调 0..1（调用方会自行节流）。播完 resolve，
   * 被 stop() 打断时也 resolve——打断由 generation 判定，不靠异常。
   */
  readonly play: (buffer: AudioBuffer, onProgress: (fraction: number) => void) => Promise<void>;
  /** 立刻停掉当前播放。 */
  readonly stop: () => void;
  /**
   * 回报一段音频的结局（0247）。**同步且自吞异常**：这一段播没播成不该有任何方式
   * 影响下一段，所以宿主负责把网络失败咽下去，这里只负责在每一段的结局确定时喊一声。
   */
  readonly reportSegmentOutcome: (report: CompanionVoicePlaybackOutcomeRequestV1) => void;
}

export type CompanionSpeechPhase = "speaking" | "finished" | "stopped" | "failed" | "text_only";

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
  readonly cue?: CharacterCuePayloadV1;
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
/**
 * 单段音频的等待上限（方案 29 §4.9，抱怨 #4「输出了但语音根本不读」）。
 *
 * 原来是 1600ms / 1200ms。这两个数字对一条**网络合成**链路太紧了：qwen-tts 与
 * edge-tts 都要一次完整往返，实测 edge-tts 容器还带着 15 次 500 和 BrokenPipeError。
 * 命中截止的旧行为是 `generation += 1` 把**整轮**音频作废——而文字早就流完了，
 * 于是用户看到的是"她说了话但没声音"，且这一轮之后再也恢复不了。
 *
 * 放宽的代价几乎为零：语音是对已显示文字的**渐进增强**，晚 2 秒开始念远好于不念。
 * 现在超时只跳过那一段（见 runQueuedSpeech），整轮一段都没播出来才降级。
 */
export const COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS = 4_000;
export const COMPANION_SPEECH_GAP_DEADLINE_MS = 3_000;
/** 合成失败后的重试间隔与次数（原来是**零退避**盲重试一次，且丢掉原始异常）。 */
const SYNTH_RETRY_DELAY_MS = 250;
const SYNTH_MAX_ATTEMPTS = 3;

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
      } catch {
        // 预取失败或即时失败都即时重发一次；再失败就**跳过这一段继续后面的**
        // （2026-09-19 用户实测"只读第一句甚至前几个字"的残余：单段合成抖动/
        // 限流曾把整轮语音直接判死）。文字显现靠阅读钟接管被跳过的段。
        try {
          buffer = await synthesize(index);
        } catch {
          continue;
        }
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
  /**
   * 增量文本（这一拍**新到的部分**，2026-09-19 修正）：会话内部累积成全量后交给
   * 切段器。切段器的 `pendingStart` 是累积文本里的绝对下标——直接把增量串交给它，
   * 第二拍起 `slice(pendingStart)` 切出空串，第一句之后的句子永远排不进队列
   * （用户实测症状：只念第一句）。
   */
  feed(text: string): void;
  /** Worker 已签发的真实片段；显示区间直接对应干净正文。 */
  feedSegment(segment: CompanionServerVoiceSegment): void;
  /** 生成结束：把最后一段增量拼上、尾巴强制成段并收尾。 */
  finish(text?: string): void;
  stop(): void;
}

export interface CompanionServerVoiceSegment {
  readonly ref: CompanionVoiceSpeakSegmentRequestV2;
  readonly displayText: string;
  readonly displayStart: number;
  readonly displayEnd: number;
  readonly cue: CharacterCuePayloadV1;
}

interface CompanionSpeechQueue {
  readonly segments: CompanionQueuedSpeechSegment[];
  finished: boolean;
  wake: (() => void) | null;
}

interface CompanionQueuedSpeechSegment {
  readonly key: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly ref?: CompanionVoiceSpeakSegmentRequestV2;
  readonly cue?: CharacterCuePayloadV1;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // 用全局 setTimeout 而不是 window.setTimeout：这个模块会被 node 环境的
  // vitest 直接加载（该测试文件没声明 jsdom），那里没有 `window`——同步抛出的
  // ReferenceError 会把整段播放判死（实测：所有排队段一个都不播）。
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("VOICE_SEGMENT_DEADLINE")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
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
  let hasStartedAudio = false;
  /** 被跳过（超时/合成失败）的段数与最后一次的原因，供收尾降级判定。 */
  let missedSegments = 0;
  let lastMissReason: "deadline" | "synth_failed" = "deadline";
  /**
   * 预取队列（深度 2，2026-09-19 段间衔接优化）：当前段在播时，后面两段已经在
   * 合成路上。深度 1 时段间仍会露出一个合成往返的空档（qwen/edge 都有网络
   * 往返），实测听感就是"句与句之间卡一下"；深度 2 让下一段几乎总是就绪。
   */
  const prefetched: Array<{ key: string; buffer: Promise<AudioBuffer>; startedAtMs: number }> = [];
  /**
   * 一段的结局要回到服务端才算得清"没声音"是谁的锅（0247）。
   * 只有带 ref 的段可报——本地文本路径没有 run/segment 身份，没有可归因的对象。
   */
  const report = (
    segment: CompanionQueuedSpeechSegment,
    reason: CompanionVoicePlaybackOutcomeRequestV1["reason"],
    startedAtMs: number,
  ): void => {
    const ref = segment.ref;
    if (!ref) return;
    args.host.reportSegmentOutcome({
      version: 1,
      conversationId: ref.conversationId,
      runId: ref.runId,
      generation: ref.generation,
      ordinal: ref.ordinal,
      segmentId: ref.segmentId,
      reason,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
  };
  const synthesize = (segment: CompanionQueuedSpeechSegment): Promise<AudioBuffer> => segment.ref
    ? args.host.synthesizeSegment(segment.ref)
    : args.host.synthesize(segment.text);
  const synthesizeWithRetry = async (segment: CompanionQueuedSpeechSegment): Promise<AudioBuffer> => {
    // 原来只重试一次、无退避、且 `catch {}` 把原始异常整个丢掉——上游 500 之后
    // 立刻再打一次只会撞上同一个错误。现在带退避多试一次，并保留**最后一次的异常**
    // 交给调用方（超时/失败的分类要靠它）。
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SYNTH_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await synthesize(segment);
      } catch (error) {
        lastError = error;
        if (attempt < SYNTH_MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => { setTimeout(resolve, SYNTH_RETRY_DELAY_MS * (attempt + 1)); });
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("VOICE_SEGMENT_SYNTH_FAILED");
  };
  const takePrefetched = (key: string): { buffer: Promise<AudioBuffer>; startedAtMs: number } | null => {
    const index = prefetched.findIndex((entry) => entry.key === key);
    if (index < 0) return null;
    const [entry] = prefetched.splice(index, 1);
    return entry ? { buffer: entry.buffer, startedAtMs: entry.startedAtMs } : null;
  };
  const prefetchUpcoming = (): void => {
    for (const upcoming of queue.segments.slice(0, 2)) {
      if (prefetched.length >= 2) break;
      if (prefetched.some((entry) => entry.key === upcoming.key)) continue;
      // startedAtMs 记在**发起合成**的那一刻，不是取用的那一刻：预取的段在队列里
      // 等着的时候等待时间也在走，而那正是"首字等了多久"的真相。
      const startedAtMs = Date.now();
      const promise = synthesizeWithRetry(upcoming);
      // 预取失败会在用到它的那一轮被 await 到；先挂个空 handler 免得变成未处理拒绝。
      promise.catch(() => undefined);
      prefetched.push({ key: upcoming.key, buffer: promise, startedAtMs });
    }
  };
  const visibleAt = (segment: CompanionQueuedSpeechSegment, fraction: number): number => {
    const start = Math.max(previousEnd, segment.startIndex);
    const span = Math.max(1, segment.endIndex - start);
    const clamped = Math.min(1, Math.max(0, fraction));
    return Math.min(segment.endIndex, start + Math.max(1, Math.floor(clamped * span)));
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
      const pending = takePrefetched(segment.key)
        ?? { buffer: synthesizeWithRetry(segment), startedAtMs: Date.now() };
      prefetchUpcoming();
      let buffer: AudioBuffer;
      try {
        buffer = await withDeadline(
          pending.buffer,
          hasStartedAudio ? COMPANION_SPEECH_GAP_DEADLINE_MS : COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS,
        );
      } catch (error) {
        if (args.runGeneration !== generation) return;
        // **一段出问题只丢那一段**（方案 29 §4.9）。旧行为是首段/段间截止一到就
        // `generation += 1` + `host.stop()`，把整轮音频连同后面已经合成好的段一起
        // 作废——而文字早已流完，用户只看到"她说话但没声音"，且当轮不可恢复。
        // 现在超时与合成失败同路：跳过这段继续后面。整轮一段都没播出来时，
        // 才在收尾处降级为 text_only（见循环结束后那段）。
        const deadlineHit = error instanceof Error && error.message === "VOICE_SEGMENT_DEADLINE";
        missedSegments += 1;
        lastMissReason = deadlineHit ? "deadline" : "synth_failed";
        report(segment, deadlineHit ? "deadline" : "synth_failed", pending.startedAtMs);
        continue;
      }
      if (args.runGeneration !== generation) return;

      emit({
        planId: args.planId,
        phase: "speaking",
        segmentIndex: playedCount,
        segmentCount: playedCount + 1 + queue.segments.length,
        visibleChars: visibleAt(segment, 0),
        ...(segment.cue ? { cue: segment.cue } : {}),
      });
      hasStartedAudio = true;
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
      // 走到这里才算"播成了"：`play()` 被打断时同样 resolve，所以必须排在上面那道
      // generation 检查之后——否则"用户三秒后打断"会被记成一次成功播放。
      report(segment, "played", pending.startedAtMs);
    }
    activePlanId = null;
    // 降级只发生在"**一段都没播出来**且确实尝试过"的整轮上——这才是
    // "她说话但没声音"的真实场景。播出了任何一段就正常收尾，个别段被跳过
    // 不打断朗读、也不向用户报"语音不可用"。
    if (playedCount === 0 && missedSegments > 0) {
      emit({
        planId: args.planId,
        phase: "text_only",
        segmentIndex: 0,
        segmentCount: missedSegments,
        visibleChars: previousEnd,
        failure: lastMissReason === "deadline"
          ? "语音合成超时，已继续显示文字"
          : "语音合成失败，已继续显示文字",
      });
      return;
    }
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
      visibleChars: previousEnd,
      failure: gatewayErrorMessage(error),
    });
  }
}

/** 开始一句流式台词。Agent 正文使用 strictSegments，只接受服务端签发的片段引用。 */
export function beginCompanionSpeechLine(options: { readonly strictSegments?: boolean } = {}): CompanionSpeechSession {
  stopCompanionSpeech();
  const planId = `speech-${(sequence += 1)}`;
  const activeHost = host;
  const mode: "voice" | "silent" = activeHost && activeHost.audible() ? "voice" : "silent";
  const queue: CompanionSpeechQueue = { segments: [], finished: false, wake: null };
  let feedState: CompanionSpeechFeedState = COMPANION_SPEECH_FEED_INITIAL;
  /** 调用方喂进来的累积文本（feed/finish 收增量，这里拼成切段器要的全量）。 */
  let accumulated = "";
  let stopped = false;

  const push = (text: string, isFinal: boolean): void => {
    if (stopped) return;
    const split = splitForSpeechIncremental(text, feedState, isFinal);
    feedState = split.next;
    if (split.segments.length === 0) return;
    queue.segments.push(...split.segments.map((segment, index) => ({
      key: `local:${segment.endIndex}:${index}`,
      text: segment.text,
      startIndex: Math.max(0, segment.endIndex - segment.text.length),
      endIndex: segment.endIndex,
    })));
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
      if (options.strictSegments) return;
      if (text.length === 0) return;
      accumulated += text;
      push(accumulated, false);
    },
    feedSegment(segment: CompanionServerVoiceSegment): void {
      if (stopped || !options.strictSegments) return;
      if (queue.segments.some((item) => item.key === segment.ref.segmentId)) return;
      queue.segments.push({
        key: segment.ref.segmentId,
        text: segment.displayText,
        startIndex: segment.displayStart,
        endIndex: segment.displayEnd,
        ref: segment.ref,
        cue: segment.cue,
      });
      queue.segments.sort((left, right) => left.startIndex - right.startIndex);
      const wake = queue.wake;
      queue.wake = null;
      wake?.();
    },
    finish(text = ""): void {
      if (options.strictSegments) {
        queue.finished = true;
        const wake = queue.wake;
        queue.wake = null;
        wake?.();
        return;
      }
      accumulated += text;
      push(accumulated, true);
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
