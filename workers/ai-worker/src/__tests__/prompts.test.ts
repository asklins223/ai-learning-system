/**
 * prompts.ts 单元测试
 *
 * 验证 SYSTEM_PROMPT 和 EVAL_SYSTEM_PROMPT 的内容结构。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_PROMPT, EVAL_SYSTEM_PROMPT } from "../lib/prompts.ts";

// ─── SYSTEM_PROMPT ───────────────────────────────────────────────────────

test("SYSTEM_PROMPT: 非空字符串", () => {
  assert.ok(typeof SYSTEM_PROMPT === "string");
  assert.ok(SYSTEM_PROMPT.length > 0);
});

test("SYSTEM_PROMPT: 包含 JSON 结构说明", () => {
  assert.ok(SYSTEM_PROMPT.includes("title"));
  assert.ok(SYSTEM_PROMPT.includes("summary"));
  assert.ok(SYSTEM_PROMPT.includes("key_points"));
  assert.ok(SYSTEM_PROMPT.includes("quote_text"));
});

test("SYSTEM_PROMPT: 包含 thinking 字段引导思维链", () => {
  assert.ok(SYSTEM_PROMPT.includes("thinking"));
  assert.ok(SYSTEM_PROMPT.includes("推理过程"));
});

test("SYSTEM_PROMPT: 包含生成步骤指引", () => {
  assert.ok(SYSTEM_PROMPT.includes("生成步骤"));
  assert.ok(SYSTEM_PROMPT.includes("先思考再输出"));
});

test("SYSTEM_PROMPT: 包含自检清单（v6 新增相似度检查项）", () => {
  assert.ok(SYSTEM_PROMPT.includes("自检清单"));
  assert.ok(SYSTEM_PROMPT.includes("☐"));
  // v6: 自检项 2 强化措辞区分度检查
  assert.ok(SYSTEM_PROMPT.includes("用自己的语言重新表述了知识点"));
  // v6: 自检项 8 新增 claim 长度检查
  assert.ok(SYSTEM_PROMPT.includes("20-80 字"));
  // v6: 模糊评价检测扩展
  assert.ok(SYSTEM_PROMPT.includes("扮演重要角色"));
});

test("SYSTEM_PROMPT: 包含约束说明", () => {
  assert.ok(SYSTEM_PROMPT.includes("quote_text 应是原文的近似逐字片段"));
  assert.ok(SYSTEM_PROMPT.includes("最多输出 5 个 key_points"));
});

test("SYSTEM_PROMPT: 要求只输出 JSON", () => {
  assert.ok(SYSTEM_PROMPT.includes("只输出 JSON"));
});

test("SYSTEM_PROMPT: 包含 claim 质量标准", () => {
  assert.ok(SYSTEM_PROMPT.includes("原子化"));
  assert.ok(SYSTEM_PROMPT.includes("自包含"));
  assert.ok(SYSTEM_PROMPT.includes("可验证"));
});

test("SYSTEM_PROMPT: 包含 claim 抽象提炼要求（v6）", () => {
  // v6: 强调用自己的语言重新表述，而非复述原文
  assert.ok(SYSTEM_PROMPT.includes("用自己的语言重新表述"));
  assert.ok(SYSTEM_PROMPT.includes("不是原文复述"));
});

test("SYSTEM_PROMPT: 包含 claim 抽象度自检方法（v6 新增）", () => {
  assert.ok(SYSTEM_PROMPT.includes("抽象度自检方法"));
  assert.ok(SYSTEM_PROMPT.includes("通用原理或结论"));
});

test("SYSTEM_PROMPT: 包含 claim 反模式示例（v6）", () => {
  assert.ok(SYSTEM_PROMPT.includes("CAP 定理"));
  assert.ok(SYSTEM_PROMPT.includes("复述改写"));
  assert.ok(SYSTEM_PROMPT.includes("跨概念混合"));
});

test("SYSTEM_PROMPT: 包含 claim 正面示例（v6 重写）", () => {
  // v6: 正反示例使用 ❌ 和 ✅ 标记，claim 用不同措辞概括底层原理
  assert.ok(SYSTEM_PROMPT.includes("抽象提炼"));
  assert.ok(SYSTEM_PROMPT.includes("❌ 差"));
  assert.ok(SYSTEM_PROMPT.includes("✅ 好"));
});

test("SYSTEM_PROMPT: 包含 claim 长度精炼度指引（v6 新增）", () => {
  assert.ok(SYSTEM_PROMPT.includes("20-80 字为佳"));
});

test("SYSTEM_PROMPT: 包含 claim-quote 相似度系统检测约束（v6 新增）", () => {
  assert.ok(SYSTEM_PROMPT.includes("系统会检测 claim 与 quote_text 的措辞相似度"));
  assert.ok(SYSTEM_PROMPT.includes("过于相似的 claim 将被过滤"));
});

test("SYSTEM_PROMPT: 包含更多反模式示例", () => {
  assert.ok(SYSTEM_PROMPT.includes("泛化描述"));
  assert.ok(SYSTEM_PROMPT.includes("跨 block 拼接"));
  // v6 新增反模式
  assert.ok(SYSTEM_PROMPT.includes("复述改写"));
  assert.ok(SYSTEM_PROMPT.includes("跨概念混合"));
});

test("SYSTEM_PROMPT: 包含 summary 结构指引", () => {
  assert.ok(SYSTEM_PROMPT.includes("2-4 句话"));
  assert.ok(SYSTEM_PROMPT.includes("知识结构"));
});

test("SYSTEM_PROMPT: 包含 key_points 选择策略", () => {
  assert.ok(SYSTEM_PROMPT.includes("核心原理"));
  assert.ok(SYSTEM_PROMPT.includes("语义重复"));
});

test("SYSTEM_PROMPT: 包含四个完整示例（v6 新增读书笔记示例）", () => {
  assert.ok(SYSTEM_PROMPT.includes("示例 1"));
  assert.ok(SYSTEM_PROMPT.includes("示例 2"));
  assert.ok(SYSTEM_PROMPT.includes("示例 3"));
  assert.ok(SYSTEM_PROMPT.includes("示例 4"));
  assert.ok(SYSTEM_PROMPT.includes("Redis"));
  assert.ok(SYSTEM_PROMPT.includes("B+ 树"));
  assert.ok(SYSTEM_PROMPT.includes("HTTP"));
  // v6 新增：读书笔记类示例
  assert.ok(SYSTEM_PROMPT.includes("思考，快与慢"));
  assert.ok(SYSTEM_PROMPT.includes("双系统"));
});

test("SYSTEM_PROMPT: 包含 quote_text 跨 block 拼接禁止规则", () => {
  assert.ok(SYSTEM_PROMPT.includes("不要从不同的 block 中各取一部分拼接"));
});

test("SYSTEM_PROMPT: 包含 claim 与 quote 区分度要求（v6 强化）", () => {
  assert.ok(SYSTEM_PROMPT.includes("claim 与 quote_text 在措辞上必须有明显区分"));
  assert.ok(SYSTEM_PROMPT.includes("重新改写 claim"));
});

test("SYSTEM_PROMPT: 包含近似逐字示例", () => {
  assert.ok(SYSTEM_PROMPT.includes("近似逐字"));
});

// ─── EVAL_SYSTEM_PROMPT ──────────────────────────────────────────────────

test("EVAL_SYSTEM_PROMPT: 非空字符串", () => {
  assert.ok(typeof EVAL_SYSTEM_PROMPT === "string");
  assert.ok(EVAL_SYSTEM_PROMPT.length > 0);
});

test("EVAL_SYSTEM_PROMPT: 包含所有 outcome 选项", () => {
  assert.ok(EVAL_SYSTEM_PROMPT.includes("preliminary_understanding"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("unclear_expression"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("misunderstanding"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("unknown"));
});

test("EVAL_SYSTEM_PROMPT: 包含 JSON 结构说明", () => {
  assert.ok(EVAL_SYSTEM_PROMPT.includes("outcome"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("confidence"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("feedback"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("covered_points"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("missing_points"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("misunderstandings"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("evidence_refs"));
});

test("EVAL_SYSTEM_PROMPT: 包含 outcome 判定标准", () => {
  // EVAL_SYSTEM_PROMPT 使用 markdown 标题格式描述各 outcome
  assert.ok(EVAL_SYSTEM_PROMPT.includes("### preliminary_understanding"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("### unclear_expression"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("### misunderstanding"));
  assert.ok(EVAL_SYSTEM_PROMPT.includes("### unknown"));
});
