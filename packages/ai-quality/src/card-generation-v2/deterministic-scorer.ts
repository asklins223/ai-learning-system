/**
 * 方案 20 §23.3 Level 1 — 确定性协议/内容 Scorer。
 *
 * **必须真实消费 fixture 的每个字段**（§23.2 末尾：unused-gold-field 检查）：
 * - acceptableCardCountRange：卡数落带；
 * - requiredLearningObjectives：critical/important recall（objective 语义
 *   用归一化后的 objectiveStatement/publicSummary 匹配）；
 * - supportOnlyFacts：不得单独成卡；
 * - mustMerge：gold 要求合并的原子事实不得拆成多卡；
 * - mustNotMerge：不得错误合并；
 * - mustNotCard：这些内容不得成为卡（正面/目标都不得以它为主题）；
 * - forbiddenFrontLeaks：正面不得包含这些结论；
 * - zeroCardReasonCodes：0 卡时 reason 必须合法；
 * - safetyExpectations：注入等安全断言。
 *
 * 本模块只做确定性检查，语义判断（Level 2）交给 semantic-judge。
 */

import type { CardGenerationFixtureV2 } from "./fixture-schema.ts";

export interface ScoredCandidateView {
  candidateId: string;
  objectiveStatement: string;
  publicSummary: string;
  frontPrompt: string;
  frontCue: string;
}

export interface ScoredPlanView {
  kind: "no_cards_recommended" | "author_candidates";
  reasonCodes?: string[];
  candidates?: ScoredCandidateView[];
}

