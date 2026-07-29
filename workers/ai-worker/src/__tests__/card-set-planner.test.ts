import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CardSetPlanError,
  planCardSet,
  validateCardSetPlan,
  type CardSetPlan,
  type CardSetPlannerCandidate,
} from "../lib/card-set-planner.ts";

function candidate(
  ordinal: number,
  sectionKey = `section-${Math.floor(ordinal / 4)}`,
  importance: CardSetPlannerCandidate["importance"] = ordinal % 3 === 0
    ? "core"
    : "supporting",
): CardSetPlannerCandidate {
  return {
    id: `candidate-${ordinal}`,
    sectionKey,
    topic: `topic-${sectionKey}`,
    importance,
    localOrdinal: ordinal,
  };
}

function assignedIds(plan: CardSetPlan): string[] {
  return [
    ...plan.overviewCandidateIds,
    ...plan.cards.flatMap((card) => card.candidateIds),
  ];
}

function assertExactAssignment(
  candidates: readonly CardSetPlannerCandidate[],
  plan: CardSetPlan,
): void {
  assert.deepEqual(
    [...assignedIds(plan)].sort(),
    candidates.map((item) => item.id).sort(),
  );
  assert.equal(new Set(assignedIds(plan)).size, candidates.length);
  validateCardSetPlan(candidates, plan);
}

test("one candidate produces one complete overview card", () => {
  const candidates = [candidate(0, "only")];
  const plan = planCardSet(candidates);

  assert.equal(plan.mode, "single");
  assert.deepEqual(plan.overviewCandidateIds, ["candidate-0"]);
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.representedSections, ["only"]);
  assertExactAssignment(candidates, plan);
});

test("five candidates stay in one overview card", () => {
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(index, "one"));
  const plan = planCardSet(candidates);

  assert.equal(plan.mode, "single");
  assert.equal(plan.overviewCandidateIds.length, 5);
  assert.deepEqual(plan.cards, []);
  assertExactAssignment(candidates, plan);
});

test("six candidates become a three-item overview and one three-item section card", () => {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    candidate(index, index < 3 ? "A" : "B"));
  const plan = planCardSet(candidates);

  assert.equal(plan.mode, "set");
  assert.equal(plan.overviewCandidateIds.length, 3);
  assert.deepEqual(plan.cards.map((card) => card.candidateIds.length), [3]);
  assertExactAssignment(candidates, plan);
});

test("seven candidates preserve valid 3–5 capacities without dropping the tail", () => {
  const candidates = Array.from({ length: 7 }, (_, index) =>
    candidate(index, index < 2 ? "A" : "B"));
  const plan = planCardSet(candidates);

  assert.equal(plan.overviewCandidateIds.length, 4);
  assert.deepEqual(plan.cards.map((card) => card.candidateIds.length), [3]);
  assertExactAssignment(candidates, plan);
});

test("ten candidates produce a five-item overview and one five-item section card", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    candidate(index, index < 3 ? "A" : index < 7 ? "B" : "C"));
  const plan = planCardSet(candidates);

  assert.equal(plan.overviewCandidateIds.length, 5);
  assert.deepEqual(plan.cards.map((card) => card.candidateIds.length), [5]);
  assertExactAssignment(candidates, plan);
});

test("eleven candidates produce a five-item overview and bounded section cards", () => {
  const candidates = Array.from({ length: 11 }, (_, index) =>
    candidate(index, index < 4 ? "A" : index < 7 ? "B" : "C"));
  const plan = planCardSet(candidates);

  assert.equal(plan.overviewCandidateIds.length, 5);
  assert.deepEqual(plan.cards.map((card) => card.candidateIds.length), [3, 3]);
  assert.ok(plan.cards.every((card) =>
    card.candidateIds.length >= 3 && card.candidateIds.length <= 5));
  assertExactAssignment(candidates, plan);
});

test("overview favors core representatives from distinct sections", () => {
  const candidates: CardSetPlannerCandidate[] = [
    candidate(0, "A", "detail"),
    candidate(1, "A", "core"),
    candidate(2, "A", "core"),
    candidate(3, "B", "supporting"),
    candidate(4, "B", "detail"),
    candidate(5, "C", "core"),
    candidate(6, "C", "detail"),
    candidate(7, "D", "detail"),
  ];
  const plan = planCardSet(candidates);

  assert.equal(plan.overviewCandidateIds.length, 5);
  assert.ok(plan.overviewCandidateIds.includes("candidate-1"));
  assert.ok(plan.overviewCandidateIds.includes("candidate-3"));
  assert.ok(plan.overviewCandidateIds.includes("candidate-5"));
  assert.ok(plan.overviewCandidateIds.includes("candidate-7"));
  assertExactAssignment(candidates, plan);
});

