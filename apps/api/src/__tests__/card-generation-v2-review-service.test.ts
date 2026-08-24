/**
 * 方案 20 — Card Generation V2 candidate-review-service 单测。
 *
 * 覆盖：
 * - handleCandidateActionV2 keep（happy path → reviewDecision = keep）
 * - handleCandidateActionV2 reject（with reasonCode + note）
 * - handleCandidateActionV2 edit（creates new revision, exposure if touches answer）
 * - handleCandidateActionV2 undo_decision
 * - 状态守卫：run 不在 review_ready → invalid_state
 * - CAS 守卫：stale_epoch / stale_plan / stale_plan_hash / stale_review_draft
 * - 候选守卫：qualityState !== passed → invalid_quality_state
 * - 候选守卫：reviewDecision !== undecided → already_reviewed
 * - edit 触及答案字段时写 answer_editor_view Exposure
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import { handleCandidateActionV2 } from "../modules/card-generation-v2/candidate-review-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";
import {
  cardGenerationRunsV2,
  cardGenerationPlansV2,
  cardGenerationCandidatesV2,
} from "../db/schema/card-generation-v2.ts";
import type { CandidateActionCommandV2, CandidateActionV2 } from "@ailearn/shared/card-generation-v2-contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000004";
const PLAN_REVISION_ID = "00000000-0000-4000-8000-000000000005";
const CANDIDATE_REVISION_HASH = "a".repeat(64);
const PLAN_HASH = "b".repeat(64);

let originalTransaction: typeof db.transaction;

beforeEach(() => {
  originalTransaction = db.transaction;
});

afterEach(() => {
  db.transaction = originalTransaction;
});

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    noteId: "note-1",
    noteVersionId: "ver-1",
    idempotencyKey: "run-key",
    status: "review_ready",
    cardContentEpoch: 1,
    semanticSpecHash: "c".repeat(64),
    inputSnapshotHash: "d".repeat(64),
    generationFingerprint: "e".repeat(64),
    sourceSnapshotHash: "f".repeat(64),
    sourceContentHash: "0".repeat(64),
    blockManifestHash: "1".repeat(64),
    assetManifestHash: "2".repeat(64),
    scopeManifestHash: "3".repeat(64),
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    semanticSpec: {},
    inputSnapshot: {},
    errorCode: null,
    errorMessage: null,
    supersedesRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-row",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    planRevisionId: PLAN_REVISION_ID,
    planVersion: 1,
    previousPlanRevisionId: null,
    inputSnapshotHash: "d".repeat(64),
    cardContentEpoch: 1,
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] },
    atomDecisions: [],
    planHash: PLAN_HASH,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand-row",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    candidateRevisionId: "crev-1",
    revision: 1,
    planRevisionId: PLAN_REVISION_ID,
    planVersion: 1,
    planHash: PLAN_HASH,
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFrom: [],
    objectiveDraft: {
      objectiveStatement: "Test objective",
      publicSummary: "Summary",
      knowledgeForm: "fact",
      canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "answer text" } },
      learningSupport: { explanation: "explanation text" },
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
    candidateRevisionHash: CANDIDATE_REVISION_HASH,
    qualityState: "passed",
    reviewDecision: "undecided",
    publishState: "unpublished",
    reviewReasonCode: null,
    reviewNote: null,
    qualityReportHashes: [],
    evidenceBindingPlanHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCommand(action: CandidateActionV2): CandidateActionCommandV2 {
  return {
    version: 2,
    runId: RUN_ID,
    expectedCardContentEpoch: 1,
    expectedPlanVersion: 1,
    expectedPlanHash: PLAN_HASH,
    expectedReviewDraftRevision: 1,
    action,
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

/**
 * Builds a where() return value that is both thenable (await resolves to rows array)
 * and has a .limit() method (for chainable callers).
 * This handles both `await tx.select().from().where()` (insertEvent) and
 * `tx.select().from().where().limit(1)` (loadRun, loadPlan, getCandidate).
 */
function makeWhereResult(rows: unknown[]) {
  const result: any = {
    limit: async () => rows,
    orderBy: () => rows,
    then(resolve: any, _reject: any) {
      return Promise.resolve(rows).then(resolve);
    },
  };
  return result;
}

/**
 * 表感知 mock：按 `from(table)` 分发，不依赖 select 调用顺序。
 *
 * 服务端当前查询流（candidate-review-service.ts）：
 *   loadRunForReview → select(cardGenerationRunsV2).where().limit(1)
 *   loadPlan         → select(cardGenerationPlansV2).where().limit(1)
 *   getCandidateForAction → select(cardGenerationCandidatesV2).where().limit(1)
 *   insertEvent      → select({maxSeq}).from(cardGenerationEventsV2).where()
 *   update ... .returning()（reviewDraftRevision CAS）
 */
