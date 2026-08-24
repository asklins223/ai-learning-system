/**
 * 方案 20 — Card Generation V2 generation-run-service 单测。
 *
 * 覆盖：
 * - createGenerationRunV2 幂等 replay（同 idempotencyKey 返回已建 run）
 * - createGenerationRunV2 note_version_not_found
 * - createGenerationRunV2 happy path（seal → planning + outbox 入队；终态由 worker 推进）
 * - getGenerationRunV2 查询（存在 / 不存在）
 * - getGenerationRunCandidatesV2（最新 revision 去重）
 * - closeGenerationRunV2 状态守卫（非 review_ready → 409）
 * - cancelGenerationRunV2 可取消状态守卫
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationEventsV2,
  cardGenerationRunOutboxV2,
} from "../db/schema/card-generation-v2.ts";
import {
  createGenerationRunV2,
  getGenerationRunV2,
  getGenerationRunCandidatesV2,
  closeGenerationRunV2,
  cancelGenerationRunV2,
} from "../modules/card-generation-v2/generation-run-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const RUN_ID = "00000000-0000-4000-8000-000000000005";

let originalTransaction: typeof db.transaction;

beforeEach(() => {
  originalTransaction = db.transaction;
});

afterEach(() => {
  db.transaction = originalTransaction;
});

function makeBaseRequest() {
  return {
    version: 2 as const,
    noteVersionId: NOTE_VERSION_ID,
    sourceScope: { kind: "whole_note" as const },
    learningGoal: "understand" as const,
    detailThreshold: "balanced" as const,
    quantity: { kind: "adaptive" as const },
    clientRequestId: "test-request-001",
  };
}

function makeBaseNote() {
  return {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "Test Note",
    createdAt: new Date(),
    updatedAt: new Date(),
    trashed: false,
    createdBy: USER_ID,
  };
}

function makeBaseVersion() {
  return {
    id: NOTE_VERSION_ID,
    noteId: NOTE_ID,
    versionNo: 1,
    createdAt: new Date(),
    createdBy: USER_ID,
  };
}

function makeBaseRun(status = "review_ready") {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    noteId: NOTE_ID,
    noteVersionId: NOTE_VERSION_ID,
    idempotencyKey: "test-key-001",
    status,
    cardContentEpoch: 1,
    semanticSpecHash: "a".repeat(64),
    inputSnapshotHash: "b".repeat(64),
    generationFingerprint: "c".repeat(64),
    sourceSnapshotHash: "d".repeat(64),
    sourceContentHash: "e".repeat(64),
    blockManifestHash: "f".repeat(64),
    assetManifestHash: "0".repeat(64),
    scopeManifestHash: "1".repeat(64),
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    semanticSpec: {},
    inputSnapshot: { rawRequest: makeBaseRequest() },
    errorCode: null,
    errorMessage: null,
    supersedesRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setupTx(impl: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    ...impl,
  };
  db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;
  return tx;
}

describe("createGenerationRunV2", () => {
  it("returns existing run on idempotency replay", async () => {
    const existingRun = makeBaseRun("no_cards_recommended");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [existingRun],
          }),
        }),
      }),
    });

    const result = await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      NOTE_VERSION_ID,
      makeBaseRequest(),
      "test-key-001",
    );

    assert.equal(result.runId, RUN_ID);
    assert.equal(result.status, "no_cards_recommended");
  });

  it("rejects a modified payload for an existing idempotency key", async () => {
    const existingRun = makeBaseRun("planning");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [existingRun],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        NOTE_VERSION_ID,
        { ...makeBaseRequest(), learningGoal: "apply" },
        "test-key-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "idempotency_conflict");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("re-checks the idempotency key after the workspace lock", async () => {
    const existingRun = makeBaseRun("planning");
    let lookupCount = 0;
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              lookupCount += 1;
              return lookupCount === 1 ? [] : [existingRun];
            },
          }),
        }),
      }),
    });

    const result = await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      NOTE_VERSION_ID,
      makeBaseRequest(),
      "test-key-001",
    );

    assert.deepEqual(result, { runId: RUN_ID, status: "planning" });
    assert.equal(lookupCount, 2);
  });

  it("throws note_version_not_found when version does not exist", async () => {
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      query: {
        noteVersions: { findFirst: async () => undefined },
        notes: { findFirst: async () => makeBaseNote() },
        noteBlocks: { findMany: async () => [] },
      },
    });

    await assert.rejects(
      () => createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        NOTE_VERSION_ID,
        makeBaseRequest(),
        "test-key-new-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "note_version_not_found");
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it("creates run, seals source, enqueues outbox job and returns planning", async () => {
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
    const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return {
              where: () => ({
                limit: async () => [], // no existing
              }),
            };
          }
          if (table === cardGenerationEventsV2) {
            // insertEvent: tx.select({maxSeq}).from(events).where(...) → returns array
            return {
              where: async () => [{ maxSeq: 0 }],
            };
          }
          return {
            where: () => ({
              limit: async () => [],
            }),
          };
        },
      }),
      query: {
        noteVersions: { findFirst: async () => makeBaseVersion() },
        notes: { findFirst: async () => makeBaseNote() },
        noteBlocks: { findMany: async () => [] },
      },
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertCalls.push({ table, values: vals });
          return { onConflictDoNothing: () => {} };
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updateCalls.push({ table, set });
          return {
            where: () => {},
          };
        },
      }),
    });

    const result = await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      NOTE_VERSION_ID,
      makeBaseRequest(),
      "test-key-create-001",
    );

    // §17.2：创建端点推进到 planning，终态（no_cards_recommended/review_ready 等）
    // 由 worker 消费 outbox 后写入——不在创建事务内同步完成。
    assert.equal(result.status, "planning");

    // 插入：1 条 run（queued）+ 1 条 outbox job（pending）
    const runInsert = insertCalls.find((i) =>
      i.table === cardGenerationRunsV2 && i.values.noteVersionId === NOTE_VERSION_ID,
    );
    assert.ok(runInsert, "should have inserted the run row");
    assert.equal(runInsert!.values.status, "queued");

    const outboxInsert = insertCalls.find((i) => i.table === cardGenerationRunOutboxV2);
    assert.ok(outboxInsert, "should have enqueued a worker outbox job");
    assert.equal(outboxInsert!.values.jobType, "card_generation_plan");
    assert.equal(outboxInsert!.values.status, "pending");

    // 状态迁移：queued → source_sealing → planning（§17.2 状态机）
    const statusUpdates = updateCalls
      .map((u) => u.set.status)
      .filter((s) => s !== undefined);
    assert.deepEqual(statusUpdates, ["source_sealing", "planning"]);
  });
});

describe("getGenerationRunV2", () => {
  it("returns null when run does not exist", async () => {
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });

    const result = await getGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.equal(result, null);
  });

  it("returns serialized run when it exists", async () => {
    const run = makeBaseRun("review_ready");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
    });

    const result = await getGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    assert.equal(result!.runId, RUN_ID);
    assert.equal(result!.status, "review_ready");
  });
});

describe("getGenerationRunCandidatesV2", () => {
  it("returns null when run does not exist", async () => {
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.equal(result, null);
  });

  it("deduplicates to latest revision per candidateId", async () => {
    const candidates = [
      { ...makeBaseCandidateRow(), candidateId: "c1", revision: 2 },
      { ...makeBaseCandidateRow(), candidateId: "c1", revision: 1 },
      { ...makeBaseCandidateRow(), candidateId: "c2", revision: 3 },
      { ...makeBaseCandidateRow(), candidateId: "c2", revision: 2 },
    ];

    let selectCount = 0;
    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return {
              where: () => ({
                limit: async () => [{ id: RUN_ID }],
              }),
            };
          }
          // candidates query
          selectCount++;
          return {
            where: () => ({
              orderBy: () => candidates, // return all, ordered by revision desc
            }),
          };
        },
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    // Should only have the latest revision per candidateId
    assert.equal(result!.length, 2);
    assert.equal(result![0].candidateId, "c1"); // revision 2 first (ordered by desc)
    assert.equal(result![0].revision, 2);
    assert.equal(result![1].candidateId, "c2");
    assert.equal(result![1].revision, 3);
  });
});

describe("closeGenerationRunV2", () => {
  it("throws invalid_state when run is not review_ready", async () => {
    const run = makeBaseRun("queued");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {},
        }),
      }),
    });

    await assert.rejects(
      () => closeGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
        1,
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_state");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("throws stale_review_draft when revision mismatch", async () => {
    const run = makeBaseRun("review_ready");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => closeGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
        99, // wrong revision
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_review_draft");
        return true;
      },
    );
  });

  it("closes run and marks undecided candidates as rejected", async () => {
    const run = makeBaseRun("review_ready");
    const updates: Record<string, unknown>[] = [];
    let selectCallCount = 0;
    setupTx({
      select: (_columns?: unknown) => ({
        from: (_table: unknown) => {
          selectCallCount++;
          // First select: run lookup (no columns arg)
          if (selectCallCount === 1) {
            return {
              where: () => ({
                limit: async () => [run],
              }),
            };
          }
          // insertEvent: select({maxSeq}).from(events).where() → returns array
          return {
            where: async () => [{ maxSeq: 0 }],
          };
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updates.push({ table, ...set });
          return {
            where: () => ({
              returning: async () => [{ id: RUN_ID, reviewDraftRevision: 2 }],
            }),
          };
        },
      }),
      insert: () => ({
        values: () => {},
      }),
    });

    const result = await closeGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      1,
    );
    assert.ok(result);
    assert.equal(result!.status, "closed_without_activation");
    // At least 2 updates: candidates → reject, run → closed
    assert.ok(updates.length >= 2);
  });
});

describe("cancelGenerationRunV2", () => {
  it("throws invalid_state when run is in non-cancellable state", async () => {
    const run = makeBaseRun("activated");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => cancelGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_state");
        return true;
      },
    );
  });

  it("cancels a queued run", async () => {
    const run = makeBaseRun("queued");
    const updates: Record<string, unknown>[] = [];
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updates.push({ table, ...set });
          return {
            where: () => ({
              returning: async () => [{ id: RUN_ID }],
            }),
          };
        },
      }),
    });

    const result = await cancelGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    assert.equal(result!.status, "cancelled");
  });

  it("P12: throws stale_run_status when CAS update fails (concurrent status change)", async () => {
    const run = makeBaseRun("queued");
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [run],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            // P12: CAS update returns empty → concurrent modification detected
            returning: async () => [],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => cancelGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_run_status");
        return true;
      },
    );
  });

  it("returns null when run does not exist", async () => {
    setupTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });

    const result = await cancelGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.equal(result, null);
  });
});

// ─── helper ──────────────────────────────────────────────────────────────

function makeBaseCandidateRow() {
  return {
    id: "row-id",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    candidateId: "cand-id",
    candidateRevisionId: "crev-id",
    revision: 1,
    planRevisionId: "plan-rev-id",
    planVersion: 1,
    planHash: "f".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFrom: [],
    objectiveDraft: {
      objectiveStatement: "Test",
      publicSummary: "Summary",
      knowledgeForm: "fact",
      canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "answer" } },
      learningSupport: { explanation: "explanation" },
      rubric: { units: [], passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false }, rubricHash: "r".repeat(64) },
      difficulty: "introductory",
      evidenceRefIds: [],
    },
    presentationDraft: {
      strategy: "recall",
      front: { cue: "Cue", prompt: "Prompt" },
      estimatedReviewSeconds: 30,
    },
    evidenceSetHash: "d".repeat(64),
    candidateRevisionHash: "e".repeat(64),
    qualityState: "passed",
    reviewDecision: "undecided",
    publishState: "unpublished",
    reviewReasonCode: null,
    reviewNote: null,
    qualityReportHashes: [],
    evidenceBindingPlanHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
