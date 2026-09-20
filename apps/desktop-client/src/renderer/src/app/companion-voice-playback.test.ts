import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionVoiceSpeakSegmentRequestV2 } from "@ailearn/shared/companion-voice-contracts";
import {
  beginCompanionSpeechLine,
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

  synthesize(text: string): Promise<AudioBuffer> {
    this.synthesized.push(text);
    if (this.failFor.has(text)) return Promise.reject(new Error("合成失败"));
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

  /** 让当前这一段播完。 */
  finishSegment(): void {
    this.resolvers.shift()?.();
  }

  /** 报告当前段的播放进度（0..1）。 */
  reportProgress(fraction: number): void {
    this.progressHandlers.at(-1)?.(fraction);
  }
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
    await flush();
    host.finishSegment();
    await flush();

    expect(host.played).toEqual(["第一句。", "第三句。"]);
    expect(events.at(-1)).toMatchObject({ phase: "finished", planId: session.planId });
  });
});