function setupStandardTx(options: {
  run?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  /** merge 场景：按 getCandidateForAction 调用顺序返回的候选列表 */
  candidates?: Array<Record<string, unknown>>;
} = {}) {
  const run = makeRun(options.run);
  const plan = makePlan(options.plan);
  const candidates = options.candidates ?? [makeCandidate(options.candidate)];
  let candidateIdx = 0;
  const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
  const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

  const tx = setupTx({
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        if (table === cardGenerationRunsV2) {
          return { where: () => makeWhereResult([run]) };
        }
        if (table === cardGenerationPlansV2) {
          return { where: () => makeWhereResult([plan]) };
        }
        if (table === cardGenerationCandidatesV2) {
          const row = candidates[candidateIdx % candidates.length];
          candidateIdx++;
          return { where: () => makeWhereResult([row]) };
        }
        // insertEvent: tx.select({maxSeq}).from(events).where(...) → array
        if (columns !== undefined) {
          return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
        }
        return { where: () => makeWhereResult([]) };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });
        const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        // handleCandidateActionV2 对 reviewDraftRevision 的 CAS update 使用
        // .returning({ id }) 判断受影响行数。
        return {
          where: () => ({ returning: async () => [{ id: "run-row" }] }),
        };
      },
    }),
  });

  return { tx, insertCalls, updateCalls };
}

describe("handleCandidateActionV2 — keep", () => {
  it("marks candidate as kept and bumps reviewDraftRevision", async () => {
    const { updateCalls } = setupStandardTx();

    const result = await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "keep",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
      }),
      "keep-key-001",
    );

    assert.equal(result.actionType, "keep");
    // Should have at least 2 updates: candidate → keep, run → reviewDraftRevision bump
    const candidateUpdate = updateCalls.find((u) => u.set.reviewDecision === "keep");
    assert.ok(candidateUpdate, "should have updated candidate reviewDecision to keep");
    const runUpdate = updateCalls.find((u) => u.set.reviewDraftRevision === 2);
    assert.ok(runUpdate, "should have bumped reviewDraftRevision to 2");
  });
});

describe("handleCandidateActionV2 — reject", () => {
  it("marks candidate as rejected with reasonCode and note", async () => {
    const { updateCalls } = setupStandardTx();

    const result = await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "reject",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
        reasonCode: "not_useful",
        note: "Not relevant",
      }),
      "reject-key-001",
    );

    assert.equal(result.actionType, "reject");
    const update = updateCalls.find((u) => u.set.reviewDecision === "reject");
    assert.ok(update);
    assert.equal(update!.set.reviewReasonCode, "not_useful");
    assert.equal(update!.set.reviewNote, "Not relevant");
  });
});

describe("handleCandidateActionV2 — undo_decision", () => {
  it("resets keep → undecided", async () => {
    const { updateCalls } = setupStandardTx({
      candidate: { reviewDecision: "keep" },
    });

    const result = await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "undo_decision",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
      }),
      "undo-key-001",
    );

    assert.equal(result.actionType, "undo_decision");
    const update = updateCalls.find((u) => u.set.reviewDecision === "undecided");
    assert.ok(update);
    assert.equal(update!.set.reviewReasonCode, null);
    assert.equal(update!.set.reviewNote, null);
  });

  it("throws invalid_state when candidate reviewDecision is undecided", async () => {
    setupStandardTx({
      candidate: { reviewDecision: "undecided" },
    });

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "undo_decision",
          candidateId: CANDIDATE_ID,
          expectedRevision: 1,
          expectedRevisionHash: CANDIDATE_REVISION_HASH,
        }),
        "undo-invalid-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_state");
        return true;
      },
    );
  });
});

