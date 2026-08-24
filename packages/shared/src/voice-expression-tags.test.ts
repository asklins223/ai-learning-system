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

// 2026-08-24 行为变更（AI 设计审查 §4.2）：此前模型自造标签原样漏进
// 展示/TTS 文本被当普通文字读出；现在 ASCII 标签形态的自造标签一并剥离，
// 仅保留中文内容的正文方括号。
test("标签剥离：模型自造的 ASCII 标签形态 token 不再漏出", () => {
  const out = stripVoiceExpressionTags("[happy] 自定义标签会被剥离 [excited]ok");
  assert.equal(out, " 自定义标签会被剥离 ok");
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

// 2026-08-24（AI 设计审查 §4.2）：未知标签防御——模型自造的 ASCII 标签
// 形态 token 不再漏进展示/TTS 文本；中文正文方括号与单字符标记不受影响。
import { stripUnknownVoiceExpressionTags } from "./voice-expression-tags.ts";

test("未知标签防御：ASCII 标签形态的模型自造标签被剥离", () => {
  // 展示管线：已知 + 未知全部剥掉
  const out = stripVoiceExpressionTags("[happy]开心 [excited]兴奋 [whisper]悄悄说");
  assert.equal(out, "开心 兴奋 悄悄说");
  // 大小写混合的自造标签同样命中
  assert.equal(stripVoiceExpressionTags("[Happy]你好"), "你好");
});

test("未知标签防御：已知标签的变形词同样剥离（前缀逃逸修复）", () => {
  // [sadly]/[excitedly]/[gasps] 是最高发的幻觉家族——负向前瞻必须锚定 ]
  const out = stripVoiceExpressionTags("[sadly]唉 [excitedly]哇 [gasps]啊 [seriously]认真点");
  assert.equal(out, "唉 哇 啊 认真点");
});

test("未知标签防御：嵌套与残留迭代清除", () => {
  // "[excited [happy]]"：先剥 [happy] 剩 "[excited ]"，迭代后清干净
  assert.equal(stripVoiceExpressionTags("[excited [happy]]你好"), "你好");
  // 双层包裹剥空后不留 "[]" 空壳
  assert.equal(stripVoiceExpressionTags("[[happy]]测试"), "测试");
});

test("未知标签防御：stripUnknown 只剥未知形态，保留 qwen 已知标签", () => {
  // TTS 原始文本管线专用：qwen 引擎需要保留 [excited] 等控制标签
  const out = stripUnknownVoiceExpressionTags("[excited]太棒了！[happy]自造 [重要]正文");
  assert.equal(out, "[excited]太棒了！自造 [重要]正文");
});

test("未知标签防御：中文方括号正文、CEFR 级别与单字符标记不误删", () => {
  const text = "[重要] 这道题选 [b]，我的英语是 [B2] 水平，参考 [答案] 在第 3 页";
  assert.equal(stripVoiceExpressionTags(text), text);
  assert.equal(stripUnknownVoiceExpressionTags(text), text);
});

test("标签清单：控制类 23 + 富语言类 7（全表）", () => {
  assert.equal(VOICE_EMOTION_TAGS.length, 23);
  assert.equal(VOICE_RICH_TAGS.length, 7);
});
