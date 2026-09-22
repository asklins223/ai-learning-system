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
 * **两个用途要分开**（方案 29 §14.11 修复 ②）：
 *
 * - `FIRST_AUDIO`：第一段音频的看门狗。合成有网络往返（实测 0.5–2.1s），在它到达前
 *   让文字先跑会变成"字念完了声音才来"，所以给足 2 秒。
 * - `GAP`：**已经在出声之后**，两次播放进度之间超过多久算"这一段卡住了"。
 *   实测播放进度每 ~80ms 一次（宿主 rAF + 客户端 80ms 节流），所以 800ms 相当于
 *   连丢十拍，正常播放不可能误触；而它决定了段间等待时文字最多冻多久。
 *   以前两者共用一个 2000ms 的数，于是任何 <2 秒的段间静音都会让**文字和声音一起冻住**
 *   （用户报的"内容和读音都卡住"）。
 */
export const COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS = 2_000;
export const COMPANION_REVEAL_GAP_SILENCE_MS = 800;
/**
 * 阅读钟最多领先音频多少字（见 `tick` 里那段注释）。
 *
 * 10 字 ≈ 2 秒朗读：够垫住一次卡顿（气泡不冻），又短到"音频一回来就对上"。
 * 它是**上限**不是速率——钟仍然按 `COMPANION_READ_MS_PER_CHAR` 走，只是走不远。
 */
export const COMPANION_REVEAL_MAX_DRIFT_CHARS = 10;

/** 阅读钟的心跳间隔。60ms ≈ 16 字/秒，与 `estimateCompanionReadDurationMs` 同一条节奏。 */
export const COMPANION_REVEAL_TICK_MS = COMPANION_READ_MS_PER_CHAR;

export type CompanionRevealSessionMode = "voice" | "silent" | "unavailable";

export interface CompanionRevealDriverOptions {
  readonly now?: () => number;
  readonly leadChars?: number;
  readonly msPerChar?: number;
  /** 第一段音频的看门狗；缺省 `COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS`。 */
  readonly firstAudioSilenceMs?: number;
  /** 出声之后判定"卡住"的间隔；缺省 `COMPANION_REVEAL_GAP_SILENCE_MS`。 */
  readonly gapSilenceMs?: number;
  /** 还有音频时阅读钟最多领先多少字；缺省 `COMPANION_REVEAL_MAX_DRIFT_CHARS`。 */
  readonly maxDriftChars?: number;
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
  const firstAudioSilenceMs = Math.max(
    0,
    Math.floor(options.firstAudioSilenceMs ?? COMPANION_REVEAL_FIRST_AUDIO_SILENCE_MS),
  );
  const gapSilenceMs = Math.max(0, Math.floor(options.gapSilenceMs ?? COMPANION_REVEAL_GAP_SILENCE_MS));
  const maxDriftChars = Math.max(0, Math.floor(options.maxDriftChars ?? COMPANION_REVEAL_MAX_DRIFT_CHARS));
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

  // 出声之后按"段间卡住"的短间隔判活；第一段还没来时 audioAt 为 null，这个判据不生效
  // （第一段由 tick 里的 firstAudioSilenceMs 看门狗负责）。
  const audioLive = (at: number): boolean =>
    !audioGaveUp && audioAt !== null && at - audioAt < gapSilenceMs;

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
    const waitedEnough = arrivedAt !== null && at - arrivedAt >= firstAudioSilenceMs;
    if (waitingFirstAudio && !waitedEnough) {
      // 第一段音频还在路上：只放行提前量，剩下的等声音。
      commit(Math.max(revealed, Math.min(arrived, leadChars)));
    } else {
      if (clockStartedAt === null) {
        clockStartedAt = at;
        clockBase = revealed;
      }
      const clockTarget = clockBase + Math.floor((at - clockStartedAt) / msPerChar);
      /**
       * **阅读钟不许把文字甩开音频太远**（2026-09-22 用户报"文字太快、气泡对不上"）。
       *
       * 阅读钟是 60ms/字（≈16.7 字/秒），而 TTS 实际约 4.6 字/秒——**快 2.6 倍**。
       * 而 `revealed` 只增不减，所以只要钟接管过一次，文字就永久停在音频前面：
       * 音频要花好几秒才追到那个位置，这期间气泡里的字和正在念的那句根本对不上。
       * 我 09-22 把"段间卡住"的判定从 2000ms 收到 800ms 之后，这件事从偶发变成了常态。
       *
       * 所以给钟加一条**只在本轮真的还有音频时**生效的上限：最多领先音频
       * `leadChars + MAX_DRIFT` 个字。它仍然能在段间静音时继续走一点（不冻住气泡），
       * 但走不远——音频一回来就重新对齐。音频彻底没了（stopped/finished/静音模式）
       * 时这条上限取消，钟照旧按阅读节奏把全文走完。
       */
      // "音频还在路上"：出过声（audioAt 有值）就一直算它在；一次都没出过声时，
      // 等满两倍第一段看门狗就认为"这一轮不会出声了"，上限取消——否则一段永远
      // 不来的音频会把文字永久钉在 lead+drift 上，气泡再也收不了尾。
      const audioPending = sessionMode === "voice" && !audioGaveUp
        && (audioAt !== null || (arrivedAt !== null && at - arrivedAt < firstAudioSilenceMs * 2));
      const cap = audioPending ? audioCeiling + leadChars + maxDriftChars : arrived;
      commit(Math.min(Math.max(revealed, clockTarget), cap));
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
