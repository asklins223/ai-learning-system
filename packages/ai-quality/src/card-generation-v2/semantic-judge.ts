/**
 * 方案 20 §23.3 Level 2 — 语义 Judge 接口（§23.8 变形测试 runner）。
 *
 * Judge 与 Author 不共享少样本答案（§23.9）；Judge 输出 strict schema，
 * 用人工集校准 precision/recall；Judge 不能代替 Grounding hard gate（§23.3）。
 */

import { z } from "zod";

export const semanticJudgeVerdictV2Schema = z.enum([
  "worth_reviewing",
  "surface_paraphrase_only",
  "not_retrievable",
  "front_leaks_answer",
  "unscorable",
  "too_fragmented",
  "duplicate",
  "missing_critical_objective",
  "zero_card_justified",
  "zero_card_unjustified",
]);
export type SemanticJudgeVerdictV2 = z.infer<typeof semanticJudgeVerdictV2Schema>;

export const semanticJudgeItemV2Schema = z
  .strictObject({
    candidateId: z.string().min(1).max(200),
    verdict: semanticJudgeVerdictV2Schema,
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type SemanticJudgeItemV2 = z.infer<typeof semanticJudgeItemV2Schema>;

export const semanticJudgeReportV2Schema = z
  .strictObject({
    version: z.literal(2),
    fixtureId: z.string().min(1).max(200),
    judgeVersion: z.string().min(1).max(200),
    setVerdict: z.enum(["acceptable", "needs_rework", "zero_card_justified", "zero_card_unjustified"]),
    perCandidate: z.array(semanticJudgeItemV2Schema).max(50),
    setIssues: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export type SemanticJudgeReportV2 = z.infer<typeof semanticJudgeReportV2Schema>;

/** Judge 输入：source + gold rubric + 完整候选集合（可含旧版对照）。 */
export interface SemanticJudgeInputV2 {
  fixtureId: string;
  language: string;
  source: string;
  goldDescription: string;
  acceptableCardCountRange: { min: number; max: number };
  candidates: Array<{
    candidateId: string;
    objectiveStatement: string;
    publicSummary: string;
    frontPrompt: string;
    canonicalAnswerPreview: string; // 判分用，不落日志
  }>;
  zeroCardReasonCodes?: string[];
}

export function parseSemanticJudgeReportV2(input: unknown): SemanticJudgeReportV2 {
  return semanticJudgeReportV2Schema.parse(input);
}

// ─── 确定性 Level-2 Judge（§23.3）────────────────────────────────────────

import type { DeterministicScoreV2 } from "./deterministic-scorer.ts";
import type { ScoredPlanView } from "./deterministic-scorer.ts";

function normalizeJudge(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * 确定性 Judge 启发式（LLM Judge 的离线替身；§23.3 要求 Judge 不替代 Grounding
 * hard gate——本实现只做可机械验证的语义信号判定）：
 * - surface_paraphrase_only：objectiveStatement 逐字复述来源（规范化后包含）；
 * - front_leaks_answer：正面 prompt 含 gold 禁止泄漏短语；
 * - not_retrievable：cue 为空/过短（无可检索性）；
 * - duplicate：同 fixture 内两候选规范化 statement 相同；
 * - too_fragmented：候选数超过 gold 上限；
 * - zero_card_justified/unjustified：0 卡 vs gold 期望；
 * - 其余 worth_reviewing。
 */
export function runDeterministicSemanticJudgeV2(input: {
  fixtureId: string;
  language: string;
  source: string;
  acceptableCardCountRange: { min: number; max: number };
  zeroCardReasonCodes?: string[];
  planView: ScoredPlanView;
  score: DeterministicScoreV2;
  judgeVersion?: string;
}): SemanticJudgeReportV2 {
  const {
    fixtureId, source, acceptableCardCountRange, zeroCardReasonCodes,
    planView, score, judgeVersion = "deterministic-judge-v1",
  } = input;
  const normSource = normalizeJudge(source);
  const candidates = planView.candidates ?? [];
  const seen = new Set<string>();
  const perCandidate: SemanticJudgeItemV2[] = [];

  const leakedNeedles = score.frontLeaks.map(normalizeJudge).filter((n) => n.length > 0);

  for (const c of candidates) {
    const normStmt = normalizeJudge(c.objectiveStatement);
    let verdict: SemanticJudgeVerdictV2 = "worth_reviewing";
    let reason = "";

    if (normStmt.length > 0 && normSource.includes(normStmt)) {
      verdict = "surface_paraphrase_only";
      reason = "objectiveStatement 逐字复述来源（无教学转换）";
    } else if (leakedNeedles.some((n) => n.length > 0 && normalizeJudge(c.frontPrompt).includes(n))) {
      verdict = "front_leaks_answer";
      reason = "正面 prompt 泄漏 gold 禁止内容";
    } else if ((c.frontCue ?? "").trim().length === 0 || c.frontPrompt.trim().length < 8) {
      verdict = "not_retrievable";
      reason = "cue/prompt 缺失或过短，无真实检索需求";
    } else if (seen.has(normStmt)) {
      verdict = "duplicate";
      reason = "与同 fixture 内另一候选语义重复";
    } else if (candidates.length > acceptableCardCountRange.max) {
      verdict = "too_fragmented";
      reason = `候选数 ${candidates.length} 超过 gold 上限 ${acceptableCardCountRange.max}`;
    }
    seen.add(normStmt);
    if (verdict === "worth_reviewing" && reason === "") {
      reason = "无可机械验证的语义缺陷（surface 复述/泄漏/检索性/重复/碎片均未命中）";
    }
    perCandidate.push({ candidateId: c.candidateId, verdict, reason });
  }

  const setIssues: string[] = [];
  if (!score.countWithinRange) {
    setIssues.push(`cardCount ${score.cardCount} 不在 gold 范围 [${acceptableCardCountRange.min}, ${acceptableCardCountRange.max}]`);
  }
  if (score.criticalRecall < 1) {
    setIssues.push(`critical objective recall ${score.criticalRecall} < 1`);
  }
  if (score.supportOnlyCarded.length > 0) {
    setIssues.push(`support-only 事实被成卡: ${score.supportOnlyCarded.join(", ")}`);
  }
  for (const v of score.mustMergeViolations) setIssues.push(`mustMerge 被拆开: ${v.join(" + ")}`);
  for (const v of score.mustNotMergeViolations) setIssues.push(`错误合并: ${v.join(" + ")}`);
  for (const v of score.mustNotCardViolations) setIssues.push(`禁止内容成卡: ${v}`);
  for (const v of score.safetyViolations) setIssues.push(`安全违规: ${v}`);

  // 0 卡判定
  const goldExpectsZero = acceptableCardCountRange.max === 0;
  const planSaysZero = planView.kind === "no_cards_recommended";
  let setVerdict: SemanticJudgeReportV2["setVerdict"];
  if (goldExpectsZero) {
    setVerdict = planSaysZero && (zeroCardReasonCodes?.length ?? 0) > 0
      ? "zero_card_justified"
      : "zero_card_unjustified";
    if (setVerdict === "zero_card_unjustified") {
      setIssues.push(planSaysZero ? "0 卡缺少 reasonCodes" : "gold 期望 0 卡但系统产出候选");
    }
  } else if (planSaysZero) {
    setVerdict = "needs_rework";
    setIssues.push("gold 期望候选但系统产出 0 卡（false negative）");
  } else {
    setVerdict = perCandidate.every((p) => p.verdict === "worth_reviewing") && setIssues.length === 0
      ? "acceptable"
      : "needs_rework";
  }

  const report: SemanticJudgeReportV2 = {
    version: 2,
    fixtureId,
    judgeVersion,
    setVerdict,
    perCandidate,
    setIssues: setIssues.slice(0, 20),
  };
  return parseSemanticJudgeReportV2(report);
}
