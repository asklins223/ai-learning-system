import { COMPANION_READ_MS_PER_CHAR } from "../components/companion/companion-bubble-reveal";

/**
 * 伴星气泡的显现驱动器（2026-09-19）。
 *
 * 病灶：文本"到达"的速度被当成了"该显示多少"。旧实现在两处把计数直接设成全文长度——
 * 草稿一到就 `Math.max(current, draft.text.length)`，终态一到又补满 `total`——于是
 * `companion-voice-playback` 每 80ms 广播的播放进度只能"抬下限"，逐字显现形同失效。
 * 用户看到的就是"整块文字先出完，然后才开始读"（`DESIGN.md:163` 要求可视字数由真实
 * 播放进度驱动）。
 *
 * 这里把时间线收成一条：`revealed` 只由**音频进度**或**阅读钟**推进，永不因为"文本到了"
 * 而跳字。规则：
 *
 * 1. 只增不减、不越界：`revealed ∈ [0, arrived]`；
 * 2. 音频在说话时是唯一权威，`revealed = 音频进度 + 提前量`（字略早于声音，字幕观感）；
 * 3. 音频 `audioSilenceMs` 没有动静就退到阅读钟（按 `COMPANION_READ_MS_PER_CHAR` 推进同一个
 *    计数）——覆盖"静音模式 / 没有宿主 / 合成失败 / 段间等待过久 / 第一段迟迟不来"；
 * 4. `voice` 模式下第一段音频到达前只放行 `leadChars` 个字，别让文字跑到声音前面；
 * 5. 收尾只认"钟走完 arrived"或"音频 finished"——`onComplete` 因此是可以安全触发气泡收起的
 *    唯一信号，不会再出现"文本到齐 → 立刻消失"。
 */

/** 音频还没出声时先放行的提前量：字幕总比声音早一点点，但不能只剩一个孤字。 */
export const COMPANION_REVEAL_LEAD_CHARS = 6;

/**
 * 多久没有音频动静就认为"这一路出不了声/home 是 silent"，退到阅读钟。
 *
 * 两个用途共用同一个数：第一段音频的看门狗（合成有网络往返），以及段间等待的上限
 * （某一段合成卡住时不能把气泡冻在那里）。
 */
export const COMPANION_REVEAL_AUDIO_SILENCE_MS = 2_000;

/** 阅读钟的心跳间隔。60ms ≈ 16 字/秒，与 `estimateCompanionReadDurationMs` 同一条节奏。 */
export const COMPANION_REVEAL_TICK_MS = COMPANION_READ_MS_PER_CHAR;

export type CompanionRevealSessionMode = "voice" | "silent" | "unavailable";

export interface CompanionRevealDriverOptions {
  readonly now?: () => number;
  readonly leadChars?: number;
  readonly msPerChar?: number;
  readonly audioSilenceMs?: number;
  readonly onReveal?: (revealed: number) => void;
}

export interface CompanionRevealDriver {
  /** 此刻该露出的字数（对 `arrived` 取上限）。 */
  readonly revealed: number;
  /** 此刻已经拿到多少字（草稿长度 / 终态全文长度）。 */
  readonly arrived: number;
  /** 换轮：一切归零（不解除 `onComplete` 订阅）。 */
  reset(): void;
  /** 文本又到了多少字。**不会**推进 `revealed`。 */
  noteArrived(chars: number): void;
  /** 本轮语音会话的模式；没有会话传 `unavailable`。 */
  noteSession(mode: CompanionRevealSessionMode): void;
  /** 音频正在播（每 80ms 一次的真实播放进度）。 */
  noteAudioProgress(visibleChars: number): void;
  /** 音频播完：全文到手，可以收尾。 */
  noteAudioFinished(): void;
  /** 音频失败/被停：交回阅读钟。 */
  noteAudioStopped(): void;
  /** 这一轮不会再长了（`assistant.final` 已到）。 */
  noteTurnFinal(): void;
  /** 用户直接要看全文（点气泡）。 */
  finish(): void;
  /** 订阅"这一轮念完了"；返回解除函数。 */
  onComplete(listener: () => void): () => void;
  /** 阅读钟心跳：没有音频在说话时按阅读节奏推进。 */
  tick(): void;
}

