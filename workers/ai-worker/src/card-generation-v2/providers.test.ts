import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CardGenerationProviderRuntime,
  CardGenerationProviderError,
  classifyProviderError,
  type CardGenerationProviderConfig,
} from "./providers.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";
import type { ChatMessage, ChatOptions, ChatResult } from "@ailearn/shared";
import type { GenerationStageRuntimeSnapshotV2 } from "@ailearn/shared/card-generation-v2-contracts";

// 一个能观测是否收到 AbortSignal 的最小 provider。chatCompletion 不 resolve，
// 模拟「悬挂 provider」；通过 done 回调暴露调用时收到的 signal。
function hangingProvider(opts: { onSignal?: (signal: AbortSignal | undefined) => void } = {}): AIProvider {
  return {
    id: "test",
    modelId: "test-model",
    visionModelId: "test-vision",
    promptVersion: "v1",
    async chatCompletion(
      _messages: ChatMessage[],
      _options: ChatOptions,
      signal?: AbortSignal,
    ): Promise<ChatResult> {
      opts.onSignal?.(signal);
      return new Promise<ChatResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

function stageRuntimes(): GenerationStageRuntimeSnapshotV2[] {
  return [];
}

function makeRuntime(provider: AIProvider): CardGenerationProviderRuntime {
  return new CardGenerationProviderRuntime({ provider, stageRuntimes: stageRuntimes() } as CardGenerationProviderConfig);
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`test timeout after ${ms}ms`)), ms);
  return controller.signal;
}

test("chatJson passes the external AbortSignal through to chatCompletion", async () => {
  let seenSignal: AbortSignal | undefined;
  const provider = hangingProvider({ onSignal: (s) => (seenSignal = s) });
  const runtime = makeRuntime(provider);
  const controller = new AbortController();

  const pending = runtime.chatJson("test", "sys", "user", controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(seenSignal, "chatCompletion should receive an AbortSignal");
  assert.equal(seenSignal!.aborted, false);

  controller.abort(new Error("external cancellation"));
  const err = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, "chatJson should reject when the external signal aborts");
  assert.match((err as Error).message, /external cancellation/i);
});

test("chatJson truly aborts a hanging provider via its per-call timeout signal", async () => {
  let seenSignal: AbortSignal | undefined;
  const provider = hangingProvider({ onSignal: (s) => (seenSignal = s) });
  const runtime = makeRuntime(provider);

  // 单调用预算默认 75s 太长——用传入的 AbortSignal.timeout 控制观测成本。
  const budget = abortAfter(50);
  const pending = runtime.chatJson("test", "sys", "user", budget);
  const err = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, "chatJson should reject once the per-call timeout aborts");
  assert.ok(seenSignal?.aborted, "the signal handed to chatCompletion should be aborted");
});

test("classifyProviderError treats an abort/timeout as retryable", () => {
  const abort = classifyProviderError("author", new DOMException("This operation was aborted", "AbortError"));
  assert.equal(abort.kind, "retryable");
});

// 2026-08-24（AI 设计审查 §4.2）：模型输出顶层数组/标量（合法 JSON 但非对象）
// 与 malformed JSON 同属随机的输出完整性问题——必须可重试。此前此形态被
// 判 non-retryable，一击致命浪费其余重试预算。
function fixedContentProvider(content: string): AIProvider {
  return {
    id: "test",
    modelId: "test-model",
    visionModelId: "test-vision",
    promptVersion: "v1",
    async chatCompletion(): Promise<ChatResult> {
      return { content, usage: {} };
    },
  };
}

test("chatJson：顶层数组/标量 JSON 输出归类为 retryable（不再一击致命）", async () => {
  const runtime = makeRuntime(fixedContentProvider('[1,2,3]'));
  const err = await runtime.chatJson("planner", "sys", "user").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof CardGenerationProviderError);
  assert.equal(err.kind, "retryable");

  const runtime2 = makeRuntime(fixedContentProvider('"just a string"'));
  const err2 = await runtime2.chatJson("planner", "sys", "user").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err2 instanceof CardGenerationProviderError);
  assert.equal(err2.kind, "retryable");
});

