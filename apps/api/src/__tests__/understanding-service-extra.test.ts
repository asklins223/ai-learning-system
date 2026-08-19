import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { reviewSchedules, understandingEvents } from "../db/schema/evidence.ts";
import {
  learningObjectiveEvidenceBindingsV2,
  learningObjectiveRevisionsV2,
} from "../db/schema/card-generation-v2.ts";
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
  learningCardsV2FindMany: mutableDb.query.learningCardsV2.findMany,
  learningObjectivesV2FindMany: mutableDb.query.learningObjectivesV2.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.query.learningCardsV2.findMany = original.learningCardsV2FindMany;
  mutableDb.query.learningObjectivesV2.findMany = original.learningObjectivesV2FindMany;
});

type StateDbFixture = {
  // V2 active learning cards（learningCardsV2.findMany）：
  // { cardId, objectiveId, lifecycle:'active', publicSummary, front, createdAt }
  cards: any[];
  // learningObjectivesV2 投影行（解析 currentObjectiveRevisionId）
  objectives?: any[];
  // understanding_events 聚合行（按 subjectId = objectiveId）
  events?: any[];
  // learningObjectiveEvidenceBindingsV2 行（{ objectiveRevisionId, supportStrength }）
  bindings?: any[];
  // review_schedules 聚合行（subjectType='card' + subjectId=objectiveId）
  cardReviews?: any[];
  // learningObjectiveRevisionsV2 行（{ objectiveId, conceptLabel }）
  revisions?: any[];
};

function installStateDb(fixture: StateDbFixture): void {
  mutableDb.query.learningCardsV2.findMany = async () => fixture.cards;
  mutableDb.query.learningObjectivesV2.findMany = async () => fixture.objectives ?? [];
  mutableDb.select = () => ({
    from: (table: unknown) => {
      if (table === understandingEvents) {
        return {
          // PERF-23：服务端用 SQL GROUP BY 聚合 understanding_events
          where: () => ({ groupBy: async () => fixture.events ?? [] }),
        };
      }
      if (table === learningObjectiveEvidenceBindingsV2) {
        return { where: async () => fixture.bindings ?? [] };
      }
      if (table === learningObjectiveRevisionsV2) {
        return { where: async () => fixture.revisions ?? [] };
      }
      if (table === reviewSchedules) {
        return {
          // V2：objective 维度复习计划用 subjectType='card' + subjectId=objectiveId
          where: () => ({
            orderBy: async () => fixture.cardReviews ?? [],
          }),
        };
      }
      throw new Error("unexpected table in state fixture");
    },
  });
}

