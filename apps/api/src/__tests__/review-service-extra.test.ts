import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ReviewStatus } from "@ailearn/shared";
import { db } from "../db/client.ts";
import { evidences, reviewSchedules } from "../db/schema/evidence.ts";
import { getSanitizedReviewMeta, listReviews } from "../modules/review/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const mutableDb = db as any;
const original = {
  select: mutableDb.select,
  reviewSchedulesFindMany: mutableDb.query.reviewSchedules.findMany,
  reviewSchedulesFindFirst: mutableDb.query.reviewSchedules.findFirst,
  validationEventsFindMany: mutableDb.query.validationEvents.findMany,
  validationEventsFindFirst: mutableDb.query.validationEvents.findFirst,
  learningCardsFindMany: mutableDb.query.learningCards.findMany,
  learningCardsFindFirst: mutableDb.query.learningCards.findFirst,
  cardKeyPointsFindMany: mutableDb.query.cardKeyPoints.findMany,
  cardKeyPointsFindFirst: mutableDb.query.cardKeyPoints.findFirst,
  evidencesFindMany: mutableDb.query.evidences.findMany,
  noteBlocksFindMany: mutableDb.query.noteBlocks.findMany,
  evidenceOverridesFindMany: mutableDb.query.evidenceOverrides.findMany,
  validationAssistanceExposuresFindFirst:
    mutableDb.query.validationAssistanceExposures.findFirst,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.reviewSchedules.findMany = original.reviewSchedulesFindMany;
  mutableDb.query.reviewSchedules.findFirst = original.reviewSchedulesFindFirst;
  mutableDb.query.validationEvents.findMany = original.validationEventsFindMany;
  mutableDb.query.validationEvents.findFirst = original.validationEventsFindFirst;
  mutableDb.query.learningCards.findMany = original.learningCardsFindMany;
  mutableDb.query.learningCards.findFirst = original.learningCardsFindFirst;
  mutableDb.query.cardKeyPoints.findMany = original.cardKeyPointsFindMany;
  mutableDb.query.cardKeyPoints.findFirst = original.cardKeyPointsFindFirst;
  mutableDb.query.evidences.findMany = original.evidencesFindMany;
  mutableDb.query.noteBlocks.findMany = original.noteBlocksFindMany;
  mutableDb.query.evidenceOverrides.findMany = original.evidenceOverridesFindMany;
  mutableDb.query.validationAssistanceExposures.findFirst =
    original.validationAssistanceExposuresFindFirst;
});

type ReviewFixture = {
  total?: number;
  reviews?: any[];
  validations?: any[];
  cards?: any[];
  activeCard?: any;
  keyPoints?: any[];
  evidences?: any[];
  blocks?: any[];
  overrides?: any[];
  schedule?: any;
  validation?: any;
  keyPointFindFirst?: any[];
  evidenceCount?: number;
  exposure?: any;
};

function installReviewDb(fixture: ReviewFixture): void {
  const keyPointFindFirst = [...(fixture.keyPointFindFirst ?? [])];
  mutableDb.select = () => ({
    from: (table: unknown) => {
      if (table === reviewSchedules) {
        return { where: async () => [{ count: fixture.total ?? 0 }] };
      }
      if (table === evidences) {
        return { where: async () => [{ count: fixture.evidenceCount ?? 0 }] };
      }
      assert.fail("unexpected table in review service test");
    },
  });
  mutableDb.query.reviewSchedules.findMany = async () => fixture.reviews ?? [];
  mutableDb.query.reviewSchedules.findFirst = async () => fixture.schedule;
  mutableDb.query.validationEvents.findMany = async () => fixture.validations ?? [];
  mutableDb.query.validationEvents.findFirst = async () => fixture.validation;
  mutableDb.query.learningCards.findMany = async () => fixture.cards ?? [];
  mutableDb.query.learningCards.findFirst = async () =>
    fixture.activeCard === null ? undefined : fixture.activeCard ?? { id: "active-card" };
  mutableDb.query.cardKeyPoints.findMany = async () => fixture.keyPoints ?? [];
  mutableDb.query.cardKeyPoints.findFirst = async () => keyPointFindFirst.shift();
  mutableDb.query.evidences.findMany = async () => fixture.evidences ?? [];
  mutableDb.query.noteBlocks.findMany = async () => fixture.blocks ?? [];
  mutableDb.query.evidenceOverrides.findMany = async () => fixture.overrides ?? [];
  mutableDb.query.validationAssistanceExposures.findFirst = async () => fixture.exposure;
}

