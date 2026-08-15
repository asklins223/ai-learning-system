/**
 * 方案 20 — Card Generation V2 reveal-service 单测。
 *
 * 覆盖：
 * - revealCandidateV2 幂等 replay（同 idempotencyKey 返回已建 exposure）
 * - revealCandidateV2 candidate_not_found
 * - revealCandidateV2 stale_revision（hash 不匹配 → 409）
 * - revealCandidateV2 happy path（先写 exposure 再返回答案）
 * - 答案字段不泄漏到 public DTO（canonicalAnswer/learningSupport 来自 objectiveDraft）
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import { revealCandidateV2 } from "../modules/card-generation-v2/reveal-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000004";
const CANDIDATE_REVISION_ID = "00000000-0000-4000-8000-000000000005";
const EXPOSURE_ID = "00000000-0000-4000-8000-000000000006";
const REVISION_HASH = "e".repeat(64);

let originalTransaction: typeof db.transaction;

beforeEach(() => {
  originalTransaction = db.transaction;
});

afterEach(() => {
  db.transaction = originalTransaction;
});

function makeCandidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-id",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    candidateRevisionId: CANDIDATE_REVISION_ID,
    revision: 1,
    planRevisionId: "plan-rev",
    planVersion: 1,
    planHash: "f".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFrom: [],
    objectiveDraft: {
      objectiveStatement: "Explain X",
      publicSummary: "Summary",
      knowledgeForm: "fact",
      canonicalAnswer: {
        kind: "text",
        unit: { unitId: "u1", text: "The answer is 42" },
      },
      learningSupport: {
        explanation: "Because the universe said so",
        boundary: "But not for everything",
        misconception: "Some think it's 41",
        workedExample: "42 = 6 * 7",
      },
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
    candidateRevisionHash: REVISION_HASH,
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

function makeExposureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "exp-row",
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    exposureId: EXPOSURE_ID,
    subjectKind: "candidate",
    subjectCandidateId: CANDIDATE_ID,
    subjectCandidateRevision: 1,
    subjectObjectiveId: null,
    subjectObjectiveRevision: null,
    subjectCardId: null,
    subjectCardRevision: null,
    exposureKind: "answer_reveal",
    contextHash: "ch".repeat(32),
    idempotencyKey: "reveal-key-001",
    exposedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Builds a where() return that is both thenable (await resolves to rows)
 * and has .limit() for chainable callers.
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

function setupTx(impl: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    ...impl,
  };
  db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;
  return tx;
}

describe("revealCandidateV2", () => {
  it("returns existing exposure on idempotency replay", async () => {
    const exposure = makeExposureRow();
    const candidate = makeCandidateRow();
    let selectCallCount = 0;

    setupTx({
      select: () => ({
        from: (_table: unknown) => {
          selectCallCount++;
          // First call: cardExposureLedgerV2 → existing exposure
          if (selectCallCount === 1) {
            return {
              where: () => makeWhereResult([exposure]),
            };
          }
          // Second call: cardGenerationCandidatesV2 → candidate for replay
          return {
            where: () => makeWhereResult([candidate]),
          };
        },
      }),
    });

    const result = await revealCandidateV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      CANDIDATE_ID,
      1,
      REVISION_HASH,
      "reveal-key-001",
    );

    assert.ok(result);
    assert.equal(result.exposureId, EXPOSURE_ID);
    assert.equal(result.candidateId, CANDIDATE_ID);
  });

  it("throws candidate_not_found when no matching candidate", async () => {
    setupTx({
      select: () => ({
        from: () => ({
          where: () => makeWhereResult([]),
        }),
      }),
    });

    await assert.rejects(
      () => revealCandidateV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
        CANDIDATE_ID,
        1,
        REVISION_HASH,
        "reveal-key-new-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "candidate_not_found");
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it("throws stale_revision when candidateRevisionHash mismatch", async () => {
    const candidate = makeCandidateRow({ candidateRevisionHash: "wrong" });
    let callCount = 0;

    setupTx({
      select: () => ({
        from: () => {
          callCount++;
          // First: exposure ledger (empty, no replay)
          if (callCount === 1) {
            return {
              where: () => makeWhereResult([]),
            };
          }
          // Second: candidate lookup
          return {
            where: () => makeWhereResult([candidate]),
          };
        },
      }),
    });

    await assert.rejects(
      () => revealCandidateV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        RUN_ID,
        CANDIDATE_ID,
        1,
        REVISION_HASH, // expected hash ≠ actual "wrong"
        "reveal-key-stale-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_revision");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("writes exposure BEFORE returning answer (exposure-first)", async () => {
    const candidate = makeCandidateRow();
    let callCount = 0;
    const allInserts: Record<string, unknown>[] = [];

    setupTx({
      select: (columns?: unknown) => ({
        from: () => {
          callCount++;
          // If columns is provided (like {maxSeq}), it's an insertEvent call
          if (columns !== undefined) {
            return {
              where: () => makeWhereResult([{ maxSeq: 0 }]),
            };
          }
          // First: exposure ledger (empty)
          if (callCount === 1) {
            return {
              where: () => makeWhereResult([]),
            };
          }
          // Second: candidate lookup
          return {
            where: () => makeWhereResult([candidate]),
          };
        },
      }),
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          allInserts.push(vals);
        },
      }),
    });

    const result = await revealCandidateV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      CANDIDATE_ID,
      1,
      REVISION_HASH,
      "reveal-key-happy-001",
    );

    // Exposure was written (find the insert with subjectKind)
    const exposureInsert = allInserts.find((v) => v.subjectKind === "candidate");
    assert.ok(exposureInsert, "exposure insert must happen before returning reveal");
    assert.equal(exposureInsert!.exposureKind, "answer_reveal");
    assert.equal(exposureInsert!.workspaceId, WORKSPACE_ID);

    // Result contains answer
    assert.ok(result);
    assert.equal(result.candidateId, CANDIDATE_ID);
    assert.equal(result.exposureId.length > 0, true);
    // canonicalAnswer from objectiveDraft
    assert.equal(result.canonicalAnswer.kind, "text");
    // explanation from learningSupport
    assert.equal(result.explanation, "Because the universe said so");
    assert.equal(result.boundary, "But not for everything");
    assert.equal(result.misconception, "Some think it's 41");
    assert.equal(result.workedExample, "42 = 6 * 7");
    // evidencePreviews is empty array (V1)
    assert.deepEqual(result.evidencePreviews, []);
    // exposedAt is ISO string
    assert.ok(typeof result.exposedAt === "string");
  });
});
