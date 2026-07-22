import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiCredentialHint,
  decryptAiCredential,
  encryptAiCredential,
  validateAiCredentialEncryptionKey,
} from "./ai-credentials.ts";
import {
  resolveDashScopeGenerationUrl,
  resolveDashScopeTextEndpoint,
  resolveOpenAIChatCompletionsUrl,
} from "./ai-endpoints.ts";
import {
  isNonPublicAIEndpointAddress,
  postJsonToPublicEndpoint,
} from "./public-json-http.ts";
import { evaluateValidationOutputSchema, learningCardOutputSchema } from "./schemas.ts";
import { parseContent } from "./markdown-parser.ts";

const HEX_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BASE64_KEY = Buffer.from(HEX_KEY, "hex").toString("base64");

describe("AI credential helpers", () => {
  it("round-trips credentials and binds ciphertext to a user", () => {
    const encrypted = encryptAiCredential("sk-private-value", "user-a", HEX_KEY);

    assert.equal(decryptAiCredential(encrypted, "user-a", HEX_KEY), "sk-private-value");
    assert.doesNotMatch(encrypted, /private-value/);
    assert.throws(() => decryptAiCredential(encrypted, "user-b", HEX_KEY), /could not be decrypted/);
  });

  it("accepts exact hex/base64 keys and rejects permissive base64 garbage", () => {
    assert.doesNotThrow(() => validateAiCredentialEncryptionKey(HEX_KEY));
    assert.doesNotThrow(() => validateAiCredentialEncryptionKey(BASE64_KEY));
    assert.throws(
      () => validateAiCredentialEncryptionKey(`${BASE64_KEY.slice(0, -1)}!`),
      /must be 32 bytes/,
    );
  });

  it("does not expose a complete short secret in a hint", () => {
    assert.equal(aiCredentialHint("sk-private-value"), "••••alue");
    assert.equal(aiCredentialHint("abcd"), "••••");
    assert.equal(aiCredentialHint("abc"), "••••");
    assert.equal(aiCredentialHint(""), "••••");
  });
});

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
    assert.equal(
      resolveDashScopeGenerationUrl("https://dashscope.aliyuncs.com/api/v1/"),
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
    );
  });

  it("routes all models through the compatible endpoint", () => {
    // qwen-plus (legacy model) — still routes to compatible endpoint
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/api/v1", "qwen-plus"),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
    // qwen3.6-plus (modern model)
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/api/v1", " qwen3.6-plus "),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
  });

  it("accepts an explicit compatible-mode base URL", () => {
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
  });
});

describe("public endpoint address policy", () => {
  it("blocks private, loopback, link-local, documentation, and mapped addresses", () => {
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
  it("rejects empty card data and out-of-range validation confidence", () => {
    assert.equal(learningCardOutputSchema.safeParse({ title: "", summary: "", key_points: [] }).success, false);
    assert.equal(evaluateValidationOutputSchema.safeParse({
      outcome: "unknown",
      confidence: 2,
      feedback: "Needs review",
    }).success, false);
  });

  it("accepts optional thinking field in evaluateValidationOutputSchema", () => {
    const withThinking = evaluateValidationOutputSchema.safeParse({
      outcome: "preliminary_understanding",
      confidence: 0.85,
      feedback: "回答准确覆盖了核心原理",
      thinking: "claim 核心要点：1) 前提条件 2) 策略选择 3) 目的",
      covered_points: ["策略选择"],
      missing_points: [],
      misunderstandings: [],
      evidence_refs: [],
    });
    assert.equal(withThinking.success, true);

    const withoutThinking = evaluateValidationOutputSchema.safeParse({
      outcome: "preliminary_understanding",
      confidence: 0.85,
      feedback: "回答准确覆盖了核心原理",
    });
    assert.equal(withoutThinking.success, true);
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
