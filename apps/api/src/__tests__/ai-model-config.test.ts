import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiCredentialHint,
  decryptAiCredential,
  encryptAiCredential,
  validateAiCredentialEncryptionKey,
} from "@ailearn/shared/ai-credentials";
import {
  resolveDashScopeGenerationUrl,
  resolveDashScopeTextEndpoint,
  resolveOpenAIChatCompletionsUrl,
} from "@ailearn/shared/ai-endpoints";
import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";
import {
  hasSamePersonalAIEndpointOrigin,
  normalizePersonalAIBaseUrl,
} from "../modules/identity/ai-model-config.ts";
import {
  AIModelConnectionError,
  testAIModelRuntimeConnection,
  type AIModelConnectionRuntime,
} from "../modules/identity/ai-model-connection.ts";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const OTHER_KEY = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";

describe("personal AI credential encryption", () => {
  it("round-trips a secret without embedding plaintext", () => {
    const encrypted = encryptAiCredential("sk-personal-secret", "user-1", TEST_KEY);
    assert.match(encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(encrypted, /personal-secret/);
    assert.equal(decryptAiCredential(encrypted, "user-1", TEST_KEY), "sk-personal-secret");
    assert.equal(aiCredentialHint("sk-personal-secret"), "••••cret");
  });

  it("rejects copied, tampered, or incorrectly keyed ciphertext", () => {
    const encrypted = encryptAiCredential("sk-personal-secret", "user-1", TEST_KEY);
    const tamperedParts = encrypted.split(".");
    tamperedParts[3] = `${tamperedParts[3][0] === "A" ? "B" : "A"}${tamperedParts[3].slice(1)}`;
    assert.throws(() => decryptAiCredential(encrypted, "user-2", TEST_KEY), /could not be decrypted/);
    assert.throws(() => decryptAiCredential(encrypted, "user-1", OTHER_KEY), /could not be decrypted/);
    assert.throws(
      () => decryptAiCredential(tamperedParts.join("."), "user-1", TEST_KEY),
      /could not be decrypted/,
    );
  });

  it("requires an explicit 32-byte server key", () => {
    assert.throws(() => validateAiCredentialEncryptionKey(""), /is required/);
    assert.throws(() => validateAiCredentialEncryptionKey("short"), /must be 32 bytes/);
    assert.doesNotThrow(() => validateAiCredentialEncryptionKey(TEST_KEY));
  });
});

describe("personal AI endpoint validation", () => {
  it("normalizes public HTTPS API roots and full endpoints", () => {
    assert.equal(
      normalizePersonalAIBaseUrl("dashscope", "https://dashscope.aliyuncs.com/api/v1/"),
      "https://dashscope.aliyuncs.com/api/v1",
    );
    assert.equal(
      normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("rejects plaintext, embedded credentials, local hosts, and unofficial DashScope hosts", () => {
    assert.throws(() => normalizePersonalAIBaseUrl("openai_compatible", "http://api.example.com/v1"), /HTTPS/);
    assert.throws(() => normalizePersonalAIBaseUrl("openai_compatible", "https://user:pass@api.example.com/v1"), /credentials/);
    assert.throws(() => normalizePersonalAIBaseUrl("openai_compatible", "https://127.0.0.1/v1"), /public DNS/);
    assert.throws(() => normalizePersonalAIBaseUrl("openai_compatible", "https://model.internal/v1"), /public DNS/);
    assert.throws(() => normalizePersonalAIBaseUrl("dashscope", "https://attacker.example/v1"), /official/);
  });

  it("adds each provider path exactly once", () => {
    assert.equal(
      resolveOpenAIChatCompletionsUrl("https://api.example.com/v1"),
      "https://api.example.com/v1/chat/completions",
    );
    assert.equal(
      resolveOpenAIChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1/chat/completions",
    );
    assert.equal(
      resolveDashScopeGenerationUrl("https://dashscope.aliyuncs.com/api/v1"),
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
    );
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/api/v1", "qwen3.5-plus"),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
    assert.deepEqual(
      resolveDashScopeTextEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
      {
        protocol: "openai_compatible",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    );
  });

  it("only reuses a stored credential on the exact same endpoint origin", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin(
        "https://api.example.com/v1",
        "https://api.example.com/v1/chat/completions",
      ),
      true,
    );
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com/v1", "https://evil.example/v1"),
      false,
    );
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com/v1", "https://api.example.com:444/v1"),
      false,
    );
  });
});

const OPENAI_RUNTIME: AIModelConnectionRuntime = {
  provider: "openai_compatible",
  baseUrl: "https://api.example.com/v1",
  model: "example-model",
  apiKey: "sk-test-secret-value",
};

describe("personal AI connection probe", () => {
  it("sends a minimal OpenAI-compatible request and never returns model content", async () => {
    const requestSnapshot: { url: string; headers: Record<string, string>; body: any } = {
      url: "",
      headers: {},
      body: null,
    };
    const requester: PublicJsonRequester = async (url, headers, body) => {
      Object.assign(requestSnapshot, { url, headers, body });
      return {
        status: 200,
        statusText: "OK",
        body: { choices: [{ message: { content: "private provider output" } }] },
      };
    };

    const result = await testAIModelRuntimeConnection(OPENAI_RUNTIME, requester, 1_000);
    assert.equal(result.ok, true);
    assert.equal(result.provider, "openai_compatible");
    assert.equal(result.model, "example-model");
    assert.equal("content" in result, false);
    assert.equal(requestSnapshot.url, "https://api.example.com/v1/chat/completions");
    assert.equal(requestSnapshot.headers.Authorization, "Bearer sk-test-secret-value");
    assert.equal(requestSnapshot.body.model, "example-model");
    assert.equal(requestSnapshot.body.messages.length, 1);
    assert.match(requestSnapshot.body.messages[0].content ?? "", /single word: OK/);
  });

  it("uses the DashScope request and response contract", async () => {
    const requestSnapshot: { url: string; body: any } = { url: "", body: null };
    const requester: PublicJsonRequester = async (url, _headers, body) => {
      Object.assign(requestSnapshot, { url, body });
      return {
        status: 200,
        statusText: "OK",
        body: { output: { choices: [{ message: { content: "OK" } }] } },
      };
    };
    const result = await testAIModelRuntimeConnection({
      ...OPENAI_RUNTIME,
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen-plus",
    }, requester, 1_000);

    assert.equal(result.provider, "dashscope");
    assert.equal(
      requestSnapshot.url,
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
    );
    assert.equal(requestSnapshot.body.input.messages.length, 1);
    assert.equal(requestSnapshot.body.parameters.result_format, "message");
  });

  it("automatically uses DashScope's compatible contract for Qwen 3.5", async () => {
    const requestSnapshot: { url: string; body: any } = { url: "", body: null };
    const requester: PublicJsonRequester = async (url, _headers, body) => {
      Object.assign(requestSnapshot, { url, body });
      return {
        status: 200,
        statusText: "OK",
        body: { choices: [{ message: { content: "OK" } }] },
      };
    };
    const result = await testAIModelRuntimeConnection({
      ...OPENAI_RUNTIME,
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3.5-plus",
    }, requester, 1_000);

    assert.equal(result.provider, "dashscope");
    assert.equal(
      requestSnapshot.url,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.equal(requestSnapshot.body.model, "qwen3.5-plus");
    assert.equal(requestSnapshot.body.messages.length, 1);
    assert.equal("input" in requestSnapshot.body, false);
  });

  it("reports invalid credentials without exposing the key or upstream echo", async () => {
    const requester: PublicJsonRequester = async () => ({
      status: 401,
      statusText: "Unauthorized",
      body: { error: { message: `invalid ${OPENAI_RUNTIME.apiKey}` } },
    });
    await assert.rejects(
      testAIModelRuntimeConnection(OPENAI_RUNTIME, requester, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof AIModelConnectionError);
        assert.equal(error.code, "invalid_credentials");
        assert.equal(error.statusCode, 422);
        assert.doesNotMatch(error.message, /sk-test-secret-value/);
        return true;
      },
    );
  });

  it("does not relay arbitrary provider error text", async () => {
    const requester: PublicJsonRequester = async () => ({
      status: 500,
      statusText: `echo ${OPENAI_RUNTIME.apiKey}`,
      body: { error: { message: `echo ${OPENAI_RUNTIME.apiKey}` } },
    });
    await assert.rejects(
      testAIModelRuntimeConnection(OPENAI_RUNTIME, requester, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof AIModelConnectionError);
        assert.equal(error.code, "provider_rejected");
        assert.doesNotMatch(error.message, /sk-test-secret-value|echo/);
        return true;
      },
    );
  });

  it("classifies incompatible success responses", async () => {
    const requester: PublicJsonRequester = async () => ({
      status: 200,
      statusText: "OK",
      body: { data: "not an OpenAI chat-completions response" },
    });
    await assert.rejects(
      testAIModelRuntimeConnection(OPENAI_RUNTIME, requester, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof AIModelConnectionError);
        assert.equal(error.code, "incompatible_response");
        assert.equal(error.statusCode, 502);
        return true;
      },
    );
  });

  it("enforces the connection-test timeout even when the requester ignores AbortSignal", async () => {
    const requester: PublicJsonRequester = () => new Promise(() => undefined);
    await assert.rejects(
      testAIModelRuntimeConnection(OPENAI_RUNTIME, requester, 5),
      (error: unknown) => {
        assert.ok(error instanceof AIModelConnectionError);
        assert.equal(error.code, "connection_timeout");
        assert.equal(error.statusCode, 504);
        return true;
      },
    );
  });
});
