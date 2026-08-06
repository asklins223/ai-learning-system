import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DashScopeProvider } from "../lib/providers/dashscope.ts";
import { ProviderRequestError } from "../lib/generation-failure-policy.ts";
import { evaluateValidationViaChat, analyzeImageViaChat } from "../lib/business-ai-ops.ts";

// ─── Helper: create a mock fetch that returns a given response ─────────

function mockFetch(responseBody: unknown, status = 200, headers: Record<string, string> = {}): {
  request: typeof fetch;
  capturedUrl: { value: string };
  capturedBody: { value: unknown };
  capturedHeaders: { value: Record<string, string> };
} {
  const capturedUrl = { value: "" };
  const capturedBody = { value: null as unknown };
  const capturedHeaders = { value: {} as Record<string, string> };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl.value = String(input);
    capturedBody.value = init?.body ? JSON.parse(String(init.body)) : null;
    capturedHeaders.value = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string> ?? {}),
    );
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }) as typeof fetch;
  return { request, capturedUrl, capturedBody, capturedHeaders };
}

function validationOutput() {
  return {
    outcome: "preliminary_understanding",
    confidence: 0.85,
    feedback: "Good answer",
    covered_points: ["point1"],
    missing_points: [],
    misunderstandings: [],
    evidence_refs: ["quote1"],
  };
}

function imageOutput() {
  return {
    contentType: "chart",
    decorative: false,
    caption: "趋势图",
    ocr: [],
    facts: [{
      text: "指标随时间上升",
      region: { x: 500, y: 500, width: 8_000, height: 8_000 },
      confidence: 0.95,
      kind: "chart",
    }],
    promptInjectionDetected: false,
    safetyFlags: [],
    unresolvedReason: null,
  };
}

// ─── Protocol selection tests ─────────────────────────────────────────

describe("DashScope provider protocol selection", () => {
  it("routes qwen-plus through the OpenAI-compatible endpoint", async () => {
    let requestedUrl = "";
    let requestedBody: any;
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(validationOutput()),
          },
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const provider = new DashScopeProvider({
      apiKey: "sk-test-secret",
      basePath: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen-plus",
      request,
    });

    await evaluateValidationViaChat(provider, {
      question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
    });

    assert.equal(
      requestedUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.equal(requestedBody.model, "qwen-plus");
    assert.equal(requestedBody.messages.length, 2);
    assert.equal("input" in requestedBody, false);
    assert.deepEqual(requestedBody.response_format, { type: "json_object" });
  });

  it("routes image analysis through the configured vision model with a data URL", async () => {
    const { request, capturedUrl, capturedBody } = mockFetch({
      choices: [{ message: { content: JSON.stringify(imageOutput()) } }],
      usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      visionModel: "qwen3-vl-plus",
      request,
    });

    const result = await analyzeImageViaChat(provider, {
      body: Buffer.from([3, 4, 5]),
      mimeType: "image/jpeg",
      width: 800,
      height: 600,
      sha256: "b".repeat(64),
      userDescription: "趋势图",
    });

    assert.equal(result.facts[0]?.kind, "chart");
    assert.equal(provider.visionModelId, "qwen3-vl-plus");
    assert.equal(
      capturedUrl.value,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = capturedBody.value as Record<string, any>;
    assert.equal(body.model, "qwen3-vl-plus");
    assert.equal(body.temperature, 0);
    const content = body.messages[1].content as Array<Record<string, any>>;
    assert.match(content[0]?.text, /normalized_0_10000/);
    assert.equal(content[1]?.image_url?.url, "data:image/jpeg;base64,AwQF");
  });
});

// ─── Constructor tests ────────────────────────────────────────────────

describe("DashScope constructor", () => {
  it("throws when DASHSCOPE_API_KEY is not set", () => {
    const origKey = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      assert.throws(
        () => new DashScopeProvider({ apiKey: undefined }),
        /DASHSCOPE_API_KEY is required/,
      );
    } finally {
      if (origKey) process.env.DASHSCOPE_API_KEY = origKey;
    }
  });

  it("reads apiKey from env when not provided", () => {
    const origKey = process.env.DASHSCOPE_API_KEY;
    const origModel = process.env.DASHSCOPE_MODEL;
    process.env.DASHSCOPE_API_KEY = "env-key";
    delete process.env.DASHSCOPE_MODEL;
    try {
      const provider = new DashScopeProvider({ request: (async () => new Response()) as typeof fetch });
      assert.equal(provider.id, "dashscope");
      assert.equal(provider.modelId, "qwen-plus");
    } finally {
      if (origKey) process.env.DASHSCOPE_API_KEY = origKey;
      else delete process.env.DASHSCOPE_API_KEY;
      if (origModel) process.env.DASHSCOPE_MODEL = origModel;
      else delete process.env.DASHSCOPE_MODEL;
    }
  });

  it("reads model from env when not provided", () => {
    const origModel = process.env.DASHSCOPE_MODEL;
    process.env.DASHSCOPE_MODEL = "qwen-max";
    try {
      const provider = new DashScopeProvider({
        apiKey: "test-key",
        request: (async () => new Response()) as typeof fetch,
      });
      assert.equal(provider.modelId, "qwen-max");
    } finally {
      if (origModel) process.env.DASHSCOPE_MODEL = origModel;
      else delete process.env.DASHSCOPE_MODEL;
    }
  });

  it("uses default base path when not provided", () => {
    const origBase = process.env.DASHSCOPE_BASE_URL;
    const origHttpBase = process.env.DASHSCOPE_HTTP_BASE_URL;
    delete process.env.DASHSCOPE_BASE_URL;
    delete process.env.DASHSCOPE_HTTP_BASE_URL;
    try {
      const provider = new DashScopeProvider({
        apiKey: "test-key",
        request: (async () => new Response()) as typeof fetch,
      });
      assert.equal(provider.promptVersion, "v6-dashscope");
    } finally {
      if (origBase) process.env.DASHSCOPE_BASE_URL = origBase;
      if (origHttpBase) process.env.DASHSCOPE_HTTP_BASE_URL = origHttpBase;
    }
  });

  it("strips trailing slash from basePath", async () => {
    const { request, capturedUrl } = mockFetch({
      choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      basePath: "https://dashscope.aliyuncs.com/api/v1/",
      model: "qwen-plus",
      request,
    });
    await evaluateValidationViaChat(provider, {
      question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
    });
    assert.ok(!capturedUrl.value.includes("v1//"));
  });
});

