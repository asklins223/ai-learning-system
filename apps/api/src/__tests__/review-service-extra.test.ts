import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ReviewStatus } from "@ailearn/shared";
import { db } from "../db/client.ts";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { listReviews } from "../modules/review/service.ts";

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
  learningCardsV2FindMany: mutableDb.query.learningCardsV2.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.reviewSchedules.findMany = original.reviewSchedulesFindMany;
  mutableDb.query.learningCardsV2.findMany = original.learningCardsV2FindMany;
});

type ReviewFixture = {
  total?: number;
  reviews?: any[];
  // V2 objective → card hydration fixtures
  v2Cards?: any[];
  // learningObjectivesV2 projection rows
  v2Objectives?: any[];
  // learningObjectiveRevisionsV2 projection rows
  v2Revisions?: any[];
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
  mutableDb.query.learningCardsV2.findMany = async () => v2Cards;
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

});

describe("review hydration and reason derivation (V2 objectives)", () => {
  it("hydrates card reviews and derives all v2 reasons from objective evidence", async () => {
    const reviews = [
      { id: "review-manual", subjectType: "card", subjectId: "obj-manual", intervalDays: 0 },
      { id: "review-gap", subjectType: "card", subjectId: "obj-gap", intervalDays: 3 },
      { id: "review-due", subjectType: "card", subjectId: "obj-due", intervalDays: 3 },
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
      { limit: 1000 },
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

  it("resolves current objective evidence when no user is supplied", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "obj-1", intervalDays: 2 }],
      v2Cards: [{ cardId: "card-1", objectiveId: "obj-1", publicSummary: "Current", front: { cue: "cue" }, lifecycle: "active" }],
      v2Objectives: [{ objectiveId: "obj-1", currentObjectiveRevisionId: "rev-1", currentRevisionId: "rev-1" }],
      v2Revisions: [{ objectiveRevisionId: "rev-1", publicSummary: "Current" }],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true }, undefined, FAKE_TX);

    assert.equal(result.items[0]!.card.title, "Current");
    assert.equal(result.items[0]!.reviewReason, "due_review");
    assert.equal(result.nextCursor, null);
  });

  it("renders a card review even when its objective has no hard evidence", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "obj-1", intervalDays: 1 }],
      v2Cards: [{ cardId: "card-1", objectiveId: "obj-1", publicSummary: "No evidence", front: { cue: "cue" }, lifecycle: "active" }],
      v2Objectives: [],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true }, USER_ID, FAKE_TX);

    assert.equal(result.items[0]!.card.title, "No evidence");
    assert.equal(result.items[0]!.blockContent, null);
    assert.equal(result.items[0]!.reviewReason, "evidence_gap");
  });
});
