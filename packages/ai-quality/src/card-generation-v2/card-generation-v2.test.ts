/**
 * 方案 20 §23 — Card Generation V2 评测包单测。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCardGenerationFixtureV2 } from "./fixture-schema.ts";
import {
  scoreFixtureDeterministic,
  type ScoredPlanView,
} from "./deterministic-scorer.ts";
import { deriveMetamorphicCases } from "./metamorphic-runner.ts";
import { evaluateRcGateV2 } from "./rc-gate.ts";
import {
  FIXTURE_OSI_MICRO_NOTE,
  FIXTURE_TODO_ZERO_CARD,
  V2_FIXTURE_CORPUS_SEED,
  zeroCardFixtureRatio,
} from "./corpus/index.ts";

function osiGoodPlan(): ScoredPlanView {
  // 合格 A+B：顺序重建 + 职责匹配（方案 §8.6）
  return {
    kind: "author_candidates",
    candidates: [
      {
        candidateId: "c1",
        objectiveStatement: "从低到高重建 OSI 七层：物理层、数据链路层、网络层、传输层、会话层、表示层、应用层",
        publicSummary: "OSI 七层顺序",
        frontPrompt: "从低到高写出 OSI 七层",
        frontCue: "OSI 分层顺序",
      },
      {
        candidateId: "c2",
        objectiveStatement: "把比特流、帧与纠错、路由、端到端传输、会话、表示、应用接口匹配到对应层",
        publicSummary: "OSI 各层职责匹配",
        frontPrompt: "把下列职责匹配到对应层",
        frontCue: "职责-层匹配",
      },
    ],
  };
}

function osiBadPlan(): ScoredPlanView {
  // 不合格：每层一张摘要卡（方案 §8.6 明令禁止）
  return {
    kind: "author_candidates",
    candidates: [
      {
        candidateId: "b1",
        objectiveStatement: "物理层负责比特流传输",
        publicSummary: "物理层",
        frontPrompt: "物理层负责什么？",
        frontCue: "物理层",
      },
      {
        candidateId: "b2",
        objectiveStatement: "数据链路层负责帧与纠错",
        publicSummary: "数据链路层",
        frontPrompt: "数据链路层负责什么？",
        frontCue: "数据链路层",
      },
      {
        candidateId: "b3",
        objectiveStatement: "网络层负责路由",
        publicSummary: "网络层",
        frontPrompt: "网络层负责什么？",
        frontCue: "网络层",
      },
      {
        candidateId: "b4",
        objectiveStatement: "传输层负责端到端传输",
        publicSummary: "传输层",
        frontPrompt: "传输层负责什么？",
        frontCue: "传输层",
      },
    ],
  };
}

describe("fixture-schema", () => {
  it("parses the OSI micro-note fixture", () => {
    const f = parseCardGenerationFixtureV2(FIXTURE_OSI_MICRO_NOTE);
    assert.equal(f.acceptableCardCountRange.max, 2);
    assert.equal(f.requiredLearningObjectives.length, 2);
  });

  it("rejects count range with max < min", () => {
    const bad = { ...FIXTURE_OSI_MICRO_NOTE, acceptableCardCountRange: { min: 3, max: 1 } };
    assert.throws(() => parseCardGenerationFixtureV2(bad));
  });

  it("rejects unknown fields (strict)", () => {
    const bad = { ...FIXTURE_OSI_MICRO_NOTE, extra: 1 } as unknown;
    assert.throws(() => parseCardGenerationFixtureV2(bad));
  });
});

describe("deterministic-scorer", () => {
  it("passes the qualified OSI plan (A+B, 2 cards)", () => {
    const score = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiGoodPlan());
    assert.equal(score.cardCount, 2);
    assert.ok(score.countWithinRange, "2 cards must be within [1,2]");
    assert.equal(score.criticalRecall, 1);
    assert.equal(score.mustMergeViolations.length, 0, "mustMerge group must be merged");
    assert.equal(score.frontLeaks.length, 0);
    assert.ok(score.passed);
  });

  it("fails the per-layer summary plan (over-generation + mustMerge violation)", () => {
    const score = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiBadPlan());
    assert.ok(!score.countWithinRange, "4 cards must be out of [1,2]");
    assert.ok(score.mustMergeViolations.length > 0, "layer facts must not be split into separate cards");
    assert.ok(!score.passed);
  });

  it("rejects zero-card fixture with non-zero cards", () => {
    const score = scoreFixtureDeterministic(FIXTURE_TODO_ZERO_CARD, osiBadPlan());
    assert.ok(!score.countWithinRange);
    assert.ok(!score.passed);
  });

  it("accepts zero-card fixture with zero cards and valid reason", () => {
    const score = scoreFixtureDeterministic(FIXTURE_TODO_ZERO_CARD, {
      kind: "no_cards_recommended",
      reasonCodes: ["source_is_temporary_or_operational"],
    });
    assert.equal(score.cardCount, 0);
    assert.ok(score.countWithinRange);
    assert.ok(score.zeroCardReasonValid);
    assert.ok(score.passed);
  });

  it("flags forbidden front leaks", () => {
    const leakingPlan: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [{
        candidateId: "l1",
        objectiveStatement: "OSI 七层顺序",
        publicSummary: "七层",
        frontPrompt: "物理层负责比特流传输，请回答",
        frontCue: "OSI",
      }],
    };
    const score = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, leakingPlan);
    assert.ok(score.frontLeaks.length > 0);
  });
});

describe("metamorphic-runner", () => {
  it("derives transform cases incl. duplicate/injection/edit (>=9; reorder skipped for single-paragraph)", () => {
    const cases = deriveMetamorphicCases(FIXTURE_OSI_MICRO_NOTE);
    assert.ok(cases.length >= 9, `expected >=9 cases, got ${cases.length}`);
    const kinds = new Set(cases.map((c) => c.transform));
    assert.ok(kinds.has("duplicate_paragraph"));
    assert.ok(kinds.has("inject_prompt_injection"));
    assert.ok(kinds.has("edit_note_during_generation"));
  });

  it("duplicate paragraph expects unchanged card count", () => {
    const cases = deriveMetamorphicCases(FIXTURE_OSI_MICRO_NOTE);
    const dup = cases.find((c) => c.transform === "duplicate_paragraph")!;
    assert.equal(dup.expectation.kind, "card_count_unchanged");
    assert.ok(dup.transformedSource.includes(FIXTURE_OSI_MICRO_NOTE.source.content));
  });
});

describe("rc-gate", () => {
  it("passes when all gates satisfied", () => {
    const result = evaluateRcGateV2({
      scores: [scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiGoodPlan())],
      zeroCardFixtureIds: [FIXTURE_TODO_ZERO_CARD.fixtureId],
      zeroCardPredictedIds: [FIXTURE_TODO_ZERO_CARD.fixtureId],
      hardGateCounts: {
        evidenceRubricRequiredUnitClosure: 0,
        unsupportedContradictedPublishedUnit: 0,
        criticalAnswerLeakage: 0,
        crossWorkspaceLeakage: 0,
        candidateFormalSideEffects: 0,
        criticBypassOrFallbackRestore: 0,
        mixedWriter: 0,
        destructiveCascadeHistoryLoss: 0,
        activationIdempotencyDuplicateCanonical: 0,
        failedMislabeledAsZeroCard: 0,
      },
    });
    assert.ok(result.overallPassed);
  });

  it("fails when hard gate count > 0", () => {
    const result = evaluateRcGateV2({
      scores: [scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiGoodPlan())],
      zeroCardFixtureIds: [],
      zeroCardPredictedIds: [],
      hardGateCounts: {
        evidenceRubricRequiredUnitClosure: 0,
        unsupportedContradictedPublishedUnit: 0,
        criticalAnswerLeakage: 1, // ← 关键答案泄漏
        crossWorkspaceLeakage: 0,
        candidateFormalSideEffects: 0,
        criticBypassOrFallbackRestore: 0,
        mixedWriter: 0,
        destructiveCascadeHistoryLoss: 0,
        activationIdempotencyDuplicateCanonical: 0,
        failedMislabeledAsZeroCard: 0,
      },
    });
    assert.ok(!result.overallPassed);
  });

  it("§23.5：long 桶退化不被总平均掩盖（micro 全过 + long 全败 → 不通过）", () => {
    const good = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiGoodPlan());
    const bad = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, {
      kind: "author_candidates",
      candidates: [],
    });
    const badWithCount = { ...bad, fixtureId: "long-fixture-1", cardCount: 5, countWithinRange: false };
    const result = evaluateRcGateV2({
      scores: [good, badWithCount],
      zeroCardFixtureIds: [],
      zeroCardPredictedIds: [],
      hardGateCounts: {
        evidenceRubricRequiredUnitClosure: 0,
        unsupportedContradictedPublishedUnit: 0,
        criticalAnswerLeakage: 0,
        crossWorkspaceLeakage: 0,
        candidateFormalSideEffects: 0,
        criticBypassOrFallbackRestore: 0,
        mixedWriter: 0,
        destructiveCascadeHistoryLoss: 0,
        activationIdempotencyDuplicateCanonical: 0,
        failedMislabeledAsZeroCard: 0,
      },
      bucketAssignments: [
        { fixtureId: good.fixtureId, bucket: "micro" },
        { fixtureId: good.fixtureId, bucket: "language" },
        { fixtureId: badWithCount.fixtureId, bucket: "long" },
        { fixtureId: badWithCount.fixtureId, bucket: "language" },
      ],
    });
    // 总平均 50% withinRange 会被 micro 桶的 100% 拉高，但 long 桶必须单测暴露
    assert.equal(result.buckets["long"].withinRangeRate, 0, "long bucket must report 0% within range");
    assert.equal(result.buckets["long"].passed, false, "long bucket must fail");
    assert.equal(result.buckets["micro"].passed, true, "micro bucket must pass");
    assert.equal(result.buckets["language"].passed, true, "language bucket is report-only");
    assert.ok(!result.overallPassed, "overall must fail when a non-language bucket degrades");
  });

  it("§23.5：全桶通过时整体通过", () => {
    const good = scoreFixtureDeterministic(FIXTURE_OSI_MICRO_NOTE, osiGoodPlan());
    const result = evaluateRcGateV2({
      scores: [good],
      zeroCardFixtureIds: [FIXTURE_TODO_ZERO_CARD.fixtureId],
      zeroCardPredictedIds: [FIXTURE_TODO_ZERO_CARD.fixtureId],
      hardGateCounts: {
        evidenceRubricRequiredUnitClosure: 0,
        unsupportedContradictedPublishedUnit: 0,
        criticalAnswerLeakage: 0,
        crossWorkspaceLeakage: 0,
        candidateFormalSideEffects: 0,
        criticBypassOrFallbackRestore: 0,
        mixedWriter: 0,
        destructiveCascadeHistoryLoss: 0,
        activationIdempotencyDuplicateCanonical: 0,
        failedMislabeledAsZeroCard: 0,
      },
      bucketAssignments: [
        { fixtureId: good.fixtureId, bucket: "micro" },
        { fixtureId: good.fixtureId, bucket: "modality" },
      ],
    });
    assert.equal(result.buckets["micro"].count, 1);
    assert.equal(result.buckets["modality"].withinRangeRate, 1);
    assert.ok(result.overallPassed);
  });
});

describe("corpus", () => {
  it("seed corpus contains the OSI baseline", () => {
    assert.ok(V2_FIXTURE_CORPUS_SEED.some((f) => f.fixtureId === "micro-osi-seven-layers"));
  });

  it("zero-card capable ratio is tracked", () => {
    const ratio = zeroCardFixtureRatio(V2_FIXTURE_CORPUS_SEED);
    assert.ok(ratio >= 0.2, `seed corpus must be >=20% zero-card capable, got ${ratio}`);
  });
});
