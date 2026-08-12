import { test } from "node:test";
import assert from "node:assert/strict";
import {
  purifyVoiceText,
  splitCompanionTtsSegments,
  companionSegmentId,
  TTS_MAX_SEGMENTS,
  TTS_MAX_TOTAL_CHARS,
} from "./tts-segments.ts";

test("净化：去掉 markdown/URL/代码块，保留中文", () => {
  const p = purifyVoiceText("好的，`x` 继续 [链接](https://a.b/c) 学习。```code``` 我们继续。");
  assert.equal(p.includes("https"), false, "URL 剔除");
  assert.equal(p.includes("```"), false, "代码块剔除");
  assert.ok(p.includes("好的"), "中文保留");
  assert.ok(p.includes("我们继续"));
});

test("净化：保留正文半角括号/连字符，只剥离 markdown 语法", () => {
  const p = purifyVoiceText("第3-4题 (b)：**重点** 请参考 [文档](https://a.b/c)。");
  assert.ok(p.includes("第3-4题 (b)"), "半角括号与连字符保留");
  assert.ok(p.includes("重点"), "强调内容保留");
  assert.ok(p.includes("文档"), "链接文字保留");
  assert.equal(p.includes("**"), false, "强调标记剥离");
  assert.equal(p.includes("https"), false, "URL 剥离");
});

test("切句：按。！？切分后贪心合并相邻句，ordinal 递增，textSha256 64 hex", () => {
  // 2026-08-12：段落间隔优化——相邻句子贪心合并到目标段长（≤120 字符）。
  // 三句短句应合并为 1-2 段（旧行为每句一段=3 段，段间独立 TTS 请求造成
  // 朗读间隔被成倍放大）。
  const segs = splitCompanionTtsSegments("这是第一句的内容。这是第二句的内容！这是第三句的内容？");
  assert.ok(segs.length >= 1 && segs.length <= 2, `合并后段数=${segs.length}`);
  for (const s of segs) {
    assert.ok(s.ordinal >= 1 && s.ordinal <= TTS_MAX_SEGMENTS);
    assert.match(s.textSha256, /^[a-f0-9]{64}$/);
    assert.match(s.segmentId, /^[a-f0-9]{64}$/);
  }
  // 合并段应保留全部句子文本，且段内自然衔接
  const all = segs.map((s) => s.text).join("");
  assert.ok(all.includes("第一句") && all.includes("第二句") && all.includes("第三句"));
  assert.equal(segs[0].ordinal, 1);
});

test("切句：单段 ≤160 字符，超长在标点处强制切分", () => {
  const long = "这是一个很长的句子，没有句号只有逗号，" + "啊".repeat(300) + "结束";
  const segs = splitCompanionTtsSegments(long);
  for (const s of segs) {
    assert.ok(s.text.length <= 160, `segment ${s.ordinal} len=${s.text.length}`);
  }
  assert.ok(segs.length > 1, "超长被切分");
});

test("切句：上限 20 段与 2000 字（超限只显示文字）", () => {
  const many = Array.from({ length: 30 }, (_, i) => `第${i + 1}段句子内容。`).join("");
  const segs = splitCompanionTtsSegments(many);
  assert.ok(segs.length <= TTS_MAX_SEGMENTS, `segments=${segs.length}`);
  const total = segs.reduce((acc, s) => acc + s.text.length, 0);
  assert.ok(total <= TTS_MAX_TOTAL_CHARS, `total=${total}`);
});

test("净化后为空 → 零段（不发 voice.segment.ready）", () => {
  assert.deepEqual(splitCompanionTtsSegments("```code```  `x`  "), []);
  assert.deepEqual(splitCompanionTtsSegments("   "), []);
});

test("companionSegmentId：runId/generation/textSha256 参与哈希且稳定", () => {
  const id1 = companionSegmentId("run-1", 0, 1, "a".repeat(64));
  const id2 = companionSegmentId("run-1", 0, 1, "a".repeat(64));
  const id3 = companionSegmentId("run-2", 0, 1, "a".repeat(64));
  const id4 = companionSegmentId("run-1", 1, 1, "a".repeat(64));
  const id5 = companionSegmentId("run-1", 0, 2, "a".repeat(64));
  const id6 = companionSegmentId("run-1", 0, 1, "b".repeat(64));
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.notEqual(id1, id4);
  assert.notEqual(id1, id5);
  assert.notEqual(id1, id6);
  assert.match(id1, /^[a-f0-9]{64}$/);
});
