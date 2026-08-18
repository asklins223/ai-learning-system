import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ReviewStatus } from "@ailearn/shared";
import { db } from "../db/client.ts";
import { reviewSchedules } from "../db/schema/evidence.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
} from "../db/schema/card-generation-v2.ts";
import { getSanitizedReviewMeta, listReviews } from "../modules/review/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const mutableDb = db as any;
// QUAL-58/SEC-26 后服务无 tx 时走 withWorkspaceTransaction（真实 db.transaction），
// 单元测试直接传入 fake tx 跳过 RLS 上下文设置。
const FAKE_TX = {
  query: mutableDb.query,
  select: (...args: unknown[]) => mutableDb.select(...args),
} as any;
const original = {
  select: mutableDb.select,
  reviewSchedulesFindMany: mutableDb.query.reviewSchedules.findMany,
  reviewSchedulesFindFirst: mutableDb.query.reviewSchedules.findFirst,
  validationEventsFindMany: mutableDb.query.validationEvents.findMany,
  learningCardsV2FindMany: mutableDb.query.learningCardsV2.findMany,
  learningCardsV2FindFirst: mutableDb.query.learningCardsV2.findFirst,
  exposureFindMany: mutableDb.query.validationAssistanceExposures.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.reviewSchedules.findMany = original.reviewSchedulesFindMany;
  mutableDb.query.reviewSchedules.findFirst = original.reviewSchedulesFindFirst;
  mutableDb.query.validationEvents.findMany = original.validationEventsFindMany;
  mutableDb.query.learningCardsV2.findMany = original.learningCardsV2FindMany;
  mutableDb.query.learningCardsV2.findFirst = original.learningCardsV2FindFirst;
  mutableDb.query.validationAssistanceExposures.findMany = original.exposureFindMany;
});

type ReviewFixture = {
  total?: number;
  reviews?: any[];
  validations?: any[];
  schedule?: any;
  // V2 objective → card hydration fixtures
  v2Cards?: any[];
  // single active V2 card (learningCardsV2.findFirst)
  v2Objective?: any;
  // learningObjectivesV2 projection rows
  v2Objectives?: any[];
  // learningObjectiveRevisionsV2 projection rows
  v2Revisions?: any[];
  exposures?: any[];
};

function installReviewDb(fixture: ReviewFixture): void {
  const v2Cards = fixture.v2Cards ?? [];
  const v2Objectives = fixture.v2Objectives ?? [];
  const v2Revisions = fixture.v2Revisions ?? [];
  mutableDb.select = () => ({
    from: (table: unknown) => {
      if (table === reviewSchedules) {
        return { where: async () => [{ count: fixture.total ?? 0 }] };
      }
      if (table === learningObjectivesV2) {
        return { where: async () => v2Objectives };
      }
      if (table === learningObjectiveRevisionsV2) {
        return { where: async () => v2Revisions };
      }
      if (table === learningCardsV2) {
        return { where: async () => v2Cards };
      }
      assert.fail(`unexpected table in review service test: ${String((table as any)?.name)}`);
    },
  });
  mutableDb.query.reviewSchedules.findMany = async () => fixture.reviews ?? [];
  mutableDb.query.reviewSchedules.findFirst = async () => fixture.schedule;
  mutableDb.query.validationEvents.findMany = async () => fixture.validations ?? [];
  mutableDb.query.learningCardsV2.findMany = async () => v2Cards;
  mutableDb.query.learningCardsV2.findFirst = async () => fixture.v2Objective;
  mutableDb.query.validationAssistanceExposures.findMany = async () => fixture.exposures ?? [];
}

describe("review listing filters and empty boundaries", () => {
  it("supports include-all, terminal status, and pending filters without hydrating empty pages", async () => {
    installReviewDb({ total: 0 });

    assert.deepEqual(await listReviews(WORKSPACE_ID, { includeAll: true }, undefined, FAKE_TX), {
      items: [], total: 0, nextCursor: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.COMPLETED }, USER_ID, FAKE_TX), {
      items: [], total: 0, nextCursor: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.DISMISSED }, undefined, FAKE_TX), {
      items: [], total: 0, nextCursor: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.PENDING }, USER_ID, FAKE_TX), {
      items: [], total: 0, nextCursor: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, {}, undefined, FAKE_TX), {
      items: [], total: 0, nextCursor: null,
    });
  });

  it("drops validation schedules whose polymorphic target disappeared", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-stale", subjectType: "validation", subjectId: "validation-stale" }],
      validations: [],
    });

    assert.deepEqual(await listReviews(WORKSPACE_ID, { includeAll: true }, undefined, FAKE_TX), {
      items: [], total: 1, nextCursor: null,
    });
  });
});

