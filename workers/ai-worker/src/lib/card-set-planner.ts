export type CardSetPlannerCandidate = {
  id: string;
  sectionKey: string;
  topic: string;
  importance: string;
  localOrdinal: number;
};

export type CardSetPlanCard = {
  scopeKey: string;
  candidateIds: string[];
  titleHint: string;
  sectionKeys: string[];
};

export type CardSetPlan = {
  mode: "single" | "set";
  overviewCandidateIds: string[];
  cards: CardSetPlanCard[];
  representedSections: string[];
};

export class CardSetPlanError extends Error {
  readonly code:
    | "planner_invalid_input"
    | "planner_duplicate_candidate"
    | "plan_invalid_structure"
    | "plan_unknown_candidate"
    | "plan_duplicate_candidate"
    | "plan_incomplete_assignment"
    | "plan_invalid_capacity"
    | "plan_section_omission";

  constructor(code: CardSetPlanError["code"], message: string) {
    super(message);
    this.name = "CardSetPlanError";
    this.code = code;
  }
}

const IMPORTANCE_RANK: Readonly<Record<string, number>> = {
  core: 0,
  supporting: 1,
  detail: 2,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function importanceRank(value: string): number {
  return IMPORTANCE_RANK[value] ?? 9;
}

function compareInSection(
  left: CardSetPlannerCandidate,
  right: CardSetPlannerCandidate,
): number {
  return left.localOrdinal - right.localOrdinal
    || importanceRank(left.importance) - importanceRank(right.importance)
    || compareText(left.topic, right.topic)
    || compareText(left.id, right.id);
}

function compareCanonical(
  left: CardSetPlannerCandidate,
  right: CardSetPlannerCandidate,
): number {
  return compareText(left.sectionKey, right.sectionKey)
    || compareInSection(left, right);
}

function assertCandidates(
  candidates: readonly CardSetPlannerCandidate[],
): CardSetPlannerCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new CardSetPlanError(
      "planner_invalid_input",
      "card-set planning requires at least one candidate",
    );
  }

  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object"
      || candidate === null
      || typeof candidate.id !== "string"
      || candidate.id.trim().length === 0
      || typeof candidate.sectionKey !== "string"
      || candidate.sectionKey.trim().length === 0
      || typeof candidate.topic !== "string"
      || candidate.topic.trim().length === 0
      || typeof candidate.importance !== "string"
      || candidate.importance.trim().length === 0
      || !Number.isSafeInteger(candidate.localOrdinal)
      || candidate.localOrdinal < 0
    ) {
      throw new CardSetPlanError(
        "planner_invalid_input",
        "candidate identity, section, topic, importance, and local ordinal must be valid",
      );
    }
    if (seenIds.has(candidate.id)) {
      throw new CardSetPlanError(
        "planner_duplicate_candidate",
        `candidate ${candidate.id} occurs more than once in the input`,
      );
    }
    seenIds.add(candidate.id);
  }

  return [...candidates].sort(compareCanonical);
}

function canPartitionIntoCards(candidateCount: number): boolean {
  if (candidateCount < 3) return false;
  const reachable = new Array<boolean>(candidateCount + 1).fill(false);
  reachable[0] = true;
  for (let count = 1; count <= candidateCount; count += 1) {
    reachable[count] = [3, 4, 5].some(
      (size) => count >= size && reachable[count - size],
    );
  }
  return reachable[candidateCount];
}

function overviewCapacity(candidateCount: number): number {
  for (let capacity = 5; capacity >= 3; capacity -= 1) {
    if (canPartitionIntoCards(candidateCount - capacity)) return capacity;
  }
  throw new CardSetPlanError(
    "plan_invalid_capacity",
    `cannot partition ${candidateCount} candidates into overview and section cards`,
  );
}

