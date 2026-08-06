/**
 * prompts.ts 单元测试
 *
 * 验证 EVAL_SYSTEM_PROMPT 的内容结构。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EVAL_SYSTEM_PROMPT } from "../lib/prompts.ts";

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
