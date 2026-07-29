/**
 * openai-compatible.ts 扩展测试
 *
 * 通过 mock requester 测试 OpenAICompatibleProvider 的所有方法：
 * - generateCard 成功/失败
 * - evaluateValidation 成功/失败
 * - call 方法的错误分支（aborted signal, error status, empty output）
 * - parseModelJson 的各种 JSON 格式解析
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

function failingRequester(error: Error): PublicJsonRequester {
  return async () => { throw error; };
}

const validCardOutput = {
  title: "测试卡片",
  summary: "测试摘要",
  key_points: [
    {
      ordinal: 0,
      claim: "测试要点",
      quote_text: "原文引用",
    },
  ],
};

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

// ─── generateCard 成功路径 ───────────────────────────────────────────────

test("OpenAICompatibleProvider.generateCard: 正常 JSON 输出成功", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: JSON.stringify(validCardOutput) } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  const result = await provider.generateCard({
    noteTitle: "测试笔记",
    blocks: [{ ordinal: 0, type: "paragraph", content: "内容" }],
  });
  assert.equal(result.title, "测试卡片");
  assert.equal(result.key_points.length, 1);
});

test("OpenAICompatibleProvider.generateCard: 保持 endpoint、鉴权和模型请求契约", async () => {
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
        body: { choices: [{ message: { content: JSON.stringify(validCardOutput) } }] },
      };
    },
  });

  await provider.generateCard({ noteTitle: "Note", blocks: [] });

  assert.equal(requestedUrl, "https://api.example.com/v1/chat/completions");
  assert.equal(requestedHeaders.Authorization, "Bearer sk-test-secret");
  assert.equal(typeof requestedBody, "object");
  const body = requestedBody as Record<string, unknown>;
  assert.equal(body.model, "example-model");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, false);
  assert.ok(Array.isArray(body.messages));
});

test("OpenAICompatibleProvider.generateCard: markdown 包裹的 JSON 成功解析", async () => {
  const markdownJson = "```json\n" + JSON.stringify(validCardOutput) + "\n```";
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
  const result = await provider.generateCard({
    noteTitle: "测试笔记",
    blocks: [{ ordinal: 0, type: "paragraph", content: "内容" }],
  });
  assert.equal(result.title, "测试卡片");
});

test("OpenAICompatibleProvider.analyzeImage: 使用独立视觉模型和 data URL 多模态消息", async () => {
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

  const result = await provider.analyzeImage({
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
  assert.equal(provider.getLastUsage()?.totalTokens, 15);
});

test("OpenAICompatibleProvider.generateCard: 无 markdown 标记的 ``` 包裹成功解析", async () => {
  const wrappedJson = "```\n" + JSON.stringify(validCardOutput) + "\n```";
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
  const result = await provider.generateCard({
    noteTitle: "测试",
    blocks: [],
  });
  assert.equal(result.title, "测试卡片");
});

test("OpenAICompatibleProvider.generateCard: JSON 前后有多余文本但含有效 JSON 对象", async () => {
  const mixedContent = "Here is the result:\n" + JSON.stringify(validCardOutput) + "\nDone.";
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
  const result = await provider.generateCard({
    noteTitle: "测试",
    blocks: [],
  });
  assert.equal(result.title, "测试卡片");
});

// ─── generateCard 失败路径 ───────────────────────────────────────────────

test("OpenAICompatibleProvider.generateCard: 无效 JSON 输出抛错", async () => {
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /no JSON object/,
  );
});

test("OpenAICompatibleProvider.generateCard: schema 校验失败抛错", async () => {
  const invalidOutput = { title: "缺少字段" };
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /schema check/,
  );
});

test("OpenAICompatibleProvider.generateCard: 空输出抛错", async () => {
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /empty output/,
  );
});

test("OpenAICompatibleProvider.generateCard: 空白输出抛错", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "   " } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /empty output/,
  );
});

test("OpenAICompatibleProvider.generateCard: HTTP 错误状态抛错", async () => {
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /500/,
  );
});

test("OpenAICompatibleProvider.generateCard: 401 错误状态抛错", async () => {
  const response: PublicJsonResponse = {
    status: 401,
    statusText: "Unauthorized",
    body: { error: { message: "invalid api key" } },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /401: invalid api key/,
  );
});

// ─── evaluateValidation 成功/失败 ─────────────────────────────────────────

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
  const result = await provider.evaluateValidation({
    question: "什么是X？",
    questionType: "free_text",
    claim: "X是Y",
    quote: "X是Y的原文",
    userAnswer: "X是Y",
  });
  assert.equal(result.outcome, "preliminary_understanding");
  assert.equal(result.confidence, 0.85);
});

test("OpenAICompatibleProvider.evaluateValidation: 无效 JSON 抛错", async () => {
  const response: PublicJsonResponse = {
    status: 200,
    statusText: "OK",
    body: { choices: [{ message: { content: "not json" } }] },
  };
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester(response),
  });
  await assert.rejects(
    provider.evaluateValidation({
      question: "什么是X？",
      questionType: "free_text",
      claim: "X是Y",
      quote: "原文",
      userAnswer: "X是Y",
    }),
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
    provider.evaluateValidation({
      question: "什么是X？",
      questionType: "free_text",
      claim: "X是Y",
      quote: "原文",
      userAnswer: "X是Y",
    }),
    /schema check/,
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }, controller.signal),
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }, controller.signal),
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /ECONNREFUSED/,
  );
});

// ─── parseModelJson 边界情况（通过 generateCard 间接测试）─────────────────

test("OpenAICompatibleProvider: 嵌套 JSON 对象正确解析", async () => {
  const nestedJson = '{"title":"卡","summary":"摘要","key_points":[{"ordinal":0,"claim":"要点","quote_text":"引用"}]}';
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
  const result = await provider.generateCard({ noteTitle: "测试", blocks: [] });
  assert.equal(result.title, "卡");
  assert.equal(result.key_points[0].claim, "要点");
});

test("OpenAICompatibleProvider: JSON 含字符串中的花括号正确解析", async () => {
  const jsonWithStringBraces = '{"title":"含{花括号}的标题","summary":"摘要","key_points":[{"ordinal":0,"claim":"要点","quote_text":"引用"}]}';
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
  const result = await provider.generateCard({ noteTitle: "测试", blocks: [] });
  assert.equal(result.title, "含{花括号}的标题");
});

test("OpenAICompatibleProvider: JSON 含转义引号正确解析", async () => {
  const jsonWithEscapedQuotes = '{"title":"含\\"引号\\"的标题","summary":"摘要","key_points":[{"ordinal":0,"claim":"要点","quote_text":"引用"}]}';
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
  const result = await provider.generateCard({ noteTitle: "测试", blocks: [] });
  assert.equal(result.title, '含"引号"的标题');
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
    /no JSON object/,
  );
});

test("OpenAICompatibleProvider: 不完整的 JSON 抛 'malformed JSON'", async () => {
  const incompleteJson = 'Here is the result: {"title":"不完整"';
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
    provider.generateCard({ noteTitle: "测试", blocks: [] }),
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

test("OpenAICompatibleProvider: failed request clears usage from the previous call", async () => {
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
            choices: [{ message: { content: JSON.stringify(validCardOutput) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        };
      }
      throw new Error("network unavailable");
    },
  });

  await provider.generateCard({ noteTitle: "测试", blocks: [] });
  assert.equal(provider.getLastUsage()?.totalTokens, 15);
  await assert.rejects(provider.generateCard({ noteTitle: "测试", blocks: [] }), /network unavailable/);
  assert.equal(provider.getLastUsage(), null);
});