describe("review listing filters and empty boundaries", () => {
  it("supports include-all, terminal status, and pending filters without hydrating empty pages", async () => {
    installReviewDb({ total: 0 });

    assert.deepEqual(await listReviews(WORKSPACE_ID, { includeAll: true }), {
      items: [], total: 0, nextOffset: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.COMPLETED }, USER_ID), {
      items: [], total: 0, nextOffset: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.DISMISSED }), {
      items: [], total: 0, nextOffset: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, { status: ReviewStatus.PENDING }, USER_ID), {
      items: [], total: 0, nextOffset: null,
    });
    assert.deepEqual(await listReviews(WORKSPACE_ID, {}, undefined), {
      items: [], total: 0, nextOffset: null,
    });
  });

  it("drops validation schedules whose polymorphic target disappeared", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-stale", subjectType: "validation", subjectId: "validation-stale" }],
      validations: [],
    });

    assert.deepEqual(await listReviews(WORKSPACE_ID, { includeAll: true }), {
      items: [], total: 1, nextOffset: null,
    });
  });
});

describe("review hydration and reason derivation", () => {
  it("hydrates mixed review subjects in batches and derives all four reasons", async () => {
    const reviews = [
      { id: "review-mis", subjectType: "validation", subjectId: "validation-mis", intervalDays: 3 },
      { id: "review-manual", subjectType: "validation", subjectId: "validation-manual", intervalDays: 0 },
      { id: "review-gap", subjectType: "card", subjectId: "card-gap", intervalDays: 3 },
      { id: "review-due", subjectType: "card", subjectId: "card-due", intervalDays: 3 },
      { id: "review-stale-validation", subjectType: "validation", subjectId: "validation-stale", intervalDays: 3 },
      { id: "review-stale-card", subjectType: "card", subjectId: "card-stale", intervalDays: 3 },
    ];
    installReviewDb({
      total: 10,
      reviews,
      validations: [
        { id: "validation-mis", cardId: "card-mis", outcome: "misunderstanding", keyPointId: "kp-mis" },
        { id: "validation-manual", cardId: "card-manual", outcome: "preliminary_understanding", keyPointId: "kp-manual" },
      ],
      cards: [
        { id: "card-mis", schemaJson: { title: "Misunderstanding" } },
        { id: "card-manual", schemaJson: {} },
        { id: "card-gap", schemaJson: { title: "Gap" } },
        { id: "card-due", schemaJson: { title: "Due" } },
      ],
      keyPoints: [
        { id: "kp-mis", cardId: "card-mis", claim: "Mis claim", quoteText: "Mis quote" },
        { id: "kp-manual", cardId: "card-manual", claim: "Manual claim", quoteText: "Manual quote" },
        { id: "kp-gap", cardId: "card-gap", claim: "Gap claim", quoteText: "Gap quote" },
        { id: "kp-due", cardId: "card-due", claim: "Due claim", quoteText: "Due quote" },
      ],
      evidences: [
        { id: "ev-mis", keyPointId: "kp-mis", alignment: "aligned", userOverride: null, blockId: "block-image-alt" },
        { id: "ev-mis-later", keyPointId: "kp-mis", alignment: "soft", userOverride: null, blockId: null },
        { id: "ev-manual", keyPointId: "kp-manual", alignment: "aligned", userOverride: null, blockId: "block-image-empty" },
        { id: "ev-gap", keyPointId: "kp-gap", alignment: "soft", userOverride: null, blockId: "block-text" },
        { id: "ev-due", keyPointId: "kp-due", alignment: "soft", userOverride: null, blockId: null },
      ],
      overrides: [{ evidenceId: "ev-due", override: "confirmed" }],
      blocks: [
        { id: "block-image-alt", type: "image", content: "![Architecture](https://secret.test/image.png)" },
        { id: "block-image-empty", type: "image", content: "![](https://secret.test/image.png)" },
        { id: "block-text", type: "paragraph", content: "Visible context" },
      ],
    });

    const result = await listReviews(
      WORKSPACE_ID,
      { limit: 1000, offset: 2 },
      USER_ID,
    );

    assert.equal(result.total, 10);
    assert.equal(result.nextOffset, 8);
    assert.deepEqual(result.items.map((item) => item.reviewReason), [
      "misunderstanding",
      "manual_pin",
      "evidence_gap",
      "due_review",
    ]);
    assert.deepEqual(result.items.map((item) => item.blockContent), [
      "Architecture",
      "[图片]",
      "Visible context",
      null,
    ]);
    assert.equal(result.items[0]!.keyPoint?.id, "kp-mis");
    assert.equal(result.items[1]!.card.title, "（未命名学习卡）");
  });

  it("falls back to the first key point and legacy override without a user", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "card-1", intervalDays: 2 }],
      cards: [{ id: "card-1", schemaJson: { title: "Legacy" } }],
      keyPoints: [{ id: "kp-first", cardId: "card-1", claim: "Claim", quoteText: "Quote" }],
      evidences: [
        { id: "ev-rejected", keyPointId: "kp-first", alignment: "aligned", userOverride: "rejected", blockId: null },
      ],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true });

    assert.equal(result.items[0]!.keyPoint?.id, "kp-first");
    assert.equal(result.items[0]!.reviewReason, "evidence_gap");
    assert.equal(result.nextOffset, null);
  });

  it("renders a card review even when it has no key points", async () => {
    installReviewDb({
      total: 1,
      reviews: [{ id: "review-1", subjectType: "card", subjectId: "card-1", intervalDays: 1 }],
      cards: [{ id: "card-1", schemaJson: { title: "No key points" } }],
      keyPoints: [],
    });

    const result = await listReviews(WORKSPACE_ID, { includeAll: true }, USER_ID);

    assert.equal(result.items[0]!.keyPoint, null);
    assert.equal(result.items[0]!.blockContent, null);
    assert.equal(result.items[0]!.reviewReason, "evidence_gap");
  });
});