export function createCompanionRevealDriver(
  options: CompanionRevealDriverOptions = {},
): CompanionRevealDriver {
  const now = options.now ?? ((): number => Date.now());
  const leadChars = Math.max(0, Math.floor(options.leadChars ?? COMPANION_REVEAL_LEAD_CHARS));
  const msPerChar = Math.max(1, Math.floor(options.msPerChar ?? COMPANION_READ_MS_PER_CHAR));
  const audioSilenceMs = Math.max(0, Math.floor(options.audioSilenceMs ?? COMPANION_REVEAL_AUDIO_SILENCE_MS));
  const listeners = new Set<() => void>();

  let arrived = 0;
  let revealed = 0;
  let sessionMode: CompanionRevealSessionMode = "unavailable";
  /** 最近一次音频进度的时间；null = 本轮还没有任何音频出过声。 */
  let audioAt: number | null = null;
  let audioCeiling = 0;
  let audioGaveUp = false;
  /** 阅读钟的起算点；null = 钟没在走（音频正在说话）。 */
  let clockStartedAt: number | null = null;
  let clockBase = 0;
  let arrivedAt: number | null = null;
  let turnFinal = false;
  let completed = false;

  const commit = (value: number): void => {
    const next = Math.min(arrived, Math.max(0, Math.floor(value)));
    if (next === revealed) return;
    revealed = next;
    options.onReveal?.(revealed);
  };

  const audioLive = (at: number): boolean =>
    !audioGaveUp && audioAt !== null && at - audioAt < audioSilenceMs;

  const completeIfDone = (): void => {
    if (completed || !turnFinal || revealed < arrived) return;
    completed = true;
    for (const listener of listeners) listener();
  };

  const tick = (): void => {
    const at = now();
    if (audioLive(at)) {
      // 音频在说话：它是唯一权威。钟挂起，等它停了再从头起算（不回退计数）。
      clockStartedAt = null;
      clockBase = revealed;
      return;
    }
    const waitingFirstAudio = sessionMode === "voice" && audioAt === null && !audioGaveUp;
    const waitedEnough = arrivedAt !== null && at - arrivedAt >= audioSilenceMs;
    if (waitingFirstAudio && !waitedEnough) {
      // 第一段音频还在路上：只放行提前量，剩下的等声音。
      commit(Math.max(revealed, Math.min(arrived, leadChars)));
    } else {
      if (clockStartedAt === null) {
        clockStartedAt = at;
        clockBase = revealed;
      }
      commit(Math.max(revealed, clockBase + Math.floor((at - clockStartedAt) / msPerChar)));
    }
    completeIfDone();
  };

  return {
    get revealed(): number {
      return revealed;
    },
    get arrived(): number {
      return arrived;
    },
    reset(): void {
      arrived = 0;
      revealed = 0;
      sessionMode = "unavailable";
      audioAt = null;
      audioCeiling = 0;
      audioGaveUp = false;
      clockStartedAt = null;
      clockBase = 0;
      arrivedAt = null;
      turnFinal = false;
      completed = false;
      options.onReveal?.(revealed);
    },
    noteArrived(chars: number): void {
      const next = Math.max(0, Math.floor(chars));
      // `arrived` 是"已知文本的最大值"：服务端回写（appendFrom 回退）会让草稿短暂变短，
      // 但那不会让已经显现的字收回去——显示端按**当前**文本切片，天然不会露出多余的尾巴。
      if (next > arrived) arrived = next;
      if (arrivedAt === null) arrivedAt = now();
      completeIfDone();
    },
    noteSession(mode: CompanionRevealSessionMode): void {
      sessionMode = mode;
    },
    noteAudioProgress(visibleChars: number): void {
      audioAt = now();
      audioGaveUp = false;
      audioCeiling = Math.max(audioCeiling, Math.max(0, Math.floor(visibleChars)));
      // 音频接管：钟停下，恢复时从当前位置重新起算。
      clockStartedAt = null;
      clockBase = revealed;
      commit(Math.max(revealed, Math.min(arrived, audioCeiling + leadChars)));
    },
    noteAudioFinished(): void {
      audioAt = now();
      audioGaveUp = true;
      clockStartedAt = null;
      commit(arrived);
      completeIfDone();
    },
    noteAudioStopped(): void {
      // 交回阅读钟：从"停的那一刻"起算，不等下一拍（否则气泡会先冻一下）。
      audioGaveUp = true;
      audioAt = null;
      clockStartedAt = now();
      clockBase = revealed;
    },
    noteTurnFinal(): void {
      turnFinal = true;
      completeIfDone();
    },
    finish(): void {
      commit(arrived);
      completeIfDone();
    },
    onComplete(listener: () => void): () => void {
      listeners.add(listener);
      // 已经收过尾的轮次（effect 因依赖变化重跑）必须立刻补一次：否则新挂上来的
      // 那个"收起气泡"回调永远不会被调用，气泡就留在屏幕上了。
      if (completed) listener();
      return () => {
        listeners.delete(listener);
      };
    },
    tick,
  };
}
