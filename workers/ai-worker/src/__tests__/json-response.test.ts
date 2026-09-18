/**
 * json-response.ts 单元测试
 *
 * 覆盖 asJsonRecord, readString, readProviderCode,
 * readProviderErrorMessage, readChatCompletionContent
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asJsonRecord,
  readString,
  readProviderCode,
  readProviderErrorMessage,
  readChatCompletionContent,
  parseAgentTurnToolCalls,
} from "../lib/providers/json-response.ts";

// ─── parseAgentTurnToolCalls（截断修复契约）──────────────────────────────

test("parseAgentTurnToolCalls: 完整 arguments JSON 正常解析", () => {
  const result = parseAgentTurnToolCalls({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call-1",
          function: { name: "record_extraction_decisions", arguments: '{"candidates":[{"localId":"c1"}]}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }, true);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsMalformed, false);
  assert.deepEqual(result.toolCalls[0].arguments, { candidates: [{ localId: "c1" }] });
  assert.equal(result.finishReason, "tool_calls");
});

test("parseAgentTurnToolCalls: 截断的不完整 arguments 标记 malformed 而非静默空对象", () => {
  const result = parseAgentTurnToolCalls({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call-1",
          function: { name: "record_extraction_decisions", arguments: '{"candidates":[{"localId":"c1"},{"localId":"c2"},{"localId":' },
        }],
      },
      finish_reason: "length",
    }],
  }, true);
  assert.equal(result.finishReason, "length");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsMalformed, true);
  assert.deepEqual(result.toolCalls[0].arguments, {});
  assert.equal(
    result.toolCalls[0].rawArguments,
    '{"candidates":[{"localId":"c1"},{"localId":"c2"},{"localId":',
  );
});

// ─── JSON mode fallback（content 内 toolCalls）────────────────────────────

test("parseAgentTurnToolCalls: JSON fallback 的字符串 arguments 正常解析", () => {
  const result = parseAgentTurnToolCalls({
    choices: [{
      message: {
        content: JSON.stringify({
          toolCalls: [{ id: "call-9", name: "companion_open_card", arguments: '{"cardId":"c-1"}' }],
        }),
      },
      finish_reason: "stop",
    }],
  }, false);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsMalformed, false);
  assert.deepEqual(result.toolCalls[0].arguments, { cardId: "c-1" });
});

test("parseAgentTurnToolCalls: JSON fallback 的损坏 arguments 标记 malformed（不得当作空对象执行）", () => {
  const result = parseAgentTurnToolCalls({
    choices: [{
      message: {
        content: JSON.stringify({
          toolCalls: [{ id: "call-9", name: "companion_open_card", arguments: '{"cardId":' }],
        }),
      },
      finish_reason: "stop",
    }],
  }, false);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsMalformed, true);
  assert.deepEqual(result.toolCalls[0].arguments, {});
  assert.equal(result.toolCalls[0].rawArguments, '{"cardId":');
});

// ─── asJsonRecord ────────────────────────────────────────────────────────

test("asJsonRecord: 普通对象返回该对象", () => {
  const obj = { a: 1, b: "hello" };
  assert.equal(asJsonRecord(obj), obj);
});

test("asJsonRecord: 空对象返回空对象", () => {
  const result = asJsonRecord({});
  assert.ok(result !== null);
  assert.equal(Object.keys(result ?? {}).length, 0);
});

test("asJsonRecord: null 返回 null", () => {
  assert.equal(asJsonRecord(null), null);
});

test("asJsonRecord: undefined 返回 null", () => {
  assert.equal(asJsonRecord(undefined), null);
});

test("asJsonRecord: 数组返回 null", () => {
  assert.equal(asJsonRecord([1, 2, 3]), null);
});

test("asJsonRecord: 字符串返回 null", () => {
  assert.equal(asJsonRecord("string"), null);
});

test("asJsonRecord: 数字返回 null", () => {
  assert.equal(asJsonRecord(42), null);
});

test("asJsonRecord: boolean 返回 null", () => {
  assert.equal(asJsonRecord(true), null);
});

// ─── readString ──────────────────────────────────────────────────────────

test("readString: 字符串值正确返回", () => {
  assert.equal(readString({ key: "value" }, "key"), "value");
});

test("readString: null record 返回 undefined", () => {
  assert.equal(readString(null, "key"), undefined);
});

test("readString: key 不存在返回 undefined", () => {
  assert.equal(readString({ a: "1" }, "key"), undefined);
});

test("readString: 非字符串值返回 undefined", () => {
  assert.equal(readString({ key: 123 }, "key"), undefined);
  assert.equal(readString({ key: true }, "key"), undefined);
  assert.equal(readString({ key: null }, "key"), undefined);
  assert.equal(readString({ key: { nested: true } }, "key"), undefined);
  assert.equal(readString({ key: [1, 2] }, "key"), undefined);
});

test("readString: 空字符串正确返回", () => {
  assert.equal(readString({ key: "" }, "key"), "");
});

// ─── readProviderCode ────────────────────────────────────────────────────

test("readProviderCode: 字符串 code 正确返回", () => {
  assert.equal(readProviderCode({ code: "invalid_api_key" }), "invalid_api_key");
});

test("readProviderCode: 数字 code 正确返回", () => {
  assert.equal(readProviderCode({ code: 401 }), 401);
});

test("readProviderCode: OpenAI 嵌套 error.code 正确返回", () => {
  assert.equal(
    readProviderCode({ error: { code: "invalid_api_key", message: "do not persist" } }),
    "invalid_api_key",
  );
});

test("readProviderCode: 顶层合法 code 优先于嵌套值", () => {
  assert.equal(
    readProviderCode({ code: "top", error: { code: "nested" } }),
    "top",
  );
});

test("readProviderCode: 嵌套对象或数组不会作为 code 返回", () => {
  assert.equal(readProviderCode({ error: { code: { secret: true } } }), undefined);
  assert.equal(readProviderCode({ error: { code: ["invalid_api_key"] } }), undefined);
});

test("readProviderCode: 无 code 返回 undefined", () => {
  assert.equal(readProviderCode({ message: "error" }), undefined);
});

test("readProviderCode: null 返回 undefined", () => {
  assert.equal(readProviderCode(null), undefined);
});

test("readProviderCode: code 为 boolean 返回 undefined", () => {
  assert.equal(readProviderCode({ code: true }), undefined);
});

test("readProviderCode: code 为对象返回 undefined", () => {
  assert.equal(readProviderCode({ code: { nested: true } }), undefined);
});

test("readProviderCode: code 为数组返回 undefined", () => {
  assert.equal(readProviderCode({ code: [1, 2] }), undefined);
});

// ─── readProviderErrorMessage ────────────────────────────────────────────

test("readProviderErrorMessage: error.message 优先返回", () => {
  const result = readProviderErrorMessage({
    error: { message: "nested error message" },
    message: "top-level message",
  });
  assert.equal(result, "nested error message");
});

test("readProviderErrorMessage: 无 error.message 时回退到 top-level message", () => {
  const result = readProviderErrorMessage({
    message: "top-level message",
  });
  assert.equal(result, "top-level message");
});

test("readProviderErrorMessage: 无任何 message 返回 undefined", () => {
  assert.equal(readProviderErrorMessage({ code: 500 }), undefined);
});

test("readProviderErrorMessage: null 返回 undefined", () => {
  assert.equal(readProviderErrorMessage(null), undefined);
});

test("readProviderErrorMessage: error 存在但无 message 回退到 top-level", () => {
  const result = readProviderErrorMessage({
    error: { code: 500 },
    message: "top-level",
  });
  assert.equal(result, "top-level");
});

test("readProviderErrorMessage: error.message 为非字符串返回 undefined（然后回退）", () => {
  const result = readProviderErrorMessage({
    error: { message: 123 },
    message: "fallback",
  });
  assert.equal(result, "fallback");
});

// ─── readChatCompletionContent ───────────────────────────────────────────

test("readChatCompletionContent: 标准 OpenAI 格式正确返回 content", () => {
  const result = readChatCompletionContent({
    choices: [
      {
        message: { role: "assistant", content: "Hello, world!" },
      },
    ],
  });
  assert.equal(result, "Hello, world!");
});

test("readChatCompletionContent: 无 choices 返回 undefined", () => {
  assert.equal(readChatCompletionContent({}), undefined);
});

test("readChatCompletionContent: choices 为空数组返回 undefined", () => {
  assert.equal(readChatCompletionContent({ choices: [] }), undefined);
});

test("readChatCompletionContent: choices 不是数组返回 undefined", () => {
  assert.equal(readChatCompletionContent({ choices: "not-array" }), undefined);
});

test("readChatCompletionContent: 无 message 返回 undefined", () => {
  assert.equal(readChatCompletionContent({ choices: [{}] }), undefined);
});

test("readChatCompletionContent: message 无 content 返回 undefined", () => {
  assert.equal(
    readChatCompletionContent({ choices: [{ message: { role: "assistant" } }] }),
    undefined,
  );
});

test("readChatCompletionContent: content 为非字符串返回 undefined", () => {
  assert.equal(
    readChatCompletionContent({ choices: [{ message: { content: 123 } }] }),
    undefined,
  );
});

test("readChatCompletionContent: null 返回 undefined", () => {
  assert.equal(readChatCompletionContent(null), undefined);
});

test("readChatCompletionContent: 空字符串 content 正确返回", () => {
  assert.equal(
    readChatCompletionContent({ choices: [{ message: { content: "" } }] }),
    "",
  );
});

test("readChatCompletionContent: 多个 choices 取第一个", () => {
  const result = readChatCompletionContent({
    choices: [
      { message: { content: "first" } },
      { message: { content: "second" } },
    ],
  });
  assert.equal(result, "first");
});
