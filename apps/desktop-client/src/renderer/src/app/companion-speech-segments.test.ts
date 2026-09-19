import { describe, expect, it } from "vitest";
import {
  COMPANION_SPEECH_FEED_INITIAL,
  COMPANION_SPEECH_MAX_SEGMENT_CHARS,
  splitForSpeech,
  splitForSpeechIncremental,
} from "./companion-speech-segments";

function expectUsableSegments(segments: readonly { text: string; endIndex: number }[], limit: number, source: string) {
  expect(segments.length).toBeGreaterThan(0);
  for (const segment of segments) {
    // 服务端 `text.trim().min(1)` 会拒掉纯空白段。
    expect(segment.text.trim().length).toBeGreaterThan(0);
    expect(segment.text.length).toBeLessThanOrEqual(limit);
    // endIndex 必须真的指回原文：念到第几段 = 露出多少字。
    expect(source.slice(0, segment.endIndex).endsWith(segment.text)).toBe(true);
  }
  for (let index = 1; index < segments.length; index += 1) {
    expect(segments[index].endIndex).toBeGreaterThan(segments[index - 1].endIndex);
  }
}

describe("splitForSpeech", () => {
  it("returns nothing for blank input", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("   \n  ")).toEqual([]);
  });

  it("keeps a short reply in one segment", () => {
    const segments = splitForSpeech("好，我先看看你的复习队列。");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ text: "好，我先看看你的复习队列。", endIndex: 13 });
  });

  it("packs whole sentences up to the limit and never exceeds it", () => {
    const source = "第一句。第二句有点长，需要慢慢说清楚。第三句收尾。";
    const segments = splitForSpeech(source, 12);
    expectUsableSegments(segments, 12, source);
    expect(segments.map((segment) => segment.text)).toEqual([
      "第一句。第二句有点长，",
      "需要慢慢说清楚。",
      "第三句收尾。",
    ]);
    expect(segments.at(-1)?.endIndex).toBe(source.length);
  });

  it("hard-splits a run with no punctuation at all", () => {
    const source = "甲".repeat(250);
    const segments = splitForSpeech(source, 100);
    expect(segments.map((segment) => segment.text.length)).toEqual([100, 100, 50]);
    expect(segments.map((segment) => segment.endIndex)).toEqual([100, 200, 250]);
    expectUsableSegments(segments, 100, source);
  });

  it("prefers a clause break inside an over-long sentence", () => {
    const source = "这句话很长，需要先在这里停一下，然后再继续说。";
    const segments = splitForSpeech(source, 10);
    expectUsableSegments(segments, 10, source);
    expect(segments[0].text).toBe("这句话很长，");
  });

  it("folds paragraph gaps into the previous segment instead of emitting blanks", () => {
    const source = "第一段。\n\n第二段。";
    const segments = splitForSpeech(source);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe(source);
    expect(segments[0].endIndex).toBe(source.length);
  });

  it("uses the contract ceiling by default", () => {
    expect(COMPANION_SPEECH_MAX_SEGMENT_CHARS).toBe(120);
    const segments = splitForSpeech("乙".repeat(300));
    expect(segments.map((segment) => segment.text.length)).toEqual([120, 120, 60]);
  });

  it("survives a degenerate limit without dropping text", () => {
    const segments = splitForSpeech("甲乙丙", 0);
    expect(segments.map((segment) => segment.text)).toEqual(["甲", "乙", "丙"]);
  });
});

