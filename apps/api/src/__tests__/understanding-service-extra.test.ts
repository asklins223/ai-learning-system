import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { evidences, reviewSchedules, understandingEvents } from "../db/schema/evidence.ts";
import {
  getUnderstandingStates,
} from "../modules/understanding/service.ts";

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
  learningCardsFindMany: mutableDb.query.learningCards.findMany,
  cardKeyPointsFindMany: mutableDb.query.cardKeyPoints.findMany,
  evidenceOverridesFindMany: mutableDb.query.evidenceOverrides.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.learningCards.findMany = original.learningCardsFindMany;
  mutableDb.query.cardKeyPoints.findMany = original.cardKeyPointsFindMany;
  mutableDb.query.evidenceOverrides.findMany = original.evidenceOverridesFindMany;
});

type StateDbFixture = {
  cards: any[];
  events?: any[];
  keyPoints?: any[];
  evidenceRows?: any[];
  overrides?: any[];
  validationReviews?: any[];
  cardReviews?: any[];
};

function installStateDb(fixture: StateDbFixture): void {
  mutableDb.query.learningCards.findMany = async () => fixture.cards;
  mutableDb.query.cardKeyPoints.findMany = async () => fixture.keyPoints ?? [];
  mutableDb.query.evidenceOverrides.findMany = async () => fixture.overrides ?? [];
  mutableDb.select = () => ({
    from: (table: unknown) => {
      if (table === understandingEvents) {
        return {
          innerJoin: () => ({
            // PERF-23：服务端用 SQL GROUP BY 聚合 understanding_events
            where: () => ({ groupBy: async () => fixture.events ?? [] }),
          }),
        };
      }
      if (table === evidences) {
        return { where: async () => fixture.evidenceRows ?? [] };
      }
      if (table === reviewSchedules) {
        return {
          // PERF-23 后：validation + card 两类 schedule 合并为一次 leftJoin 查询，
          // 结果行的 cardId = COALESCE(validation.card_id, schedule.subject_id)。
          leftJoin: () => ({
            where: () => ({
              orderBy: async () => [
                ...(fixture.validationReviews ?? []).map((r) => ({
                  cardId: r.cardId,
                  nextReviewAt: r.nextReviewAt,
                  status: r.status,
                })),
                ...(fixture.cardReviews ?? []).map((r) => ({
                  cardId: r.subjectId,
                  nextReviewAt: r.nextReviewAt,
                  status: r.status,
                })),
              ],
            }),
          }),
        };
      }
      throw new Error("unexpected table in state fixture");
    },
  });
}

function stateCard(id: string, title?: string): any {
  return {
    id,
    schemaJson: title === undefined ? {} : { title },
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
  };
}

