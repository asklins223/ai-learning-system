import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DashScopeProvider } from "./dashscope.ts";

describe("DashScope provider protocol selection", () => {
  it("uses the OpenAI-compatible contract for Qwen 3.5 configured with the legacy root", async () => {
    let requestedUrl = "";
    let requestedBody: any;
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Card",
              summary: "Summary",
              key_points: [{ ordinal: 0, claim: "Claim", quote_text: "Quote" }],
            }),
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

    const result = await provider.generateCard({ noteTitle: "Note", blocks: [] });

    assert.equal(result.title, "Card");
    assert.equal(
      requestedUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.equal(requestedBody.model, "qwen3.5-plus");
    assert.equal(requestedBody.messages.length, 2);
    assert.equal("input" in requestedBody, false);
  });

  it("keeps the native text-generation contract for qwen-plus", async () => {
    let requestedUrl = "";
    let requestedBody: any;
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: "Card",
                summary: "Summary",
                key_points: [{ ordinal: 0, claim: "Claim", quote_text: "Quote" }],
              }),
            },
          }],
        },
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

    await provider.generateCard({ noteTitle: "Note", blocks: [] });

    assert.equal(
      requestedUrl,
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
    );
    assert.equal(requestedBody.input.messages.length, 2);
    assert.equal(requestedBody.parameters.result_format, "message");
  });
});
