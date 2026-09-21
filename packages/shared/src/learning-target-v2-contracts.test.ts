/**
 * Tests for LearningTargetSnapshotV2 contracts (方案 20 §16).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  learningRunReturnTargetV2Schema,
  learningRunTargetPublicV2Schema,
  parseLearningTargetSnapshotV2,
  parseLearningRunOriginV2,
  parseLearningRunTargetPublicV2,
  type LearningTargetSnapshotV2,
  type LearningRunOriginV2,
  type LearningRunTargetPublicV2,
} from "../src/learning-target-v2-contracts.ts";

const FAKE_HASH = "0".repeat(64);
const FAKE_UUID = "00000000-0000-4000-8000-000000000001";

function baseTarget(): LearningTargetSnapshotV2["target"] {
  return {
    objectiveId: FAKE_UUID,
    objectiveRevision: 1,
    cardId: FAKE_UUID,
    publicationRevision: 1,
    cardRevision: 1,
    publicPayloadHash: FAKE_HASH,
    revealPayloadHash: FAKE_HASH,
    objectiveStatement: "Objective statement",
    publicSummary: "Summary",
    knowledgeForm: "fact",
    preferredIntents: ["recall"],
    canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "Answer" } },
    learningSupport: { explanation: "Explanation" },
    scoringRubric: {
      version: 2,
      units: [{
        rubricUnitId: "rubric-1",
        facet: "recall",
        criterion: "能正确回答",
        required: true,
        answerUnitIds: ["u1"],
        evidenceRefIds: [FAKE_UUID],
      }],
      passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
      rubricHash: FAKE_HASH,
    },
    relations: [],
    practiceItem: null,
    evidence: [],
    evidenceBindingSetHash: FAKE_HASH,
    evidenceEligibilityVectorHash: FAKE_HASH,
    semanticTargetFingerprint: FAKE_HASH,
    targetRevisionHash: FAKE_HASH,
  };
}

function baseSnapshot(): LearningTargetSnapshotV2 {
  return {
    version: 2,
    snapshotId: FAKE_UUID,
    workspaceId: FAKE_UUID,
    userId: FAKE_UUID,
    runId: FAKE_UUID,
    cardContentEpoch: 1,
    objectiveLifecycleEpoch: 1,
    target: baseTarget(),
    planningExposure: {
      scope: "objective",
      lastExposedAt: null,
      exposureIds: [],
      sameCueRecentlyRevealed: false,
      qualificationNotBefore: null,
      preRunRevealPolicyVersion: "pre-run-reveal-v1",
    },
    lifecycleAtPrepare: "active",
    publishedTargetEligibility: "eligible",
    preparedAt: "2026-08-14T00:00:00Z",
    snapshotHash: FAKE_HASH,
  };
}

describe("learningTargetSnapshotV2Schema", () => {
  it("parses a valid snapshot", () => {
    const snap = baseSnapshot();
    const result = parseLearningTargetSnapshotV2(snap);
    assert.equal(result.version, 2);
    assert.equal(result.target.objectiveRevision, 1);
    assert.equal(result.planningExposure.scope, "objective");
    assert.equal(result.publishedTargetEligibility, "eligible");
  });

  it("rejects version !== 2", () => {
    const snap = baseSnapshot() as unknown as Record<string, unknown>;
    snap.version = 1;
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects invalid hash format", () => {
    const snap = baseSnapshot();
    snap.target.semanticTargetFingerprint = "short";
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects missing preferredIntents", () => {
    const snap = baseSnapshot();
    // @ts-expect-error: intentionally removing field
    delete snap.target.preferredIntents;
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects a rubric with no required unit", () => {
    const snap = baseSnapshot();
    snap.target.scoringRubric.units = snap.target.scoringRubric.units.map((unit) => ({
      ...unit,
      required: false,
    }));
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects duplicate rubric unit ids", () => {
    const snap = baseSnapshot();
    const original = snap.target.scoringRubric.units[0]!;
    snap.target.scoringRubric.units.push({
      ...original,
      criterion: "A distinct criterion must have its own id",
    });

    assert.throws(
      () => parseLearningTargetSnapshotV2(snap),
      /rubricUnitId must be unique/,
    );
  });

  it("rejects missing userId", () => {
    const snap = baseSnapshot() as unknown as Record<string, unknown>;
    delete snap.userId;
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects missing planningExposure fields", () => {
    const snap = baseSnapshot() as unknown as Record<string, unknown>;
    delete (snap.planningExposure as Record<string, unknown>).qualificationNotBefore;
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects objectiveRevision < 1", () => {
    const snap = baseSnapshot();
    snap.target.objectiveRevision = 0;
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });

  it("rejects unknown extra fields (strict)", () => {
    const snap = baseSnapshot() as unknown as Record<string, unknown>;
    snap.extraField = "not allowed";
    assert.throws(() => parseLearningTargetSnapshotV2(snap));
  });
});

describe("learningRunTargetPublicV2Schema", () => {
  it("parses a valid public target", () => {
    const target: LearningRunTargetPublicV2 = {
      objectiveId: FAKE_UUID,
      objectiveRevision: 1,
      cardId: FAKE_UUID,
      publicationRevision: 1,
      cardRevision: 1,
      publicPayloadHash: FAKE_HASH,
      publicSummary: "Summary",
      semanticTargetFingerprint: FAKE_HASH,
      targetRevisionHash: FAKE_HASH,
    };
    const result = parseLearningRunTargetPublicV2(target);
    assert.equal(result.objectiveRevision, 1);
  });

  it("rejects canonicalAnswer in public target (strict unknown fields)", () => {
    const target = {
      objectiveId: FAKE_UUID,
      objectiveRevision: 1,
      cardId: FAKE_UUID,
      publicationRevision: 1,
      cardRevision: 1,
      publicPayloadHash: FAKE_HASH,
      publicSummary: "Summary",
      semanticTargetFingerprint: FAKE_HASH,
      targetRevisionHash: FAKE_HASH,
      canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "leak" } },
    };
    assert.throws(() => learningRunTargetPublicV2Schema.parse(target));
  });
});

describe("learningRunOriginV2Schema", () => {
  it("parses card origin", () => {
    const origin: LearningRunOriginV2 = {
      kind: "card",
      cardId: FAKE_UUID,
      objectiveId: FAKE_UUID,
    };
    const result = parseLearningRunOriginV2(origin);
    assert.equal(result.kind, "card");
  });

  it("parses review origin", () => {
    const origin = {
      kind: "review",
      scheduleId: FAKE_UUID,
      objectiveId: FAKE_UUID,
      scheduleGeneration: 1,
    };
    const result = parseLearningRunOriginV2(origin);
    assert.equal(result.kind, "review");
  });

  it("parses today origin", () => {
    const origin = {
      kind: "today",
      objectiveId: FAKE_UUID,
    };
    const result = parseLearningRunOriginV2(origin);
    assert.equal(result.kind, "today");
  });

  it("rejects unknown origin kind", () => {
    assert.throws(() => parseLearningRunOriginV2({ kind: "unknown" }));
  });
});

describe("learningRunReturnTargetV2Schema", () => {
  it("parses today return target", () => {
    const target = { kind: "today" as const };
    const result = learningRunReturnTargetV2Schema.parse(target);
    assert.equal(result.kind, "today");
  });

  it("parses onboarding return target", () => {
    const target = { kind: "onboarding" as const, destination: "card" as const };
    const result = learningRunReturnTargetV2Schema.parse(target);
    assert.equal(result.kind, "onboarding");
    assert.equal((result as { destination: string }).destination, "card");
  });
});
