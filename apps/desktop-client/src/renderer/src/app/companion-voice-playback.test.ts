import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompanionVoicePlaybackOutcomeRequestV1,
  CompanionVoiceSpeakSegmentRequestV2,
} from "@ailearn/shared/companion-voice-contracts";
import {
  COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS,
  COMPANION_SPEECH_GAP_DEADLINE_MS,
  COMPANION_SPEECH_PLAY_STALL_MS,
  beginCompanionSpeechLine,
  isCompanionSpeechActive,
  resetCompanionVoicePlayback,
  setCompanionVoiceHost,
  speakCompanionLine,
  stopCompanionSpeech,
  subscribeCompanionSpeech,
  type CompanionSpeechProgress,
  type CompanionVoiceHost,
} from "./companion-voice-playback";

/** 三段、每段 61 字：刚好越过 120 字上限，切成三段。 */
const THREE_LINE = ["甲".repeat(60), "乙".repeat(60), "丙".repeat(60)].map((part) => `${part}。`).join("");
const THREE_SEGMENT_ENDS = [61, 122, 183];

function buffer(id: string): AudioBuffer {
  return { id } as unknown as AudioBuffer;
}

function bufferId(value: AudioBuffer): string {
  return String((value as unknown as { id: string }).id);
}

/** play() 挂住不 resolve，测试自己决定什么时候"播完"、播到几成。 */
class FakeHost implements CompanionVoiceHost {
  readonly synthesized: string[] = [];
  readonly played: string[] = [];
  readonly failFor = new Set<string>();
  audibleValue = true;
  private resolvers: Array<() => void> = [];
  private progressHandlers: Array<(fraction: number) => void> = [];

  audible(): boolean {
    return this.audibleValue;
  }

  /** 命中即"永远不返回"，用来触发段级截止（方案 29 §4.9）。 */
  hangFor = new Set<string>();

  synthesize(text: string): Promise<AudioBuffer> {
    this.synthesized.push(text);
    if (this.failFor.has(text)) return Promise.reject(new Error("合成失败"));
    if (this.hangFor.has(text)) return new Promise<AudioBuffer>(() => undefined);
    return Promise.resolve(buffer(text));
  }

  /** 严格片段通道：测试里以 segmentId 为键，与 synthesize 共用失败表。 */
  synthesizeSegment(ref: CompanionVoiceSpeakSegmentRequestV2): Promise<AudioBuffer> {
    return this.synthesize(ref.segmentId);
  }

  play(value: AudioBuffer, onProgress: (fraction: number) => void): Promise<void> {
    this.played.push(bufferId(value));
    this.progressHandlers.push(onProgress);
    return new Promise<void>((resolve) => { this.resolvers.push(resolve); });
  }

