import type {
  LearningObjectivePrimaryActionV3,
  ObjectiveListItemV3,
  ObjectivePersonalStateV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import type { LearningRunResultV2 } from "@ailearn/shared/learning-run-v2-contracts";
export { companionCelebrationAllowed as companionResultFeedbackAllowed } from "../../app/companion-celebration-policy";

export type ObjectiveQuestRegion = "ready" | "active" | "mastered";

export type RunModePresentation = Readonly<{
  mode: "formal" | "practice" | "unavailable";
  label: string;
  description: string;
}>;

export type LearningRunFeedbackViewModel = Readonly<{
  tone: "success" | "progress" | "practice" | "neutral";
  seal: string;
  /** 演出圆章那两个字。`seal` 是整词，108px 的圆章装不下，所以单独一支。 */
  stamp: string;
  headline: string;
  achievement: string;
  gap: string;
  strengths: readonly string[];
  improvements: readonly string[];
}>;

export type LearningDiscoveryCardViewModel = Readonly<{
  eyebrow: "伴星发现" | "本次闪光点" | "远征拾光";
  title: string;
  detail: string;
  motif: "leaf" | "shell" | "star";
}>;

const READY_STATES = new Set<ObjectivePersonalStateV3>([
  "unvalidated",
  "fragile",
  "needs_repair",
  "due_review",
  "outdated",
]);

export function objectiveQuestRegion(state: ObjectivePersonalStateV3): ObjectiveQuestRegion {
  if (state === "stable") return "mastered";
  if (state === "learning" || state === "scheduled") return "active";
  return READY_STATES.has(state) ? "ready" : "active";
}

export function orderObjectivesForQuest(
  items: readonly ObjectiveListItemV3[],
  primaryFocusId: string | null,
  queuePriorityIds: readonly string[],
): ObjectiveListItemV3[] {
  const priority = new Map(queuePriorityIds.map((id, index) => [id, index + 1]));
  return [...items].sort((left, right) => {
    if (left.objectiveId === primaryFocusId) return -1;
    if (right.objectiveId === primaryFocusId) return 1;
    const leftPriority = priority.get(left.objectiveId) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.objectiveId) ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority;
  });
}

export function runModePresentation(action: LearningObjectivePrimaryActionV3): RunModePresentation {
  if (action.kind === "practice_only") {
    return {
      mode: "practice",
      label: "练习关",
      description: action.formalValidationNotBefore
        ? "本轮可以练习，但不会写入正式掌握；到开放时间后再正式验证。"
        : "本轮可以练习，但不会写入正式掌握。",
    };
  }
  if (action.kind === "create_run" || action.kind === "resume_run" || action.kind === "create_review_run") {
    return {
      mode: "formal",
      label: "正式挑战",
      description: "提交后的结果会按真实证据更新理解状态与复习安排。",
    };
  }
  return {
    mode: "unavailable",
    label: "尚未开放",
    description: "当前没有可开始的验证；页面会说明等待或修复条件。",
  };
}

const FACET_LABELS: Record<string, string> = {
  recall: "回忆",
  paraphrase: "复述",
  explain: "解释",
  example: "举例",
  apply: "应用",
  boundary: "边界",
  procedure: "步骤",
  relate: "关联",
  repair: "修补",
};

function facets(facetIds: readonly string[], empty: string): string {
  if (!facetIds.length) return empty;
  return facetIds.map((facet) => FACET_LABELS[facet] ?? facet).join("、");
}

function rubricFacets(result: LearningRunResultV2, verdicts: readonly string[]): string[] {
  const accepted = new Set(verdicts);
  return [...new Set((result.assessment?.rubricResults ?? [])
    .filter((item) => accepted.has(item.verdict))
    .map((item) => item.facet))];
}

function rubricReasons(result: LearningRunResultV2, verdicts: readonly string[]): string[] {
  const accepted = new Set(verdicts);
  return [...new Set((result.assessment?.rubricResults ?? [])
    .filter((item) => accepted.has(item.verdict))
    .map((item) => item.userFacingReason.trim())
    .filter(Boolean))];
}

function reasonSummary(reasons: readonly string[], fallback: string): string {
  return reasons.length ? reasons.slice(0, 2).join("；") : fallback;
}

function stableChoice(seed: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}

const DISCOVERY_TITLES: Record<string, string> = {
  recall: "关键事实，已经能主动取回",
  paraphrase: "你已经能换成自己的话",
  explain: "你把“为什么”讲清了",
  example: "例子开始为理解作证",
  apply: "你把理解用到了新情境",
  boundary: "你看见了成立的边界",
  procedure: "步骤已经串成一条路",
  relate: "你连起了知识之间的关系",
  repair: "你找到了该修补的位置",
};

