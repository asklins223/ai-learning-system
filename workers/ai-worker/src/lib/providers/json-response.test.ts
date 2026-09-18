/**
 * 2026-09-15（管线评审 L3）：extractJsonFromText 的多候选选择。
 *
 * 背景：此前括号匹配只从**第一个** `{` 开始——模型在 JSON 前输出含 `{` 的
 * 说明文本（如示例片段）时会截取到错误对象，随后 schema 校验失败并被判
 * retryable，白烧一轮重试。现在收集所有顶层平衡对象，并在调用方给出
 * `requiredKeys` 时优先返回包含期望键的对象。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractJsonFromText } from "./json-response.ts";

test("单一 JSON 直接解析（含 ```json 围栏）", () => {
  assert.deepEqual(extractJsonFromText('{"atoms":[1]}'), { atoms: [1] });
  assert.deepEqual(extractJsonFromText('```json\n{"atoms":[1]}\n```'), { atoms: [1] });
});

test("前缀说明文本不含 `{` 时行为不变", () => {
  assert.deepEqual(extractJsonFromText('Here is the result:\n{"atoms":[1]}'), { atoms: [1] });
});

test("requiredKeys：跳过前缀示例对象，选中真正的答案对象", () => {
  const raw = '示例：{"note":"示意"} 正式输出：{"atoms":[{"atomId":"atom-1"}]}';
  assert.deepEqual(extractJsonFromText(raw, ["atoms"]), { atoms: [{ atomId: "atom-1" }] });
});

test("未提供 requiredKeys 时保持原有语义（返回第一个平衡对象）", () => {
  const raw = '示例：{"note":"示意"} 正式输出：{"atoms":[{"atomId":"atom-1"}]}';
  assert.deepEqual(extractJsonFromText(raw), { note: "示意" });
});

test("requiredKeys 全部未命中时退回命中键数最多/最后出现者", () => {
  const raw = '{"a":1} {"b":2,"c":3}';
  assert.deepEqual(extractJsonFromText(raw, ["b"]), { b: 2, c: 3 });
});

test("字符串字面量里的花括号不破坏平衡匹配", () => {
  assert.deepEqual(extractJsonFromText('{"text":"a { b } c"}'), { text: "a { b } c" });
});

test("截断的 JSON 报错（调用方按 retryable 处理，不返回半成品）", () => {
  assert.throws(() => extractJsonFromText('{"atoms":[{"atomId":'), /malformed JSON/);
});

test("完全没有花括号时报 no JSON object", () => {
  assert.throws(() => extractJsonFromText("plain text"), /no JSON object/);
});

test("顶层数组/标量仍按原样返回（由调用方判定形状）", () => {
  assert.deepEqual(extractJsonFromText("[1,2,3]"), [1, 2, 3]);
  assert.equal(extractJsonFromText('"just a string"'), "just a string");
});