  stop(): void {
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /** 每一段的结局上报（0247）——这段测试断言的就是这只数组。 */
  readonly reports: CompanionVoicePlaybackOutcomeRequestV1[] = [];

  reportSegmentOutcome(report: CompanionVoicePlaybackOutcomeRequestV1): void {
    this.reports.push(report);
  }

  /** 让当前这一段播完。 */
  finishSegment(): void {
    this.resolvers.shift()?.();
  }

  /** 报告当前段的播放进度（0..1）。 */
  reportProgress(fraction: number): void {
    this.progressHandlers.at(-1)?.(fraction);
  }
}

/**
 * 等真实时间里的某个条件成立。
 *
 * 失败段的合成现在带退避重试（250ms、500ms），`setTimeout(0)` 的 flush 跨不过去；
 * 断言"跳过坏段、后面的照常念"必须用真实等待，且**不写死重试次数**——
 * 重试策略以后再调，这条测试不该跟着一起改。
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil 超时");
}

/** 让所有排队的微任务跑完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function collect(): CompanionSpeechProgress[] {
  const events: CompanionSpeechProgress[] = [];
  subscribeCompanionSpeech((progress) => events.push(progress));
  return events;
}

afterEach(() => {
  resetCompanionVoicePlayback();
});

describe("speakCompanionLine", () => {
  it("returns null for blank text", () => {
    setCompanionVoiceHost(new FakeHost());
    expect(speakCompanionLine("   ")).toBeNull();
  });

  it("reveals one segment at a time and finishes on the full text", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const handle = speakCompanionLine(THREE_LINE);
    expect(handle?.mode).toBe("voice");
    expect(handle?.segments.map((segment) => segment.endIndex)).toEqual(THREE_SEGMENT_ENDS);

    await flush();
    expect(events.at(-1)).toMatchObject({ phase: "speaking", segmentIndex: 0, visibleChars: 1 });

    host.finishSegment();
    await flush();
    expect(events.at(-1)).toMatchObject({ phase: "speaking", segmentIndex: 1, visibleChars: 62 });

    host.finishSegment();
    await flush();
    expect(events.at(-1)).toMatchObject({ phase: "speaking", segmentIndex: 2, visibleChars: 123 });

    host.finishSegment();
    await flush();
    expect(events.at(-1)).toMatchObject({ phase: "finished", visibleChars: 183 });
    expect(host.played).toEqual([THREE_LINE.slice(0, 61), THREE_LINE.slice(61, 122), THREE_LINE.slice(122)]);
  });

  it("reveals the reply in step with the audio instead of dumping the whole sentence", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    speakCompanionLine(THREE_LINE);
    await flush();
    // 开口就有字：空节点不会渲染，用户会觉得她没说话。
    expect(events.at(-1)).toMatchObject({ phase: "speaking", segmentIndex: 0, visibleChars: 1 });

    clock.mockReturnValue(100);
    host.reportProgress(0.5);
    await flush();
    expect(events.at(-1)?.phase).toBe("speaking");
    expect(events.at(-1)?.visibleChars).toBe(30);

    clock.mockReturnValue(200);
    host.reportProgress(1);
    await flush();
    expect(events.at(-1)?.visibleChars).toBe(61);

    clock.mockRestore();
  });

  it("throttles progress broadcasts so the bubble is not re-rendered per frame", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    speakCompanionLine(THREE_LINE);
    await flush();
    const before = events.length;

    host.reportProgress(0.3);
    host.reportProgress(0.4);
    host.reportProgress(0.5);
    await flush();
    expect(events.length).toBe(before);

    clock.mockReturnValue(120);
    host.reportProgress(0.6);
    await flush();
    expect(events.length).toBe(before + 1);

    clock.mockRestore();
  });

  it("synthesizes the next segment while the current one is still playing", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);

    speakCompanionLine(THREE_LINE);
    await flush();
    // 第一段才刚开始播，第二段已经在路上。
    expect(host.played).toHaveLength(1);
    expect(host.synthesized).toEqual([
      THREE_LINE.slice(0, 61),
      THREE_LINE.slice(61, 122),
    ]);
  });

  it("re-synthesizes a segment whose prefetch failed instead of dropping it", async () => {
    const host = new FakeHost();
    host.failFor.add(THREE_LINE.slice(61, 122));
    setCompanionVoiceHost(host);
    const events = collect();

    speakCompanionLine(THREE_LINE);
    await flush();
    host.failFor.clear();
    host.finishSegment();
    await flush();

    expect(events.at(-1)).toMatchObject({ phase: "speaking", segmentIndex: 1, visibleChars: 62 });
    expect(host.synthesized.filter((text) => text === THREE_LINE.slice(61, 122))).toHaveLength(2);
  });

  it("skips a segment whose synthesis keeps failing instead of killing the line", async () => {
    // 2026-09-19 语义变更：单段合成反复失败曾把整轮语音判死（用户实测
    // "只读第一句甚至前几个字"）。现在失败段跳过，后面的段照常念。
    const host = new FakeHost();
    host.failFor.add(THREE_LINE.slice(0, 61));
    setCompanionVoiceHost(host);
    const events = collect();

    speakCompanionLine(THREE_LINE);
    await flush();
    host.finishSegment();
    await flush();
    host.finishSegment();
    await flush();

    expect(events.filter((event) => event.phase === "failed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ phase: "finished" });
    expect(host.played).toEqual([THREE_LINE.slice(61, 122), THREE_LINE.slice(122)]);
  });

  it("stays silent (and leaves timing to the caller) when the host cannot be heard", () => {
    const host = new FakeHost();
    host.audibleValue = false;
    setCompanionVoiceHost(host);
    const events = collect();

    const handle = speakCompanionLine(THREE_LINE);
    expect(handle?.mode).toBe("silent");
    expect(handle?.segmentCount).toBe(3);
    expect(events).toEqual([]);
    expect(host.synthesized).toEqual([]);
  });

  it("stays silent when no host is registered at all", () => {
    const handle = speakCompanionLine("说一句。");
    expect(handle?.mode).toBe("silent");
  });

  it("replaces the line being spoken instead of queueing behind it", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const first = speakCompanionLine(THREE_LINE);
    await flush();
    speakCompanionLine("换一句新的。");
    await flush();

    expect(host.played.at(-1)).toBe("换一句新的。");
    // 被打断的那一句只会走到 stopped，绝不会继续推进或宣告念完。
    expect(events.filter((event) => event.planId === first?.planId).map((event) => event.phase))
      .toEqual(["speaking", "stopped"]);
  });

  it("stops on demand", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const handle = speakCompanionLine(THREE_LINE);
    await flush();
    handle?.stop();

    expect(events.at(-1)?.phase).toBe("stopped");
    const afterStop = events.length;
    host.finishSegment();
    await flush();
    expect(events.length).toBe(afterStop);
  });

  it("stops the line in flight when the host goes away", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    speakCompanionLine(THREE_LINE);
    await flush();
    setCompanionVoiceHost(null);

    expect(events.at(-1)?.phase).toBe("stopped");
    expect(() => stopCompanionSpeech()).not.toThrow();
  });
});

describe("beginCompanionSpeechLine", () => {
  it("keeps queueing later sentences when the caller feeds deltas (regression: only the first sentence was spoken)", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const session = beginCompanionSpeechLine();
    expect(session.mode).toBe("voice");

    // 流式路径喂的是**增量**（每一拍新到的文本）——2026-09-19 之前增量被直接交给
    // 按累积下标工作的切段器，第二拍起切出空串，第一句之后再也没声音。
    session.feed("第一句。");
    await flush();
    expect(host.played).toEqual(["第一句。"]);

    session.feed("第二句。");
    session.feed("第三句。");
    session.finish("");
    await flush();

    host.finishSegment();
    await flush();
    host.finishSegment();
    await flush();
    host.finishSegment();
    await flush();

    expect(host.synthesized).toEqual(["第一句。", "第二句。", "第三句。"]);
    expect(events.at(-1)).toMatchObject({ phase: "finished", planId: session.planId, visibleChars: 12 });
  });

  it("forces the pending tail into a segment on finish so nothing is dropped", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const session = beginCompanionSpeechLine();
    session.feed("第一句。");
    await flush();
    host.finishSegment();
    await flush();
    session.finish("尾巴没有句号");
    await flush();
    host.finishSegment();
    await flush();

    expect(host.synthesized).toEqual(["第一句。", "尾巴没有句号"]);
    expect(events.at(-1)).toMatchObject({ phase: "finished", planId: session.planId });
  });

  it("ignores empty feeds instead of corrupting the accumulation", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();

    const session = beginCompanionSpeechLine();
    session.feed("");
    session.feed("只有一句。");
    session.finish("");
    await flush();
    host.finishSegment();
    await flush();

    expect(host.synthesized).toEqual(["只有一句。"]);
    expect(events.at(-1)).toMatchObject({ phase: "finished" });
  });

  it("keeps speaking later sentences when one queued segment fails to synthesize", async () => {
    // 排队路径同一条语义：中间一段合成反复失败 → 跳过它，第三句照常念，
    // 整轮正常收尾（不再"第一句之后全队沉默"）。
    const host = new FakeHost();
    host.failFor.add("第二句。");
    setCompanionVoiceHost(host);
    const events = collect();

    const session = beginCompanionSpeechLine();
    session.feed("第一句。");
    await flush();
    session.feed("第二句。");
    session.feed("第三句。");
    session.finish("");
    await flush();

    host.finishSegment();
    await waitUntil(() => host.played.includes("第三句。"));
    host.finishSegment();
    await flush();

    expect(host.played).toEqual(["第一句。", "第三句。"]);
    expect(events.at(-1)).toMatchObject({ phase: "finished", planId: session.planId });
  });

  it("首段合成超时只跳过那一段，不再把整轮音频作废（方案 29 §4.9）", async () => {
    // 回归护栏：旧行为是首段截止一到就 `generation += 1` + `host.stop()` +
    // phase:"text_only"，于是"文字显示出来但语音根本不读"、且当轮不可恢复。
    // 现在超时只丢那一段，后面的照常念，整轮以 finished 收尾。
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      host.hangFor.add("第一句。");
      setCompanionVoiceHost(host);
      const events = collect();

      const session = beginCompanionSpeechLine();
      session.feed("第一句。");
      session.feed("第二句。");
      session.finish("");

      // 推进到首段截止之后；重试的退避落在同一段预算内，不会突破 deadline。
      await vi.advanceTimersByTimeAsync(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS + 50);
      await vi.runAllTimersAsync();

      expect(host.played).toEqual(["第二句。"]);
      expect(events.some((e) => e.phase === "text_only")).toBe(false);
      expect(events.some((e) => e.phase === "speaking")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("整轮一段都没播出来时才降级 text_only（不静默无声）", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      host.hangFor.add("只有一句。");
      setCompanionVoiceHost(host);
      const events = collect();

      const session = beginCompanionSpeechLine();
      session.feed("只有一句。");
      session.finish("");

      await vi.advanceTimersByTimeAsync(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS + 50);
      await vi.runAllTimersAsync();

      expect(host.played).toEqual([]);
      expect(events.at(-1)).toMatchObject({ phase: "text_only" });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 一段音频的结局上报（0247，抱怨 #4「语音经常没声音」的下半场）。
 *
 * 服务端那一半只能证明"字节交出去了"；这段测试固定的是**只有渲染进程知道**的那一半：
 * 播成了、等到超时被跳过、取段就失败了，三态各上报一次，且都带着能回到那一段的身份。
 * 反过来两条同样重要：**没 ref 的本地文本路径不产生任何上报**（没有可归因的对象），
 * **被打断的一轮不把没播完的段记成播过了**（否则"失败率"会随用户打字速度浮动）。
 */
describe("逐段播放结局上报", () => {
  const CONVERSATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const RUN_ID = "11111111-2222-3333-4444-555555555555";
  const segmentIdFor = (ordinal: number): string =>
    `${ordinal.toString(16).padStart(2, "0")}${"0".repeat(62)}`;

  function refSegment(ordinal: number, text: string) {
    const start = (ordinal - 1) * 10;
    return {
      ref: {
        version: 2 as const,
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        generation: 1,
        ordinal,
        segmentId: segmentIdFor(ordinal),
      },
      displayText: text,
      displayStart: start,
      displayEnd: start + text.length,
      cue: { version: 1 as const, intent: "explain" as const, emotion: "neutral" as const, intensity: 0.5 },
    };
  }

  function strictSessionWithRef(host: FakeHost, count = 1) {
    const session = beginCompanionSpeechLine({ strictSegments: true });
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      session.feedSegment(refSegment(ordinal, `第${ordinal}句。`));
    }
    session.finish("");
    return session;
  }

  // 方案 29 §14.11 修复 ①：预取原来只有一个触发点——某一段**出队之后**。
  // 于是第 1 段到达时队列里只有它（预取无事可做），第 2…N 段在第 1 段播放期间到达
  // 却没人开始合成，等第 1 段播完才开始——整段合成时间变成静音。
  // 实测（48h / 61 次段间切换）：进入第 2 段的切换 **82% 有 >0.3s 静音**，中位 0.58s。
  it("服务端签发的第 2 段一到就开始合成，不等第 1 段播完", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const session = beginCompanionSpeechLine({ strictSegments: true });

    session.feedSegment(refSegment(1, "第一句。"));
    await waitUntil(() => host.played.length === 1);
    expect(host.synthesized).toEqual([segmentIdFor(1)]);

    // 第 1 段还在播（play() 没 resolve），第 2 段到了。
    session.feedSegment(refSegment(2, "第二句。"));
    await waitUntil(() => host.synthesized.length === 2);
    expect(host.played).toHaveLength(1);           // 第 1 段确实还没播完
    expect(host.synthesized[1]).toBe(segmentIdFor(2));

    session.finish("");
  });

