/**
 * P2-3：FAST_EXTRACT 执行器单元测试。
 *
 * 覆盖:重试编排(retryable 重试 ≤2 次)、升级(escalate 立即 Full)、
 * 通过即停、JSON 容错提取、截断重试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runFastExtract,
  extractJsonObject,
} from "../agent/fast-extract-executor.ts";
import {
  fastExtractionArtifactSchema,
  composeArtifactSchema,
  lightCriticInputSchema,
  lightCriticOutputSchema,
  type FastExtractionArtifact,
} from "@ailearn/shared";

function validArtifact(): FastExtractionArtifact {
  return {
    documentIntent: "意图",
    learningFocus: ["焦点"],
    candidates: [{
      localId: "c1",
      claim: "命题",
      topic: "主题",
      sectionKey: "1",
      cognitiveType: "concept",
      importance: "core",
      difficulty: "basic",
      evidenceRefIds: ["ev-1"],
    }],
    noCandidateDecisions: [],
  };
}

function makeDeps(responses: Array<{ content: string; finishReason: string }>) {
  let calls = 0;
  return {
    executeProviderTurn: async () => {
      const r = responses[calls]!;
      calls += 1;
      return r;
    },
    getCalls: () => calls,
  };
}

function baseCtx() {
  return {
    evidenceAllowlist: new Map([["ev-1", { refId: "ev-1", blockType: "paragraph", isImage: false, containsFormulaMarker: false }]]),
    evidenceBundleByRef: new Map([["ev-1", "bundle-1"]]),
    requiredBundleIds: ["bundle-1"],
    finishReason: "stop",
  };
}

test("JSON 提取:markdown 围栏 + 前后说明中提取首个 JSON 对象", () => {
  const raw = '```json\n{"a": 1}\n```';
  assert.deepEqual(extractJsonObject(raw), { a: 1 });
  assert.deepEqual(extractJsonObject('前置说明 {"a":1} 结尾'), { a: 1 });
  assert.equal(extractJsonObject("not json at all"), null);
  assert.equal(extractJsonObject('{"broken": '), null);
});

test("首次尝试校验通过 → proceed(不重试)", async () => {
  const deps = makeDeps([{ content: JSON.stringify(validArtifact()), finishReason: "stop" }]);
  const result = await runFastExtract(deps, {
    systemPrompt: "p",
    userMessage: "u",
    validationContext: baseCtx(),
  });
  assert.equal(result.action.kind, "proceed");
  assert.equal(result.action.attemptCount, 1);
  assert.equal((deps as unknown as { getCalls: () => number }).getCalls(), 1);
});

test("retryable 失败(截断)→ 重试后通过(attemptCount=2)", async () => {
  const truncated = JSON.stringify(validArtifact()).slice(0, -20); // 非法 JSON
  const deps = makeDeps([
    { content: truncated, finishReason: "length" },
    { content: JSON.stringify(validArtifact()), finishReason: "stop" },
  ]);
  const result = await runFastExtract(deps, {
    systemPrompt: "p",
    userMessage: "u",
    validationContext: baseCtx(),
  });
  assert.equal(result.action.kind, "proceed");
  assert.equal(result.action.attemptCount, 2);
});

test("escalate(代码类型不匹配)→ 立即升级 Full(不重试)", async () => {
  const bad = validArtifact();
  bad.candidates[0] = { ...bad.candidates[0]!, cognitiveType: "code", evidenceRefIds: ["ev-1"] };
  const deps = makeDeps([{ content: JSON.stringify(bad), finishReason: "stop" }]);
  const result = await runFastExtract(deps, {
    systemPrompt: "p",
    userMessage: "u",
    validationContext: baseCtx(),
  });
  assert.equal(result.action.kind, "escalate_to_full");
  assert.ok(result.action.issues.includes("code_evidence_type_mismatch"));
  assert.equal((deps as unknown as { getCalls: () => number }).getCalls(), 1, "escalate 不应重试");
});

test("全部重试仍失败 → escalate_to_full(保留 issues)", async () => {
  const deps = makeDeps([
    { content: "invalid1", finishReason: "stop" },
    { content: "invalid2", finishReason: "stop" },
    { content: "invalid3", finishReason: "stop" },
  ]);
  const result = await runFastExtract(deps, {
    systemPrompt: "p",
    userMessage: "u",
    validationContext: baseCtx(),
  });
  assert.equal(result.action.kind, "escalate_to_full");
  assert.equal(result.action.attemptCount, 3);
  assert.equal(result.attemptLog.length, 3);
});

test("ComposeArtifact / LightCritic schema 可解析", () => {
  const compose = { cards: [{ localId: "card1", title: "t", summary: "s", candidateIds: ["c1"], ordinal: 0, learningObjective: "lo" }] };
  assert.equal(fastExtractionArtifactSchema.safeParse(validArtifact()).success, true);
  assert.equal(composeArtifactSchema.safeParse(compose).success, true);
  const lcIn = { claim: "c", evidence: [{ refId: "ev-1", text: "t" }], candidateId: "c1", riskLevel: "high" };
  assert.equal(lightCriticInputSchema.safeParse(lcIn).success, true);
  const lcOut = { verdict: "supported", supportingEvidenceRefIds: ["ev-1"], hardIssues: [], softIssues: [] };
  assert.equal(lightCriticOutputSchema.safeParse(lcOut).success, true);
});
