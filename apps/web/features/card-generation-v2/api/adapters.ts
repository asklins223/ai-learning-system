/**
 * Card Generation V2 — Adapters (R7)。
 *
 * 把后端 public DTO（serializeRunPublic / serializeCandidatePublic / plan）
 * 映射为 ui-contracts 的展示形态；并构造 §17.4 candidate action / §17.5
 * activation 请求。这里不含任何 mock 数据——全部字段来自真实 API 响应。
 */

import type {
  CandidatePublicView,
  RunPublicView,
} from "../api-client";
import type {
  CandidateReviewItemV2,
  CandidateSetSummaryV2,
  ZeroCardResultV2,
} from "../contracts/ui-contracts";

const STRATEGY_LABELS: Record<string, string> = {
  recall: "回忆",
  cloze: "填空",
  compare: "比较",
  sequence: "顺序",
  why: "原因",
  boundary: "边界",
  application: "应用",
};

const KNOWLEDGE_FORM_LABELS: Record<string, string> = {
  fact: "事实",
  concept: "概念",
  procedure: "过程",
  principle: "原理",
  relation: "关系",
  heuristic: "启发性判断",
};

const REASON_LABELS: Record<string, string> = {
  works_for: "值得做记忆/回忆练习",
  recall_depth: "需要主动回忆而非辨认",
  high_value: "核心概念，值得反复练习",
  fragile: "容易混淆，需要边界训练",
};

/** 把一次 candidate 的语义简化为用户可读的“为什么做成卡”。 */
function recommendationReason(candidate: CandidatePublicView): string {
  if (!candidate.recommendation.recommended) {
    return "系统认为它的价值主要在其支撑的合并目标里。";
  }
  const codes = candidate.recommendation.reasonCodes
    .map((code) => {
      if (REASON_LABELS[code]) return REASON_LABELS[code];
      const learnability = /^learnability-(\d+)$/.exec(code);
      if (learnability) {
        const v = Number(learnability[1]);
        if (v >= 9000) return "学习价值很高，值得优先练习";
        if (v >= 8000) return "学习价值较高，适合稳定回忆";
        return "有一定学习价值";
      }
      const importance = /^importance-(\d+)$/.exec(code);
      if (importance) {
        const v = Number(importance[1]);
        if (v >= 9000) return "核心概念，重要度高";
        if (v >= 8000) return "重要概念，需要掌握";
        return "基础概念，值得记住";
      }
      return "";
    })
    .filter(Boolean);
  if (codes.length > 0) return codes.join("；");
  return "它是本目标里值得稳定回忆的核心内容。";
}

/** Map a candidate public view to the review-item UI shape. */
export function toCandidateReviewItem(
  candidate: CandidatePublicView,
): CandidateReviewItemV2 {
  return {
    candidateId: candidate.candidateId,
    revision: candidate.revision,
    revisionHash: candidate.candidateRevisionHash,
    objective: candidate.objective.statement,
    prompt: candidate.front.prompt,
    reason: recommendationReason(candidate),
    sourceLabel: "",
    knowledgeForm:
      KNOWLEDGE_FORM_LABELS[candidate.objective.knowledgeForm] ??
      candidate.objective.knowledgeForm,
    strategyLabel:
      STRATEGY_LABELS[candidate.strategy] ?? candidate.strategy,
    estimatedSeconds: candidate.estimatedReviewSeconds,
    // 2026-08-16（实机验证修复）：qualityState 与 reviewDecision 共同决定
    // 展示状态——
    //   failed      → rejected（无 binding plan，激活闭包必然缺字段，禁勾选）
    //   keep        → kept（已保留，计入激活集合，勾选锁定不可取消）
    //   passed 未决 → ready（可勾选；勾选即提交 keep）
    //   其余        → rechecking（等待服务端重核）
    reviewState: candidate.qualityState === "failed"
      ? "rejected"
      : candidate.reviewDecision === "keep"
        ? "kept"
        : candidate.isReviewReady
          ? "ready"
          : "rechecking",
    // kept 候选已提交 keep，必须计入激活集合（否则 close 时被丢弃）。
    selected:
      (candidate.reviewDecision === "keep" &&
        candidate.qualityState === "passed") ||
      (Boolean(candidate.recommendation.recommended) &&
        candidate.isReviewReady),
  };
}

/** Map run + candidates to the review-set summary UI shape. */
export function toCandidateSetSummary(
  _run: RunPublicView,
  candidates: CandidatePublicView[],
  atomCount: number,
): CandidateSetSummaryV2 {
  const recommended = candidates.filter((c) => c.recommendation.recommended);
  const supportOnly = candidates.length - recommended.length;
  return {
    sourceLabel: "这篇笔记",
    sourceVersion: 1,
    atomCount,
    candidateCount: recommended.length,
    supportOnlyCount: supportOnly,
    mergedCount: 0,
    estimatedReviewSeconds: recommended.reduce(
      (sum, c) => sum + c.estimatedReviewSeconds,
      0,
    ),
  };
}

/** Build the Zero-Card UI view from a `no_cards_recommended` plan. */
export function toZeroCardResult(plan: {
  readonly result: { kind: "no_cards_recommended"; reasonCodes: string[] };
}): ZeroCardResultV2 {
  const reasonCodes = plan.result.reasonCodes;
  const title = "这段笔记暂时不需要单独做学习卡";
  const explanation = reasonCodes.some((code) => code === "covered_by_existing")
    ? "它已被现有学习目标覆盖，重复制卡只会在复习时增加负担。"
    : reasonCodes.some((code) => code === "todo_or_context")
      ? "这段内容主要是待办或上下文，没有可独立回忆的学习目标。"
      : reasonCodes.some((code) => code === "support_only")
        ? "这些事实已经作为其它目标的答案依据，不必单独成卡。"
        : "系统没有找到值得长期反复练习的独立目标。";
  const reasonLabels: Record<string, string> = {
    covered_by_existing: "已被现有目标覆盖",
    todo_or_context: "待办或上下文",
    support_only: "仅作答案支持",
    too_trivial: "过于琐碎",
    no_independent_atom: "没有可独立的回忆目标",
  };
  const decisions = reasonCodes.map((code) => ({
    label: reasonLabels[code] ?? code,
    value: code,
  }));
  return {
    title,
    explanation,
    reasonLabel: reasonCodes.map((c) => reasonLabels[c] ?? c).join(" · "),
    decisions,
  };
}

/** Compute the 0-card decision view from reason codes only (run-level fallback). */
export function toZeroCardResultFromCodes(reasonCodes: string[]): ZeroCardResultV2 {
  return toZeroCardResult({
    result: { kind: "no_cards_recommended", reasonCodes },
  });
}