describe("handleCandidateActionV2 — edit", () => {
  it("creates new candidate revision and writes answer_editor_view exposure when touching answer", async () => {
    const { insertCalls } = setupStandardTx();

    const result = await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "edit",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
        patch: {
          canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "edited answer" } },
        },
      }),
      "edit-key-001",
    );

    assert.equal(result.actionType, "edit");
    // Should have inserted: exposure + new candidate revision
    const exposureInsert = insertCalls.find((i) =>
      i.values.exposureKind === "answer_editor_view",
    );
    assert.ok(exposureInsert, "should have written answer_editor_view exposure");
    const candidateInsert = insertCalls.find((i) =>
      i.values.candidateRevisionId !== undefined && i.values.candidateRevisionId !== "crev-1",
    );
    assert.ok(candidateInsert, "should have inserted new candidate revision");
    assert.equal(candidateInsert!.values.revision, 2);
  });

  it("does not write exposure when edit does not touch answer fields", async () => {
    const { insertCalls } = setupStandardTx();

    await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "edit",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
        patch: {
          objectiveStatement: "Updated statement only",
        },
      }),
      "edit-no-answer-001",
    );

    // Only count answer_editor_view exposures that have subjectCandidateId
    // (persistIdempotency also writes answer_editor_view but without subjectCandidateId)
    const exposureInsert = insertCalls.find((i) =>
      i.values.exposureKind === "answer_editor_view" &&
      i.values.subjectCandidateId !== undefined,
    );
    assert.ok(!exposureInsert, "should NOT have written answer_editor_view exposure with subjectCandidateId");
  });

  it("preserves front.cue when edit patch only updates prompt (deep merge)", async () => {
    const { insertCalls } = setupStandardTx();

    await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "edit",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
        patch: {
          front: { prompt: "Edited prompt" },
        },
      }),
      "edit-merge-001",
    );

    const candidateInsert = insertCalls.find((i) =>
      i.values.candidateRevisionId !== undefined && i.values.candidateRevisionId !== "crev-1",
    );
    assert.ok(candidateInsert, "should have inserted new candidate revision");
    const presentation = candidateInsert!.values.presentationDraft as {
      front?: { cue?: string; prompt?: string };
    };
    assert.equal(
      presentation?.front?.cue,
      "Cue",
      "cue must survive the edit patch (regression: shallow merge wiped cue → recheck empty cue → candidate failed)",
    );
    assert.equal(presentation?.front?.prompt, "Edited prompt");
  });

  it("stores edited learning support under the nested objective path and preserves siblings", async () => {
    const { insertCalls } = setupStandardTx({
      candidate: {
        objectiveDraft: {
          ...makeCandidate().objectiveDraft,
          learningSupport: {
            explanation: "Original explanation",
            boundary: "Original boundary",
            misconception: "Original misconception",
            workedExample: "Original example",
          },
        },
      },
    });

    await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "edit",
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        expectedRevisionHash: CANDIDATE_REVISION_HASH,
        patch: {
          explanation: "Edited explanation",
        },
      }),
      "edit-learning-support-001",
    );

    const candidateInsert = insertCalls.find((i) =>
      i.values.candidateRevisionId !== undefined && i.values.candidateRevisionId !== "crev-1",
    );
    assert.ok(candidateInsert, "should have inserted new candidate revision");
    const objective = candidateInsert!.values.objectiveDraft as {
      explanation?: string;
      learningSupport?: Record<string, unknown>;
    };
    assert.equal(objective.explanation, undefined, "support content must not be written at the draft root");
    assert.deepEqual(objective.learningSupport, {
      explanation: "Edited explanation",
      boundary: "Original boundary",
      misconception: "Original misconception",
      workedExample: "Original example",
    });
  });

  it("applies the same nested learning support patch to merged candidates", async () => {
    const source = makeCandidate({
      objectiveDraft: {
        ...makeCandidate().objectiveDraft,
        learningSupport: {
          explanation: "Original explanation",
          boundary: "Original boundary",
        },
      },
    });
    const { insertCalls } = setupStandardTx({ candidates: [source] });

    await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "merge",
        candidateIds: [CANDIDATE_ID],
        expectedRevisions: [
          { candidateId: CANDIDATE_ID, revision: 1, hash: CANDIDATE_REVISION_HASH },
        ],
        mergedDraft: {
          explanation: "Merged explanation",
        },
      }),
      "merge-learning-support-001",
    );

    const mergedInsert = insertCalls.find((i) =>
      i.values.candidateRevisionId !== undefined && i.values.candidateRevisionId !== "crev-1",
    );
    assert.ok(mergedInsert, "should have inserted merged candidate revision");
    const objective = mergedInsert!.values.objectiveDraft as {
      explanation?: string;
      learningSupport?: Record<string, unknown>;
    };
    assert.equal(objective.explanation, undefined, "merged support content must not be written at the draft root");
    assert.deepEqual(objective.learningSupport, {
      explanation: "Merged explanation",
      boundary: "Original boundary",
    });
  });
});

