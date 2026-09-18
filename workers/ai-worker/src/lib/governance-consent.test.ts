/**
 * 治理包装的同意门（此前零覆盖）。
 *
 * `createGovernedEmbeddingProvider` 是**每一次外部 embedding 调用的必经点**：
 * handler 可以为了更好的 UX 提前解析同意，但真正出网的调用必须过 `governedPayload`
 * 的 `!consentOk && provider.id !== "mock"` 判定——否则 aiDataPolicy / 同意开关就
 * 只是装饰性元数据。
 *
 * 这里用注入的假 provider 直接验证这条边界，不依赖任何平台配置或网络：
 *   1. 未同意 + 非 mock provider → 抛 AIConsentRequiredError，且**不调用**底层 provider；
 *   2. 未同意 + mock provider → 放行（mock 不外发数据，故意豁免，否则离线/桌面场景全死）；
 *   3. 同意与工作区策略是**两道独立的门**：同意已给但 sendToExternal=false 仍拒绝；
 *      两道都放行才真正透传。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIConsentRequiredError,
  createDefaultAIPolicy,
  createGovernedEmbeddingProvider,
} from "./governance.ts";

const POLICY = createDefaultAIPolicy();
/** 同意已给 + 工作区策略允许外发（DEFAULT 是 sendToExternal=false 的拒绝默认）。 */
const POLICY_ALLOW_EXTERNAL = { ...createDefaultAIPolicy(), sendToExternal: true };

function fakeProvider(id: string): {
  provider: Parameters<typeof createGovernedEmbeddingProvider>[0];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      id,
      embeddingModelId: `${id}-model`,
      embed: async (text: string) => {
        calls.push(text);
        return [0.1, 0.2, 0.3];
      },
    } as unknown as Parameters<typeof createGovernedEmbeddingProvider>[0],
  };
}

describe("createGovernedEmbeddingProvider：同意门", () => {
  it("未同意 + 外部 provider → 抛 AIConsentRequiredError 且不触达 provider", async () => {
    const { provider, calls } = fakeProvider("siliconflow");
    const governed = createGovernedEmbeddingProvider(provider, { consentOk: false, policy: POLICY }, "ws-1");

    await assert.rejects(() => governed.embed("需要外发的记忆内容"), AIConsentRequiredError);
    assert.deepEqual(calls, [], "被同意门拦下时不得调用底层 provider（不得出网）");
  });

  it("未同意 + mock provider → 放行（mock 不外发，故意豁免）", async () => {
    const { provider, calls } = fakeProvider("mock");
    const governed = createGovernedEmbeddingProvider(provider, { consentOk: false, policy: POLICY }, "ws-1");

    const vector = await governed.embed("离线场景文本");
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.deepEqual(calls, ["离线场景文本"]);
  });

  it("同意已给但工作区策略禁止外发 → 仍然拒绝（同意与策略是两道独立的门）", async () => {
    const { provider, calls } = fakeProvider("siliconflow");
    const governed = createGovernedEmbeddingProvider(provider, { consentOk: true, policy: POLICY }, "ws-1");

    await assert.rejects(() => governed.embed("普通文本"), (error: unknown) => {
      assert.match(String((error as { code?: string })?.code ?? ""), /ai_data_policy_denied/);
      return true;
    });
    assert.deepEqual(calls, [], "策略拒绝时同样不得触达 provider");
  });

  it("同意已给 + 策略允许外发 → 透传清洗后的文本给底层 provider", async () => {
    const { provider, calls } = fakeProvider("siliconflow");
    const governed = createGovernedEmbeddingProvider(
      provider,
      { consentOk: true, policy: POLICY_ALLOW_EXTERNAL },
      "ws-1",
    );

    await governed.embed("普通文本");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "普通文本");
  });

  it("包装后仍暴露 embeddingModelId（handler 用它写 model_revision）", () => {
    const { provider } = fakeProvider("siliconflow");
    const governed = createGovernedEmbeddingProvider(
      provider,
      { consentOk: true, policy: POLICY_ALLOW_EXTERNAL },
      "ws-1",
    );
    assert.equal(governed.embeddingModelId, "siliconflow-model");
  });
});
