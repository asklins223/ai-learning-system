/**
 * 方案 20 — Card Generation V2 helpers 单测。
 *
 * 覆盖：
 * - applyPatch（增删改、null 删除、undefined 跳过）
 * - serializeRunPublic / serializeCandidatePublic（字段映射、隐私守卫）
 * - CardGenerationV2ServiceError（code/statusCode/message）
 * - insertEvent（seq 递增、payload 存储）
 * - getCandidateForAction（404 / 409 stale / happy path）
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import {
  applyPatch,
  CardGenerationV2ServiceError,
  serializeRunPublic,
  serializeCandidatePublic,
  insertEvent,
  getCandidateForAction,
  NO_STORE,
  sanitizeEventPayloadV2,
} from "../modules/card-generation-v2/helpers.ts";
import {
  cardGenerationRunsV2,
  cardGenerationCandidatesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000004";

let originalTransaction: typeof db.transaction;

beforeEach(() => {
  originalTransaction = db.transaction;
});

afterEach(() => {
  db.transaction = originalTransaction;
});

function mockTx(impl: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    ...impl,
  };
  db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;
  return tx;
}

describe("applyPatch", () => {
  it("adds new keys", () => {
    const result = applyPatch({ a: 1 }, { b: 2 });
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("overwrites existing keys", () => {
    const result = applyPatch({ a: 1, b: 2 }, { a: 99 });
    assert.deepEqual(result, { a: 99, b: 2 });
  });

  it("deletes keys when value is null", () => {
    const result = applyPatch({ a: 1, b: 2 }, { a: null });
    assert.deepEqual(result, { b: 2 });
  });

  it("skips undefined values", () => {
    const result = applyPatch({ a: 1 }, { a: undefined, b: 2 });
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("handles nested objects by replacing not merging", () => {
    const result = applyPatch({ obj: { x: 1, y: 2 } }, { obj: { x: 99 } });
    assert.deepEqual(result, { obj: { x: 99 } });
  });

  it("field-merges learningSupport patches and preserves untouched support fields", () => {
    const result = applyPatch(
      {
        learningSupport: {
          explanation: "old explanation",
          boundary: "keep this boundary",
          misconception: "keep this misconception",
        },
      },
      { learningSupport: { explanation: "new explanation" } },
    );

    assert.deepEqual(result, {
      learningSupport: {
        explanation: "new explanation",
        boundary: "keep this boundary",
        misconception: "keep this misconception",
      },
    });
  });

  it("allows a learningSupport field to be cleared without deleting its siblings", () => {
    const result = applyPatch(
      {
        learningSupport: {
          explanation: "explanation",
          boundary: "remove me",
          workedExample: "keep this example",
        },
      },
      { learningSupport: { boundary: null } },
    );

    assert.deepEqual(result, {
      learningSupport: {
        explanation: "explanation",
        workedExample: "keep this example",
      },
    });
  });
});

describe("CardGenerationV2ServiceError", () => {
  it("carries code and statusCode", () => {
    const err = new CardGenerationV2ServiceError("test_code", 418, "test message");
    assert.equal(err.code, "test_code");
    assert.equal(err.statusCode, 418);
    assert.equal(err.message, "test message");
    assert.equal(err.name, "CardGenerationV2ServiceError");
    assert.ok(err instanceof Error);
  });
});

describe("NO_STORE header", () => {
  it("has correct cache-control value", () => {
    assert.equal(NO_STORE["Cache-Control"], "private, no-store");
  });
});

describe("serializeRunPublic", () => {
  function makeBaseRunRow() {
    return {
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      noteId: "00000000-0000-4000-8000-000000000006",
      noteVersionId: "00000000-0000-4000-8000-000000000007",
      idempotencyKey: "idem-1",
      status: "review_ready",
      cardContentEpoch: 1,
      semanticSpecHash: "a".repeat(64),
      inputSnapshotHash: "b".repeat(64),
      generationFingerprint: "c".repeat(64),
      sourceSnapshotHash: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      blockManifestHash: "f".repeat(64),
      assetManifestHash: "g".repeat(64),
      scopeManifestHash: "h".repeat(64),
      currentPlanVersion: 1,
      reviewDraftRevision: 1,
      semanticSpec: {},
      inputSnapshot: {},
      errorCode: null as string | null,
      errorMessage: null as string | null,
      supersedesRunId: null as string | null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };
  }

  it("serializes all public fields and nulls out error when no error", async () => {
    const row = makeBaseRunRow();
    const result = await serializeRunPublic(row as typeof cardGenerationRunsV2.$inferSelect);
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.status, "review_ready");
    assert.equal(result.sourceOutdated, false);
    assert.equal(result.error, null);
    assert.equal(result.createdAt, "2026-01-01T00:00:00.000Z");
  });

  it("serializes error when errorCode is present", async () => {
    const row = {
      ...makeBaseRunRow(),
      status: "failed",
      currentPlanVersion: 0,
      errorCode: "planner_error",
      errorMessage: "Planner timed out",
    };
    const result = await serializeRunPublic(row as typeof cardGenerationRunsV2.$inferSelect);
    assert.deepEqual(result.error, { code: "planner_error", message: "Planner timed out" });
  });
});

describe("serializeCandidatePublic", () => {
  it("serializes candidate with three-state fields and review readiness", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000010",
      candidateId: CANDIDATE_ID,
      candidateRevisionId: "crev-1",
      revision: 1,
      runId: RUN_ID,
      planRevisionId: "plan-1",
      planVersion: 1,
      planObjectiveLocalId: "obj-1",
      recommendation: { recommended: true, reasonCodes: ["high_value"] },
      objectiveDraft: {
        objectiveStatement: "Explain X",
        publicSummary: "Summary of X",
        knowledgeForm: "fact",
      },
      presentationDraft: {
        strategy: "recall",
        transformationKind: "retrieval_definition",
        front: { cue: "What is X?", prompt: "Explain X" },
        estimatedReviewSeconds: 30,
      },
      evidenceSetHash: "d".repeat(64),
      candidateRevisionHash: "e".repeat(64),
      hints: { level1: "L1", level2: "L2" },
      qualityState: "passed",
      reviewDecision: "undecided",
      publishState: "unpublished",
      reviewReasonCode: null,
      reviewNote: null,
      qualityReportHashes: [],
      evidenceBindingPlanHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaceId: WORKSPACE_ID,
      derivedFrom: [],
      planHash: "f".repeat(64),
      cardContentEpoch: 1,
    };
    const result = serializeCandidatePublic(row as typeof cardGenerationCandidatesV2.$inferSelect);
    assert.equal(result.candidateId, CANDIDATE_ID);
    assert.equal(result.objective.statement, "Explain X");
    assert.equal(result.front.cue, "What is X?");
    assert.equal(result.qualityState, "passed");
    assert.equal(result.reviewDecision, "undecided");
    assert.equal(result.publishState, "unpublished");
    assert.equal(result.isReviewReady, true);
  });

  it("returns isReviewReady=false when qualityState is not passed", () => {
    const row = {
      ...makeBaseCandidateRow(),
      qualityState: "authored",
    };
    const result = serializeCandidatePublic(row as typeof cardGenerationCandidatesV2.$inferSelect);
    assert.equal(result.isReviewReady, false);
  });

  it("returns isReviewReady=false when reviewDecision is not undecided", () => {
    const row = {
      ...makeBaseCandidateRow(),
      reviewDecision: "keep",
    };
    const result = serializeCandidatePublic(row as typeof cardGenerationCandidatesV2.$inferSelect);
    assert.equal(result.isReviewReady, false);
  });

  it("returns isReviewReady=false when publishState is not unpublished", () => {
    const row = {
      ...makeBaseCandidateRow(),
      publishState: "activated",
    };
    const result = serializeCandidatePublic(row as typeof cardGenerationCandidatesV2.$inferSelect);
    assert.equal(result.isReviewReady, false);
  });
});

function makeBaseCandidateRow() {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    candidateId: CANDIDATE_ID,
    candidateRevisionId: "crev-1",
    revision: 1,
    runId: RUN_ID,
    planRevisionId: "plan-1",
    planVersion: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: [] },
    objectiveDraft: {
      objectiveStatement: "Test",
      publicSummary: "Summary",
      knowledgeForm: "fact",
    },
    presentationDraft: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: { cue: "Cue", prompt: "Prompt" },
      estimatedReviewSeconds: 30,
    },
    evidenceSetHash: "d".repeat(64),
    candidateRevisionHash: "e".repeat(64),
    hints: { level1: "L1", level2: "L2" },
    qualityState: "passed",
    reviewDecision: "undecided",
    publishState: "unpublished",
    reviewReasonCode: null,
    reviewNote: null,
    qualityReportHashes: [],
    evidenceBindingPlanHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    workspaceId: WORKSPACE_ID,
    derivedFrom: [],
    planHash: "f".repeat(64),
    cardContentEpoch: 1,
  };
}

describe("insertEvent", () => {
  it("computes next seq and inserts event", async () => {
    let capturedValues: Record<string, unknown>[] = [];
    const tx = mockTx({
      select: () => ({
        from: () => ({
          where: async () => [{ maxSeq: 5 }],
        }),
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          capturedValues.push(vals);
        },
      }),
    });

    await insertEvent(tx, WORKSPACE_ID, RUN_ID, "card_generation.created", { runId: RUN_ID });

    assert.equal(capturedValues.length, 1);
    assert.equal(capturedValues[0].eventSeq, 6);
    assert.equal(capturedValues[0].eventType, "card_generation.created");
    assert.equal(capturedValues[0].workspaceId, WORKSPACE_ID);
    assert.equal(capturedValues[0].runId, RUN_ID);
  });

  it("handles empty events table (maxSeq null → COALESCE 0 → 0+1=1)", async () => {
    let captured: Record<string, unknown>[] = [];
    const tx = mockTx({
      select: () => ({
        from: () => ({
          where: async () => [{ maxSeq: null }],
        }),
      }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          captured.push(vals);
        },
      }),
    });

    await insertEvent(tx, WORKSPACE_ID, RUN_ID, "card_candidate.authored");

    assert.equal(captured[0].eventSeq, 1);
  });
});

describe("getCandidateForAction", () => {
  it("throws candidate_not_found when no rows", async () => {
    const tx = mockTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => getCandidateForAction(tx, WORKSPACE_ID, RUN_ID, CANDIDATE_ID, 1, "hash"),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "candidate_not_found");
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it("throws stale_revision when hash mismatch", async () => {
    const candidate = makeBaseCandidateRow();
    const tx = mockTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [candidate],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => getCandidateForAction(tx, WORKSPACE_ID, RUN_ID, CANDIDATE_ID, 1, "wrong_hash"),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_revision");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("returns candidate on happy path", async () => {
    const candidate = makeBaseCandidateRow();
    const tx = mockTx({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [candidate],
          }),
        }),
      }),
    });

    const result = await getCandidateForAction(tx, WORKSPACE_ID, RUN_ID, CANDIDATE_ID, 1, candidate.candidateRevisionHash);
    assert.equal(result.candidateId, CANDIDATE_ID);
    assert.equal(result.revision, 1);
  });
});

describe("sanitizeEventPayloadV2 (§17.1/§22.3 SSE 白名单)", () => {
  it("strips private content fields at top level", () => {
    const out = sanitizeEventPayloadV2({
      runId: RUN_ID,
      candidateId: CANDIDATE_ID,
      canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "答案" } },
      answer: "泄露",
      front: { cue: "泄漏" },
    });
    assert.deepEqual(Object.keys(out).sort(), ["candidateId", "runId"]);
  });

  it("recursively strips blocked keys inside nested objects and arrays", () => {
    const out = sanitizeEventPayloadV2({
      candidate: {
        candidateRevisionId: "rev-1",
        objectiveDraft: { canonicalAnswer: { text: "答案" }, objectiveStatement: "目标" },
      },
      reports: [
        { reportId: "r1", scoringRubric: { passingPolicy: {} } },
        { reportId: "r2", evidenceBindings: [] },
      ],
      planHash: "a".repeat(64),
    });
    const candidate = out.candidate as Record<string, unknown>;
    assert.deepEqual(Object.keys(candidate), ["candidateRevisionId"]);
    const reports = out.reports as Record<string, unknown>[];
    assert.deepEqual(Object.keys(reports[0]), ["reportId"]);
    assert.deepEqual(Object.keys(reports[1]), ["reportId"]);
    assert.equal(out.planHash, "a".repeat(64));
  });

  it("keeps audit-safe scalar fields (ids/hashes/enums)", () => {
    const out = sanitizeEventPayloadV2({
      runId: RUN_ID,
      eventSeq: 3,
      reasonCodes: ["source_is_temporary_or_operational"],
      resultKind: "no_cards_recommended",
      planHash: "b".repeat(64),
    });
    assert.equal(out.runId, RUN_ID);
    assert.equal(out.eventSeq, 3);
    assert.deepEqual(out.reasonCodes, ["source_is_temporary_or_operational"]);
    assert.equal(out.resultKind, "no_cards_recommended");
  });
});
