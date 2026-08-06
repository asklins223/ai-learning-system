import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { learningCards } from "../db/schema/card.ts";
import { evidences, reviewSchedules, understandingEvents, validationEvents } from "../db/schema/evidence.ts";
import {
  getUnderstandingGraph,
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
  noteVersionsFindMany: mutableDb.query.noteVersions.findMany,
  notesFindMany: mutableDb.query.notes.findMany,
  sourcesFindMany: mutableDb.query.sources.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.learningCards.findMany = original.learningCardsFindMany;
  mutableDb.query.cardKeyPoints.findMany = original.cardKeyPointsFindMany;
  mutableDb.query.evidenceOverrides.findMany = original.evidenceOverridesFindMany;
  mutableDb.query.noteVersions.findMany = original.noteVersionsFindMany;
  mutableDb.query.notes.findMany = original.notesFindMany;
  mutableDb.query.sources.findMany = original.sourcesFindMany;
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

type GraphDbFixture = {
  stateCards: any[];
  graphCards?: any[];
  stateKeyPoints?: any[];
  graphKeyPoints?: any[];
  events?: any[];
  evidenceRows?: any[];
  overrides?: any[];
  noteVersions?: any[];
  notes?: any[];
  sources?: any[];
  validationRows?: any[];
  totalCards?: number;
};

function installGraphDb(fixture: GraphDbFixture): void {
  let cardQuery = 0;
  let keyPointQuery = 0;
  let evidenceSelect = 0;
  let reviewSelect = 0;
  mutableDb.query.learningCards.findMany = async () => (
    ++cardQuery === 1 ? fixture.stateCards : fixture.graphCards ?? fixture.stateCards
  );
  mutableDb.query.cardKeyPoints.findMany = async () => (
    ++keyPointQuery === 1 ? fixture.stateKeyPoints ?? [] : fixture.graphKeyPoints ?? fixture.stateKeyPoints ?? []
  );
  mutableDb.query.evidenceOverrides.findMany = async () => fixture.overrides ?? [];
  mutableDb.query.noteVersions.findMany = async () => fixture.noteVersions ?? [];
  mutableDb.query.notes.findMany = async () => fixture.notes ?? [];
  mutableDb.query.sources.findMany = async () => fixture.sources ?? [];
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
        evidenceSelect += 1;
        return { where: async () => fixture.evidenceRows ?? [] };
      }
      if (table === reviewSchedules) {
        reviewSelect += 1;
        return {
          // PERF-23 后为合并的 leftJoin 查询；graph fixture 不提供复习数据。
          leftJoin: () => ({ where: () => ({ orderBy: async () => [] }) }),
        };
      }
      if (table === learningCards) {
        return { where: async () => [{ count: fixture.totalCards ?? fixture.stateCards.length }] };
      }
      if (table === validationEvents) {
        return { where: () => ({ orderBy: async () => fixture.validationRows ?? [] }) };
      }
      throw new Error(`unexpected graph select #${evidenceSelect}`);
    },
  });
}

