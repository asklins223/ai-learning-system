import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveDashScopeTextEndpoint,
  resolveOpenAIChatCompletionsUrl,
} from "./ai-endpoints.ts";
import {
  isNonPublicAIEndpointAddress,
  postSseToPublicEndpoint,
  postJsonToPublicEndpoint,
} from "./public-json-http.ts";
import {
  imageInsightOutputSchema,
  learningCardOutputSchema,
} from "./schemas.ts";
import { parseContent } from "./markdown-parser.ts";

describe("AI endpoint resolution", () => {
  it("adds terminal provider paths only once", () => {
    assert.equal(
      resolveOpenAIChatCompletionsUrl("https://api.example.com/v1/"),
      "https://api.example.com/v1/chat/completions",
    );
    assert.equal(
      resolveOpenAIChatCompletionsUrl("https://api.example.com/v1/chat/completions/"),
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("routes all models through the compatible endpoint", () => {
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
  });

  it("rejects the retired native endpoint root", () => {
    assert.throws(
      () => resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/api/v1"),
      /compatible-mode\/v1/,
    );
  });
});

describe("public endpoint address policy", () => {
  it("blocks private, loopback, link-local, documentation, and mapped addresses", () => {
    const previous = process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
    try {
      // This contract asserts the default fail-closed policy regardless of a
      // developer's local Docker/VPN compatibility override.
      delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
      for (const address of [
        "0.0.0.0",
        "10.0.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.168.0.1",
        "203.0.113.10",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
      ]) {
        assert.equal(isNonPublicAIEndpointAddress(address), true, address);
      }
    } finally {
      if (previous === undefined) delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
      else process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = previous;
    }
  });

  it("allows representative public IPv4 and IPv6 addresses", () => {
    assert.equal(isNonPublicAIEndpointAddress("8.8.8.8"), false);
    assert.equal(isNonPublicAIEndpointAddress("2606:4700:4700::1111"), false);
  });

  it("rejects a private literal endpoint before opening a socket", async () => {
    await assert.rejects(
      postJsonToPublicEndpoint("https://127.0.0.1/v1/chat/completions", {}, {}),
      /non-public address/,
    );
  });

  it("applies the same SSRF guard to streaming endpoints", async () => {
    await assert.rejects(
      postSseToPublicEndpoint("https://127.0.0.1/v1/chat/completions", {}, {}),
      /non-public address/,
    );
  });

  it("keeps Docker Desktop synthetic DNS compatibility explicit", () => {
    const previous = process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
    try {
      delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
      assert.equal(isNonPublicAIEndpointAddress("198.18.0.44"), true);
      process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = "true";
      assert.equal(isNonPublicAIEndpointAddress("198.18.0.44"), false);
      assert.equal(isNonPublicAIEndpointAddress("127.0.0.1"), true);
      assert.equal(isNonPublicAIEndpointAddress("10.0.0.1"), true);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
      } else {
        process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = previous;
      }
    }
  });
});

describe("shared AI output contracts", () => {
  it("rejects empty card data", () => {
    assert.equal(learningCardOutputSchema.safeParse({ title: "", summary: "", key_points: [] }).success, false);
  });

  it("keeps decorative and hard image evidence mutually exclusive", () => {
    const base = {
      contentType: "decorative" as const,
      decorative: true,
      caption: "装饰插图",
      ocr: [],
      facts: [],
      promptInjectionDetected: false,
      safetyFlags: [],
      unresolvedReason: null,
    };
    assert.equal(imageInsightOutputSchema.safeParse(base).success, true);
    assert.equal(imageInsightOutputSchema.safeParse({
      ...base,
      ocr: [{
        text: "不应发布",
        region: { x: 0, y: 0, width: 100, height: 100 },
        confidence: 0.99,
      }],
    }).success, false);
  });

});

describe("shared Markdown parser", () => {
  it("keeps every segment span anchored to the original CRLF input", () => {
    const content = "# Title\r\n\r\nParagraph one.\r\n\r\n- first\r\n- second";

    for (const segment of parseContent(content, "markdown")) {
      assert.equal(content.slice(segment.charStart, segment.charEnd), segment.text);
    }
  });

  it("keeps closed and unclosed fenced-code spans anchored to the input", () => {
    for (const content of [
      "```ts\r\nconst answer = 42;\r\n```\r\n",
      "```ts\r\nconst answer = 42;",
    ]) {
      const [segment] = parseContent(content, "markdown");
      assert.equal(segment.segmentType, "code");
      assert.equal(content.slice(segment.charStart, segment.charEnd), segment.text);
    }
  });
});
