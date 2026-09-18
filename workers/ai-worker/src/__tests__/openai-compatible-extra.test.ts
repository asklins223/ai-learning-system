/**
 * OpenAI-compatible provider contract tests.
 *
 * Validation-session prompt/schema tests were removed with the obsolete V1
 * validation worker path. These tests cover the active generic chat and
 * Supervisor Agent transport contracts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

const messages = [{ role: "user" as const, content: "ping" }];

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

function createProvider(request: PublicJsonRequester = mockRequester({
  status: 200,
  statusText: "OK",
  body: { choices: [{ message: { content: "ok" } }] },
})): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request,
  });
}

test("OpenAICompatibleProvider: generic chat completion returns content and usage", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  }));

  const result = await provider.chatCompletion(messages, { responseFormat: "text" });
  assert.equal(result.content, "hello");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.usage.promptTokens, 10);
  assert.equal(result.usage.completionTokens, 5);
});

test("OpenAICompatibleProvider: HTTP errors expose provider status", async () => {
  const provider = createProvider(mockRequester({
    status: 401,
    statusText: "Unauthorized",
    body: { error: { code: "invalid_api_key", message: "invalid api key" } },
  }));

  await assert.rejects(
    provider.chatCompletion(messages, { responseFormat: "text" }),
    (error: unknown) =>
      error instanceof ProviderRequestError
      && error.status === 401
      && error.providerCode === "invalid_api_key",
  );
});

test("OpenAICompatibleProvider: abort and network errors fail closed", async () => {
  const provider = createProvider(async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(provider.chatCompletion(messages, { responseFormat: "text" }), /network unavailable/);

  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    provider.chatCompletion(messages, { responseFormat: "text" }, controller.signal),
    /user cancelled/,
  );
});

test("OpenAICompatibleProvider: id and prompt version identify the active transport", () => {
  const provider = createProvider();
  assert.equal(provider.id, "openai_compatible");
  assert.equal(provider.promptVersion, "v6-openai-compatible");
  assert.equal(provider.modelId, "gpt-4");
});

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

test("OpenAICompatibleProvider.executeAgentTurn: finish_reason=length is non-retryable", async () => {
  const provider = createProvider(mockRequester({
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
              arguments: '{"candidates":[{"localId":"c1"},{"localId":',
            },
          }],
        },
        finish_reason: "length",
      }],
    },
  }));

  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: malformed tool arguments are rejected", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: { name: "record_extraction_decisions", arguments: "{invalid json" },
          }],
        },
        finish_reason: "stop",
      }],
    },
  }));

  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (error: unknown) => error instanceof AgentOutputError && error.code === "arguments_malformed",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: valid tool calls are returned", async () => {
  const provider = createProvider(mockRequester({
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
  }));

  const result = await provider.executeAgentTurn(agentTurnRequest as never);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "record_extraction_decisions");
  assert.deepEqual(result.toolCalls[0].arguments, {
    bundleIds: ["b1"],
    candidates: [{ localId: "c1" }],
  });
  assert.equal(result.finishReason, "tool_calls");
});
