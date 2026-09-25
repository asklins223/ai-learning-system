/**
 * Tests for LearningTargetSnapshotV2 contracts (方案 20 §16).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeLearningTargetSnapshotHashV2 } from "../src/card-generation-v2-hashing.ts";
import {
  learningRunOriginV2Schema,
  learningRunReturnTargetV2Schema,
  learningRunTargetPublicV2Schema,
  parseLearningTargetSnapshotV2,
  parseLearningRunOriginV2,
  parseLearningRunTargetPublicV2,
  startRunOriginV2,
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

// ─── 39d W3-4：无卡目标的合同与哈希闭包 ────────────────────────────────

/**
 * 这条常数是**放宽类型之前那份实现**（`git show HEAD:` 取出的
 * `card-generation-v2-hashing.ts` ＋ 同一份 `canonicalJsonV2`）对下面这个输入对象算出的
 * 摘要，比对当场跑过：HEAD 与改动后对同一输入逐字节相同。它的作用只有一个：
 * 证明"把卡身份五个字段放宽成可空"**不改动任何已有行的快照哈希**——一旦这里变了，
 * 全部 V2 提交复验（比的是存下来的 `snapshot_hash`）都会对不上。
 */
const SNAPSHOT_HASH_CARDED_BEFORE_WIDENING =
  "291c4c3b5d1dee50de8e319b12d8aadf6c4b9ca6e01d5c3b92165dfebcee4cf8";

function cardedHashInput() {
  return {
    workspaceId: FAKE_UUID,
    userId: FAKE_UUID,
    runId: FAKE_UUID,
    objectiveId: FAKE_UUID,
    objectiveRevision: 1,
    semanticTargetFingerprint: "f".repeat(64),
    targetRevisionHash: "e".repeat(64),
    cardContentEpoch: 2,
    objectiveLifecycleEpoch: 1,
    cardId: "55555555-5555-4555-8555-555555555555",
    publicationRevision: 3,
    cardRevision: 4,
    publicPayloadHash: "a".repeat(64),
    revealPayloadHash: "b".repeat(64),
    canonicalAnswerHash: "c".repeat(64),
    learningSupportHash: "d".repeat(64),
    rubricHash: "1".repeat(64),
    evidenceBindingSetHash: "2".repeat(64),
    evidenceEligibilityVectorHash: "3".repeat(64),
    planningExposure: {
      scope: "objective" as const,
      lastExposedAt: null,
      exposureIds: [],
      sameCueRecentlyRevealed: false,
      qualificationNotBefore: null,
      preRunRevealPolicyVersion: "pre-run-reveal-v1",
    },
    lifecycleAtPrepare: "active" as const,
    publishedTargetEligibility: "eligible" as const,
    targetSnapshotPolicyVersion: "learning-target-snapshot-v2.1",
  };
}

describe("无卡快照的合同与哈希闭包（W3-4）", () => {
  it("有卡输入的摘要与放宽类型之前逐字节相同（历史行不作废）", () => {
    assert.equal(
      computeLearningTargetSnapshotHashV2(cardedHashInput()),
      SNAPSHOT_HASH_CARDED_BEFORE_WIDENING,
      "卡身份放宽成可空，竟改动了有卡输入的摘要——全部存量快照哈希都会对不上",
    );
  });

  it("无卡（五个字段显式 null）得到的是另一个摘要，而不是同一个", () => {
    const cardless = computeLearningTargetSnapshotHashV2({
      ...cardedHashInput(),
      cardId: null,
      publicationRevision: null,
      cardRevision: null,
      publicPayloadHash: null,
      revealPayloadHash: null,
    });
    assert.notEqual(cardless, SNAPSHOT_HASH_CARDED_BEFORE_WIDENING);
    assert.match(cardless, /^[0-9a-f]{64}$/);
  });

  it("省键与置空是两个不同摘要 ⇒ 构造无卡快照必须写显式 null", () => {
    // canonicalJsonV2 跳过 undefined：省键的输入看起来"等价"，算出来的哈希却是第三个值。
    // 这条断言钉的是"别用条件展开构造无卡快照"。
    const input = cardedHashInput() as Record<string, unknown>;
    for (const key of ["cardId", "publicationRevision", "cardRevision", "publicPayloadHash", "revealPayloadHash"]) {
      delete input[key];
    }
    const omitted = computeLearningTargetSnapshotHashV2(input as never);
    const nulled = computeLearningTargetSnapshotHashV2({
      ...cardedHashInput(), cardId: null, publicationRevision: null, cardRevision: null,
      publicPayloadHash: null, revealPayloadHash: null,
    });
    assert.notEqual(omitted, nulled, "省键与显式 null 竟然同摘要 ⇒ 这条判据没在读规范化序列化");
  });

  it("无卡的快照与公共投影都能 parse，但坏形状仍然被拒（放宽不是放开）", () => {
    const snapshot = { ...baseSnapshot(), target: { ...baseTarget(), cardId: null, publicationRevision: null, cardRevision: null, publicPayloadHash: null, revealPayloadHash: null } };
    assert.equal(parseLearningTargetSnapshotV2(snapshot).target.cardId, null);
    assert.throws(() => parseLearningTargetSnapshotV2({
      ...snapshot, target: { ...snapshot.target, cardId: "不是 uuid" },
    }));
    assert.throws(() => parseLearningTargetSnapshotV2({
      ...snapshot, target: { ...snapshot.target, cardRevision: 0 },
    }));
    const publicTarget = {
      objectiveId: FAKE_UUID, objectiveRevision: 1,
      cardId: null, publicationRevision: null, cardRevision: null, publicPayloadHash: null,
      publicSummary: "Summary", semanticTargetFingerprint: FAKE_HASH, targetRevisionHash: FAKE_HASH,
    };
    assert.equal(parseLearningRunTargetPublicV2(publicTarget).cardId, null);
    assert.throws(() => parseLearningRunTargetPublicV2({ ...publicTarget, publicPayloadHash: "abc" }));
  });
});

describe("startRunOriginV2（有卡 card／没卡 today，39d W4-2）", () => {
  it("有卡就带 cardId；没卡（null 或读不到）走 today，绝不产出 cardId 为空的 card 档", () => {
    assert.deepEqual(
      startRunOriginV2({ objectiveId: FAKE_UUID, cardId: FAKE_UUID }),
      { kind: "card", cardId: FAKE_UUID, objectiveId: FAKE_UUID },
    );
    for (const cardId of [null, undefined] as const) {
      const origin = startRunOriginV2({ objectiveId: FAKE_UUID, cardId });
      assert.deepEqual(origin, { kind: "today", objectiveId: FAKE_UUID });
      // 无卡那一支必须过合同：`today` 不带 recommendationId 也合法。
      assert.equal(learningRunOriginV2Schema.safeParse(origin).success, true);
    }
    // 反向自证：如果哪天有人把空卡写成 card 档，strict 合同要挡住它。
    assert.equal(
      learningRunOriginV2Schema.safeParse({ kind: "card", cardId: null, objectiveId: FAKE_UUID }).success,
      false,
    );
  });
});