describe("handleCandidateActionV2 — guards", () => {
  it("throws invalid_state when run is not review_ready", async () => {
    setupStandardTx({ run: { status: "queued" } });

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "keep",
          candidateId: CANDIDATE_ID,
          expectedRevision: 1,
          expectedRevisionHash: CANDIDATE_REVISION_HASH,
        }),
        "guard-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_state");
        return true;
      },
    );
  });

  it("throws stale_epoch when cardContentEpoch mismatch", async () => {
    setupStandardTx({});

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        {
          ...makeCommand({
            type: "keep",
            candidateId: CANDIDATE_ID,
            expectedRevision: 1,
            expectedRevisionHash: CANDIDATE_REVISION_HASH,
          }),
          expectedCardContentEpoch: 99, // wrong epoch
        },
        "guard-epoch-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_epoch");
        return true;
      },
    );
  });

  it("throws stale_review_draft when reviewDraftRevision mismatch", async () => {
    setupStandardTx({});

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        {
          ...makeCommand({
            type: "keep",
            candidateId: CANDIDATE_ID,
            expectedRevision: 1,
            expectedRevisionHash: CANDIDATE_REVISION_HASH,
          }),
          expectedReviewDraftRevision: 99,
        },
        "guard-draft-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_review_draft");
        return true;
      },
    );
  });

  it("throws invalid_quality_state when candidate qualityState is not passed", async () => {
    setupStandardTx({ candidate: { qualityState: "authored" } });

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "keep",
          candidateId: CANDIDATE_ID,
          expectedRevision: 1,
          expectedRevisionHash: CANDIDATE_REVISION_HASH,
        }),
        "guard-quality-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_quality_state");
        return true;
      },
    );
  });

  it("throws already_reviewed when reviewDecision is not undecided", async () => {
    setupStandardTx({ candidate: { reviewDecision: "keep" } });

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "keep",
          candidateId: CANDIDATE_ID,
          expectedRevision: 1,
          expectedRevisionHash: CANDIDATE_REVISION_HASH,
        }),
        "guard-reviewed-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "already_reviewed");
        return true;
      },
    );
  });

  it("throws already_published when publishState is not unpublished", async () => {
    setupStandardTx({ candidate: { publishState: "activated" } });

    await assert.rejects(
      () => handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "keep",
          candidateId: CANDIDATE_ID,
          expectedRevision: 1,
          expectedRevisionHash: CANDIDATE_REVISION_HASH,
        }),
        "guard-published-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "already_published");
        return true;
      },
    );
  });
});

describe("handleCandidateActionV2 — merge", () => {
  it("creates merged candidate and marks source candidates as merged", async () => {
    const CANDIDATE_ID_2 = "00000000-0000-4000-8000-000000000005";
    const candidate1 = makeCandidate({});
    const candidate2 = makeCandidate({
      candidateId: CANDIDATE_ID_2,
      candidateRevisionId: "crev-2",
    });
    const { insertCalls, updateCalls } = setupStandardTx({
      candidates: [candidate1, candidate2],
    });

    const result = await handleCandidateActionV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeCommand({
        type: "merge",
        candidateIds: [CANDIDATE_ID, CANDIDATE_ID_2],
        expectedRevisions: [
          { candidateId: CANDIDATE_ID, revision: 1, hash: CANDIDATE_REVISION_HASH },
          { candidateId: CANDIDATE_ID_2, revision: 1, hash: CANDIDATE_REVISION_HASH },
        ],
        mergedDraft: {
          objectiveStatement: "Merged objective",
          canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "merged answer" } },
          explanation: "Merged explanation",
          front: { cue: "Merged cue", prompt: "Merged prompt" },
          strategy: "recall",
        },
      }),
      "merge-key-001",
    );

    assert.equal(result.actionType, "merge");

    // Should have inserted a new merged candidate
    const mergedInsert = insertCalls.find((i) =>
      i.values.candidateRevisionId !== undefined &&
      i.values.revision === 1 &&
      i.values.qualityState === "authored",
    );
    assert.ok(mergedInsert, "should have inserted merged candidate with qualityState=authored");
    assert.equal(mergedInsert!.values.reviewDecision, "undecided");

    // Should have marked both source candidates as merged
    const mergedUpdates = updateCalls.filter((u) => u.set.reviewDecision === "merged");
    assert.equal(mergedUpdates.length, 2, "should have marked both source candidates as merged");
  });

  // R#6-9：0163 部分唯一（仅 plan/post_activation 单例）下，同 run 对「不同候选」两次
  // recheck 派发都应成功入队（insertCalls 各含一条 recheck 行），不会被 DB 唯一的
  // 全类型 (run_id, job_type) 约束吞掉——行为回归护栏（防未来 schema 漂移反向重建全唯一）。
  it("dispatches both recheck jobs for two merges on the same run (different candidates) — 0163 部分唯一下均入队", async () => {
    async function runMerge(candId: string, revId: string) {
      const candidate = makeCandidate({ candidateId: candId, candidateRevisionId: revId });
      const { insertCalls } = setupStandardTx({ candidates: [candidate] });
      await handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeCommand({
          type: "merge",
          candidateIds: [candId],
          expectedRevisions: [
            { candidateId: candId, revision: 1, hash: CANDIDATE_REVISION_HASH },
          ],
          mergedDraft: {
            objectiveStatement: "Merged objective",
            canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "merged answer" } },
            explanation: "Merged explanation",
            front: { cue: "Merged cue", prompt: "Merged prompt" },
            strategy: "recall",
          },
        }),
        `merge-key-${candId}`,
      );
      const recheck = insertCalls.filter((i) =>
        i.values.jobType === "card_generation_recheck_candidate",
      );
      assert.equal(recheck.length, 1, `merge(${candId}) 应派发一条 recheck job`);
      return recheck;
    }

    // 同一 run（RUN_ID），两个不同候选各触发一次 merge → 两条独立 recheck 行。
    const first = await runMerge("00000000-0000-4000-8000-00000000000a", "crev-a");
    const second = await runMerge("00000000-0000-4000-8000-00000000000b", "crev-b");
    assert.equal(first[0].values.runId, RUN_ID);
    assert.equal(second[0].values.runId, RUN_ID);
    // 不同候选 → 两条 recheck 载荷不同（candidateId 藏于 payload），均成功入队。
    const firstCandidate = (first[0].values.payload as { candidateId?: unknown }).candidateId;
    const secondCandidate = (second[0].values.payload as { candidateId?: unknown }).candidateId;
    assert.notEqual(firstCandidate, secondCandidate, "两次 recheck 应针对不同候选");
  });
});

