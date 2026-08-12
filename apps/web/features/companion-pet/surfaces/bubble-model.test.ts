import assert from "node:assert/strict";
import test from "node:test";
import {
  bubbleAutoDismissMs,
  bubblePriority,
  buildPreviewSegments,
  canOverrideBubble,
  displayUrlLabel,
  segmentLengthRange,
  shouldShowFullContentLink,
  splitSentences,
} from "./bubble-model";

test("bubble priority order is fixed", () => {
  assert.ok(bubblePriority("voice_error") < bubblePriority("user_turn"));
  assert.ok(bubblePriority("user_turn") < bubblePriority("confirmation"));
  assert.ok(bubblePriority("confirmation") < bubblePriority("task_result"));
  assert.ok(bubblePriority("task_result") < bubblePriority("proactive"));
  assert.ok(bubblePriority("proactive") < bubblePriority("ambient"));
  assert.equal(canOverrideBubble("ambient", "user_turn"), false);
  assert.equal(canOverrideBubble("voice_error", "user_turn"), true);
  assert.equal(canOverrideBubble("proactive", null), true);
});

test("Chinese sentences split on full-width punctuation", () => {
  const sentences = splitSentences("第一句。第二句！第三句？\n第四句；第五句");
  assert.deepEqual(sentences, ["第一句。", "第二句！", "第三句？", "第四句；", "第五句"]);
});

test("English sentences split on . ? ! ; and protect abbreviations", () => {
  const sentences = splitSentences("Dr. Smith is here. He said e.g. this example works! Right?");
  assert.deepEqual(sentences, [
    "Dr. Smith is here.",
    "He said e.g. this example works!",
    "Right?",
  ]);
});

test("preview segments respect the CJK length window", () => {
  const long = "第一句完整内容。第二句完整内容。第三句完整内容。".repeat(3);
  const segments = buildPreviewSegments(long);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.ok(segment.length <= segmentLengthRange(segment).max);
  }
  // Short text stays one segment.
  assert.deepEqual(buildPreviewSegments("短消息。"), ["短消息。"]);
});

test("auto-dismiss timing follows the 4s..12s clamp", () => {
  assert.equal(bubbleAutoDismissMs("turn", 0), 4000);
  assert.equal(bubbleAutoDismissMs("turn", 10), 4000);
  assert.equal(bubbleAutoDismissMs("incoming", 100), 2500 + 100 * 80);
  assert.equal(bubbleAutoDismissMs("turn", 120), 12000);
  assert.equal(bubbleAutoDismissMs("turn", 500), 12000);
  assert.equal(bubbleAutoDismissMs("privacy_placeholder", 999), 6000);
  assert.equal(bubbleAutoDismissMs("never", 10), null);
});

test("long content detection flags code, tables and long text", () => {
  assert.equal(shouldShowFullContentLink("x".repeat(300)), true);
  assert.equal(shouldShowFullContentLink("```code```"), true);
  assert.equal(shouldShowFullContentLink("| a | b |"), true);
  assert.equal(shouldShowFullContentLink("短内容。"), false);
});

test("URL display labels are host-shortened", () => {
  assert.equal(displayUrlLabel("https://www.example.com/very/long/path?a=1"), "example.com/very");
  assert.equal(displayUrlLabel("https://example.com/"), "example.com");
  assert.equal(displayUrlLabel("不是网址"), "不是网址");
});
