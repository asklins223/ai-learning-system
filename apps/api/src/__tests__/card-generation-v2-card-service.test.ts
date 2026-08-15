/**
 * 方案 20 — Card 级服务单测（card-service.ts，§17.3/§17.6）。
 *
 * 覆盖：
 * - revealCardV2：exposure-first（先写 learning_exposures_v2 再返回答案）、
 *   409 stale_presentation、reminder 延后 upsert
 * - archiveCardV2：lifecycle CAS、pending schedule 关闭、reminder 取消、
 *   409 stale_lifecycle_epoch
 * - updateCardPresentationV2：presentation-only、leakage gate 拒绝泄题 front
 * - listReadyRemindersV2 / cancelReminderV2
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import {
  revealCardV2,
  archiveCardV2,
  updateCardPresentationV2,
  listReadyRemindersV2,
  cancelReminderV2,
} from "../modules/card-generation-v2/card-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";
const OBJECTIVE_REVISION_ID = "00000000-0000-4000-8000-000000000005";
const HASH = "a".repeat(64);

let originalTransaction: typeof db.transaction;

beforeEach(() => {
  originalTransaction = db.transaction;
});

afterEach(() => {
  db.transaction = originalTransaction;
});

function makeWhereResult(rows: unknown[]) {
  const result: Record<string, unknown> = {
    limit: async () => rows,
    orderBy: () => result,
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
  };
  return result;
}

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-row",
    workspaceId: WORKSPACE_ID,
    cardId: CARD_ID,
    objectiveId: OBJECTIVE_ID,
    cardRevision: 1,
    currentPublicationRevision: 1,
    lifecycle: "active",
    front: { cue: "Cue", prompt: "Prompt" },
    publicSummary: "Summary",
    knowledgeForm: "fact",
    strategy: "recall",
    sourceLabel: null,
    presentationHash: HASH,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePublication(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-row",
    workspaceId: WORKSPACE_ID,
    cardId: CARD_ID,
    publicationRevision: 1,
    cardRevision: 1,
    objectiveId: OBJECTIVE_ID,
    objectiveRevision: 1,
    lifecycleAtPublication: "active",
    publicPayloadHash: HASH,
    revealPayloadHash: HASH,
    activatedAt: new Date(),
    ...overrides,
  };
}

function makeRevision(overrides: Record<string, unknown> = {}) {
  return {
    objectiveRevisionId: OBJECTIVE_REVISION_ID,
    objectiveId: OBJECTIVE_ID,
    workspaceId: WORKSPACE_ID,
    revision: 1,
    objectiveStatement: "Objective",
    publicSummary: "Summary",
    knowledgeForm: "fact",
    preferredIntents: ["recall"],
    canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "The correct answer to this question is definitely X" } },
    learningSupport: { explanation: "Explanation" },
    scoringRubric: { units: [], passingPolicy: {}, rubricHash: HASH },
    relations: [],
    evidenceBindings: [],
    semanticTargetFingerprint: HASH,
    targetRevisionHash: HASH,
    privatePayloadHash: HASH,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeObjective(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    workspaceId: WORKSPACE_ID,
    semanticIdentityClassId: "sem-id-1",
    semanticIdentityPolicyVersion: "sem-id-v1",
    semanticTargetFingerprint: HASH,
    lifecycle: "active",
    lifecycleEpoch: 1,
    currentObjectiveRevisionId: OBJECTIVE_REVISION_ID,
    currentRevision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * 表感知 mock：按 drizzle 表名分发（card-service 查询面：cards / publications /
 * revisions / objectives / exposures / reminders / schedules / events / outbox）。
 */
function setupCardTx(options: {
  card?: Record<string, unknown>;
  publication?: Record<string, unknown>;
  revision?: Record<string, unknown>;
  objective?: Record<string, unknown>;
  existingExposure?: Record<string, unknown> | null;
  existingReminder?: Record<string, unknown> | null;
  existingSchedule?: Record<string, unknown> | null;
} = {}) {
  const card = makeCard(options.card);
  const publication = makePublication(options.publication);
  const revision = makeRevision(options.revision);
  const objective = makeObjective(options.objective);
  const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
  const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

  const tableRows = (tableName: string | undefined): unknown[] => {
    switch (tableName) {
      case "learning_cards_v2": return [card];
      case "learning_card_publication_revisions_v2": return [publication];
      case "learning_objective_revisions_v2": return [revision];
      case "learning_objectives_v2": return [objective];
      case "learning_exposures_v2": return options.existingExposure ? [options.existingExposure] : [];
      case "initial_validation_reminders_v2": return options.existingReminder ? [options.existingReminder] : [];
      case "review_schedules": return options.existingSchedule ? [options.existingSchedule] : [];
      default: return [];
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
        if (columns !== undefined && tName === "card_generation_events_v2") {
          return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
        }
        return { where: () => makeWhereResult(tableRows(tName)) };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return {
          where: () => ({ returning: async () => [{ id: "mock-id" }] }),
        };
      },
    }),
  };
  db.transaction = (async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;
  return { tx, insertCalls, updateCalls };
}