export function learningDiscoveryCard(result: LearningRunResultV2, seed: string): LearningDiscoveryCardViewModel | null {
  const rubricEvidence = (result.assessment?.rubricResults ?? []).filter((item) =>
    ["covered", "partial", "missing", "contradicted"].includes(item.verdict));
  const selectedRubric = rubricEvidence.length
    ? rubricEvidence[stableChoice(`${seed}:rubric`, rubricEvidence.length)]
    : null;
  const demonstratedFacet = result.demonstratedFacets.length
    ? result.demonstratedFacets[stableChoice(`${seed}:demonstrated`, result.demonstratedFacets.length)]
    : null;
  const gapFacet = result.gapFacets.length
    ? result.gapFacets[stableChoice(`${seed}:gap`, result.gapFacets.length)]
    : null;
  const eyebrow = (["伴星发现", "本次闪光点", "远征拾光"] as const)[stableChoice(`${seed}:eyebrow`, 3)];
  const motif = (["leaf", "shell", "star"] as const)[stableChoice(`${seed}:motif`, 3)];
  const positiveFacet = selectedRubric?.verdict === "covered" || selectedRubric?.verdict === "partial"
    ? selectedRubric.facet
    : demonstratedFacet;
  if (positiveFacet) {
    return {
      eyebrow,
      motif,
      title: DISCOVERY_TITLES[positiveFacet] ?? `${FACET_LABELS[positiveFacet] ?? positiveFacet}已经留下证据`,
      detail: selectedRubric && selectedRubric.facet === positiveFacet
        ? selectedRubric.userFacingReason
        : `本轮正式结果把「${FACET_LABELS[positiveFacet] ?? positiveFacet}」列为掌握证据。`,
    };
  }
  const firstGap = selectedRubric?.verdict === "missing" || selectedRubric?.verdict === "contradicted"
    ? selectedRubric.facet
    : gapFacet;
  if (!firstGap) return null;
  return {
    eyebrow,
    motif,
    title: `下一张线索：${FACET_LABELS[firstGap] ?? firstGap}`,
    detail: selectedRubric && selectedRubric.facet === firstGap
      ? selectedRubric.userFacingReason
      : `本轮结果把「${FACET_LABELS[firstGap] ?? firstGap}」列为待补证据。`,
  };
}

export function learningRunFeedback(result: LearningRunResultV2): LearningRunFeedbackViewModel {
  const coveredReasons = rubricReasons(result, ["covered"]);
  const improvementReasons = rubricReasons(result, ["partial", "missing", "contradicted"]);
  if (result.outcome === "demonstrated") {
    return {
      tone: "success",
      seal: "掌握完成",
      stamp: "通关",
      headline: "这一关，你真的说明白了",
      achievement: reasonSummary(coveredReasons, facets(result.demonstratedFacets, "这次回答已经形成足够的理解证据。")),
      gap: reasonSummary(improvementReasons, facets(result.gapFacets, "没有留下新的理解缺口。")),
      strengths: coveredReasons,
      improvements: improvementReasons,
    };
  }
  if (result.outcome === "practice_completed") {
    const covered = rubricFacets(result, ["covered"]);
    const missing = rubricFacets(result, ["missing", "contradicted"]);
    return {
      tone: "practice",
      seal: covered.length ? "练习有收获" : "练习已留痕",
      stamp: covered.length ? "收获" : "留痕",
      headline: covered.length ? "这次练习，已经看见你会了什么" : "这次练习留下了可复盘的线索",
      achievement: reasonSummary(coveredReasons, covered.length
        ? `这次已经说清：${facets(covered, "")}`
        : improvementReasons.length
          ? "这次还没有得到“已说清”的判定，具体缺口见下方。"
          : "本轮没有返回可判定的评分项，暂时不能判断对错；练习记录已保存。"),
      gap: reasonSummary(improvementReasons, facets(result.gapFacets.length ? result.gapFacets : missing, "可以按原路线继续正式挑战。")),
      strengths: coveredReasons,
      improvements: improvementReasons,
    };
  }
  if (result.outcome === "partial" || result.outcome === "needs_repair") {
    const covered = rubricFacets(result, ["covered"]);
    const missing = rubricFacets(result, ["missing", "contradicted"]);
    return {
      tone: "progress",
      seal: result.outcome === "partial" ? "推进一段" : "发现缺口",
      stamp: result.outcome === "partial" ? "推进" : "修补",
      headline: result.outcome === "partial" ? "已经证明了一部分" : "找到下一处要修补的地方",
      achievement: reasonSummary(coveredReasons, facets(result.demonstratedFacets.length ? result.demonstratedFacets : covered, "这次尚未形成可写入的正式证据。")),
      gap: reasonSummary(improvementReasons, facets(result.gapFacets.length ? result.gapFacets : missing, "查看逐条反馈，补上最关键的一处。")),
      strengths: coveredReasons,
      improvements: improvementReasons,
    };
  }
  const neutralCopy = result.outcome === "declared_unable"
    ? "承认暂时不会也是有效的学习判断"
    : result.outcome === "skipped"
      ? "这一关先放回路线里"
      : "这次还没有形成可评估的证据";
  return {
    tone: "neutral",
    seal: result.outcome === "declared_unable" ? "先去补给" : "暂存路线",
    stamp: "放回",
    headline: neutralCopy,
    achievement: "这次不会扣除任何学习进度。",
    gap: reasonSummary(improvementReasons, facets(result.gapFacets, "按下一步建议继续即可。")),
    strengths: coveredReasons,
    improvements: improvementReasons,
  };
}

/**
 * 演出眉标的前半截。不取界面那枚 `runModeLabel`：结构题的 ceiling 在服务端被钳成
 * practice，快照的 `publishedTargetEligibility` 却仍是 eligible（run-planner.ts:462），
 * 拿它拼练习结算会得到「正式挑战 · 练习有收获」这种自相矛盾的印子。
 */
const ceremonyModeLabel: Record<LearningRunFeedbackViewModel["tone"], string> = {
  success: "正式挑战",
  practice: "练习旅程",
  progress: "理解推进",
  neutral: "学习留痕",
};

export function ceremonyPresentation(feedback: LearningRunFeedbackViewModel): {
  stamp: string;
  eyebrow: string;
} {
  return { stamp: feedback.stamp, eyebrow: `${ceremonyModeLabel[feedback.tone]} · ${feedback.seal}` };
}
