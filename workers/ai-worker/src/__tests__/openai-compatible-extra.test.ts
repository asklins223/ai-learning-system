/**
 * openai-compatible.ts 扩展测试
 *
 * 通过 mock requester 测试 OpenAICompatibleProvider 的所有方法：
 * - evaluateValidation 成功/失败（R5: via evaluateValidationViaChat helper）
 * - call 方法的错误分支（aborted signal, error status, empty output）
 * - parseModelJson 的各种 JSON 格式解析
 * - analyzeImage 多模态消息
 *
 * R5: Business methods removed from provider; tests now use
 * evaluateValidationViaChat helper from business-ai-ops.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import { ProviderRequestError } from "../lib/generation-failure-policy.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import { evaluateValidationViaChat, analyzeImageViaChat } from "../lib/business-ai-ops.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

function failingRequester(error: Error): PublicJsonRequester {
  return async () => { throw error; };
}

const validEvalOutput = {
  outcome: "preliminary_understanding",
  confidence: 0.85,
  feedback: "回答正确",
  covered_points: ["要点1"],
  missing_points: [],
  misunderstandings: [],
  evidence_refs: ["原文引用"],
};

const validImageOutput = {
  contentType: "document",
  decorative: false,
  caption: "一张包含标题的文档截图",
  ocr: [{
    text: "缓存一致性",
    region: { x: 100, y: 200, width: 3_000, height: 800 },
    confidence: 0.98,
  }],
  facts: [],
  promptInjectionDetected: false,
  safetyFlags: [],
  unresolvedReason: null,
};

function evalInput() {
  return {
    question: "什么是X？",
    questionType: "free_text",
    claim: "X是Y",
    quote: "X是Y的原文",
    userAnswer: "X是Y",
  };
}

// ─── evaluateValidation 成功路径 ─────────────────────────────────────────

test("OpenAICompatibleProvider.evaluateValidation: 正常 JSON 输出成功", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: JSON.stringify(validEvalOutput) } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.outcome, "preliminary_understanding");
  assert.equal(result.output.confidence, 0.85);
});

test("OpenAICompatibleProvider.evaluateValidation: 保持 endpoint、鉴权和模型请求契约", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  let requestedBody: unknown;
  const provider = new OpenAICompatibleProvider({
    apiKey: "sk-test-secret",
    baseUrl: "https://api.example.com/v1",
    model: "example-model",
    request: async (url, headers, body) => {
      requestedUrl = url;
      requestedHeaders = headers;
      requestedBody = body;
      return {
        status: 200,
        statusText: "OK",
        body: { choices: [{ message: { content: JSON.stringify(validEvalOutput) } }] },
      };
    },
  });

  await evaluateValidationViaChat(provider, evalInput());

  assert.equal(requestedUrl, "https://api.example.com/v1/chat/completions");
  assert.equal(requestedHeaders.Authorization, "Bearer sk-test-secret");
  assert.equal(typeof requestedBody, "object");
  const body = requestedBody as Record<string, unknown>;
  assert.equal(body.model, "example-model");
  assert.equal(body.stream, false);
  assert.ok(Array.isArray(body.messages));
});

test("analyzeImageViaChat: 使用独立视觉模型和 data URL 多模态消息", async () => {
  let requestedBody: unknown;
  const provider = new OpenAICompatibleProvider({
    apiKey: "sk-test-secret",
    baseUrl: "https://api.example.com/v1",
    model: "text-model",
    visionModel: "vision-model",
    request: async (_url, _headers, body) => {
      requestedBody = body;
      return {
        status: 200,
        statusText: "OK",
        body: {
          choices: [{ message: { content: JSON.stringify(validImageOutput) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      };
    },
  });

  const result = await analyzeImageViaChat(provider, {
    body: Buffer.from([0, 1, 2]),
    mimeType: "image/png",
    width: 640,
    height: 480,
    sha256: "a".repeat(64),
    userDescription: "一致性示意图",
  });

  assert.equal(provider.visionModelId, "vision-model");
  assert.equal(result.ocr[0]?.text, "缓存一致性");
  const body = requestedBody as Record<string, any>;
  assert.equal(body.model, "vision-model");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 4096);
  const content = body.messages[1].content as Array<Record<string, any>>;
  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.text, /normalized_0_10000/);
  assert.equal(content[1]?.type, "image_url");
  assert.equal(content[1]?.image_url?.url, "data:image/png;base64,AAEC");
});

test("OpenAICompatibleProvider.evaluateValidation: markdown 包裹的 JSON 成功解析", async () => {
  const markdownJson = "```json\n" + JSON.stringify(validEvalOutput) + "\n```";
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: markdownJson } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.outcome, "preliminary_understanding");
});

test("OpenAICompatibleProvider.evaluateValidation: 无 markdown 标记的 ``` 包裹成功解析", async () => {
  const wrappedJson = "```\n" + JSON.stringify(validEvalOutput) + "\n```";
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: wrappedJson } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.outcome, "preliminary_understanding");
});

test("OpenAICompatibleProvider.evaluateValidation: JSON 前后有多余文本但含有效 JSON 对象", async () => {
  const mixedContent = "Here is the result:\n" + JSON.stringify(validEvalOutput) + "\nDone.";
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: mixedContent } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.outcome, "preliminary_understanding");
});

// ─── evaluateValidation 失败路径 ─────────────────────────────────────────

test("OpenAICompatibleProvider.evaluateValidation: 无效 JSON 输出抛错", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "not json at all" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /no JSON object/,
  );
});

test("OpenAICompatibleProvider.evaluateValidation: schema 校验失败抛错", async () => {
  const invalidOutput = { wrong: "field" };
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: JSON.stringify(invalidOutput) } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /schema check/,
  );
});

test("OpenAICompatibleProvider.evaluateValidation: 空输出抛错", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /empty output/,
  );
});

test("OpenAICompatibleProvider.evaluateValidation: HTTP 错误状态抛错", async () => {
  const response: PublicJsonResponse = {
    status: 500,
    statusText: "Internal Server Error",
    body: { error: "server error" },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /500/,
  );
});

test("OpenAICompatibleProvider.evaluateValidation: 401 错误状态抛错", async () => {
  const response: PublicJsonResponse = {
    status: 401,
    statusText: "Unauthorized",
    body: { error: { code: "invalid_api_key", message: "invalid api key" } },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    (error: unknown) =>
      error instanceof ProviderRequestError
      && error.status === 401
      && error.providerCode === "invalid_api_key",
  );
});

// ─── call 方法分支 ───────────────────────────────────────────────────────

test("OpenAICompatibleProvider: aborted signal 抛错", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "OK" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput(), controller.signal),
    /user cancelled/,
  );
});

test("OpenAICompatibleProvider: aborted signal 无 reason 抛默认错误", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "OK" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput(), controller.signal),
    /aborted/,
  );
});

test("OpenAICompatibleProvider: 网络错误抛错", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: failingRequester(new Error("ECONNREFUSED")),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /ECONNREFUSED/,
  );
});

// ─── parseModelJson 边界情况（通过 evaluateValidation 间接测试）──────────

test("OpenAICompatibleProvider: 嵌套 JSON 对象正确解析", async () => {
  const nestedJson = '{"outcome":"preliminary_understanding","confidence":0.85,"feedback":"ok","covered_points":[],"missing_points":[],"misunderstandings":[],"evidence_refs":[]}';
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: nestedJson } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.outcome, "preliminary_understanding");
});

test("OpenAICompatibleProvider: JSON 含字符串中的花括号正确解析", async () => {
  const jsonWithStringBraces = '{"outcome":"preliminary_understanding","confidence":0.85,"feedback":"含{花括号}的反馈","covered_points":[],"missing_points":[],"misunderstandings":[],"evidence_refs":[]}';
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: jsonWithStringBraces } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.feedback, "含{花括号}的反馈");
});

test("OpenAICompatibleProvider: JSON 含转义引号正确解析", async () => {
  const jsonWithEscapedQuotes = '{"outcome":"preliminary_understanding","confidence":0.85,"feedback":"含\\"引号\\"的反馈","covered_points":[],"missing_points":[],"misunderstandings":[],"evidence_refs":[]}';
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: jsonWithEscapedQuotes } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(result.output.feedback, '含"引号"的反馈');
});

test("OpenAICompatibleProvider: 无 { 的输出抛 'no JSON object'", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "no braces here" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /no JSON object/,
  );
});

test("OpenAICompatibleProvider: 不完整的 JSON 抛 'malformed JSON'", async () => {
  const incompleteJson = 'Here is the result: {"outcome":"不完整"';
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: incompleteJson } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    evaluateValidationViaChat(provider, evalInput()),
    /malformed JSON/,
  );
});

// ─── Provider 属性验证 ───────────────────────────────────────────────────

test("OpenAICompatibleProvider: id 和 promptVersion 正确", () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
  });
  assert.equal(provider.id, "openai_compatible");
  assert.equal(provider.promptVersion, "v6-openai-compatible");
  assert.equal(provider.modelId, "gpt-4");
});

test("OpenAICompatibleProvider: usage returned per call, not retained across calls", async () => {
  let callCount = 0;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          status: 200,
          statusText: "OK",
          body: {
            choices: [{ message: { content: JSON.stringify(validEvalOutput) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        };
      }
      throw new Error("network unavailable");
    },
  });

  const ok = await evaluateValidationViaChat(provider, evalInput());
  assert.equal(ok.usage.totalTokens, 15);
  await assert.rejects(evaluateValidationViaChat(provider, evalInput()), /network unavailable/);
});

// ─── executeAgentTurn 截断/参数损坏检测（截断空转修复）────────────────────

const agentTurnRequest = {
  role: "text_extractor",
  systemPrompt: "test system prompt",
  messages: [{ role: "user" as const, content: "分析这段内容" }],
  tools: [{
    name: "record_extraction_decisions",
    description: "记录提取决策",
    parameters: { type: "object", properties: {} },
  }],
};

test("OpenAICompatibleProvider.executeAgentTurn: finish_reason=length 抛 output_truncated", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: {
              name: "record_extraction_decisions",
              // 模拟输出被截断：arguments 是不完整 JSON
              arguments: '{"candidates":[{"localId":"c1"},{"localId":',
            },
          }],
        },
        finish_reason: "length",
      }],
    },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (err: unknown) =>
      err instanceof AgentOutputError && err.code === "output_truncated",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: malformed arguments 抛 arguments_malformed", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: {
              name: "record_extraction_decisions",
              arguments: "{invalid json",
            },
          }],
        },
        finish_reason: "stop",
      }],
    },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (err: unknown) =>
      err instanceof AgentOutputError && err.code === "arguments_malformed",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: 完整 tool call 正常返回", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: {
              name: "record_extraction_decisions",
              arguments: '{"bundleIds":["b1"],"candidates":[{"localId":"c1"}]}',
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await provider.executeAgentTurn(agentTurnRequest as never);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "record_extraction_decisions");
  assert.deepEqual(result.toolCalls[0].arguments, { bundleIds: ["b1"], candidates: [{ localId: "c1" }] });
  assert.equal(result.finishReason, "tool_calls");
});