function stateCard(id: string, objectiveId: string, title?: string): any {
  return {
    cardId: id,
    objectiveId,
    lifecycle: "active",
    publicSummary: title ?? "",
    front: title === undefined ? {} : { cue: title },
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

  it("derives every visible state and per-objective evidence/review aggregates", async () => {
    const cards = [
      stateCard("card-misunderstood", "obj-misunderstood", "Misunderstood"),
      stateCard("card-due", "obj-due", "Due"),
      stateCard("card-unseen", "obj-unseen"),
      stateCard("card-validated", "obj-validated", "Validated"),
      stateCard("card-reviewed", "obj-reviewed", "Reviewed"),
      stateCard("card-seen", "obj-seen", "Seen"),
      stateCard("card-unknown", "obj-unknown", "Unknown"),
    ];
    installStateDb({
      cards,
      objectives: [
        { objectiveId: "obj-misunderstood", currentObjectiveRevisionId: "rev-misunderstood" },
        { objectiveId: "obj-due", currentObjectiveRevisionId: "rev-due" },
        { objectiveId: "obj-unseen", currentObjectiveRevisionId: "rev-unseen" },
        { objectiveId: "obj-validated", currentObjectiveRevisionId: "rev-validated" },
        { objectiveId: "obj-reviewed", currentObjectiveRevisionId: "rev-reviewed" },
        { objectiveId: "obj-seen", currentObjectiveRevisionId: "rev-seen" },
        { objectiveId: "obj-unknown", currentObjectiveRevisionId: null },
      ],
      // revisions 返回 conceptLabel 用于标题回退链
      revisions: [
        { objectiveId: "obj-misunderstood", conceptLabel: "Misunderstood" },
        { objectiveId: "obj-due", conceptLabel: "Due" },
        { objectiveId: "obj-unseen", conceptLabel: null },
        { objectiveId: "obj-validated", conceptLabel: "Validated" },
        { objectiveId: "obj-reviewed", conceptLabel: "Reviewed" },
        { objectiveId: "obj-seen", conceptLabel: "Seen" },
      ],
      // events 按 subjectId = objectiveId 聚合（V2：objective 承担旧 keyPointId 角色）
      events: [
        {
          subjectId: "obj-misunderstood",
          latestEventType: "reviewed",
          latestValidationEventType: "misunderstood",
          lastValidatedAt: new Date("2026-07-20T00:00:00Z"),
          misunderstandingCount: 2,
        },
        {
          subjectId: "obj-due",
          latestEventType: "seen",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          subjectId: "obj-validated",
          latestEventType: "validated",
          latestValidationEventType: "validated",
          lastValidatedAt: new Date("2026-07-20T00:00:00Z"),
          misunderstandingCount: 0,
        },
        {
          subjectId: "obj-reviewed",
          latestEventType: "reviewed",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          subjectId: "obj-seen",
          latestEventType: "seen",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
        {
          subjectId: "obj-unknown",
          latestEventType: "custom",
          latestValidationEventType: null,
          lastValidatedAt: null,
          misunderstandingCount: 0,
        },
      ],
      // allReviewRows 的投影字段为 objectiveId（service 用 reviewSchedules.subjectId 别名）
      cardReviews: [
        { objectiveId: "obj-due", nextReviewAt: new Date("2020-01-01T00:00:00Z"), status: "pending" },
        { objectiveId: "obj-due", nextReviewAt: new Date("2098-01-01T00:00:00Z"), status: "pending" },
      ],
      // bindings 按 objectiveRevisionId 关联（服务经 objectiveRevisionId→objectiveId
      // 反向映射聚合；revision id ≠ objectiveId）。
      bindings: [
        { objectiveRevisionId: "rev-misunderstood", supportStrength: "hard" },
        { objectiveRevisionId: "rev-misunderstood", supportStrength: "hard" },
        { objectiveRevisionId: "rev-misunderstood", supportStrength: "soft" },
        { objectiveRevisionId: "rev-due", supportStrength: "soft" },
      ],
    });

    const results = await getUnderstandingStates(WORKSPACE_ID, undefined, USER_ID, FAKE_TX);
    const byId = new Map(results.map((result) => [result.subjectId, result]));

    assert.equal(byId.get("card-misunderstood")?.state, "misunderstood");
    assert.equal(byId.get("card-misunderstood")?.misunderstandingCount, 2);
    assert.equal(byId.get("card-misunderstood")?.hardEvidenceCount, 2);
    assert.equal(byId.get("card-misunderstood")?.softEvidenceCount, 1);
    // coverage 按该 objective 自身的 binding 总数计算（Math.min(1, 3) = 1）
    assert.equal(byId.get("card-misunderstood")?.evidenceCoverage, 1);
    assert.equal(byId.get("card-due")?.state, "due_review");
    assert.equal(byId.get("card-due")?.hardEvidenceCount, 0);
    assert.equal(byId.get("card-due")?.softEvidenceCount, 1);
    assert.equal(byId.get("card-unseen")?.state, "unseen");
    assert.equal(byId.get("card-unseen")?.title, "（未命名学习目标）");
    assert.equal(byId.get("card-validated")?.state, "preliminary_understood");
    assert.equal(byId.get("card-reviewed")?.state, "reviewed");
    assert.equal(byId.get("card-seen")?.state, "seen");
    assert.equal(byId.get("card-unknown")?.state, "unseen");
  });

  it("filters by derived state without a user", async () => {
    installStateDb({
      cards: [
        stateCard("card-soft", "obj-soft", "Soft"),
        stateCard("card-unknown", "obj-unknown", "Unknown"),
      ],
      events: [{
        subjectId: "obj-soft",
        latestEventType: "seen",
        latestValidationEventType: null,
        lastValidatedAt: null,
        misunderstandingCount: 0,
      }],
      objectives: [
        { objectiveId: "obj-soft", currentObjectiveRevisionId: "rev-soft" },
        { objectiveId: "obj-unknown", currentObjectiveRevisionId: null },
      ],
      revisions: [
        { objectiveId: "obj-soft", conceptLabel: "Soft" },
      ],
    });

    assert.deepEqual(await getUnderstandingStates(WORKSPACE_ID, { state: "misunderstood" }, undefined, FAKE_TX), []);
    const seen = await getUnderstandingStates(WORKSPACE_ID, { state: "seen" }, undefined, FAKE_TX);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.subjectId, "card-soft");
  });
});
