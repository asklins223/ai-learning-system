import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DashScopeProvider } from "../lib/providers/dashscope.ts";

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

function cardOutput() {
  return {
    title: "Test Card",
    summary: "Test Summary",
    key_points: [{ ordinal: 0, claim: "Test Claim", quote_text: "Test Quote" }],
  };
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
            content: JSON.stringify(cardOutput()),
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

    const result = await provider.generateCard({ noteTitle: "Note", blocks: [] });

    assert.equal(result.title, "Test Card");
    assert.equal(
      requestedUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.equal(requestedBody.model, "qwen-plus");
    assert.equal(requestedBody.messages.length, 2);
    assert.equal("input" in requestedBody, false);
    // response_format must be set to enforce JSON output
    assert.deepEqual(requestedBody.response_format, { type: "json_object" });
  });

  it("routes qwen3.5-plus through the OpenAI-compatible endpoint", async () => {
    let requestedUrl = "";
    let requestedBody: any;
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(cardOutput()),
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
      model: "qwen3.5-plus",
      request,
    });

    await provider.generateCard({ noteTitle: "Note", blocks: [] });

    assert.equal(
      requestedUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.deepEqual(requestedBody.response_format, { type: "json_object" });
  });

  it("sets stream:false and max_tokens in the request body", async () => {
    let requestedBody: any;
    const request = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
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
    await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(requestedBody.stream, false);
    assert.equal(requestedBody.max_tokens, 4096);
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

    const result = await provider.analyzeImage({
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
    assert.equal(provider.getLastUsage()?.totalTokens, 18);
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
    process.env.DASHSCOPE_API_KEY = "env-key";
    try {
      const provider = new DashScopeProvider({ request: (async () => new Response()) as typeof fetch });
      assert.equal(provider.id, "dashscope");
      assert.equal(provider.modelId, "qwen-plus");
    } finally {
      if (origKey) process.env.DASHSCOPE_API_KEY = origKey;
      else delete process.env.DASHSCOPE_API_KEY;
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
      choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      basePath: "https://dashscope.aliyuncs.com/api/v1/",
      model: "qwen-plus",
      request,
    });
    await provider.generateCard({ noteTitle: "Note", blocks: [] });
    // The URL should not contain double slashes from the trailing slash
    assert.ok(!capturedUrl.value.includes("v1//"));
  });
});

// ─── generateCard tests ───────────────────────────────────────────────

describe("DashScope generateCard", () => {
  it("returns parsed card output", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const result = await provider.generateCard({
      noteTitle: "My Note",
      blocks: [{ ordinal: 0, type: "paragraph", content: "content" }],
    });
    assert.equal(result.title, "Test Card");
    assert.equal(result.summary, "Test Summary");
    assert.equal(result.key_points.length, 1);
    assert.equal(result.key_points[0].claim, "Test Claim");
  });

  it("throws when aborted before call", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider.generateCard({ noteTitle: "Note", blocks: [] }, controller.signal),
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
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /schema check/,
    );
  });

  it("handles JSON wrapped in markdown fences", async () => {
    const fencedJson = "```json\n" + JSON.stringify(cardOutput()) + "\n```";
    const { request } = mockFetch({
      choices: [{ message: { content: fencedJson } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const result = await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(result.title, "Test Card");
  });

  it("handles JSON with prose prefix", async () => {
    const jsonWithProse = 'Here is the card:\n' + JSON.stringify(cardOutput());
    const { request } = mockFetch({
      choices: [{ message: { content: jsonWithProse } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    const result = await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(result.title, "Test Card");
  });

  it("throws when response has no JSON object", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: "no json here" } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /no JSON object/,
    );
  });

  it("throws when response JSON is malformed", async () => {
    const { request } = mockFetch({
      choices: [{ message: { content: "{ broken json }" } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /could not be parsed/,
    );
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
    const result = await provider.evaluateValidation({
      question: "What is X?",
      questionType: "free_text",
      claim: "X is Y",
      quote: "X equals Y",
      userAnswer: "Y",
    });
    assert.equal(result.outcome, "preliminary_understanding");
    assert.equal(result.confidence, 0.85);
    assert.equal(result.feedback, "Good answer");
    // evaluateValidation uses 2048 max_tokens
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
      provider.evaluateValidation(
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
      provider.evaluateValidation({
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
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /dashscope InvalidApiKey: Invalid API key provided/,
    );
  });

  it("throws on non-OK response with status code fallback", async () => {
    const { request } = mockFetch({ foo: "bar" }, 500);
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /dashscope/,
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
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
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
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /empty output/,
    );
  });

  it("throws when response has no choices field", async () => {
    const { request } = mockFetch({
      request_id: "xxx",
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await assert.rejects(
      provider.generateCard({ noteTitle: "Note", blocks: [] }),
      /empty output/,
    );
  });
});

// ─── Workspace header test ────────────────────────────────────────────

describe("DashScope workspace header", () => {
  it("sends X-DashScope-WorkSpace header when workspace is configured", async () => {
    const { request, capturedHeaders } = mockFetch({
      choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      workspace: "ws-123",
      request,
    });
    await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(capturedHeaders.value["X-DashScope-WorkSpace"], "ws-123");
  });

  it("does not send X-DashScope-WorkSpace header when workspace is not configured", async () => {
    const { request, capturedHeaders } = mockFetch({
      choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
    });
    const provider = new DashScopeProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      request,
    });
    await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.ok(!("X-DashScope-WorkSpace" in capturedHeaders.value));
  });
});

// ─── AbortSignal during request ───────────────────────────────────────

describe("DashScope abort signal handling", () => {
  it("throws when signal is aborted after response", async () => {
    const controller = new AbortController();
    const request = (async () => {
      // Abort the signal after the fetch starts but before we read the body
      controller.abort();
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
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
      provider.generateCard({ noteTitle: "Note", blocks: [] }, controller.signal),
    );
  });
});

describe("DashScope usage accounting", () => {
  it("clears usage from the previous call when the next request fails", async () => {
    let callCount = 0;
    const request = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(cardOutput()) } }],
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

    await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(provider.getLastUsage()?.totalTokens, 12);
    await assert.rejects(provider.generateCard({ noteTitle: "Note", blocks: [] }), /network unavailable/);
    assert.equal(provider.getLastUsage(), null);
  });
});