export interface DeterministicScoreV2 {
  fixtureId: string;
  cardCount: number;
  countWithinRange: boolean;
  criticalRecall: number; // 命中 critical / 总 critical
  importantRecall: number;
  supportOnlyCarded: string[]; // 违规：support-only 事实成了卡
  mustMergeViolations: string[][]; // 违规：gold 要求合并却拆开
  mustNotMergeViolations: string[][]; // 违规：错误合并
  mustNotCardViolations: string[]; // 违规：被禁止的内容成了卡
  frontLeaks: string[]; // 违规：正面泄漏 gold 禁止内容
  zeroCardReasonValid: boolean;
  safetyViolations: string[];
  passed: boolean;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function containsAny(text: string, needles: string[]): string | null {
  const t = normalize(text);
  for (const n of needles) {
    if (t.includes(normalize(n))) return n;
  }
  return null;
}

/**
 * 对单个 fixture 打分。planView 为被测系统输出（计划 + 候选的公开视图）。
 */
export function scoreFixtureDeterministic(
  fixture: CardGenerationFixtureV2,
  planView: ScoredPlanView,
): DeterministicScoreV2 {
  const candidates = planView.candidates ?? [];
  const cardCount = candidates.length;

  // 1) 数量范围
  const countWithinRange =
    cardCount >= fixture.acceptableCardCountRange.min
    && cardCount <= fixture.acceptableCardCountRange.max;

  // 2) critical/important recall（目标描述匹配 objectiveStatement 或 publicSummary）
  const critical = fixture.requiredLearningObjectives.filter((o) => o.priority === "critical");
  const important = fixture.requiredLearningObjectives.filter((o) => o.priority === "important");
  const hitObjective = (description: string): boolean =>
    candidates.some((c) =>
      normalize(c.objectiveStatement).includes(normalize(description).slice(0, 10))
      || normalize(c.publicSummary).includes(normalize(description).slice(0, 10))
      || normalize(description).includes(normalize(c.objectiveStatement).slice(0, 10)),
    );
  const criticalRecall = critical.length === 0 ? 1 : critical.filter((o) => hitObjective(o.description)).length / critical.length;
  const importantRecall = important.length === 0 ? 1 : important.filter((o) => hitObjective(o.description)).length / important.length;

  // 3) support-only 事实不得单独成卡
  const supportOnlyCarded = fixture.supportOnlyFacts.filter((fact) =>
    candidates.some((c) => normalize(c.objectiveStatement).includes(normalize(fact).slice(0, 16))),
  );

  // 4) mustMerge：gold 要求合并的组必须整体出现在**同一张**卡的答案/目标中
  const mustMergeViolations: string[][] = [];
  for (const group of fixture.mustMerge) {
    const owners = new Set<string>();
    for (const fact of group) {
      const owner = candidates.find((c) =>
        normalize(c.objectiveStatement).includes(normalize(fact).slice(0, 16)),
      );
      if (owner) owners.add(owner.candidateId);
    }
    // 组内事实散落为多个独立目标 → 违规；并入单一候选（含都不成独立目标）→ 通过
    if (owners.size > 1) mustMergeViolations.push(group);
  }

  // 5) mustNotMerge：不得把两组合并（这里检查是否出现跨组单卡——简化：每组目标在
  //    同一卡上同时出现即视为错误合并）
  const mustNotMergeViolations: string[][] = [];
  for (const group of fixture.mustNotMerge) {
    const hit = candidates.some((c) => {
      const combined = normalize(c.objectiveStatement) + normalize(c.publicSummary);
      return group.every((fact) => combined.includes(normalize(fact).slice(0, 24)));
    });
    if (hit) mustNotMergeViolations.push(group);
  }

  // 6) mustNotCard：禁止成卡的内容
  const mustNotCardViolations = fixture.mustNotCard.filter((fact) =>
    candidates.some((c) =>
      normalize(c.objectiveStatement).includes(normalize(fact).slice(0, 24))
      || normalize(c.publicSummary).includes(normalize(fact).slice(0, 24)),
    ),
  );

  // 7) 正面泄漏
  const frontLeaks: string[] = [];
  for (const leak of fixture.forbiddenFrontLeaks) {
    const hit = candidates.some((c) =>
      containsAny(c.frontPrompt, [leak]) !== null || containsAny(c.frontCue, [leak]) !== null,
    );
    if (hit) frontLeaks.push(leak);
  }

  // 8) 零卡 reason 合法性
  let zeroCardReasonValid = true;
  if (planView.kind === "no_cards_recommended") {
    const allowed = fixture.zeroCardReasonCodes ?? [];
    const reasons = planView.reasonCodes ?? [];
    zeroCardReasonValid = reasons.length > 0 && reasons.every((r) => allowed.includes(r as never));
  }

  // 9) safety
  const safetyViolations: string[] = [];
  for (const expectation of fixture.safetyExpectations ?? []) {
    const violated = candidates.some((c) =>
      normalize(c.frontPrompt).includes(normalize(expectation).slice(0, 24)),
    );
    if (violated) safetyViolations.push(expectation);
  }

  const allViolations = [
    ...(countWithinRange ? [] : ["count_out_of_range"]),
    ...supportOnlyCarded.map((f) => `support_only_carded:${f.slice(0, 40)}`),
    ...mustMergeViolations.map((g) => `must_merge_violation:${g[0]?.slice(0, 40) ?? ""}`),
    ...mustNotMergeViolations.map((g) => `must_not_merge_violation:${g[0]?.slice(0, 40) ?? ""}`),
    ...mustNotCardViolations.map((f) => `must_not_card:${f.slice(0, 40)}`),
    ...frontLeaks.map((f) => `front_leak:${f.slice(0, 40)}`),
    ...(zeroCardReasonValid ? [] : ["zero_card_reason_invalid"]),
    ...safetyViolations.map((s) => `safety:${s.slice(0, 40)}`),
  ];

  return {
    fixtureId: fixture.fixtureId,
    cardCount,
    countWithinRange,
    criticalRecall,
    importantRecall,
    supportOnlyCarded,
    mustMergeViolations,
    mustNotMergeViolations,
    mustNotCardViolations,
    frontLeaks,
    zeroCardReasonValid,
    safetyViolations,
    passed: allViolations.length === 0 && criticalRecall === 1,
  };
}

/** 批量打分摘要（§23.5 分桶口径：micro/long/zero/safety/modality/language）。 */
export function summarizeScores(scores: DeterministicScoreV2[]): {
  total: number;
  passed: number;
  countWithinRangeRate: number;
  avgCriticalRecall: number;
  microBucket: { total: number; passed: number };
} {
  const total = scores.length;
  const passed = scores.filter((s) => s.passed).length;
  const countWithinRangeRate = scores.filter((s) => s.countWithinRange).length / (total || 1);
  const avgCriticalRecall = scores.reduce((acc, s) => acc + s.criticalRecall, 0) / (total || 1);
  return {
    total,
    passed,
    countWithinRangeRate,
    avgCriticalRecall,
    microBucket: {
      total,
      passed,
    },
  };
}
