import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COMPANION_PERSONA_V1,
  COMPANION_PERSONA_V1_PROMPT_ID,
  COMPANION_PERSONA_V1_SHA256,
} from "./companion-persona.ts";

// 03 合同 §9.1：canonical bytes = UTF-8、LF 换行、无 BOM、末行后无换行，1335 bytes，
// SHA-256 固定。任何字符变化都必须升级 prompt version，不能悄悄修改。
test("companion-persona-v1 canonical bytes 与 hash 固定", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V1, "utf8");
  assert.equal(bytes.length, 1335, "canonical bytes 必须是 1335");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, COMPANION_PERSONA_V1_SHA256, "SHA-256 必须匹配合同固定值");
  assert.equal(hash, "719f18b816b401de16ee33e3ee6e26bb6f09b2f5256c2bf4a40695a220a4d39d");
  assert.equal(COMPANION_PERSONA_V1_PROMPT_ID, "companion-persona-v1");
  assert.equal(bytes[0] !== 0xef, true, "无 BOM（不以 EF BB BF 开头）");
  assert.equal(COMPANION_PERSONA_V1.endsWith("。"), true, "末行后无换行");
});

import {
  COMPANION_PERSONA_V2,
  COMPANION_PERSONA_V2_PROMPT_ID,
  COMPANION_PERSONA_V2_SHA256,
} from "./companion-persona.ts";

// 15c：companion-persona-v2 canonical bytes 与 hash 固定（音频聊天适配升级）。
// 15b 二期：追加语音标签表（30 个）+ 末尾"情绪标签"例外说明。
// 2026-08-13：编造/道歉/回顾强化修订（见文件头注释）。
test("companion-persona-v2 canonical bytes 与 hash 固定", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V2, "utf8");
  assert.equal(bytes.length, 3274, "canonical bytes 必须是 3274");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, COMPANION_PERSONA_V2_SHA256, "SHA-256 必须匹配合同固定值");
  assert.equal(hash, "05181b90f96ee85215f268a78ba4e2689ce02cc95776a276ecd4b73f35ee29df");
  assert.equal(COMPANION_PERSONA_V2_PROMPT_ID, "companion-persona-v2");
  // 音频聊天适配约束必须存在
  assert.ok(COMPANION_PERSONA_V2.includes("不超过 60 字"), "长度约束");
  assert.ok(COMPANION_PERSONA_V2.includes("不要用 markdown"), "无 markdown 约束");
  assert.ok(COMPANION_PERSONA_V2.includes("列表符号"), "无列表约束");
  assert.ok(COMPANION_PERSONA_V2.includes("适合语音朗读"), "朗读适配");
  assert.ok(COMPANION_PERSONA_V2.includes("这个我还不太清楚"), "不编造");
  assert.ok(COMPANION_PERSONA_V2.includes("不要反复解释或道歉"), "不反复道歉");
  assert.ok(COMPANION_PERSONA_V2.includes("自然地回应一下"), "接住情绪");
  assert.ok(COMPANION_PERSONA_V2.includes("不要重复或反复解释同一件事"), "不重复");
  // 2026-08-13 修订：编造/道歉/回顾强化
  assert.ok(COMPANION_PERSONA_V2.includes("编造事实是严重错误"), "编造禁令强化");
  assert.ok(COMPANION_PERSONA_V2.includes("不要主动提起或检讨过去说错的话"), "禁止回顾道歉");
  assert.ok(COMPANION_PERSONA_V2.includes("每次回复都应是新的内容"), "禁止复读");
  assert.ok(!COMPANION_PERSONA_V2.includes("刚才可能没说清楚"), "删除诱导回顾句式");
  // 15b 二期：语音标签表必须存在（全表 30 个）且末句允许语音标签
  assert.ok(COMPANION_PERSONA_V2.includes("[excited]兴奋"), "标签表");
  assert.ok(COMPANION_PERSONA_V2.includes("[laughing]大笑"), "富语言标签");
  assert.ok(COMPANION_PERSONA_V2.includes("[very fast]快速"), "全表标签");
  assert.ok(COMPANION_PERSONA_V2.includes("上文的语音标签除外"), "标签例外");
  assert.ok(COMPANION_PERSONA_V2.endsWith("。"), "末行后无换行");
});

import {
  COMPANION_PERSONA_V3,
  COMPANION_PERSONA_V3_PROMPT_ID,
  COMPANION_PERSONA_V3_SHA256,
} from "./companion-persona.ts";

