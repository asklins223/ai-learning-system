/**
 * 零卡链路合同回归（2026-09-18）。
 *
 * 缺陷：planner prompt 明确要求模型对玩笑/待办/无来源断言/矛盾内容"输出 0 个原子"，
 * 而 provider 把"模型返回空原子集"一律判为**协议错误**（retryable）→ 重试耗尽后
 * run 变 `needs_attention`。后果是**零卡这个合法终态在真实 LLM 链路里根本到不了**：
 * 12 条零卡 fixture 实测全部 needs_attention（22 次 planner 调用、0 次成功终态）。
 *
 * 修法：空原子集必须由模型显式声明理由码（`noAtomsReasonCode`），provider 按冻结
 * 枚举的子集校验后透传；planner-service 在"无可成卡目标"时优先用该码作为
 * `no_cards_recommended.reasonCodes`。
 *
 * 本测试覆盖两件都必须成立的事：
 * 1. **合法零卡**：空数组 + 合法理由码 → 正常返回（不抛错）；
 * 2. **fail-closed 不变**：空数组 + 缺失/非法理由码 → 仍判协议错误（不能把
 *    "输出坏了"伪装成"正确地判了 0 卡"）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PlannerAtomExtractionProvider, CardGenerationProviderRuntime } from "./providers.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import type { ChatMessage, ChatOptions, ChatResult } from "@ailearn/shared";
import type { GenerationStageRuntimeSnapshotV2 } from "@ailearn/shared/card-generation-v2-contracts";
import type { SourceBlockInput } from "@ailearn/shared/card-generation-v2-pipeline";

function runtimeReturning(content: string): CardGenerationProviderRuntime {
  const provider: AIProvider = {
    id: "test",
    modelId: "test-model",
    visionModelId: "test-vision",
    promptVersion: "v1",
    async chatCompletion(_m: ChatMessage[], _o: ChatOptions): Promise<ChatResult> {
      return { content } as ChatResult;
    },
  };
  return new CardGenerationProviderRuntime({
    provider,
    stageRuntimes: [] as GenerationStageRuntimeSnapshotV2[],
  });
}

const BLOCKS: SourceBlockInput[] = [
  { blockId: "b1", type: "text", content: "周一综合征：早上起不来，中午困得慌，晚上精神好。" },
] as SourceBlockInput[];

async function extract(content: string) {
  const runtime = runtimeReturning(content);
  const provider = new PlannerAtomExtractionProvider(runtime);
  // buildPlannerUserPrompt 只读取 semanticRequest（含 feedbackContext）。
  const semanticSpec = { semanticRequest: {} } as never;
  return provider.extractAtoms(BLOCKS, semanticSpec, { evidenceList: [], existingObjectives: [] });
}

test("空原子集 + 合法 noAtomsReasonCode → 正常返回零卡结论（不抛协议错误）", async () => {
  const out = await extract(JSON.stringify({
    atoms: [],
    noAtomsReasonCode: "no_learnable_objective",
  }));
  assert.deepEqual(out.atoms, []);
  assert.equal(out.noAtomsReasonCode, "no_learnable_objective");
});

test("待办/操作性内容可用 source_is_temporary_or_operational 声明", async () => {
  const out = await extract(JSON.stringify({
    atoms: [],
    noAtomsReasonCode: "source_is_temporary_or_operational",
  }));
  assert.deepEqual(out.atoms, []);
  assert.equal(out.noAtomsReasonCode, "source_is_temporary_or_operational");
});

test("fail-closed：空原子集但缺少 noAtomsReasonCode → 仍判协议错误", async () => {
  await assert.rejects(
    () => extract(JSON.stringify({ atoms: [] })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /noAtomsReasonCode/);
      return true;
    },
  );
});

test("fail-closed：理由码不在允许子集内（如已被服务端状态决定的码）→ 判协议错误", async () => {
  await assert.rejects(
    () => extract(JSON.stringify({
      atoms: [],
      noAtomsReasonCode: "already_covered_by_active_objectives",
    })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /noAtomsReasonCode/);
      return true;
    },
  );
});

test("非空原子集照常返回（noAtomsReasonCode 忽略）", async () => {
  const out = await extract(JSON.stringify({
    atoms: [{
      atomId: "atom-1",
      proposition: "负载均衡算法包括轮询与一致性哈希",
      evidenceRefIds: [],
      sourceSectionKeys: [],
      importanceBps: 7000,
      learnabilityBps: 8000,
      confidenceBps: 8500,
      knowledgeFormHint: "fact",
    }],
  }));
  assert.equal(out.atoms.length, 1);
  assert.equal(out.noAtomsReasonCode, undefined);
});
