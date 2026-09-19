import { describe, expect, it } from "vitest";
import {
  COMPANION_VAD_INITIAL_STATE,
  COMPANION_VAD_TUNING,
  companionVadStep,
  type CompanionVadState,
  type CompanionVadVerdict,
} from "./companion-voice-vad";

const TICK_MS = 50;

/** 按录音器 20Hz 的节拍推一组电平，返回首次触发 stop 的时间。 */
function run(levels: readonly number[], options?: { readonly startAt?: number }): {
  readonly stopAt: number | null;
  readonly state: CompanionVadState;
  readonly verdict: CompanionVadVerdict;
} {
  let state = COMPANION_VAD_INITIAL_STATE;
  let verdict: CompanionVadVerdict = "listening";
  let stopAt: number | null = null;
  let at = options?.startAt ?? 0;
  for (const level of levels) {
    const step = companionVadStep(state, { level, at });
    state = step.state;
    verdict = step.verdict;
    if (step.verdict === "stop" && stopAt === null) stopAt = at;
    at += TICK_MS;
  }
  return { stopAt, state, verdict };
}

function constant(level: number, count: number): number[] {
  return Array.from({ length: count }, () => level);
}

describe("companionVadStep", () => {
  it("never auto-stops when nobody spoke", () => {
    const { verdict, state } = run(constant(0.001, 200));
    expect(verdict).toBe("listening");
    expect(state.speechMs).toBe(0);
  });

  it("does not arm auto-stop from a short noise burst", () => {
    // 一声咳嗽：两拍越过阈值（约 50ms 累计），远不到 minSpeechMs。
    const { verdict, state } = run([0.2, 0.2, ...constant(0.001, 200)]);
    expect(state.speechMs).toBeLessThan(COMPANION_VAD_TUNING.minSpeechMs);
    expect(verdict).toBe("listening");
  });

  it("stops after minSpeechMs of speech followed by silenceMs of quiet", () => {
    const speech = constant(0.3, 11); // at 0..500ms
    const silence = constant(0.001, 30);
    const { stopAt } = run([...speech, ...silence]);
    // 人声在 500ms 结束，静音 1200ms 后收尾。
    expect(stopAt).toBe(500 + COMPANION_VAD_TUNING.silenceMs);
  });

  it("keeps listening while the user keeps talking", () => {
    const { verdict } = run(constant(0.3, 200));
    expect(verdict).toBe("listening");
  });

  it("restarts the silence clock every time speech resumes", () => {
    const { stopAt } = run([
      ...constant(0.3, 11), // 500ms 人声 → 武装
      ...constant(0.001, 10), // 500ms 静音，还没到 1200ms
      ...constant(0.3, 10), // 又说了一句 → 重新计时
      ...constant(0.001, 40),
    ]);
    expect(stopAt).toBe(500 + 500 + 500 + COMPANION_VAD_TUNING.silenceMs);
  });

  it("honours an explicit threshold", () => {
    const belowDefault = 0.02; // 默认阈值 0.045 之下，自定义阈值 0.01 之上
    expect(run(constant(belowDefault, 80)).state.speechMs).toBe(0);

    let state: CompanionVadState = COMPANION_VAD_INITIAL_STATE;
    let verdict: CompanionVadVerdict = "listening";
    let at = 0;
    const feed = (level: number, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const step = companionVadStep(state, { level, at, threshold: 0.01, minSpeechMs: 100, silenceMs: 200 });
        state = step.state;
        verdict = step.verdict;
        at += TICK_MS;
      }
    };
    feed(belowDefault, 4);
    expect(verdict).toBe("listening");
    feed(0.001, 10);
    expect(verdict).toBe("stop");
  });
});