describe("understanding state aggregation", () => {
  it("short-circuits when there are no active cards", async () => {
    let selects = 0;
    installStateDb({ cards: [] });
    mutableDb.select = () => {
      selects += 1;
      throw new Error("should not query aggregates");
    };

    assert.deepEqual(await getUnderstandingStates(WORKSPACE_ID, undefined, undefined, FAKE_TX), []);
    assert.equal(selects, 0);
  });

  it("derives every visible state and per-user evidence/review aggregates", async () => {
    const cards = [
      stateCard("card-misunderstood", "Misunderstood"),
      stateCard("card-due", "Due"),
      stateCard("card-unseen"),
      stateCard("card-validated", "Validated"),
      stateCard("card-reviewed", "Reviewed"),
      stateCard("card-seen", "Seen"),
      stateCard("card-unknown", "Unknown"),
    ];
    installStateDb({
      cards,
      // PERF-23 后服务端用 SQL GROUP BY 聚合，fixture 提供聚合行：
      // { cardId, latestEventType, latestValidationEventType, lastValidatedAt, misunderstandingCount }
      events: [
        {
          cardId: "card-misunderstood",
          latestEventType: "reviewed",
          latestValidationEventType: "misunderstood",
          lastValidatedAt: new Date("2026-07-20T00:00:00Z"),
          misunderstandingCount: 2,
        },
        {
          cardId: "card-due",
          latestEventType: "seen",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          cardId: "card-validated",
          latestEventType: "validated",
          latestValidationEventType: "validated",
          lastValidatedAt: new Date("2026-07-20T00:00:00Z"),
          misunderstandingCount: 0,
        },
        {
          cardId: "card-reviewed",
          latestEventType: "reviewed",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          cardId: "card-seen",
          latestEventType: "seen",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          cardId: "card-unknown",
          latestEventType: "custom",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
      ],
      keyPoints: [
        { id: "kp-misunderstood", cardId: "card-misunderstood" },
        { id: "kp-due-hard", cardId: "card-due" },
        { id: "kp-due-soft", cardId: "card-due" },
        { id: "kp-orphan", cardId: "not-visible" },
      ],
      evidenceRows: [
        { id: "ev-rejected", keyPointId: "kp-misunderstood", alignment: "aligned", userOverride: null },
        { id: "ev-hard", keyPointId: "kp-due-hard", alignment: "soft", userOverride: null },
        { id: "ev-soft", keyPointId: "kp-due-soft", alignment: "aligned", userOverride: null },
        { id: "ev-legacy-hard", keyPointId: "kp-due-hard", alignment: "aligned", userOverride: null },
        { id: "ev-orphan", keyPointId: "kp-unknown", alignment: "aligned", userOverride: null },
      ],
      overrides: [
        { evidenceId: "ev-rejected", override: "rejected" },
        { evidenceId: "ev-hard", override: "confirmed" },
        { evidenceId: "ev-soft", override: "downgraded" },
      ],
      validationReviews: [
        { cardId: "card-due", nextReviewAt: new Date("2099-01-01T00:00:00Z"), status: "pending" },
      ],
      cardReviews: [
        { subjectId: "card-due", nextReviewAt: new Date("2020-01-01T00:00:00Z"), status: "pending" },
        { subjectId: "card-due", nextReviewAt: new Date("2098-01-01T00:00:00Z"), status: "pending" },
      ],
    });

    const results = await getUnderstandingStates(WORKSPACE_ID, undefined, USER_ID, FAKE_TX);
    const byId = new Map(results.map((result) => [result.subjectId, result]));

    assert.equal(byId.get("card-misunderstood")?.state, "misunderstood");
    assert.equal(byId.get("card-misunderstood")?.misunderstandingCount, 2);
    assert.equal(byId.get("card-due")?.state, "due_review");
    assert.equal(byId.get("card-due")?.hardEvidenceCount, 2);
    assert.equal(byId.get("card-due")?.softEvidenceCount, 1);
    assert.equal(byId.get("card-due")?.evidenceCoverage, 0.5);
    assert.equal(byId.get("card-unseen")?.state, "unseen");
    assert.equal(byId.get("card-unseen")?.title, "（未命名学习卡）");
    assert.equal(byId.get("card-validated")?.state, "preliminary_understood");
    assert.equal(byId.get("card-reviewed")?.state, "reviewed");
    assert.equal(byId.get("card-seen")?.state, "seen");
    assert.equal(byId.get("card-unknown")?.state, "unseen");
  });

  it("uses legacy evidence overrides without a user and filters by derived state", async () => {
    installStateDb({
      cards: [stateCard("card-soft", "Soft")],
      events: [{
        cardId: "card-soft",
        latestEventType: "seen",
        latestValidationEventType: null,
        lastValidatedAt: null,
        misunderstandingCount: 0,
      }],
      keyPoints: [{ id: "kp-soft", cardId: "card-soft" }],
      evidenceRows: [
        { id: "ev-soft", keyPointId: "kp-soft", alignment: "aligned", userOverride: "downgraded" },
        { id: "ev-rejected", keyPointId: "kp-soft", alignment: "aligned", userOverride: "rejected" },
      ],
    });

    assert.deepEqual(await getUnderstandingStates(WORKSPACE_ID, { state: "misunderstood" }, undefined, FAKE_TX), []);
    const seen = await getUnderstandingStates(WORKSPACE_ID, { state: "seen" }, undefined, FAKE_TX);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.softEvidenceCount, 1);
    assert.equal(seen[0]!.hardEvidenceCount, 0);
  });
});

