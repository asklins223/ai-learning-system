/**
 * ai-model-connection.ts 扩展测试
 *
 * 通过 mock requester 测试 testAIModelRuntimeConnection 的所有分支：
 * - 成功连接（OpenAI 兼容格式 + DashScope compatible 格式）
 * - 401/403 无效凭据
 * - 404 端点不存在
 * - 429 限流
 * - 其他错误状态
 * - 超时
 * - 网络错误
 * - 不兼容响应
 * - AIModelConnectionError 类行为
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AIModelConnectionError,
  testAIModelRuntimeConnection,
  type AIModelConnectionRuntime,
  type AIModelConnectionErrorCode,
} from "../modules/identity/ai-model-connection.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

const runtime: AIModelConnectionRuntime = {
  provider: "openai_compatible",
  baseUrl: "https://api.example.com",
  model: "gpt-4",
  apiKey: "test-key-12345",
};

const dashscopeRuntime: AIModelConnectionRuntime = {
  provider: "dashscope",
  baseUrl: "https://dashscope.aliyuncs.com",
  model: "qwen-plus",
  apiKey: "test-key-12345",
};

function mockRequester(
  response: PublicJsonResponse,
  delayMs = 0,
): PublicJsonRequester {
  return async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return response;
  };
}

function failingRequester(error: Error): PublicJsonRequester {
  return async () => { throw error; };
}

// ─── AIModelConnectionError 类行为 ──────────────────────────────────────

test("AIModelConnectionError 包含正确的 name", () => {
  const err = new AIModelConnectionError("test", "connection_failed", 502);
  assert.equal(err.name, "AIModelConnectionError");
  assert.equal(err.message, "test");
  assert.equal(err.code, "connection_failed");
  assert.equal(err.statusCode, 502);
});

test("AIModelConnectionError 是 Error 的实例", () => {
  const err = new AIModelConnectionError("test", "connection_failed", 502);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof AIModelConnectionError);
});

test("AIModelConnectionError 包含可选的 provider 和 model", () => {
  const err = new AIModelConnectionError("test", "connection_failed", 502, "dashscope", "qwen-plus");
  assert.equal(err.provider, "dashscope");
  assert.equal(err.model, "qwen-plus");
});

test("AIModelConnectionError 包含可选的 durationMs 和 upstreamStatus", () => {
  const err = new AIModelConnectionError("test", "connection_timeout", 504, "dashscope", "qwen-plus", 15000, 504);
  assert.equal(err.durationMs, 15000);
  assert.equal(err.upstreamStatus, 504);
});

test("AIModelConnectionError 所有错误码可构造", () => {
  const codes: AIModelConnectionErrorCode[] = [
    "invalid_configuration",
    "invalid_credentials",
    "endpoint_or_model_not_found",
    "provider_rate_limited",
    "provider_rejected",
    "incompatible_response",
    "connection_failed",
    "connection_timeout",
  ];
  for (const code of codes) {
    const err = new AIModelConnectionError("test", code, 502);
    assert.equal(err.code, code);
  }
});

// ─── testAIModelRuntimeConnection 成功路径 ────────────────────────────────

test("testAIModelRuntimeConnection: OpenAI 兼容格式 200 成功", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      choices: [{ message: { content: "OK" } }],
    },
  };
  const result = await testAIModelRuntimeConnection(runtime, mockRequester(response), 5000);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai_compatible");
  assert.equal(result.model, "gpt-4");
  assert.ok(result.latencyMs >= 0);
  assert.ok(result.checkedAt);
});

test("testAIModelRuntimeConnection: DashScope compatible 格式 200 成功", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      choices: [{ message: { content: "OK" } }],
    },
  };
  const result = await testAIModelRuntimeConnection(dashscopeRuntime, mockRequester(response), 5000);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "dashscope");
  assert.equal(result.model, "qwen-plus");
});

test("testAIModelRuntimeConnection: DashScope compatible 格式（带额外字段）200 成功", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    },
  };
  const result = await testAIModelRuntimeConnection(dashscopeRuntime, mockRequester(response), 5000);
  assert.equal(result.ok, true);
});

// ─── testAIModelRuntimeConnection 错误路径 ────────────────────────────────

test("testAIModelRuntimeConnection: 401 返回 invalid_credentials", async () => {
  const response: PublicJsonResponse = {
    status: 401,
    statusText: "Unauthorized",
    body: { error: "invalid api key" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "invalid_credentials");
      assert.equal(err.statusCode, 422);
      assert.equal(err.upstreamStatus, 401);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 403 返回 invalid_credentials", async () => {
  const response: PublicJsonResponse = {
    status: 403,
    statusText: "Forbidden",
    body: { error: "forbidden" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "invalid_credentials");
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 404 返回 endpoint_or_model_not_found", async () => {
  const response: PublicJsonResponse = {
    status: 404,
    statusText: "Not Found",
    body: { error: "model not found" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "endpoint_or_model_not_found");
      assert.equal(err.statusCode, 422);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 429 返回 provider_rate_limited", async () => {
  const response: PublicJsonResponse = {
    status: 429,
    statusText: "Too Many Requests",
    body: { error: "rate limited" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "provider_rate_limited");
      assert.equal(err.statusCode, 429);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 500 返回 provider_rejected", async () => {
  const response: PublicJsonResponse = {
    status: 500,
    statusText: "Internal Server Error",
    body: { error: "server error" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "provider_rejected");
      assert.equal(err.statusCode, 502);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 502 返回 provider_rejected", async () => {
  const response: PublicJsonResponse = {
    status: 502,
    statusText: "Bad Gateway",
    body: { error: "bad gateway" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "provider_rejected");
      return true;
    },
  );
});

// ─── testAIModelRuntimeConnection 不兼容响应 ──────────────────────────────

test("testAIModelRuntimeConnection: 200 但响应格式不兼容返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { unexpected: "format" },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      assert.equal(err.statusCode, 502);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 200 但 content 为空返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "" } }] },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 200 但 content 为空白返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "   " } }] },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 200 但 choices 为空数组返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [] },
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 200 但 body 为 null 返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: null,
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: 200 但 body 为数组返回 incompatible_response", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: [1, 2, 3],
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(response), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "incompatible_response");
      return true;
    },
  );
});

// ─── testAIModelRuntimeConnection 网络错误 ────────────────────────────────

test("testAIModelRuntimeConnection: 网络错误返回 connection_failed", async () => {
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, failingRequester(new Error("ECONNREFUSED")), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "connection_failed");
      assert.equal(err.statusCode, 502);
      return true;
    },
  );
});

test("testAIModelRuntimeConnection: DNS 错误返回 connection_failed", async () => {
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, failingRequester(new Error("ENOTFOUND")), 5000),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "connection_failed");
      return true;
    },
  );
});

// ─── testAIModelRuntimeConnection 超时 ────────────────────────────────────

test("testAIModelRuntimeConnection: 超时返回 connection_timeout", async () => {
  const slowResponse: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "OK" } }] },
  };
  // 使用 100ms 超时，但 mock 延迟 500ms
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, mockRequester(slowResponse, 500), 100),
    (err: unknown) => {
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err.code, "connection_timeout");
      assert.equal(err.statusCode, 504);
      return true;
    },
  );
});

// ─── testAIModelRuntimeConnection 非 AIModelConnectionError 异常透传 ───────

test("testAIModelRuntimeConnection: AIModelConnectionError 异常直接透传不被包装", async () => {
  const connErr = new AIModelConnectionError(
    "pre-existing error",
    "invalid_credentials",
    422,
  );
  const requesterThrowingConnError: PublicJsonRequester = async () => {
    throw connErr;
  };
  await assert.rejects(
    testAIModelRuntimeConnection(runtime, requesterThrowingConnError, 5000),
    (err: unknown) => {
      // Should be the same error object, not wrapped
      assert.ok(err instanceof AIModelConnectionError);
      assert.equal(err, connErr);
      return true;
    },
  );
});