describe("understanding graph data projection", () => {
  it("returns stable metadata when there are no visible cards", async () => {
    installGraphDb({ stateCards: [], totalCards: 3 });

    const graph = await getUnderstandingGraph(WORKSPACE_ID, USER_ID, FAKE_TX);

    assert.deepEqual(graph.nodes, []);
    assert.equal(graph.meta.totalCards, 3);
    assert.equal(graph.meta.truncated, false);
  });

  it("hydrates real source-note-version-card-key-point lineage and user evidence", async () => {
    const createdAt = new Date("2026-07-20T00:00:00.000Z");
    const updatedAt = new Date("2026-07-21T00:00:00.000Z");
    const stateCards = [{
      id: "card-1",
      noteVersionId: "version-1",
      schemaJson: { title: "Card", summary: "Summary" },
      status: "active",
      createdAt,
      updatedAt,
    }];
    const keyPoints = [{
      id: "kp-1",
      cardId: "card-1",
      ordinal: 0,
      claim: "Claim",
      quoteText: "Quote",
      segmentRef: { segmentId: "segment-1" },
    }];
    installGraphDb({
      stateCards,
      graphCards: stateCards,
      stateKeyPoints: keyPoints,
      graphKeyPoints: keyPoints,
      events: [{ cardId: "card-1", eventType: "validated", createdAt }],
      evidenceRows: [{
        id: "evidence-1",
        keyPointId: "kp-1",
        alignment: "soft",
        userOverride: null,
        legacyOverride: null,
      }],
      overrides: [{ evidenceId: "evidence-1", override: "confirmed" }],
      noteVersions: [{ id: "version-1", noteId: "note-1", versionNo: 2, createdAt }],
      notes: [{
        id: "note-1",
        title: "Note",
        sourceId: "source-1",
        currentVersionId: "version-1",
        createdAt,
        updatedAt,
      }],
      sources: [{
        id: "source-1",
        type: "markdown",
        title: "Source",
        origin: "source.md",
        status: "ready",
        metadata: { language: "zh" },
        createdAt,
        updatedAt,
      }],
      validationRows: [
        {
          cardId: "card-1",
          keyPointId: "kp-1",
          outcome: "misunderstanding",
          createdAt: updatedAt,
        },
        {
          cardId: "card-1",
          keyPointId: "kp-1",
          outcome: "misunderstanding",
          createdAt,
        },
        {
          cardId: "card-1",
          keyPointId: null,
          outcome: "preliminary_understanding",
          createdAt,
        },
      ],
      totalCards: 1,
    });

    const graph = await getUnderstandingGraph(WORKSPACE_ID, USER_ID, FAKE_TX);

    assert.deepEqual(graph.nodes.map((node) => node.type), ["source", "note", "card", "key_point"]);
    assert.equal(graph.meta.totalCards, 1);
    assert.equal(graph.meta.truncated, false);
    const card = graph.nodes.find((node) => node.type === "card");
    assert.equal(card?.lastValidatedAt, updatedAt.toISOString());
    const keyPoint = graph.nodes.find((node) => node.type === "key_point");
    assert.equal(keyPoint?.hardEvidenceCount, 1);
    assert.equal(keyPoint?.softEvidenceCount, 0);
    assert.equal(keyPoint?.misunderstandingCount, 2);
  });

  it("keeps a card graph useful when upstream lineage and key points are absent", async () => {
    const createdAt = new Date("2026-07-20T00:00:00.000Z");
    const card = {
      id: "card-1",
      noteVersionId: "missing-version",
      schemaJson: {},
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    installGraphDb({
      stateCards: [card],
      graphCards: [card],
      stateKeyPoints: [],
      graphKeyPoints: [],
      noteVersions: [],
      totalCards: 1,
    });

    const graph = await getUnderstandingGraph(WORKSPACE_ID, USER_ID, FAKE_TX);

    assert.equal(graph.meta.cardCount, 1);
    assert.equal(graph.meta.noteCount, 0);
    assert.equal(graph.meta.sourceCount, 0);
    assert.equal(graph.meta.keyPointCount, 0);
  });

  it("does not invent a graph card if it disappears after state aggregation", async () => {
    const createdAt = new Date("2026-07-20T00:00:00.000Z");
    installGraphDb({
      stateCards: [{
        id: "card-deleted",
        noteVersionId: "version-deleted",
        schemaJson: { title: "Deleted concurrently" },
        status: "active",
        createdAt,
        updatedAt: createdAt,
      }],
      graphCards: [],
      totalCards: 0,
    });

    const graph = await getUnderstandingGraph(WORKSPACE_ID, USER_ID, FAKE_TX);

    assert.equal(graph.meta.cardCount, 0);
    assert.equal(graph.nodes.length, 0);
  });
});