function selectOverview(
  ordered: readonly CardSetPlannerCandidate[],
  capacity: number,
): CardSetPlannerCandidate[] {
  const bySection = new Map<string, CardSetPlannerCandidate[]>();
  for (const candidate of ordered) {
    const section = bySection.get(candidate.sectionKey) ?? [];
    section.push(candidate);
    bySection.set(candidate.sectionKey, section);
  }

  const sectionRepresentatives = [...bySection.values()]
    .map((section) => [...section].sort((left, right) =>
      importanceRank(left.importance) - importanceRank(right.importance)
      || compareInSection(left, right))[0])
    .filter((candidate): candidate is CardSetPlannerCandidate => candidate !== undefined)
    .sort((left, right) =>
      importanceRank(left.importance) - importanceRank(right.importance)
      || compareCanonical(left, right));

  const selected = sectionRepresentatives.slice(0, capacity);
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  if (selected.length < capacity) {
    const remaining = ordered
      .filter((candidate) => !selectedIds.has(candidate.id))
      .sort((left, right) =>
        importanceRank(left.importance) - importanceRank(right.importance)
        || compareCanonical(left, right));
    for (const candidate of remaining.slice(0, capacity - selected.length)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }

  return selected.sort(compareCanonical);
}

type Partition = {
  sizes: number[];
  sectionCrossings: number;
  sectionSplits: number;
  sizePenalty: number;
};

function crossingsWithin(
  candidates: readonly CardSetPlannerCandidate[],
  start: number,
  end: number,
): number {
  let crossings = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (candidates[index - 1]?.sectionKey !== candidates[index]?.sectionKey) {
      crossings += 1;
    }
  }
  return crossings;
}

function isBetterPartition(candidate: Partition, current: Partition | undefined): boolean {
  if (!current) return true;
  const numericScores: Array<[number, number]> = [
    [candidate.sectionCrossings, current.sectionCrossings],
    [candidate.sectionSplits, current.sectionSplits],
    [candidate.sizePenalty, current.sizePenalty],
    [candidate.sizes.length, current.sizes.length],
  ];
  for (const [left, right] of numericScores) {
    if (left !== right) return left < right;
  }
  for (let index = 0; index < candidate.sizes.length; index += 1) {
    const left = candidate.sizes[index] ?? 0;
    const right = current.sizes[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Split the canonical candidate stream into bounded cards. Section boundaries
 * are preferred over arbitrary cuts; adjacent small sections are only combined
 * when a 3–5 item card cannot otherwise be formed.
 */
function partitionSectionCards(
  candidates: readonly CardSetPlannerCandidate[],
): CardSetPlannerCandidate[][] {
  const best: Array<Partition | undefined> = new Array(candidates.length + 1);
  best[candidates.length] = {
    sizes: [],
    sectionCrossings: 0,
    sectionSplits: 0,
    sizePenalty: 0,
  };

  for (let start = candidates.length - 1; start >= 0; start -= 1) {
    for (const size of [3, 4, 5]) {
      const end = start + size;
      if (end > candidates.length) continue;
      const suffix = best[end];
      if (!suffix) continue;
      const splitsSection = end < candidates.length
        && candidates[end - 1]?.sectionKey === candidates[end]?.sectionKey;
      const option: Partition = {
        sizes: [size, ...suffix.sizes],
        sectionCrossings:
          crossingsWithin(candidates, start, end) + suffix.sectionCrossings,
        sectionSplits: Number(splitsSection) + suffix.sectionSplits,
        sizePenalty: Math.abs(size - 4) + suffix.sizePenalty,
      };
      if (isBetterPartition(option, best[start])) best[start] = option;
    }
  }

  const partition = best[0];
  if (!partition) {
    throw new CardSetPlanError(
      "plan_invalid_capacity",
      `cannot partition ${candidates.length} remaining candidates into section cards`,
    );
  }

  const cards: CardSetPlannerCandidate[][] = [];
  let offset = 0;
  for (const size of partition.sizes) {
    cards.push(candidates.slice(offset, offset + size));
    offset += size;
  }
  return cards;
}

function uniqueSections(candidates: readonly CardSetPlannerCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.sectionKey))].sort(compareText);
}

