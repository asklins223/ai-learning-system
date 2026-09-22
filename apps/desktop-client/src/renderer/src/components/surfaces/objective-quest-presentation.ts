import type {
  LearningObjectivePrimaryActionV3,
  ObjectiveListItemV3,
  ObjectivePersonalStateV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import type { LearningRunResultV2 } from "@ailearn/shared/learning-run-v2-contracts";

export type ObjectiveQuestRegion = "ready" | "active" | "mastered";

export type RunModePresentation = Readonly<{
  mode: "formal" | "practice" | "unavailable";
  label: string;
  description: string;
}>;

export type LearningRunFeedbackViewModel = Readonly<{
  tone: "success" | "progress" | "practice" | "neutral";
  seal: string;
  headline: string;
  achievement: string;
  gap: string;
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

export function learningRunFeedback(result: LearningRunResultV2): LearningRunFeedbackViewModel {
  if (result.outcome === "demonstrated") {
    return {
      tone: "success",
      seal: "掌握完成",
      headline: "这一关，你真的说明白了",
      achievement: facets(result.demonstratedFacets, "这次回答已经形成足够的理解证据。"),
      gap: facets(result.gapFacets, "没有留下新的理解缺口。"),
    };
  }
  if (result.outcome === "practice_completed") {
    return {
      tone: "practice",
      seal: "练习完成",
      headline: "这次练习走完了",
      achievement: "练习记录已经保存，但本轮不会写入正式掌握。",
      gap: facets(result.gapFacets, "可以按原路线继续正式挑战。"),
    };
  }
  if (result.outcome === "partial" || result.outcome === "needs_repair") {
    return {
      tone: "progress",
      seal: result.outcome === "partial" ? "推进一段" : "发现缺口",
      headline: result.outcome === "partial" ? "已经证明了一部分" : "找到下一处要修补的地方",
      achievement: facets(result.demonstratedFacets, "这次尚未形成可写入的正式证据。"),
      gap: facets(result.gapFacets, "查看逐条反馈，补上最关键的一处。"),
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
    headline: neutralCopy,
    achievement: "这次不会扣除任何学习进度。",
    gap: facets(result.gapFacets, "按下一步建议继续即可。"),
  };
}
