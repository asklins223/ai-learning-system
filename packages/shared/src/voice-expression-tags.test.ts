// 15b 二期：情感与富语言标签工具（shared 层，worker 与 api 共用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_EMOTION_TAGS,
  VOICE_RICH_TAGS,
  stripVoiceExpressionTags,
  extractVoiceEmotion,
} from "./voice-expression-tags.ts";

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

test("标签清单：控制类 23 + 富语言类 7（全表）", () => {
  assert.equal(VOICE_EMOTION_TAGS.length, 23);
  assert.equal(VOICE_RICH_TAGS.length, 7);
});
