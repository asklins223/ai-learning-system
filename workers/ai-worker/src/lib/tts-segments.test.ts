import { test } from "node:test";
import assert from "node:assert/strict";
import {
  purifyVoiceText,
  splitCompanionTtsSegments,
  splitCompanionTtsSegmentsIncremental,
  companionSegmentId,
  stripVoiceExpressionTags,
  extractVoiceEmotion,
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

test("切句：上限 40 段与 4000 字（超限只显示文字）", () => {
  const many = Array.from(
    { length: 120 },
    (_, i) => `第${i + 1}段句子内容，继续写一些字让段落更长一些，这里再补充几个短语增加长度。`,
  ).join("");
  const segs = splitCompanionTtsSegments(many);
  assert.ok(segs.length <= TTS_MAX_SEGMENTS, `segments=${segs.length}`);
  assert.ok(segs.length > 20, `长文本段数应超过原 20 段上限（当前 ${segs.length}）——15a 修复后长回复后面不再"不读"`);
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

test("增量切段：完整句立即切出、未完成句留 rest、final flush", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  // 第一块：两个完整句 + 半句
  let r = splitCompanionTtsSegmentsIncremental("你好世界。今天天气不错。明天会", state);
  assert.equal(r.segments.length, 2, "两个完整句立即成段");
  assert.ok(r.segments[0].text.includes("你好世界"));
  assert.ok(r.segments[1].text.includes("今天天气不错"));
  assert.equal(r.next.rest, "明天会", "半句留在 rest");
  state = r.next;
  // 第二块：补全 rest + 新句
  r = splitCompanionTtsSegmentsIncremental("更好。后天再说。", state);
  assert.equal(r.segments.length, 2, "rest 补全 + 新完整句");
  assert.ok(r.segments[0].text.includes("明天会更好"));
  assert.equal(r.next.rest, "", "无未完成句");
  state = r.next;
  // final flush：rest 空则无段
  r = splitCompanionTtsSegmentsIncremental("", state, true);
  assert.equal(r.segments.length, 0);
  // ordinal 连续递增
  assert.equal(r.next.sentCount, 4);
});

test("增量切段：final flush 强制切出 rest", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  let r = splitCompanionTtsSegmentsIncremental("只说了半句没说完", state);
  assert.equal(r.segments.length, 0, "无完整句不切");
  assert.equal(r.next.rest, "只说了半句没说完");
  state = r.next;
  r = splitCompanionTtsSegmentsIncremental("", state, true);
  assert.equal(r.segments.length, 1, "final 强制切出 rest");
  assert.ok(r.segments[0].text.includes("只说了半句没说完"));
});

test("增量切段：上限按累计维护（超限丢弃不朗读）", () => {
  const opts = { maxSegments: 2, maxTotalChars: 1000 };
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  let r = splitCompanionTtsSegmentsIncremental(
    "第一句。第二句。第三句。第四句。",
    state,
    false,
    opts,
  );
  assert.equal(r.segments.length, 2, "只切 2 段（上限）");
  assert.equal(r.next.sentCount, 2);
});

// ─── 15b 二期：情感与富语言标签 ─────────────────────────────────────────

test("标签剥离：白名单标签全部剥离（含大小写与带空格标签）", () => {
  const input =
    "[excited]今天天气真不错！[laughing]我们一起出去玩吧！" +
    "[Very Fast]快一点说。[deep and loud shouting]大声喊！";
  const out = stripVoiceExpressionTags(input);
  assert.equal(out, "今天天气真不错！我们一起出去玩吧！快一点说。大声喊！");
});

test("标签剥离：不误伤正文普通方括号（[重要] 原样保留）", () => {
  const out = stripVoiceExpressionTags("[重要] 这道题 [b] 不是标签");
  assert.equal(out, "[重要] 这道题 [b] 不是标签");
});

test("标签剥离：未知标签原样保留（防误删模型自造标签）", () => {
  const out = stripVoiceExpressionTags("[happy] 自定义标签不剥离 [excited]ok");
  assert.equal(out, "[happy] 自定义标签不剥离 ok");
});

test("标签剥离：无标签文本原样返回", () => {
  const input = "今天想学点什么？";
  assert.equal(stripVoiceExpressionTags(input), input);
});

test("emotion 解析：取段内最后一个控制类标签（小写）", () => {
  assert.equal(extractVoiceEmotion("[excited]太好了！"), "excited");
  assert.equal(
    extractVoiceEmotion("[serious]注意安全。[excited]开始吧！"),
    "excited",
  );
  assert.equal(extractVoiceEmotion("[giggles]只有富语言标签"), null);
  assert.equal(extractVoiceEmotion("没有标签"), null);
  assert.equal(extractVoiceEmotion("[Very Slowly]慢一点"), "very slowly");
});

// ─── 15b 二期（问题2 修复）：首段提前触发 ───────────────────────────────

test("首段提前：缓冲 ≥14 字且无完整句也切段（声音尽早开始）", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  const r = splitCompanionTtsSegmentsIncremental(
    "这句话还没有说完但是已经够长了",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r.segments.length, 1, "≥14 字即切出首段");
  assert.equal(r.next.sentCount, 1);
  assert.equal(r.next.rest, "", "缓冲已切走");
  assert.ok(r.segments[0].text.includes("这句话还没有说完"), "半句也被切出");
});

test("首段提前：不足 14 字仍等完整句（不提前切）", () => {
  let state = { rest: "", sentCount: 0, sentChars: 0 };
  const r = splitCompanionTtsSegmentsIncremental(
    "太短了。",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r.segments.length, 1, "有完整句正常切");
  // 无完整句且不足 14 字 → 不切
  const r2 = splitCompanionTtsSegmentsIncremental(
    "这句话没说完",
    state,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r2.segments.length, 0, "不足 14 字且无完整句 → 不切");
  assert.equal(r2.next.rest.length > 0, true, "留在 rest");
});

test("首段提前：只对首段生效，后续段仍等完整句", () => {
  // 首段提前切出后（sentCount=1），后续累积无完整句 → 不切
  const r1 = splitCompanionTtsSegmentsIncremental(
    "这是第一段提前切出来的内容对吧",
    { rest: "", sentCount: 0, sentChars: 0 },
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r1.segments.length, 1, "首段提前切出");
  const r2 = splitCompanionTtsSegmentsIncremental(
    "第二句还没说完",
    r1.next,
    false,
    { firstSegmentMinChars: 14 },
  );
  assert.equal(r2.segments.length, 0, "第二段无完整句不切");
  assert.equal(r2.next.rest, "第二句还没说完");
});
