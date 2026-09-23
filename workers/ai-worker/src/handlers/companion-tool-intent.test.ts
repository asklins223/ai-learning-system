import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../lib/ai-provider.ts";
import { companionNeedsTool } from "./companion-tool-intent.ts";

function provider(decide: (input: string) => boolean): AIProvider {
  return {
    id: "test",
    modelId: "test",
    visionModelId: "test",
    promptVersion: "test",
    chatCompletion: async (messages) => ({
      content: JSON.stringify({ needsTool: decide(String(messages.at(-1)?.content ?? "")) }),
      usage: {},
    }),
  } as AIProvider;
}

test("语义判断把简称文章的插图请求交给工具，不依赖固定措辞", async () => {
  const model = provider((input) => input.includes("插图") && input.includes("IndexTTS"));
  const result = await companionNeedsTool(model, [
    { role: "user", content: "给我看看 IndexTTS 2.5 文章的插图" },
  ], new AbortController().signal);
  assert.equal(result, true);
});

test("闲聊可以直接回复；无效结构化输出不会假装判断成功", async () => {
  const direct = provider(() => false);
  assert.equal(await companionNeedsTool(direct, [{ role: "user", content: "你是谁？" }], new AbortController().signal), false);
  const invalid = { ...direct, chatCompletion: async () => ({ content: "{}", usage: {} }) } as AIProvider;
  assert.equal(await companionNeedsTool(invalid, [{ role: "user", content: "那篇的图呢？" }], new AbortController().signal), null);
});
