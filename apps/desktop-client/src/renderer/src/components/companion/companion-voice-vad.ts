/**
 * 伴星语音输入的静音自动结束判定（2026-09-18）。
 *
 * 交互是「点一下开始说」，所以必须由渲染层判断用户什么时候说完了。判定要同时
 * 挡住两种情况：一声咳嗽就掐掉录音，以及用户还在想词时提前收尾。因此要求累计
 * 人声时长先到 `minSpeechMs`（自动结束才"武装"），之后连续静音 `silenceMs` 才
 * 收尾。纯函数，节拍由 `CompanionVoiceRecorder` 的 onLevel 回调驱动，便于单测。
 */

export interface CompanionVadState {
  /** 累计越过阈值的人声时长；用来武装自动结束。 */
  readonly speechMs: number;
  /** 上一次步进的时间，用来算这一拍的增量。 */
  readonly lastStepAt: number | null;
  /** 最近一次越过阈值的时间；静音计时从这里开始。 */
  readonly lastVoiceAt: number | null;
}

export const COMPANION_VAD_INITIAL_STATE: CompanionVadState = Object.freeze({
  speechMs: 0,
  lastStepAt: null,
  lastVoiceAt: null,
});

export const COMPANION_VAD_TUNING = Object.freeze({
  /** 判定"在说话"的振幅阈值，与 voice-recorder 的 RMS 同一量纲（0..1）。 */
  threshold: 0.045,
  /** 人声累计到这么久，自动结束才武装。 */
  minSpeechMs: 350,
  /** 连续静音这么久就收尾。 */
  silenceMs: 1_200,
});

export type CompanionVadVerdict = "listening" | "stop";

export interface CompanionVadInput {
  readonly level: number;
  readonly at: number;
  readonly threshold?: number;
  readonly minSpeechMs?: number;
  readonly silenceMs?: number;
}

export interface CompanionVadStep {
  readonly state: CompanionVadState;
  readonly verdict: CompanionVadVerdict;
}

export function companionVadStep(state: CompanionVadState, input: CompanionVadInput): CompanionVadStep {
  const threshold = input.threshold ?? COMPANION_VAD_TUNING.threshold;
  const minSpeechMs = input.minSpeechMs ?? COMPANION_VAD_TUNING.minSpeechMs;
  const silenceMs = input.silenceMs ?? COMPANION_VAD_TUNING.silenceMs;

  const delta = state.lastStepAt === null ? 0 : Math.max(0, input.at - state.lastStepAt);
  const voiced = input.level >= threshold;
  const next: CompanionVadState = {
    speechMs: voiced ? state.speechMs + delta : state.speechMs,
    lastStepAt: input.at,
    lastVoiceAt: voiced ? input.at : state.lastVoiceAt,
  };

  if (next.speechMs < minSpeechMs || next.lastVoiceAt === null) {
    return { state: next, verdict: "listening" };
  }
  return {
    state: next,
    verdict: input.at - next.lastVoiceAt >= silenceMs ? "stop" : "listening",
  };
}