describe("review hydration and reason derivation (V2 objectives)", () => {
  it("hydrates card reviews and derives all v2 reasons from objective evidence", async () => {
    const reviews = [
      { id: "review-manual", subjectType: "card", subjectId: "card-manual", intervalDays: 0 },
      { id: "review-gap", subjectType: "card", subjectId: "card-gap", intervalDays: 3 },
      { id: "review-due", subjectType: "card", subjectId: "card-due", intervalDays: 3 },
    ];
    installReviewDb({
      total: 10,
      reviews,
      v2Cards: [
        { cardId: "card-manual", objectiveId: "obj-manual", publicSummary: "Manual objective", front: { cue: "Manual cue" }, lifecycle: "active" },
        { cardId: "card-gap", objectiveId: "obj-gap", publicSummary: "Gap objective", front: { cue: "Gap cue" }, lifecycle: "active" },
        { cardId: "card-due", objectiveId: "obj-due", publicSummary: "Due objective", front: { cue: "Due cue" }, lifecycle: "active" },
      ],
      v2Objectives: [
        // currentRevisionId = 由 select 别名投影出的硬证据信号字段（resolveObjectiveEvidence）。
        { objectiveId: "obj-manual", currentObjectiveRevisionId: "rev-manual", currentRevisionId: "rev-manual" },
        { objectiveId: "obj-due", currentObjectiveRevisionId: "rev-due", currentRevisionId: "rev-due" },
        // obj-gap has no revision → no hard evidence → evidence_gap
      ],
      v2Revisions: [
        { objectiveRevisionId: "rev-manual", publicSummary: "Manual objective" },
        { objectiveRevisionId: "rev-due", publicSummary: "Due objective" },
      ],
    });

    const result = await listReviews(
      WORKSPACE_ID,
      { limit: 1000, offset: 2 },
      USER_ID,
      FAKE_TX,
    );

    assert.equal(result.total, 10);
    assert.deepEqual(result.items.map((item) => item.reviewReason), [
      "manual_pin",
      "evidence_gap",
      "due_review",
    ]);
    assert.equal(result.items[0]!.card.title, "Manual objective");
    assert.equal(result.items[1]!.card.title, "Gap objective");
    assert.equal(result.items[2]!.card.title, "Due objective");
    assert.equal(result.items[0]!.objective?.id, "obj-manual");
    assert.equal(result.items[2]!.objective?.id, "obj-due");
  });

  it("falls back to objective evidence when no user is supplied", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "card-1", intervalDays: 2 }],
      v2Cards: [{ cardId: "card-1", objectiveId: "obj-1", publicSummary: "Legacy", front: { cue: "cue" }, lifecycle: "active" }],
      v2Objectives: [{ objectiveId: "obj-1", currentObjectiveRevisionId: "rev-1", currentRevisionId: "rev-1" }],
      v2Revisions: [{ objectiveRevisionId: "rev-1", publicSummary: "Legacy" }],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true }, undefined, FAKE_TX);

    assert.equal(result.items[0]!.card.title, "Legacy");
    assert.equal(result.items[0]!.reviewReason, "due_review");
    assert.equal(result.nextCursor, null);
  });

  it("renders a card review even when its objective has no hard evidence", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "card-1", intervalDays: 1 }],
      v2Cards: [{ cardId: "card-1", objectiveId: "obj-1", publicSummary: "No evidence", front: { cue: "cue" }, lifecycle: "active" }],
      v2Objectives: [],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true }, USER_ID, FAKE_TX);

    assert.equal(result.items[0]!.card.title, "No evidence");
    assert.equal(result.items[0]!.blockContent, null);
    assert.equal(result.items[0]!.reviewReason, "evidence_gap");
  });
});

describe("review Focus metadata (V2 objectives)", () => {
  const nextReviewAt = new Date("2026-07-24T13:02:00.000Z");

  it("resolves the objective id for a card schedule", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-card",
        userId: USER_ID,
        subjectType: "card",
        subjectId: "card-1",
        validationEventId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 1,
      },
      v2Objective: { cardId: "card-1", objectiveId: "obj-1", publicSummary: "Objective", lifecycle: "active" },
      exposures: [],
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-card",
      USER_ID,
      FAKE_TX,
    );

    assert.equal(result?.cardId, "card-1");
    assert.equal(result?.objectiveId, "obj-1");
    assert.equal(result?.reviewReason, "due_review");
  });

  it("uses the linked objective for an objective schedule", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-objective",
        userId: USER_ID,
        subjectType: "objective",
        subjectId: "obj-1",
        validationEventId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 3,
      },
      v2Objective: { cardId: "card-obj", objectiveId: "obj-1", publicSummary: "Objective", lifecycle: "active" },
      exposures: [],
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-objective",
      USER_ID,
      FAKE_TX,
    );

    assert.equal(result?.cardId, "card-obj");
    assert.equal(result?.objectiveId, "obj-1");
    assert.equal(result?.reviewReason, "due_review");
  });

  it("hides a schedule when its objective card is no longer consumer-active", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-inactive",
        userId: USER_ID,
        subjectType: "objective",
        subjectId: "obj-inactive",
        validationEventId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 3,
      },
      v2Objective: undefined,
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-inactive",
      USER_ID,
      FAKE_TX,
    );

    assert.equal(result, null);
  });
});