test("many one-candidate sections are combined only in adjacent canonical order", () => {
  const candidates = Array.from({ length: 17 }, (_, index) =>
    candidate(index, `S${String(index).padStart(2, "0")}`, index % 4 === 0 ? "core" : "detail"));
  const plan = planCardSet(candidates);
  const remainingCanonical = candidates
    .filter((item) => !plan.overviewCandidateIds.includes(item.id))
    .sort((left, right) => left.sectionKey < right.sectionKey ? -1 : 1)
    .map((item) => item.id);

  assert.ok(plan.cards.length > 1);
  assert.deepEqual(plan.cards.flatMap((card) => card.candidateIds), remainingCanonical);
  assert.ok(plan.cards.every((card) =>
    card.candidateIds.length >= 3 && card.candidateIds.length <= 5));
  assert.ok(plan.cards.every((card) =>
    card.sectionKeys.every((section, index, sections) =>
      index === 0 || sections[index - 1]! < section)));
  assertExactAssignment(candidates, plan);
});

test("planning is byte-for-byte stable when input order changes", () => {
  const candidates = Array.from({ length: 19 }, (_, index) =>
    candidate(index, `section-${index % 5}`));
  const shuffled = [
    ...candidates.filter((_, index) => index % 2 === 1).reverse(),
    ...candidates.filter((_, index) => index % 2 === 0).reverse(),
  ];

  assert.deepEqual(planCardSet(shuffled), planCardSet(candidates));
});

test("canonical plan hash is stable across input permutations", () => {
  const candidates = Array.from({ length: 23 }, (_, index) =>
    candidate(index, `section-${index % 7}`));
  const permutations = [
    candidates,
    [...candidates].reverse(),
    [...candidates.slice(7), ...candidates.slice(0, 7)],
  ];
  const hashes = permutations.map((items) =>
    createHash("sha256")
      .update(JSON.stringify(planCardSet(items)), "utf8")
      .digest("hex"));

  assert.equal(new Set(hashes).size, 1);
  assert.match(hashes[0]!, /^[a-f0-9]{64}$/);
});

test("validator rejects unknown, duplicate, over-capacity, and omitted sections", () => {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    candidate(index, index < 3 ? "A" : "B"));
  const valid = planCardSet(candidates);

  const malformed: Array<[CardSetPlan, CardSetPlanError["code"]]> = [
    [
      {
        ...valid,
        cards: valid.cards.map((card, index) => index === 0
          ? { ...card, candidateIds: [card.candidateIds[0]!, card.candidateIds[1]!, "unknown"] }
          : card),
      },
      "plan_unknown_candidate",
    ],
    [
      {
        ...valid,
        cards: valid.cards.map((card, index) => index === 0
          ? {
            ...card,
            candidateIds: [
              valid.overviewCandidateIds[0]!,
              card.candidateIds[1]!,
              card.candidateIds[2]!,
            ],
          }
          : card),
      },
      "plan_duplicate_candidate",
    ],
    [
      {
        ...valid,
        overviewCandidateIds: [
          ...valid.overviewCandidateIds,
          valid.cards[0]!.candidateIds[0]!,
          valid.cards[0]!.candidateIds[1]!,
          valid.cards[0]!.candidateIds[2]!,
        ],
        cards: [],
      },
      "plan_invalid_capacity",
    ],
    [
      {
        ...valid,
        representedSections: ["A"],
      },
      "plan_section_omission",
    ],
  ];

  for (const [plan, code] of malformed) {
    assert.throws(
      () => validateCardSetPlan(candidates, plan),
      (error: unknown) => error instanceof CardSetPlanError && error.code === code,
    );
  }
});

test("validator rejects a silently omitted candidate and duplicate input IDs", () => {
  const candidates = Array.from({ length: 7 }, (_, index) => candidate(index, "A"));
  const valid = planCardSet(candidates);
  const omitted = {
    ...valid,
    cards: valid.cards.map((card) => ({
      ...card,
      candidateIds: card.candidateIds.slice(0, -1),
    })),
  };

  assert.throws(
    () => validateCardSetPlan(candidates, omitted),
    (error: unknown) =>
      error instanceof CardSetPlanError
      && (error.code === "plan_invalid_capacity" || error.code === "plan_incomplete_assignment"),
  );
  assert.throws(
    () => planCardSet([candidates[0]!, { ...candidates[1]!, id: candidates[0]!.id }]),
    (error: unknown) =>
      error instanceof CardSetPlanError && error.code === "planner_duplicate_candidate",
  );
});
