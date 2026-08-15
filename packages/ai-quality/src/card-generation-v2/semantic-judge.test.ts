/**
 * 方案 20 §23.3 — 确定性 Semantic Judge 单元测试。
 *
 * 验证：
 * 1. worth_reviewing（干净候选）；
 * 2. surface_paraphrase_only（逐字复述来源）；
 * 3. front_leaks_answer（正面泄漏 gold 禁止短语）；
 * 4. not_retrievable（cue/prompt 缺失）；
 * 5. duplicate（同 fixture 语义重复）；
 * 6. too_fragmented（超 gold 上限）；
 * 7. zero_card_justified / zero_card_unjustified；
 * 8. 0 卡 false negative（gold 期望候选但系统 0 卡）；
 * 9. strict schema 解析拒绝未知字段；
 * 10. 全 corpus 链式冒烟：scoreFixtureDeterministic → judge 报告全部可解析。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runDeterministicSemanticJudgeV2,
  parseSemanticJudgeReportV2,
} from "./semantic-judge.ts";
import { scoreFixtureDeterministic } from "./deterministic-scorer.ts";
import { V2_FIXTURE_CORPUS_SEED } from "./corpus/index.ts";
import type { ScoredPlanView } from "./deterministic-scorer.ts";
import type { DeterministicScoreV2 } from "./deterministic-scorer.ts";

const SOURCE = "机会成本是指为了得到某种东西而必须放弃的其他东西的价值；在决策中，选择某方案就意味着放弃次优方案所能带来的收益。";

function makeBaseInput(overrides: Record<string, unknown> = {}) {
  const planView: ScoredPlanView = {
    kind: "author_candidates",
    candidates: [{
      candidateId: "cand-1",
      objectiveStatement: "机会成本指为了得到某物而放弃的次优选择的价值",
      publicSummary: "机会成本",
      frontPrompt: "请解释：机会成本的含义与决策含义",
      frontCue: "什么是机会成本？",
    }],
  };
  const score: DeterministicScoreV2 = {
    fixtureId: "fixture-1",
    cardCount: 1,
    countWithinRange: true,
    criticalRecall: 1,
    importantRecall: 1,
    supportOnlyCarded: [],
    mustMergeViolations: [],
    mustNotMergeViolations: [],
    mustNotCardViolations: [],
    frontLeaks: [],
    zeroCardReasonValid: true,
    safetyViolations: [],
    passed: true,
  };
  return {
    fixtureId: "fixture-1",
    language: "zh",
    source: SOURCE,
    acceptableCardCountRange: { min: 1, max: 2 },
    zeroCardReasonCodes: [],
    planView,
    score,
    ...overrides,
  };
}

describe("§23.3 Deterministic Semantic Judge", () => {
  test("干净候选 → worth_reviewing + acceptable", () => {
    const report = runDeterministicSemanticJudgeV2(makeBaseInput());
    assert.equal(report.setVerdict, "acceptable");
    assert.equal(report.perCandidate[0].verdict, "worth_reviewing");
    assert.equal(report.perCandidate[0].reason.length > 0, true);
  });

  test("逐字复述来源 → surface_paraphrase_only + needs_rework", () => {
    const planView: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [{
        candidateId: "cand-copy",
        objectiveStatement: SOURCE,
        publicSummary: "机会成本",
        frontPrompt: "请回答：机会成本是指为了得到某种东西而必须放弃的其他东西的价值",
        frontCue: "机会成本定义",
      }],
    };
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({ planView }));
    assert.equal(report.perCandidate[0].verdict, "surface_paraphrase_only");
    assert.equal(report.setVerdict, "needs_rework");
  });

  test("正面泄漏 gold 禁止短语 → front_leaks_answer", () => {
    const planView: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [{
        candidateId: "cand-leak",
        objectiveStatement: "机会成本的决策含义",
        publicSummary: "机会成本",
        frontPrompt: "请回答：机会成本是指为了得到某种东西而必须放弃的其他东西的价值",
        frontCue: "什么是机会成本",
      }],
    };
    const score: DeterministicScoreV2 = {
      ...makeBaseInput().score,
      frontLeaks: ["机会成本是指为了得到某种东西而必须放弃"],
    };
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({ planView, score }));
    assert.equal(report.perCandidate[0].verdict, "front_leaks_answer");
    assert.equal(report.setVerdict, "needs_rework");
  });

  test("cue/prompt 缺失 → not_retrievable", () => {
    const planView: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [{
        candidateId: "cand-nor",
        objectiveStatement: "机会成本的决策含义",
        publicSummary: "机会成本",
        frontPrompt: "请回答",
        frontCue: "",
      }],
    };
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({ planView }));
    assert.equal(report.perCandidate[0].verdict, "not_retrievable");
  });

  test("同 fixture 语义重复 → duplicate", () => {
    const planView: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [
        {
          candidateId: "cand-a",
          objectiveStatement: "机会成本指为得到某物而放弃的次优选择的价值",
          publicSummary: "A",
          frontPrompt: "请解释机会成本的决策含义",
          frontCue: "机会成本是什么",
        },
        {
          candidateId: "cand-b",
          objectiveStatement: "机会成本指为得到某物而放弃的次优选择的价值",
          publicSummary: "B",
          frontPrompt: "请解释机会成本的含义",
          frontCue: "机会成本是什么",
        },
      ],
    };
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({ planView }));
    const verdicts = report.perCandidate.map((p) => p.verdict);
    assert.ok(verdicts.includes("duplicate"), `expected duplicate, got ${verdicts.join(",")}`);
    assert.equal(report.setVerdict, "needs_rework");
  });

  test("候选数超 gold 上限 → too_fragmented", () => {
    const planView: ScoredPlanView = {
      kind: "author_candidates",
      candidates: [0, 1, 2].map((i) => ({
        candidateId: `cand-${i}`,
        objectiveStatement: `独立目标${i}：机会成本的第${i}个应用场景`,
        publicSummary: `目标${i}`,
        frontPrompt: `请解释目标${i}的内容`,
        frontCue: `目标${i}是什么`,
      })),
    };
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({
      planView,
      acceptableCardCountRange: { min: 1, max: 2 },
      score: { ...makeBaseInput().score, cardCount: 3, countWithinRange: false },
    }));
    assert.equal(report.perCandidate[0].verdict, "too_fragmented");
    assert.equal(report.setVerdict, "needs_rework");
  });

  test("0 卡 justified（gold 期望 0 且带 reasonCodes）", () => {
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({
      acceptableCardCountRange: { min: 0, max: 0 },
      zeroCardReasonCodes: ["no_learnable_objective"],
      planView: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] },
      score: { ...makeBaseInput().score, cardCount: 0, countWithinRange: true, zeroCardReasonValid: true },
    }));
    assert.equal(report.setVerdict, "zero_card_justified");
  });

  test("0 卡 unjustified（gold 期望 0 但系统产出候选）", () => {
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({
      acceptableCardCountRange: { min: 0, max: 0 },
      zeroCardReasonCodes: ["no_learnable_objective"],
      planView: {
        kind: "author_candidates",
        candidates: [{
          candidateId: "cand-x",
          objectiveStatement: "机会成本的决策含义",
          publicSummary: "x",
          frontPrompt: "请解释机会成本",
          frontCue: "机会成本是什么",
        }],
      },
      score: { ...makeBaseInput().score, cardCount: 1, countWithinRange: false },
    }));
    assert.equal(report.setVerdict, "zero_card_unjustified");
  });

  test("gold 期望候选但系统 0 卡 → needs_rework（false negative）", () => {
    const report = runDeterministicSemanticJudgeV2(makeBaseInput({
      planView: { kind: "no_cards_recommended", reasonCodes: ["nothing_learnable"] },
      score: { ...makeBaseInput().score, cardCount: 0, countWithinRange: false },
    }));
    assert.equal(report.setVerdict, "needs_rework");
    assert.ok(report.setIssues.some((i) => i.includes("false negative")));
  });

  test("strict schema：未知字段拒绝", () => {
    assert.throws(() => parseSemanticJudgeReportV2({
      version: 2,
      fixtureId: "f",
      judgeVersion: "v1",
      setVerdict: "acceptable",
      perCandidate: [],
      setIssues: [],
      extra: true,
    }), "unknown fields must be rejected");
  });

  test("corpus 链式冒烟：全部 374 fixture → scorer → judge 报告可解析", () => {
    for (const fixture of V2_FIXTURE_CORPUS_SEED) {
      const source = fixture.source.content;
      const planView: ScoredPlanView = fixture.acceptableCardCountRange.max === 0
        ? { kind: "no_cards_recommended", reasonCodes: fixture.zeroCardReasonCodes ?? [] }
        : {
            kind: "author_candidates",
            candidates: [{
              candidateId: "cand-smoke",
              objectiveStatement: source.slice(0, 60),
              publicSummary: source.slice(0, 20),
              frontPrompt: `请回答：${source.slice(0, 40)}`,
              frontCue: "复习卡片",
            }],
          };
      const score = scoreFixtureDeterministic(fixture, planView);
      const report = runDeterministicSemanticJudgeV2({
        fixtureId: fixture.fixtureId,
        language: fixture.language,
        source,
        acceptableCardCountRange: fixture.acceptableCardCountRange,
        zeroCardReasonCodes: fixture.zeroCardReasonCodes,
        planView,
        score,
      });
      // strict parse 已内建于 judge；此处再显式解析确保可复现
      const parsed = parseSemanticJudgeReportV2(report);
      assert.equal(parsed.fixtureId, fixture.fixtureId);
      assert.ok(parsed.perCandidate.length <= 50);
    }
  });
});