function titleHintFor(
  candidates: readonly CardSetPlannerCandidate[],
  sectionKeys: readonly string[],
): string {
  if (sectionKeys.length > 1) return sectionKeys.join(" / ");
  const sectionKey = sectionKeys[0];
  if (sectionKey && sectionKey !== "__intro__") return sectionKey;
  const topics = [...new Set(candidates.map((candidate) => candidate.topic))].sort(compareText);
  return topics.slice(0, 2).join(" / ");
}

function makeCards(
  groups: readonly CardSetPlannerCandidate[][],
): CardSetPlanCard[] {
  const usedScopeKeys = new Set<string>();
  return groups.map((candidates) => {
    const sectionKeys = uniqueSections(candidates);
    const baseScopeKey = sectionKeys.join(" + ");
    let scopeKey = baseScopeKey;
    let occurrence = 1;
    while (usedScopeKeys.has(scopeKey)) {
      occurrence += 1;
      scopeKey = `${baseScopeKey}#${occurrence}`;
    }
    usedScopeKeys.add(scopeKey);
    return {
      scopeKey,
      candidateIds: candidates.map((candidate) => candidate.id),
      titleHint: titleHintFor(candidates, sectionKeys),
      sectionKeys,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new CardSetPlanError(
      "plan_invalid_structure",
      `${field} must be an array of non-empty strings`,
    );
  }
  return value;
}

/**
 * Validate a persisted or externally supplied plan without trusting its IDs or
 * coverage metadata. Every input candidate must be assigned exactly once.
 */
export function validateCardSetPlan(
  candidates: readonly CardSetPlannerCandidate[],
  plan: CardSetPlan,
): CardSetPlan {
  const ordered = assertCandidates(candidates);
  if (!isRecord(plan)) {
    throw new CardSetPlanError("plan_invalid_structure", "card-set plan must be an object");
  }

  const expectedMode = ordered.length <= 5 ? "single" : "set";
  if (plan.mode !== expectedMode) {
    throw new CardSetPlanError(
      "plan_invalid_capacity",
      `expected ${expectedMode} mode for ${ordered.length} candidates`,
    );
  }
  const overviewCandidateIds = requireStringArray(
    plan.overviewCandidateIds,
    "overviewCandidateIds",
  );
  if (!Array.isArray(plan.cards) || !Array.isArray(plan.representedSections)) {
    throw new CardSetPlanError(
      "plan_invalid_structure",
      "cards and representedSections must be arrays",
    );
  }
  const representedSections = requireStringArray(
    plan.representedSections,
    "representedSections",
  );

  if (
    (plan.mode === "single"
      && (overviewCandidateIds.length < 1 || overviewCandidateIds.length > 5))
    || (plan.mode === "set"
      && (overviewCandidateIds.length < 3 || overviewCandidateIds.length > 5))
  ) {
    throw new CardSetPlanError(
      "plan_invalid_capacity",
      "overview card is outside its allowed capacity",
    );
  }
  if (plan.mode === "single" && plan.cards.length !== 0) {
    throw new CardSetPlanError(
      "plan_invalid_capacity",
      "single-card mode cannot contain section cards",
    );
  }
  if (plan.mode === "set" && plan.cards.length === 0) {
    throw new CardSetPlanError(
      "plan_invalid_capacity",
      "card-set mode requires at least one section card",
    );
  }

  const byId = new Map(ordered.map((candidate) => [candidate.id, candidate]));
  const assigned = new Set<string>();
  const assign = (candidateId: string): CardSetPlannerCandidate => {
    const candidate = byId.get(candidateId);
    if (!candidate) {
      throw new CardSetPlanError(
        "plan_unknown_candidate",
        `plan referenced unknown candidate ${candidateId}`,
      );
    }
    if (assigned.has(candidateId)) {
      throw new CardSetPlanError(
        "plan_duplicate_candidate",
        `candidate ${candidateId} was assigned more than once`,
      );
    }
    assigned.add(candidateId);
    return candidate;
  };

  for (const candidateId of overviewCandidateIds) assign(candidateId);

  const scopeKeys = new Set<string>();
  for (const [index, rawCard] of plan.cards.entries()) {
    if (!isRecord(rawCard)) {
      throw new CardSetPlanError(
        "plan_invalid_structure",
        `cards[${index}] must be an object`,
      );
    }
    const candidateIds = requireStringArray(rawCard.candidateIds, `cards[${index}].candidateIds`);
    const sectionKeys = requireStringArray(rawCard.sectionKeys, `cards[${index}].sectionKeys`);
    if (candidateIds.length < 3 || candidateIds.length > 5) {
      throw new CardSetPlanError(
        "plan_invalid_capacity",
        `cards[${index}] is outside the 3–5 candidate capacity`,
      );
    }
    if (
      typeof rawCard.scopeKey !== "string"
      || rawCard.scopeKey.trim().length === 0
      || typeof rawCard.titleHint !== "string"
      || rawCard.titleHint.trim().length === 0
    ) {
      throw new CardSetPlanError(
        "plan_invalid_structure",
        `cards[${index}] requires a scope key and title hint`,
      );
    }
    if (scopeKeys.has(rawCard.scopeKey)) {
      throw new CardSetPlanError(
        "plan_invalid_structure",
        `scope key ${rawCard.scopeKey} occurs more than once`,
      );
    }
    scopeKeys.add(rawCard.scopeKey);

    const cardCandidates = candidateIds.map(assign);
    const expectedSections = uniqueSections(cardCandidates);
    if (
      sectionKeys.length !== new Set(sectionKeys).size
      || sectionKeys.length !== expectedSections.length
      || sectionKeys.some((sectionKey, sectionIndex) =>
        sectionKey !== expectedSections[sectionIndex])
    ) {
      throw new CardSetPlanError(
        "plan_section_omission",
        `cards[${index}] section metadata does not match its candidates`,
      );
    }
  }

  if (assigned.size !== ordered.length) {
    const missing = ordered
      .filter((candidate) => !assigned.has(candidate.id))
      .map((candidate) => candidate.id);
    throw new CardSetPlanError(
      "plan_incomplete_assignment",
      `plan omitted candidates: ${missing.join(", ")}`,
    );
  }

  const expectedSections = uniqueSections(ordered);
  if (
    representedSections.length !== new Set(representedSections).size
    || representedSections.length !== expectedSections.length
    || representedSections.some((sectionKey, index) =>
      sectionKey !== expectedSections[index])
  ) {
    throw new CardSetPlanError(
      "plan_section_omission",
      "representedSections does not exactly cover every eligible section",
    );
  }

  return plan;
}

export function planCardSet(
  candidates: readonly CardSetPlannerCandidate[],
): CardSetPlan {
  const ordered = assertCandidates(candidates);
  const representedSections = uniqueSections(ordered);
  if (ordered.length <= 5) {
    return validateCardSetPlan(ordered, {
      mode: "single",
      overviewCandidateIds: ordered.map((candidate) => candidate.id),
      cards: [],
      representedSections,
    });
  }

  const overview = selectOverview(ordered, overviewCapacity(ordered.length));
  const overviewIds = new Set(overview.map((candidate) => candidate.id));
  const remaining = ordered.filter((candidate) => !overviewIds.has(candidate.id));
  const plan: CardSetPlan = {
    mode: "set",
    overviewCandidateIds: overview.map((candidate) => candidate.id),
    cards: makeCards(partitionSectionCards(remaining)),
    representedSections,
  };
  return validateCardSetPlan(ordered, plan);
}