// ─── evaluateValidation tests ─────────────────────────────────────────

describe("DashScope evaluateValidation", () => {
  it("returns parsed validation output", async () => {
    const { request, capturedBody } = mockFetch({
      choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const result = await evaluateValidationViaChat(provider, {
      question: "What is X?",
      questionType: "free_text",
      claim: "X is Y",
      quote: "X equals Y",
      userAnswer: "Y",
    });
    assert.equal(result.output.outcome, "preliminary_understanding");
    assert.equal(result.output.confidence, 0.85);
    assert.equal(result.output.feedback, "Good answer");
    const body = capturedBody.value as Record<string, unknown>;
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("throws when aborted before call", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      evaluateValidationViaChat(
        provider,
        { question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A" },
        controller.signal,
      ),
      /aborted/,
    );
  });

  it("throws on schema validation failure", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: JSON.stringify({ wrong: "shape" }) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      evaluateValidationViaChat(provider, {
        question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
      }),
      /schema check/,
    );
  });
});

// ─── Error response tests ─────────────────────────────────────────────

describe("DashScope error handling", () => {
  it("throws on non-OK response with error code and message", async () => {
    const { request } = mockFetch({
      code: "InvalidApiKey",
      message: "Invalid API key provided",
    }, 401);
    const provider = new DashScopeProvider({
      apiKey: "bad-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      evaluateValidationViaChat(provider, {
        question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
      }),
      (error: unknown) =>
        error instanceof ProviderRequestError
        && error.status === 401
        && error.providerCode === "InvalidApiKey",
    );
  });

  it("throws when response body is not valid JSON", async () => {
    const request = (async () => {
      return new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      evaluateValidationViaChat(provider, {
        question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
      }),
      /invalid JSON/,
    );
  });

  it("throws when response has empty output", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: "" } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      evaluateValidationViaChat(provider, {
        question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
      }),
      /empty output/,
    );
  });
});

// ─── Workspace header test ────────────────────────────────────────────

describe("DashScope workspace header", () => {
  it("sends X-DashScope-WorkSpace header when workspace is configured", async () => {
    const { request, capturedHeaders } = mockFetch({
      choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      workspace: "ws-123",
      request,
    });
    await evaluateValidationViaChat(provider, {
      question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
    });
    assert.equal(capturedHeaders.value["X-DashScope-WorkSpace"], "ws-123");
  });

  it("does not send X-DashScope-WorkSpace header when workspace is not configured", async () => {
    const { request, capturedHeaders } = mockFetch({
      choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await evaluateValidationViaChat(provider, {
      question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
    });
    assert.ok(!("X-DashScope-WorkSpace" in capturedHeaders.value));
  });
});

// ─── AbortSignal during request ───────────────────────────────────────

describe("DashScope abort signal handling", () => {
  it("throws when signal is aborted after response", async () => {
    const controller = new AbortController();
    const request = (async () => {
      controller.abort();
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      evaluateValidationViaChat(
        provider,
        { question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A" },
        controller.signal,
      ),
    );
  });
});

// ─── Usage accounting ─────────────────────────────────────────────────

describe("DashScope usage accounting", () => {
  it("clears usage from the previous call when the next request fails", async () => {
    let callCount = 0;
    const request = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validationOutput()) } }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("network unavailable");
    }) as typeof fetch;
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });

    const ok = await evaluateValidationViaChat(provider, {
      question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
    });
    assert.equal(ok.usage.totalTokens, 12);
    await assert.rejects(
      evaluateValidationViaChat(provider, {
        question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
      }),
      /network unavailable/,
    );
  });
});

// ─── AbortSignal forwarding ───────────────────────────────────────────

describe("DashScope abort signal forwarding", () => {
  it("forwards the worker AbortSignal to the HTTP request", async () => {
    let requestSignal: AbortSignal | undefined;
    const request: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      await new Promise<never>((_, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
      throw new Error("request should have been aborted");
    };
    const provider = new DashScopeProvider({ apiKey: "test-key", request });
    const controller = new AbortController();
    const pending = evaluateValidationViaChat(
      provider,
      { question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A" },
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.equal(requestSignal, controller.signal);
  });
});