describe("answer leakage prevention", () => {
  it("serializeCandidatePublic does not expose canonicalAnswer, explanation, or rubric", () => {
    // Source-level assertion: the helpers file must not include these fields
    // in the serializeCandidatePublic function body
    const helpersSource = readFileSync(
      resolve(import.meta.dirname, "../modules/card-generation-v2/helpers.ts"),
      "utf8",
    );

    // Find the serializeCandidatePublic function body
    const fnStart = helpersSource.indexOf("function serializeCandidatePublic");
    assert.ok(fnStart >= 0, "serializeCandidatePublic should exist");

    const fnEnd = helpersSource.indexOf("\n}", fnStart);
    assert.ok(fnEnd > fnStart, "function should have a closing brace");

    const fnBody = helpersSource.slice(fnStart, fnEnd);

    // These answer-related fields must NOT appear in the serialized output
    assert.ok(!fnBody.includes("canonicalAnswer"), "serializeCandidatePublic must not expose canonicalAnswer");
    assert.ok(!fnBody.includes("explanation"), "serializeCandidatePublic must not expose explanation");
    assert.ok(!fnBody.includes("rubric"), "serializeCandidatePublic must not expose rubric");
    assert.ok(!fnBody.includes("learningSupport"), "serializeCandidatePublic must not expose learningSupport");
    assert.ok(!fnBody.includes("misconception"), "serializeCandidatePublic must not expose misconception");
    assert.ok(!fnBody.includes("workedExample"), "serializeCandidatePublic must not expose workedExample");
  });

  it("public card demo data does not contain answer fields", () => {
    // Check that demo data files don't leak answer content into public DTOs
    const demoSource = readFileSync(
      resolve(import.meta.dirname, "../../../web/features/card-generation-v2/demo/demo-data.ts"),
      "utf8",
    );

    // The demoPublicCards array should not contain answer-related fields
    const cardsStart = demoSource.indexOf("demoPublicCards");
    const cardsEnd = demoSource.indexOf("];", cardsStart);
    assert.ok(cardsStart >= 0 && cardsEnd > cardsStart);

    const cardsBody = demoSource.slice(cardsStart, cardsEnd);

    assert.ok(!cardsBody.includes("canonicalAnswer"), "public cards must not expose canonicalAnswer");
    assert.ok(!cardsBody.includes("explanation"), "public cards must not expose explanation");
    assert.ok(!cardsBody.includes("misconception"), "public cards must not expose misconception");
    assert.ok(!cardsBody.includes("evidenceId"), "public cards must not expose evidenceId");
    assert.ok(!cardsBody.includes("exposureId"), "public cards must not expose exposureId");
  });
});