describe("legacy review Focus metadata", () => {
  const nextReviewAt = new Date("2026-07-24T13:02:00.000Z");

  it("recovers a validation schedule key point from its validation event", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-validation",
        userId: USER_ID,
        subjectType: "validation",
        subjectId: "validation-1",
        validationEventId: null,
        keyPointId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 1,
      },
      validation: {
        id: "validation-1",
        userId: USER_ID,
        cardId: "card-1",
        keyPointId: "kp-validation",
        outcome: "misunderstanding",
      },
      keyPointFindFirst: [{ id: "kp-validation", cardId: "card-1" }],
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-validation",
      USER_ID,
    );

    assert.equal(result?.cardId, "card-1");
    assert.equal(result?.keyPointId, "kp-validation");
    assert.equal(result?.reviewReason, "misunderstanding");
  });

  it("uses the same first-key-point fallback as the queue for legacy card schedules", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-card",
        userId: USER_ID,
        subjectType: "card",
        subjectId: "card-legacy",
        validationEventId: null,
        keyPointId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 3,
      },
      keyPointFindFirst: [{ id: "kp-first", cardId: "card-legacy" }],
      evidences: [{
        id: "ev-first",
        keyPointId: "kp-first",
        alignment: "aligned",
        userOverride: null,
        blockId: null,
      }],
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-card",
      USER_ID,
    );

    assert.equal(result?.cardId, "card-legacy");
    assert.equal(result?.keyPointId, "kp-first");
    assert.equal(result?.reviewReason, "due_review");
  });

  it("hides a schedule when its card is no longer consumer-active", async () => {
    installReviewDb({
      schedule: {
        id: "schedule-inactive-set",
        userId: USER_ID,
        subjectType: "card",
        subjectId: "card-inactive-set",
        validationEventId: null,
        keyPointId: null,
        status: "pending",
        nextReviewAt,
        intervalDays: 3,
      },
      activeCard: null,
    });

    const result = await getSanitizedReviewMeta(
      WORKSPACE_ID,
      "schedule-inactive-set",
      USER_ID,
    );

    assert.equal(result, null);
  });
});