  it("播完的段上报 played，并带上这段的身份", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    strictSessionWithRef(host);

    await waitUntil(() => host.played.length === 1);
    host.finishSegment();
    await waitUntil(() => host.reports.length === 1);

    expect(host.reports[0]).toMatchObject({
      version: 1,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      generation: 1,
      ordinal: 1,
      segmentId: segmentIdFor(1),
      reason: "played",
    });
    expect(host.reports[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("等到超时的段上报 deadline，而不是悄悄丢掉", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      host.hangFor.add(segmentIdFor(1));
      setCompanionVoiceHost(host);
      strictSessionWithRef(host, 2);

      await vi.advanceTimersByTimeAsync(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS + 50);

      expect(host.reports).toHaveLength(1);
      expect(host.reports[0]).toMatchObject({ ordinal: 1, reason: "deadline" });
      // 超时是按段判定的，后面的段仍要能播完并各自上报。
      // 这里**不能**用 `runAllTimersAsync()`：播放封顶那条计时器也在里面，跑光所有
      // 计时器等于宣布"第 2 段的音频钟也停住了"，那条 dropped 会把断言搅浑。
      await vi.advanceTimersByTimeAsync(10);
      host.finishSegment();
      await vi.advanceTimersByTimeAsync(10);
      expect(host.reports[1]).toMatchObject({ ordinal: 2, reason: "played" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("取段本身就失败的段上报 synth_failed", async () => {
    const host = new FakeHost();
    host.failFor.add(segmentIdFor(1));
    setCompanionVoiceHost(host);
    strictSessionWithRef(host);

    await waitUntil(() => host.reports.length === 1);
    expect(host.reports[0]).toMatchObject({
      ordinal: 1,
      segmentId: segmentIdFor(1),
      reason: "synth_failed",
    });
    expect(host.played).toEqual([]);
  });

  // 实机 2026-09-22 为了一段"给了音频却没响"只能跨表反推：客户端在"字节到手又被打断"
  // 这些分支上一个字都不报，于是"没在线"与"没响"在同一张表里长得一模一样。
  it("被打断时已预取却没播的段上报 dropped，且记成 rejected 而不是失败", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    strictSessionWithRef(host, 3);

    await waitUntil(() => host.played.length === 1);
    stopCompanionSpeech();
    host.finishSegment();
    await waitUntil(() => host.reports.some((report) => report.reason === "dropped"));

    const dropped = host.reports
      .filter((report) => report.reason === "dropped")
      .map((report) => report.ordinal)
      .sort();
    // played 只由正常路径写：play() 被 stop() 提前 resolve 时没人能证明用户听见了。
    // 预取深度 2：第 1 段在播时第 2、3 段的字节已经在路上，打断后它们永远不会有
    // 第二条结局——这一段就是那条"没响"的证据。
    expect(dropped).toEqual([1, 2, 3]);
    expect(host.reports.filter((report) => report.reason === "played")).toEqual([]);
  });

  // 实机 2026-09-22 03:59：一整轮的音频钟停住过（14/15/16 三段的 `played` 在同一秒里
  // 补吐出来），循环就停在 `await host.play()` 上——那一行之后再也没有 generation 检查，
  // 于是那一轮预取到手的段带着服务端的 `synth ok` 行永远没有结局（报表里那 3 段
  // "音频已交付却零上报"就是它）。播这一等必须封顶。
  it("play() 永不返回（音频钟停住）时按 dropped 收口，并把整轮放开", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const events = collect();
    strictSessionWithRef(host, 2);

    await waitUntil(() => host.played.length === 1);
    host.finishSegment();                      // 第 1 段正常播完 → played
    await waitUntil(() => host.reports.length === 1);
    expect(host.reports[0]).toMatchObject({ ordinal: 1, reason: "played" });

    // 第 2 段：字节到手（FakeHost 的合成即时 resolve），但 play() 这一次不再返回。
    await waitUntil(() => host.played.length === 2);
    await waitUntil(
      () => host.reports.some((report) => report.reason === "dropped"),
      COMPANION_SPEECH_PLAY_STALL_MS + 3_000,
    );

    expect(host.reports.at(-1)).toMatchObject({ ordinal: 2, reason: "dropped" });
    // 卡住的那一轮必须把 `activePlanId` 放开：否则她永远"在说话"，
    // 主动提示音会一直给这条不存在的朗读让路（isCompanionSpeechActive 是那条让路的判据）。
    expect(isCompanionSpeechActive()).toBe(false);
    expect(events.some((event) => event.phase === "stopped")).toBe(true);
  });

  it("还在路上的预取不算 dropped：字节没到手的段不编造「给了音频没响」", async () => {
    const host = new FakeHost();
    // 第 2 段是"当前正在等"的那一条，第 4 段是**已发起却没到手**的预取；
    // 只有第 3 段真的拿到了字节。断言的方向因此只能是"恰好一条"。
    host.hangFor.add(segmentIdFor(2));
    host.hangFor.add(segmentIdFor(4));
    setCompanionVoiceHost(host);
    strictSessionWithRef(host, 4);

    await waitUntil(() => host.played.length === 1);
    host.finishSegment();                      // 第 1 段播完 → 取第 2 段，卡在等字节
    await waitUntil(() => host.reports.length === 1);
    stopCompanionSpeech();                     // 用户在这时打断

    await waitUntil(
      () => host.reports.some((report) => report.reason === "dropped"),
      COMPANION_SPEECH_GAP_DEADLINE_MS + 3_000,
    );
    expect(host.reports.filter((report) => report.reason === "dropped").map((report) => report.ordinal))
      .toEqual([3]);
  });

  it("本地文本路径（服务端没签段引用）不产生任何上报", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    const session = beginCompanionSpeechLine();
    session.feed("第一句。");
    session.finish("");

    await waitUntil(() => host.played.length === 1);
    host.finishSegment();
    await flush();
    expect(host.reports).toEqual([]);
  });

  it("被打断的一轮不把没播完的段记成播过了", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    strictSessionWithRef(host, 2);

    await waitUntil(() => host.played.length === 1);
    // 用户开口打断：generation 前进 + host.stop() 让 play() resolve。
    stopCompanionSpeech();
    await flush();
    await flush();

    expect(host.reports.filter((report) => report.reason === "played")).toEqual([]);
  });

  // 方案 29 §12 C5 的判据：「取段成功但没有 playback 行的段，必须有一个明确的
  // reason 上报」。它以前靠"每条 return 前记得报一次"维持，于是**外层 catch**
  // 那条出口漏了——循环里任何一处意外抛错都会让已到手的字节只剩服务端的 synth ok 行。
  // 这里用一个"在 speaking 阶段抛错的订阅者"复现那条出口（emit 是同步调用监听器）。
  it("意外异常也必须给已到手的段一个终态，不能只留服务端 synth ok 行", async () => {
    const host = new FakeHost();
    setCompanionVoiceHost(host);
    subscribeCompanionSpeech((progress) => {
      if (progress.phase === "speaking") throw new Error("emit 抛错（模拟循环里的意外异常）");
    });
    strictSessionWithRef(host, 3);

    await waitUntil(() => host.reports.length > 0);

    // 第 1 段（在飞）+ 第 2、3 段（预取深度 2、字节已到手）都要有结局；
    // played 一条都不该有——play() 根本没走完。
    expect(host.reports.map((report) => report.reason)).toEqual(["dropped", "dropped", "dropped"]);
    expect(host.reports.map((report) => report.ordinal).sort()).toEqual([1, 2, 3]);
  });
});
