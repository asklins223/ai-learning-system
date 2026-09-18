/**
 * 2026-09-15（管线评审 M6/M7）回归：Card Generation V2 handler 的确定性辅助。
 *
 * - selectDistinctCandidatesV2：§10.1 step 8 Global Selector / Merge / Dedup
 *   此前**从未接线**——语义重复候选一路走到 deck gate 被判 deck 级 hard issue，
 *   整个 run 进 needs_attention（同主题多篇笔记时高频发生）。现在在 grounding
 *   之后、Pedagogy 之前完成去重选择。
 * - capSourceContentForPrompts：源文本规模硬上限（此前无上限，大笔记可达
 *   数十万字符并贯穿四阶段 prompt/内存）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import {
  capSourceContentForPrompts,
  isNonRetryableErrorLike,
  selectDistinctCandidatesV2,
  V2_SOURCE_CONTENT_MAX_CHARS,
} from "./card-generation-v2-handler.ts";
import type { LearningCardCandidateRevisionV2 } from "@ailearn/shared/card-generation-v2-contracts";

function candidate(statement: string, evidenceRefIds: string[] = []): LearningCardCandidateRevisionV2 {
  return {
    version: 2,
    candidateRevisionId: randomUUID(),
    candidateId: randomUUID(),
    revision: 1,
    runId: randomUUID(),
    planRevisionId: randomUUID(),
    planVersion: 1,
    planHash: "b".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: `obj-${statement}`,
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: statement,
      publicSummary: statement,
      conceptLabel: statement.slice(0, 20),
      knowledgeForm: "fact",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: { kind: "text", unit: { unitId: "ans-1", text: statement } },
      learningSupport: { explanation: statement },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-1",
          facet: "recall",
          criterion: statement,
          required: true,
          answerUnitIds: ["ans-1"],
          evidenceRefIds: [],
        }],
        passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
        rubricHash: "e".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds,
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: { cue: statement, prompt: `请回答：${statement}` },
      estimatedReviewSeconds: 40,
    },
    evidenceSetHash: "c".repeat(64),
    candidateRevisionHash: "a".repeat(64),
  } as LearningCardCandidateRevisionV2;
}

test("语义去重：完全相同的 statement 只保留 authoring 顺序最前的一个", () => {
  const first = candidate("牛顿第二定律的公式表述");
  const dup = candidate("牛顿第二定律的公式表述");
  const other = candidate("光合作用的暗反应阶段产物");
  const { kept, dropped } = selectDistinctCandidatesV2([first, dup, other]);
  assert.deepEqual(kept.map((c) => c.candidateId), [first.candidateId, other.candidateId]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].candidate.candidateId, dup.candidateId);
  assert.equal(dropped[0].relation, "duplicate");
  assert.equal(dropped[0].keptCandidateId, first.candidateId);
  assert.ok(dropped[0].clusterId.length > 0);
});

test("语义去重：候选互不相同（无簇）→ 全部保留、无落选", () => {
  const a = candidate("牛顿第二定律的公式表述");
  const b = candidate("光合作用的暗反应阶段产物");
  const { kept, dropped } = selectDistinctCandidatesV2([a, b]);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

test("语义去重：单候选早退（不调用聚类）", () => {
  const only = candidate("牛顿第二定律的公式表述");
  const { kept, dropped } = selectDistinctCandidatesV2([only]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test("源文本上限：未超限原样返回；超限截断并标记", () => {
  const workspaceId = randomUUID();
  const small = "x".repeat(10);
  assert.deepEqual(capSourceContentForPrompts(small, workspaceId), { content: small, truncated: false });

  const huge = "y".repeat(V2_SOURCE_CONTENT_MAX_CHARS + 5_000);
  const capped = capSourceContentForPrompts(huge, workspaceId);
  assert.equal(capped.truncated, true);
  assert.equal(capped.content.length, V2_SOURCE_CONTENT_MAX_CHARS);
  assert.ok(huge.startsWith(capped.content));
});

// ─── 2026-09-17 事故回归：非重试错误被当成可重试 ────────────────────────────
//
// 事故形态：`providers.ts` 的 mock/未配置 provider fail-closed 抛的是**裸 Error**，
// 只设置 `name="CardGenerationProviderError"` + `retryable=false`，没有 `kind` 字段；
// 而 `isNonRetryableErrorLike` 只读 `kind` → 判成可重试 → outbox 按
// 15/30/60/120/240s 退避重试 6 次（dev 库实测 7m45s 墙钟）、期间零 LLM 调用，
// 用户只看到长时间"生成中"然后 needs_attention。
//
// 契约：**两种错误形状都必须被尊重**——任何一个"显式标注不可重试"的错误都不得
// 进入重试退避。

test("错误分类：裸 Error 只带 retryable=false（2026-09-17 事故形态）判为不可重试", () => {
  const err = new Error(
    "card-generation-v2 LLM mode resolved to mock provider: missing API key or platform not configured",
  ) as Error & { retryable: boolean };
  err.name = "CardGenerationProviderError";
  err.retryable = false;
  assert.equal(isNonRetryableErrorLike(err), true);
});

test("错误分类：同类裸 Error 标记 retryable=true 时仍按可重试处理", () => {
  const err = new Error("provider transient failure") as Error & { retryable: boolean };
  err.name = "CardGenerationProviderError";
  err.retryable = true;
  assert.equal(isNonRetryableErrorLike(err), false);
});

test("错误分类：CardGenerationProviderError 类实例按 kind 判定（canonical 形状）", async () => {
  const { CardGenerationProviderError } = await import("../card-generation-v2/providers.ts");
  assert.equal(
    isNonRetryableErrorLike(new CardGenerationProviderError("non-retryable", "config error")),
    true,
  );
  assert.equal(
    isNonRetryableErrorLike(new CardGenerationProviderError("retryable", "HTTP 503")),
    false,
  );
});

test("错误分类：未标注的普通错误保持可重试（不误伤瞬态故障）", () => {
  assert.equal(isNonRetryableErrorLike(new Error("socket hang up")), false);
  assert.equal(isNonRetryableErrorLike("ECONNRESET"), false);
});