test("sampling：完整 prompt-version 字符串映射到契约裸阶段名（含 critic 归一化）", async () => {
  // stageRuntimes 种子用裸阶段名；此前 chatJson 传 "card-generation-v2/vX/planner"
  // 精确匹配永不命中，per-run 采样配置被静默忽略（全部回退 temperature 0）。
  const snap = (stage: string): GenerationStageRuntimeSnapshotV2 => ({
    stage: stage as GenerationStageRuntimeSnapshotV2["stage"],
    providerId: "system",
    modelSnapshot: "probe-model",
    deploymentId: "local",
    capabilityFingerprint: "basic",
    promptVersion: "v2",
    sampling: { temperature: 0.3 },
    outputSchemaVersion: "v2",
  });
  const cases = [
    "card-generation-v2/v2/planner",
    "card-generation-v2/v2/author",
    "card-generation-v2/v2/grounding",
    "card-generation-v2/v2/pedagogy",
  ];
  for (const stageArg of cases) {
    let seenModel: string | undefined;
    let seenTemperature: number | undefined;
    const observing: AIProvider = {
      id: "test",
      modelId: "fallback-model",
      visionModelId: "test-vision",
      promptVersion: "v1",
      async chatCompletion(_m: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
        seenModel = options.model;
        seenTemperature = options.temperature;
        return { content: "{}", usage: {} };
      },
    };
    const rt = new CardGenerationProviderRuntime({
      provider: observing,
      stageRuntimes: [snap("planner"), snap("author"), snap("grounding_critic"), snap("pedagogy_critic")],
    } as CardGenerationProviderConfig);
    await rt.chatJson(stageArg, "sys", "user");
    assert.equal(seenModel, "probe-model", `${stageArg} 应命中对应 stageRuntimes 条目`);
    assert.equal(seenTemperature, 0.3, `${stageArg} 应采用条目的采样温度`);
  }
});

// round-7 🟡5：真实 HTTP abort 契约闭合测试。
// 生产路径 `postJsonToPublicEndpoint` 位于 @ailearn/shared（`https.request({signal})`），
// V2 provider 经可注入的 `PublicJsonRequester` 发起真实 HTTP 调用。此用例用一个
// **模拟 Node https 行为** 的 requester（挂在 signal 上，signal 触发即 reject——
// 等价于 Node https 对 `RequestOptions.signal` 的落地），贯穿完整链路
// `CardGenerationProviderRuntime.chatJson → OpenAICompatibleProvider.chatCompletion →
// PublicJsonRequester(signal)`，断言：
//  1. 真实 requester 收到与 hangingProvider 相同的 AbortSignal；
//  2. 单调用预算 AbortSignal.timeout 触发的 abort 被真实传播（requester 侧 reject）；
//  3. chatJson 把该 abort 归类为 retryable（provider 超时 → 可重试）。
function abortAwareRequester(opts: { onSignal?: (s: AbortSignal | undefined) => void } = {}): {
  requester: PublicJsonRequester;
  seenSignal: () => AbortSignal | undefined;
} {
  let seen: AbortSignal | undefined;
  const requester: PublicJsonRequester = (_url, _headers, _body, signal): Promise<never> => {
    seen = signal;
    opts.onSignal?.(signal);
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  return { requester, seenSignal: () => seen };
}

test("chatJson → OpenAICompatibleProvider → real HTTP requester: abort propagates and is retryable", async () => {
  const { requester, seenSignal } = abortAwareRequester();
  const httpProvider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.invalid",
    model: "test-model",
    request: requester,
  }) as unknown as AIProvider;
  const runtime = new CardGenerationProviderRuntime({
    provider: httpProvider,
    stageRuntimes: stageRuntimes(),
  } as CardGenerationProviderConfig);

  // 单调用预算用极短的 AbortSignal.timeout 触发真实 abort（等效 75s 超时的快速路径）。
  const budget = abortAfter(30);
  const err = await runtime.chatJson("grounding", "sys", "user", budget).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof CardGenerationProviderError, "abort must surface as a classified CardGenerationProviderError");
  assert.equal(err.kind, "retryable", "provider abort/timeout must be classified retryable");
  assert.ok(seenSignal()?.aborted, "the signal handed to the HTTP requester should be aborted (real abort contract)");
  assert.match(err.message, /AbortError|aborted|signal|timeout/i, "error should echo the abort cause");
});