// 2026-08-16：companion-persona-v3 canonical bytes 与 hash 固定（桌宠聊天风格优化）。
test("companion-persona-v3 canonical bytes 与 hash 固定", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V3, "utf8");
  assert.equal(bytes.length, 3467, "canonical bytes 必须是 3467");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, COMPANION_PERSONA_V3_SHA256, "SHA-256 必须匹配合同固定值");
  assert.equal(hash, "383194f6da9eeec87908689711b07652ecc181d37fc5ca9b891c7371be40486c");
  assert.equal(COMPANION_PERSONA_V3_PROMPT_ID, "companion-persona-v3");
  // 小宠物有来有回风格约束必须存在
  assert.ok(COMPANION_PERSONA_V3.includes("有来有回"), "有来有回");
  assert.ok(COMPANION_PERSONA_V3.includes("小宠物"), "小宠物风格");
  assert.ok(COMPANION_PERSONA_V3.includes("把球抛回去"), "延续对话");
  assert.ok(COMPANION_PERSONA_V3.includes("50 字以内"), "短句约束");
  assert.ok(COMPANION_PERSONA_V3.includes("嗯嗯"), "口语回应词");
  assert.ok(COMPANION_PERSONA_V3.includes("不要堆砌"), "不堆砌");
  assert.ok(COMPANION_PERSONA_V3.includes("[giggles]咯咯笑"), "语音标签表");
  assert.ok(COMPANION_PERSONA_V3.endsWith("。"), "末行后无换行");
});

import {
  COMPANION_PERSONA_V4,
  COMPANION_PERSONA_V4_PROMPT_ID,
  COMPANION_PERSONA_V4_SHA256,
} from "./companion-persona.ts";

// 2026-08-24：companion-persona-v4 canonical bytes 与 hash 固定（prompt 减负重构）。
// 核心变化：移出 30 条语音标签全表（改由确定性语气层注入）+ 内嵌 few-shot 示例。
test("companion-persona-v4 canonical bytes 与 hash 固定", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V4, "utf8");
  assert.equal(bytes.length, 3225, "canonical bytes 必须是 3225");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, COMPANION_PERSONA_V4_SHA256, "SHA-256 必须匹配合同固定值");
  assert.equal(hash, "2a45f9706f05257726d3357c9db6e2d47230cf1aa19d0feb0f95fdbcfdf6d6a6");
  assert.equal(COMPANION_PERSONA_V4_PROMPT_ID, "companion-persona-v4");
  // V3 风格硬约束全部保留
  assert.ok(COMPANION_PERSONA_V4.includes("有来有回"), "有来有回");
  assert.ok(COMPANION_PERSONA_V4.includes("小宠物"), "小宠物风格");
  assert.ok(COMPANION_PERSONA_V4.includes("把球抛回去"), "延续对话");
  assert.ok(COMPANION_PERSONA_V4.includes("50 字以内"), "短句约束");
  assert.ok(COMPANION_PERSONA_V4.includes("嗯嗯"), "口语回应词");
  assert.ok(COMPANION_PERSONA_V4.includes("不要每句都堆"), "不堆砌");
  assert.ok(COMPANION_PERSONA_V4.endsWith("。"), "末行后无换行");
  // 安全约束保留
  assert.ok(COMPANION_PERSONA_V4.includes("不要编造"), "不编造");
  assert.ok(COMPANION_PERSONA_V4.includes("不要反复解释或道歉"), "不道歉链");
  assert.ok(COMPANION_PERSONA_V4.includes("不要用 markdown"), "无 markdown 约束");
  assert.ok(COMPANION_PERSONA_V4.includes("扮演恋爱伴侣"), "关系边界");
  assert.ok(COMPANION_PERSONA_V4.includes("API key"), "隐私边界");
  // 减负核心：不再携带标签全表
  assert.ok(!COMPANION_PERSONA_V4.includes("[sad]悲伤"), "已移出语音标签全表");
  assert.ok(!COMPANION_PERSONA_V4.includes("[asmr]轻柔耳语"), "已移出语音标签全表（2）");
  // 新增：few-shot 示例 + 方括号禁令
  assert.ok(COMPANION_PERSONA_V4.includes("下面是几段对话示例"), "内嵌 few-shot");
  assert.ok(COMPANION_PERSONA_V4.includes("F=ma"), "示例内容存在");
  assert.ok(COMPANION_PERSONA_V4.includes("不要输出 [方括号] 形式的任何标记"), "未知标签防御的 prompt 侧声明");
});
