// 确定性语气层单测（2026-08-24，AI 设计审查 §4.2 修复；二轮审查重构后）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyDeterministicToneToSegments,
  resolveReplyToneEmotion,
} from "./companion-tone.ts";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test("resolveReplyToneEmotion：happy 回复 → happy", () => {
  assert.equal(resolveReplyToneEmotion("恭喜你！这次复习通过啦～"), "happy");
});

test("resolveReplyToneEmotion：中性回复 → neutral（不注入）", () => {
  assert.equal(resolveReplyToneEmotion("今天的安排就是这样。"), "neutral");
});

test("resolveReplyToneEmotion：单关键词 curious/concerned 也命中（对齐 cue 判定面）", () => {
  assert.equal(resolveReplyToneEmotion("我看看这个安排。"), "curious");
  assert.equal(resolveReplyToneEmotion("别担心，一次没考好说明不了什么。"), "concerned");
});

test("resolveReplyToneEmotion：全文已有已知控制类标签时不叠加（返回 neutral）", () => {
  assert.equal(resolveReplyToneEmotion("[excited]恭喜！太棒了！"), "neutral");
});

test("resolveReplyToneEmotion：未知标签先剥离再判定", () => {
  // 模型幻觉的 [happy] 被剥掉，正文"恭喜"命中 happy
  assert.equal(resolveReplyToneEmotion("[happy]恭喜你！做到了！"), "happy");
});

test("applyDeterministicToneToSegments：逐段注入句首控制标签", () => {
  const out = applyDeterministicToneToSegments(
    [
      { ordinal: 1, text: "恭喜你！", textSha256: sha("恭喜你！") },
      { ordinal: 2, text: "这次复习通过啦。要不要继续？", textSha256: sha("这次复习通过啦。要不要继续？") },
    ],
    "happy",
  );
  assert.equal(out[0].text, "[excited]恭喜你！");
  assert.equal(out[1].text, "[excited]这次复习通过啦。要不要继续？");
  // textSha256 必须按注入后的文本重算
  assert.equal(out[0].textSha256, sha("[excited]恭喜你！"));
  assert.equal(out[1].textSha256, sha("[excited]这次复习通过啦。要不要继续？"));
});

test("applyDeterministicToneToSegments：neutral 只净化不注入", () => {
  const out = applyDeterministicToneToSegments(
    [{ ordinal: 1, text: "[happy]今天就这样吧。", textSha256: sha("[happy]今天就这样吧。") }],
    "neutral",
  );
  assert.equal(out[0].text, "今天就这样吧。");
});

test("applyDeterministicToneToSegments：段内已有已知标签不叠加，幻觉标签净化", () => {
  const out = applyDeterministicToneToSegments(
    [
      { ordinal: 1, text: "[sighing]先歇会儿。", textSha256: sha("[sighing]先歇会儿。") },
      { ordinal: 2, text: "[sadly]别灰心 [重要]保留", textSha256: sha("[sadly]别灰心 [重要]保留") },
    ],
    "concerned",
  );
  // 段1 已有控制类标签 → 不注 [empathetic]
  assert.equal(out[0].text, "[sighing]先歇会儿。");
  // 段2 幻觉标签 [sadly] 剥掉、中文方括号保留、注入 [empathetic]
  assert.equal(out[1].text, "[empathetic]别灰心 [重要]保留");
});

test("applyDeterministicToneToSegments：注入会顶破 160 上限的满段跳过注入（保音频）", () => {
  // 硬切可产出恰好 160 字符的段；[empathetic] 长 12 字符，注入即超合同上限
  const full160 = "a".repeat(160);
  const out = applyDeterministicToneToSegments(
    [
      { ordinal: 1, text: full160, textSha256: sha(full160) },
      { ordinal: 2, text: "短句。", textSha256: sha("短句。") },
    ],
    "concerned",
  );
  // 满 160 的段不注入（否则 web 客户端按 >160 静默丢音频）
  assert.equal(out[0].text.length, 160);
  assert.equal(out[0].text, full160);
  // 正常长度段照常注入
  assert.equal(out[1].text, "[empathetic]短句。");
});