describe("revealCardV2", () => {
  it("writes exposure BEFORE returning answer (exposure-first) and defers reminder", async () => {
    const { insertCalls } = setupCardTx();

    const reveal = await revealCardV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { cardId: CARD_ID, expectedPublicationRevision: 1, expectedPublicPayloadHash: HASH },
      "reveal-key-001",
    );

    assert.equal(reveal.cardId, CARD_ID);
    assert.equal(reveal.objectiveId, OBJECTIVE_ID);
    assert.ok(reveal.exposureId.length > 0);
    assert.equal(reveal.revealPayloadHash, HASH);

    // Exposure-first：learning_exposures_v2 行必须存在
    const exposureInsert = insertCalls.find((i) =>
      i.values.exposureKind === "answer_reveal" && i.values.idempotencyKey === "reveal-key-001",
    );
    assert.ok(exposureInsert, "should have persisted exposure before returning answer");

    // Reminder 延后创建（pending + 24h cooldown）
    const reminderInsert = insertCalls.find((i) => i.values.status === "pending");
    assert.ok(reminderInsert, "should have created deferred reminder");
    const qnb = new Date(reminderInsert!.values.qualificationNotBefore as string);
    assert.ok(qnb.getTime() > Date.now(), "reminder should be deferred by cooldown");
  });

  it("returns same exposure on idempotent replay", async () => {
    const { insertCalls } = setupCardTx({
      existingExposure: {
        exposureId: "00000000-0000-4000-8000-000000000010",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        objectiveId: OBJECTIVE_ID,
        objectiveRevision: 1,
        cardId: CARD_ID,
        cardRevision: 1,
        exposureKind: "answer_reveal",
        contextHash: HASH,
        idempotencyKey: "reveal-key-001",
        exposedAt: new Date(),
      },
    });

    const reveal = await revealCardV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { cardId: CARD_ID, expectedPublicationRevision: 1, expectedPublicPayloadHash: HASH },
      "reveal-key-001",
    );

    assert.equal(reveal.exposureId, "00000000-0000-4000-8000-000000000010");
    assert.equal(insertCalls.length, 0, "replay must not write new rows");
  });

  it("throws stale_presentation when publication revision or public payload hash mismatch", async () => {
    setupCardTx();
    await assert.rejects(
      () => revealCardV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        { cardId: CARD_ID, expectedPublicationRevision: 99, expectedPublicPayloadHash: HASH },
        "reveal-key-002",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_presentation");
        return true;
      },
    );
  });
});

describe("archiveCardV2", () => {
  it("archives objective+card, bumps lifecycle epoch, closes schedules and cancels reminders", async () => {
    const { updateCalls } = setupCardTx({});

    const result = await archiveCardV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        cardId: CARD_ID,
        expectedPublicationRevision: 1,
        expectedPublicPayloadHash: HASH,
        expectedObjectiveLifecycleEpoch: 1,
      },
      "archive-key-001",
    );

    assert.equal(result.resultingLifecycle, "archived");
    assert.equal(result.resultingLifecycleEpoch, 2);
    assert.equal(result.publicationRevision, 2);

    // Objective lifecycle CAS update
    const objUpdate = updateCalls.find((u) => u.set.lifecycle === "archived" && u.set.lifecycleEpoch === 2);
    assert.ok(objUpdate, "should have archived objective with bumped epoch");
    // Schedule close（lifecycle reason）
    const scheduleUpdate = updateCalls.find((u) => u.set.reasonCode === "lifecycle_archived");
    assert.ok(scheduleUpdate, "should have closed pending schedules with lifecycle reason");
    // Reminder cancel
    const reminderUpdate = updateCalls.find((u) => u.set.status === "cancelled");
    assert.ok(reminderUpdate, "should have cancelled reminders");
  });

  it("throws stale_lifecycle_epoch when epoch mismatch", async () => {
    setupCardTx();
    await assert.rejects(
      () => archiveCardV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        {
          cardId: CARD_ID,
          expectedPublicationRevision: 1,
          expectedPublicPayloadHash: HASH,
          expectedObjectiveLifecycleEpoch: 99,
        },
        "archive-key-002",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_lifecycle_epoch");
        return true;
      },
    );
  });
});

describe("updateCardPresentationV2", () => {
  it("creates new card + publication revision for presentation-only patch", async () => {
    const { insertCalls } = setupCardTx();

    const result = await updateCardPresentationV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      CARD_ID,
      1,
      HASH,
      { front: { cue: "New cue", prompt: "New prompt" } },
    );

    assert.equal(result.cardRevision, 2);
    assert.equal(result.publicationRevision, 2);
    const pubInsert = insertCalls.find((i) => i.values.publicationRevision === 2);
    assert.ok(pubInsert, "should have inserted new publication revision");
  });

  it("rejects front that leaks answer content", async () => {
    setupCardTx();
    await assert.rejects(
      () => updateCardPresentationV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        CARD_ID,
        1,
        HASH,
        // canonicalAnswer = "The answer is X" → prompt 包含其前 50 字符
        { front: { cue: "Cue", prompt: "The correct answer to this question is definitely X — please explain" } },
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "front_leaks_answer");
        return true;
      },
    );
  });
});

describe("reminders", () => {
  it("lists ready reminders for current user", async () => {
    setupCardTx();
    const result = await listReadyRemindersV2({ workspaceId: WORKSPACE_ID, userId: USER_ID });
    assert.ok(Array.isArray(result));
  });

  it("cancels a pending reminder idempotently", async () => {
    setupCardTx({
      existingReminder: {
        reminderId: "00000000-0000-4000-8000-000000000020",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        objectiveId: OBJECTIVE_ID,
        status: "pending",
      },
    });
    const result = await cancelReminderV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      "00000000-0000-4000-8000-000000000020",
    );
    assert.equal(result.status, "cancelled");
  });
});