describe("splitForSpeechIncremental", () => {
  it("只在完整句之后成段，尾巴留到下一次", () => {
    const first = splitForSpeechIncremental("你好，我先看看", COMPANION_SPEECH_FEED_INITIAL);
    expect(first.segments).toEqual([]);
    const second = splitForSpeechIncremental("你好，我先看看你的复习队列。还", first.next);
    expect(second.segments.map((segment) => segment.text)).toEqual(["你好，我先看看你的复习队列。"]);
    expect(second.segments[0].endIndex).toBe(14);
  });

  it("重复喂同一份累积文本是幂等的（SSE 重连会重复投递）", () => {
    const text = "第一句。第二句。";
    // 已完成的两句一起成段（同一次调用里能切的都切）。
    const first = splitForSpeechIncremental(text, COMPANION_SPEECH_FEED_INITIAL);
    expect(first.segments.map((segment) => segment.text)).toEqual(["第一句。第二句。"]);
    // 同样的累积文本再喂一遍：没有新段（已经合成过的不会重来）。
    const again = splitForSpeechIncremental(text, first.next);
    expect(again.segments).toEqual([]);
    expect(splitForSpeechIncremental(text, again.next, true).segments).toEqual([]);
  });

  it("isFinal 把没有句末标点的尾巴强制成段（收尾不漏字）", () => {
    const result = splitForSpeechIncremental("先说一半没有标点", COMPANION_SPEECH_FEED_INITIAL, true);
    expect(result.segments.map((segment) => segment.text)).toEqual(["先说一半没有标点"]);
  });

  it("endIndex 是累积文本里的绝对下标（音频进度直接映射回原文）", () => {
    const text = "开头一句。第二句结束。";
    let state = COMPANION_SPEECH_FEED_INITIAL;
    const collected: { text: string; endIndex: number }[] = [];
    for (let index = 1; index <= text.length; index += 1) {
      const step = splitForSpeechIncremental(text.slice(0, index), state);
      state = step.next;
      collected.push(...step.segments);
    }
    const tail = splitForSpeechIncremental(text, state, true);
    collected.push(...tail.segments);
    expect(collected.map((segment) => segment.text)).toEqual(["开头一句。", "第二句结束。"]);
    expect(collected.map((segment) => segment.endIndex)).toEqual([5, 11]);
    expectUsableSegments(collected, COMPANION_SPEECH_MAX_SEGMENT_CHARS, text);
  });

  it("超长无标点的尾巴按上限硬切，不把整段憋到收尾", () => {
    const state = COMPANION_SPEECH_FEED_INITIAL;
    const text = "丙".repeat(150);
    const result = splitForSpeechIncremental(text, state);
    expect(result.segments.map((segment) => segment.text.length)).toEqual([120, 30]);
    expect(result.next.pendingStart).toBe(150);
  });

  it("跳过段间空白，不产出纯空白段", () => {
    const result = splitForSpeechIncremental("第一句。\n\n  ", COMPANION_SPEECH_FEED_INITIAL);
    expect(result.segments.map((segment) => segment.text)).toEqual(["第一句。"]);
    const tail = splitForSpeechIncremental("第一句。\n\n  ", result.next, true);
    expect(tail.segments).toEqual([]);
  });

  it("第一段在靠后的软断点提前开口（字幕不必等整句）", () => {
    const text = "我先看看你的复习队列，然后再决定";
    const first = splitForSpeechIncremental(text, COMPANION_SPEECH_FEED_INITIAL);
    expect(first.segments.map((segment) => segment.text)).toEqual(["我先看看你的复习队列，"]);
    expect(first.segments[0].endIndex).toBe(11);
    // 已经开过口：后续仍按句末标点成段，不再在逗号处切碎。
    const second = splitForSpeechIncremental(text, first.next);
    expect(second.segments).toEqual([]);
  });

  it("第一段提前开口也要求软断点不靠前，且达到最小长度", () => {
    // 够长（14 字）但逗号在第 2 个字：提前成段会切出一个碎片，不做。
    const tooEarly = splitForSpeechIncremental("嗯，那我就先说说这道题的思路", COMPANION_SPEECH_FEED_INITIAL);
    expect(tooEarly.segments).toEqual([]);
    // 还没到最小长度：继续等（这一拍也不该产出段）。
    const tooShort = splitForSpeechIncremental("我先看看你的，", COMPANION_SPEECH_FEED_INITIAL);
    expect(tooShort.segments).toEqual([]);
  });

  it("第一段提前开口不会改掉句末标点的优先级", () => {
    const first = splitForSpeechIncremental("好，我先看看你的队列。接着", COMPANION_SPEECH_FEED_INITIAL);
    expect(first.segments.map((segment) => segment.text)).toEqual(["好，我先看看你的队列。"]);
  });
});
