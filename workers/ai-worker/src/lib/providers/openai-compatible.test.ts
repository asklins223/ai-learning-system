import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNonPublicAIEndpointAddress,
  postJsonToPublicEndpoint,
} from "@ailearn/shared/public-json-http";
import { OpenAICompatibleProvider, resolveChatCompletionsUrl } from "./openai-compatible.ts";

describe("OpenAI-compatible personal provider", () => {
  it("normalizes API roots without duplicating the chat path", () => {
    assert.equal(resolveChatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
    assert.equal(resolveChatCompletionsUrl("https://api.example.com/v1/chat/completions/"), "https://api.example.com/v1/chat/completions");
  });

  it("preserves the model/request contract and validates generated cards", async () => {
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> = {};
    let requestedBody: any;
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
          body: {
            choices: [{ message: { content: "```json\n{\"title\":\"Card\",\"summary\":\"Summary\",\"key_points\":[{\"ordinal\":0,\"claim\":\"Claim\",\"quote_text\":\"Quote\"}]}\n```" } }],
          },
        };
      },
    });

    const result = await provider.generateCard({ noteTitle: "Note", blocks: [] });
    assert.equal(result.title, "Card");
    assert.equal(requestedUrl, "https://api.example.com/v1/chat/completions");
    assert.equal(requestedHeaders.Authorization, "Bearer sk-test-secret");
    assert.equal(requestedBody.model, "example-model");
    assert.equal(requestedBody.temperature, 0.2);
  });

  it("rejects private literal endpoints before opening a socket", async () => {
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
      if (previous === undefined) delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
      else process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = previous;
    }
  });
});
