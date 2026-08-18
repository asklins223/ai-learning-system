import type { LearningRunOriginV1, LearningRunPublicV1, LearningTaskPublicV1 } from "../contracts";

export type LearningRunDemoQueryV1 = {
  origin: LearningRunOriginV1;
  originLabel: string;
  returnLabel: string;
  returnTo: string;
  keyPointTitle: string;
  keyPointContext: string;
  initialScenarioId: string;
  explicitSource: boolean;
  targetReference: string | null;
  consumedParameters: string[];
};

type SearchParamsReader = { get: (name: string) => string | null };

const ORIGIN_PRESENTATION: Record<LearningRunOriginV1, { label: string; returnLabel: string; route: string; scenario: string }> = {
  card: { label: "学习卡", returnLabel: "返回学习卡", route: "/cards", scenario: "card-text" },
  review: { label: "到期复习", returnLabel: "返回复习队列", route: "/review", scenario: "review-voice" },
  star_map: { label: "理解星图", returnLabel: "返回理解星图", route: "/graph", scenario: "low-friction-intents" },
  today: { label: "今日学习", returnLabel: "返回今日学习", route: "/today", scenario: "card-text" },
  onboarding: { label: "首次引导", returnLabel: "返回学习首页", route: "/", scenario: "low-friction-intents" },
};

function value(params: SearchParamsReader, name: string): string | null {
  const raw = params.get(name)?.trim();
  return raw ? raw.slice(0, 180) : null;
}

function compactReference(reference: string): string {
  return reference.length <= 12 ? reference : `${reference.slice(0, 8)}…${reference.slice(-3)}`;
}

function normalizeOrigin(raw: string | null, params: SearchParamsReader): { origin: LearningRunOriginV1; explicit: boolean } {
  if (raw === "graph" || raw === "star_map") return { origin: "star_map", explicit: true };
  if (raw === "card" || raw === "review" || raw === "today" || raw === "onboarding") return { origin: raw, explicit: true };
  if (value(params, "scheduleId")) return { origin: "review", explicit: true };
  if (value(params, "refId")) return { origin: "today", explicit: true };
  if (value(params, "cardId") || value(params, "keyPointId")) return { origin: "card", explicit: true };
  return { origin: "card", explicit: false };
}

export function safeLearningRunReturnPath(candidate: string | null): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\") || /[\u0000-\u001f]/.test(decoded)) return null;
  try {
    const parsed = new URL(decoded, "https://study.local");
    if (parsed.origin !== "https://study.local") return null;
    if (parsed.pathname === "/learning-runs/ui-redraw") return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function returnLabelForPath(returnTo: string, fallback: string): string {
  const pathname = returnTo.split(/[?#]/, 1)[0];
  if (pathname === "/" ) return "返回学习首页";
  if (pathname === "/cards" || pathname.startsWith("/cards/")) return "返回学习目标库";
  if (pathname.startsWith("/learning-cards/")) return "返回学习卡";
  if (pathname === "/review" || pathname.startsWith("/review/")) return "返回复习队列";
  if (pathname === "/graph" || pathname.startsWith("/graph/")) return "返回理解星图";
  if (pathname === "/today" || pathname.startsWith("/today/")) return "返回今日学习";
  return fallback;
}

export function resolveLearningRunDemoQuery(params: SearchParamsReader): LearningRunDemoQueryV1 {
  const cardId = value(params, "cardId");
  const keyPointId = value(params, "keyPointId");
  const scheduleId = value(params, "scheduleId");
  const refId = value(params, "refId");
  const targetNodeId = value(params, "targetNodeId");
  const targetType = value(params, "targetType");
  const targetLabel = value(params, "targetLabel") ?? value(params, "keyPointTitle");
  const normalized = normalizeOrigin(value(params, "origin"), params);
  const presentation = ORIGIN_PRESENTATION[normalized.origin];
  const targetReference = keyPointId ?? targetNodeId ?? scheduleId ?? refId ?? cardId;

  const defaultReturn = normalized.origin === "card" && cardId
    ? `/learning-cards/${encodeURIComponent(cardId)}`
    : presentation.route;
  const returnTo = safeLearningRunReturnPath(value(params, "returnTo")) ?? defaultReturn;
  const returnLabel = returnLabelForPath(returnTo, presentation.returnLabel);
  const referenceLabel = targetReference ? compactReference(targetReference) : null;
  const keyPointTitle = targetLabel
    ?? (normalized.origin === "review"
      ? "当前到期复习"
      : normalized.origin === "star_map"
        ? "从选定星体继续"
        : normalized.origin === "today"
          ? "今日选定学习项"
          : normalized.origin === "onboarding"
            ? "第一次三分钟练习"
            : normalized.explicit
              ? "学习卡中的选定要点"
              : "主动回忆与长期记忆");
  const contextParts = [presentation.label];
  if (targetType) contextParts.push(targetType === "key_point" ? "要点星" : targetType);
  if (referenceLabel) contextParts.push(`目标 ${referenceLabel}`);

  const consumedParameters = [
    ["origin", value(params, "origin")],
    ["cardId", cardId],
    ["keyPointId", keyPointId],
    ["scheduleId", scheduleId],
    ["refId", refId],
    ["returnTo", value(params, "returnTo")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([name]) => name);

  return {
    origin: normalized.origin,
    originLabel: presentation.label,
    returnLabel,
    returnTo,
    keyPointTitle,
    keyPointContext: contextParts.join(" · "),
    initialScenarioId: presentation.scenario,
    explicitSource: normalized.explicit,
    targetReference,
    consumedParameters,
  };
}

function contextualizeOpenResponse(task: LearningTaskPublicV1, targetTitle: string): LearningTaskPublicV1 {
  if (task.interaction.kind !== "text_response" && task.interaction.kind !== "voice_teachback") return task;
  return {
    ...task,
    intent: "paraphrase",
    title: "用自己的方式说明这个选定要点",
    prompt: `先不看原文，你会怎样向另一个人解释“${targetTitle}”？`,
    targetSummary: "说清它最关键的机制、条件或关系即可；当前页面只预览作答 UI，不读取卡片正文。",
    alternatives: task.alternatives.filter((alternative) => alternative.interactionKind === "text_response" || alternative.interactionKind === "voice_teachback"),
  };
}

export function applyLearningRunDemoQuery(run: LearningRunPublicV1, context: LearningRunDemoQueryV1): LearningRunPublicV1 {
  if (!context.explicitSource) return run;
  return {
    ...run,
    origin: context.origin,
    originLabel: context.originLabel,
    returnLabel: context.returnLabel,
    keyPointTitle: context.keyPointTitle,
    keyPointContext: context.keyPointContext,
    activeTask: run.activeTask ? contextualizeOpenResponse(run.activeTask, context.keyPointTitle) : null,
  };
}
