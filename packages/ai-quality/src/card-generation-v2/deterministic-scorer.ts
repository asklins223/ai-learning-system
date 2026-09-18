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

/** 匹配用的归一化（去空白 + 小写）。导出以便评测侧复用同一实现，避免判据漂移。 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}
const normalize = normalizeForMatch;

/** 归一化后的候选视图（匹配用的最小字段集）。 */
export interface NormCandidateView {
  id: string;
  objectiveStatement: string;
  publicSummary: string;
  frontPrompt: string;
  frontCue: string;
}

/**
 * "gold 目标是否被某张卡覆盖"的匹配判据（2026-09-17 修复词面假阴性）。
 *
 * 旧判据只认"**前 10 字**子串"：候选 statement/summary 含 gold 描述前 10 字，
 * 或 gold 描述含候选 statement 前 10 字。它对**改写**几乎必然漏判，实测：
 *
 *   gold  : 按存放位置说明 Cookie 与 Session 的区别及配合方式
 *   生成  : 说出Cookie与Session存储位置的区别      ← 语义完全正确，共享 14 字子串
 *   旧判据: 未命中（gold 以"按存放位置说明"开头、候选以"说出"开头，前 10 字都不含对方）
 *
 * 且旧判据**不对称**：检查了 statement→desc，却没检查 summary→desc。
 *
 * 新判据（任一命中即算覆盖，三个方向都查）：
 *   a. 前缀规则（保留，向后兼容既有基线）：任一侧的前 10 字出现在另一侧；
 *   b. **共享长片段**：两侧存在 ≥ `SHARED_SUBSTRING_MIN` 个归一化字符的公共子串
 *      —— 中文里 8 字连续重合是强信号（"cookie与session"这类术语/短语）；
 *   c. **字符二元组 Dice 相似度** ≥ `DICE_THRESHOLD`：容忍语序不同但用词重叠的改写。
 *
 * 阈值校准依据：对 dev 语料上 24 个真实生成的 fixture-run 逐对计算，已知正确的
 * 覆盖对共享子串 ≥8 字或 Dice ≥0.45；而互不相关的目标对 Dice 均 <0.2。
 * 取 8 / 0.35 留出安全边界——**宁可漏判也不误判**（误判会把"漏卡"粉饰成达标）。
 */
export const SHARED_SUBSTRING_MIN = 8;
export const DICE_THRESHOLD = 0.35;

/** 两串的最长公共子串长度（评测规模下 O(n·m) 可接受；n,m 为短句）。 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** 字符二元组 Dice 系数（0..1）。 */
export function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * 单个 gold 目标描述是否被候选集覆盖。三个方向（statement / summary 对 desc）都查。
 */
export function hitObjectiveDescription(
  description: string,
  candidates: NormCandidateView[],
): boolean {
  const nDesc = normalize(description);
  const nDescPrefix = nDesc.slice(0, 10);
  const matches = (field: string): boolean => {
    if (field.length === 0) return false;
    // a. 前缀规则（保留旧行为，避免既有基线整体位移）
    if (field.includes(nDescPrefix) || nDesc.includes(field.slice(0, 10))) return true;
    // b. 共享长片段
    if (longestCommonSubstringLength(nDesc, field) >= SHARED_SUBSTRING_MIN) return true;
    // c. 二元组 Dice
    return bigramDice(nDesc, field) >= DICE_THRESHOLD;
  };
  return candidates.some((c) => matches(c.objectiveStatement) || matches(c.publicSummary));
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

  // 预归一化每个候选的字符串一次，避免嵌套候选×目标/事实循环中对同一段
  // 文本反复调用 normalize()（normalize 含 lower + 正则去空白，成本随文本
  // 长度增长；预计算后各循环只做 includes 匹配）。
  const normCandidates = candidates.map((c) => ({
    id: c.candidateId,
    objectiveStatement: normalize(c.objectiveStatement),
    publicSummary: normalize(c.publicSummary),
    frontPrompt: normalize(c.frontPrompt),
    frontCue: normalize(c.frontCue),
  }));

  // 1) 数量范围
  const countWithinRange =
    cardCount >= fixture.acceptableCardCountRange.min
    && cardCount <= fixture.acceptableCardCountRange.max;

  // 2) critical/important recall（目标描述匹配 objectiveStatement 或 publicSummary）
  const critical = fixture.requiredLearningObjectives.filter((o) => o.priority === "critical");
  const important = fixture.requiredLearningObjectives.filter((o) => o.priority === "important");
  const hitObjective = (description: string): boolean => hitObjectiveDescription(description, normCandidates);
  const criticalRecall = critical.length === 0 ? 1 : critical.filter((o) => hitObjective(o.description)).length / critical.length;
  const importantRecall = important.length === 0 ? 1 : important.filter((o) => hitObjective(o.description)).length / important.length;

  // 3) support-only 事实不得单独成卡
  const supportOnlyCarded = fixture.supportOnlyFacts.filter((fact) => {
    const nFact = normalize(fact).slice(0, 16);
    return normCandidates.some((c) => c.objectiveStatement.includes(nFact));
  });

  // 4) mustMerge：gold 要求合并的组必须整体出现在**同一张**卡的答案/目标中
  const mustMergeViolations: string[][] = [];
  for (const group of fixture.mustMerge) {
    const owners = new Set<string>();
    for (const fact of group) {
      const nFact = normalize(fact).slice(0, 16);
      const ownerIndex = normCandidates.findIndex((c) => c.objectiveStatement.includes(nFact));
      if (ownerIndex >= 0) owners.add(normCandidates[ownerIndex].id);
    }
    // 组内事实散落为多个独立目标 → 违规；并入单一候选（含都不成独立目标）→ 通过
    if (owners.size > 1) mustMergeViolations.push(group);
  }

  // 5) mustNotMerge：不得把两组合并（这里检查是否出现跨组单卡——简化：每组目标在
  //    同一卡上同时出现即视为错误合并）
  const mustNotMergeViolations: string[][] = [];
  for (const group of fixture.mustNotMerge) {
    const hit = normCandidates.some((c) => {
      const combined = c.objectiveStatement + c.publicSummary;
      return group.every((fact) => combined.includes(normalize(fact).slice(0, 24)));
    });
    if (hit) mustNotMergeViolations.push(group);
  }

  // 6) mustNotCard：禁止成卡的内容
  const mustNotCardViolations = fixture.mustNotCard.filter((fact) => {
    const nFact = normalize(fact).slice(0, 24);
    return normCandidates.some((c) =>
      c.objectiveStatement.includes(nFact) || c.publicSummary.includes(nFact),
    );
  });

  // 7) 正面泄漏
  const frontLeaks: string[] = [];
  for (const leak of fixture.forbiddenFrontLeaks) {
    const nLeak = normalize(leak);
    if (normCandidates.some((c) => c.frontPrompt.includes(nLeak) || c.frontCue.includes(nLeak))) {
      frontLeaks.push(leak);
    }
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
    const violated = normCandidates.some((c) =>
      c.frontPrompt.includes(normalize(expectation).slice(0, 24)),
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
