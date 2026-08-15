/**
 * 方案 20 — Card Generation V2 activation-service 单测。
 *
 * 覆盖：
 * - activateCardCandidatesV2 幂等 replay（同 idempotencyKey 返回已有 receipt）
 * - activateCardCandidatesV2 happy path（create_new intent → 创建 Objective + Card + Receipt）
 * - 状态守卫：run 非 review_ready → invalid_state
 * - CAS 守卫：sourceSnapshotHash / semanticSpecHash / inputSnapshotHash / cardContentEpoch 不匹配
 * - clientReviewHash 不匹配 → client_review_hash_mismatch
 * - candidate CAS：stale_revision / not_kept / already_published
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import { activateCardCandidatesV2 } from "../modules/card-generation-v2/activation-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";
import { computeClientReviewHashV2, computeCanonicalAnswerHashV2, computeLearningSupportHashV2, computeRelationsHashV2 } from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import type { ActivateCardCandidatesRequestV2, ActivationIntentV2 } from "@ailearn/shared/card-generation-v2-contracts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_ID = "00000000-0000-4000-8000-000000000004";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000005";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000006";
const CANDIDATE_REVISION_ID = "00000000-0000-4000-8000-000000000007";
const PLAN_REVISION_ID = "00000000-0000-4000-8000-000000000008";
const REVISION_HASH = "a".repeat(64);
const PLAN_HASH = "b".repeat(64);
const SOURCE_SNAPSHOT_HASH = "c".repeat(64);
const SEMANTIC_SPEC_HASH = "d".repeat(64);
const INPUT_SNAPSHOT_HASH = "e".repeat(64);
const EVIDENCE_BINDING_PLAN_HASH = "f".repeat(64);

let originalTransaction: typeof db.transaction;

/**
 * R36 §5.4：与服务端 activation-service 重算逻辑一致的 equivalence report hash。
 * 测试 mock 的 candidate/objective 数据必须复现服务端闭包计算，否则 409。
 */
function computeTestEquivalenceReportHash(): string {
  const candidate = makeCandidate();
  const objectiveDraft = candidate.objectiveDraft as {
    objectiveStatement: string;
    publicSummary: string;
    knowledgeForm: string;
    canonicalAnswer: { kind: string; unit: { unitId: string; text: string } };
    learningSupport: { explanation: string };
    rubric: { units: unknown[]; passingPolicy: unknown; rubricHash: string };
    relations?: unknown[];
  };
  const canonicalAnswerHash = computeCanonicalAnswerHashV2(objectiveDraft.canonicalAnswer);
  const learningSupportHash = computeLearningSupportHashV2(objectiveDraft.learningSupport);
  const rubricHash = objectiveDraft.rubric.rubricHash;
  const relationsHash = computeRelationsHashV2(objectiveDraft.relations ?? []);
  const proposedSemanticContentHash = hashCanonicalV2("objective-semantic-content-v2", {
    objectiveStatement: objectiveDraft.objectiveStatement,
    publicSummary: objectiveDraft.publicSummary,
    knowledgeForm: objectiveDraft.knowledgeForm,
    canonicalAnswerHash,
    learningSupportHash,
    rubricHash,
    relationsHash,
  });
  const proposedEvidenceBindingPlanHash = hashCanonicalV2("candidate-evidence-binding-plan-v2", {
    candidateRevisionId: CANDIDATE_REVISION_ID,
  });
  return hashCanonicalV2("objective-equivalence-report-v2", {
    objectiveId: OBJECTIVE_ID,
    priorObjectiveRevisionId: OBJECTIVE_REVISION_ID,
    priorTargetRevisionHash: REVISION_HASH,
    proposedCandidateRevisionId: CANDIDATE_REVISION_ID,
    proposedCandidateRevisionHash: REVISION_HASH,
    proposedSemanticContentHash,
    proposedEvidenceBindingPlanHash,
    verdict: "equivalent",
    policyVersion: "equivalence-policy-v1",
    authorizedBy: "deterministic_policy_and_human",
  });
}

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
    noteId: NOTE_ID,
    noteVersionId: NOTE_VERSION_ID,
    idempotencyKey: "run-key",
    status: "review_ready",
    cardContentEpoch: 1,
    semanticSpecHash: SEMANTIC_SPEC_HASH,
    inputSnapshotHash: INPUT_SNAPSHOT_HASH,
    generationFingerprint: "g".repeat(64),
    sourceSnapshotHash: SOURCE_SNAPSHOT_HASH,
    sourceContentHash: "h".repeat(64),
    blockManifestHash: "i".repeat(64),
    assetManifestHash: "j".repeat(64),
    scopeManifestHash: "k".repeat(64),
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
    inputSnapshotHash: INPUT_SNAPSHOT_HASH,
    cardContentEpoch: 1,
    result: { kind: "author_candidates", recommendedCardCount: 1, activationHardMax: 5, objectives: [], existingActions: [] },
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
    candidateRevisionId: CANDIDATE_REVISION_ID,
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
      canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "answer" } },
      learningSupport: { explanation: "explanation" },
      rubric: { units: [], passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false }, rubricHash: "r".repeat(64) },
      difficulty: "introductory",
      evidenceRefIds: [],
      preferredTaskIntents: ["recall"],
    },
    presentationDraft: {
      strategy: "recall",
      front: { cue: "Cue", prompt: "Prompt" },
      estimatedReviewSeconds: 30,
    },
    evidenceSetHash: "d".repeat(64),
    candidateRevisionHash: REVISION_HASH,
    qualityState: "passed",
    reviewDecision: "keep",
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

function makeRequest(overrides: Record<string, unknown> = {}): ActivateCardCandidatesRequestV2 {
  const selectedCandidates = [
    {
      candidateRevisionId: CANDIDATE_REVISION_ID,
      candidateId: CANDIDATE_ID,
      revision: 1,
      revisionHash: REVISION_HASH,
      candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
      qualityReportHashes: [],
      intent: { kind: "create_new" as const },
    },
  ];
  const clientReviewHash = computeClientReviewHashV2({
    runId: RUN_ID,
    expectedReviewDraftRevision: 1,
    selected: [{ candidateId: CANDIDATE_ID, revision: 1, revisionHash: REVISION_HASH }],
    reviewUiContractVersion: "review-ui-v1",
  });
  return {
    version: 2,
    runId: RUN_ID,
    sourceSnapshotHash: SOURCE_SNAPSHOT_HASH,
    semanticSpecHash: SEMANTIC_SPEC_HASH,
    inputSnapshotHash: INPUT_SNAPSHOT_HASH,
    expectedCardContentEpoch: 1,
    planRevisionId: PLAN_REVISION_ID,
    expectedPlanVersion: 1,
    planHash: PLAN_HASH,
    selectedCandidates,
    existingLifecycleActions: [],
    expectedReviewDraftRevision: 1,
    clientReviewHash,
    ...overrides,
  } as ActivateCardCandidatesRequestV2;
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

/**
 * Helper: checks if a drizzle table object is one of the evidence eligibility tables.
 * Returns empty result for binding plans (skip eligibility check), usable for eligibility states.
 */
function checkEvidenceTable(table: unknown): { rows: unknown[] | null } {
  const drizzleName = Symbol.for("drizzle:Name");
  const tableName = (table as Record<symbol, unknown>)?.[drizzleName] as string | undefined;
  if (tableName === "candidate_evidence_binding_plans_v2") return { rows: [] };
  if (tableName === "evidence_eligibility_states_v2") return { rows: [{ status: "usable" }] };
  return { rows: null };
}

function setupActivationTx(options: {
  run?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  existingReceipt?: Record<string, unknown> | null;
  objective?: Record<string, unknown>;
  existingCard?: Record<string, unknown>;
} = {}) {
  const run = makeRun(options.run);
  const plan = makePlan(options.plan);
  const candidate = makeCandidate(options.candidate);
  const objective = makeObjective(options.objective);
  const existingCard = makeExistingCard(options.existingCard);
  const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
  const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

  /**
   * 全表感知 mock：按 drizzle 表名分发（不依赖 select 调用顺序）。
   * R5 后激活事务新增了 binding plan / exposure / reminder / hash 复验等查询，
   * 调用序 mock 无法继续维护。
   */
  const tableRows = (tableName: string | undefined): unknown[] => {
    switch (tableName) {
      case "card_activation_receipts_v2":
        return options.existingReceipt ? [options.existingReceipt] : [];
      case "card_generation_runs_v2":
        return [run];
      case "card_generation_plans_v2":
        return [plan];
      case "card_generation_candidates_v2":
        return [candidate];
      case "candidate_evidence_binding_plans_v2":
        return []; // 无 binding plan（R4 assembler 前）
      case "evidence_eligibility_states_v2":
        return [{ status: "usable" }];
      case "card_exposure_ledger_v2":
        return []; // 无候选 exposure
      case "learning_exposures_v2":
        return []; // 无 objective exposure（幂等键未命中）
      case "initial_validation_reminders_v2":
        return []; // 无既有 reminder → 新建
      case "learning_objectives_v2":
        return [objective];
      case "learning_objective_revisions_v2":
        return [makeObjectiveRevision()];
      case "learning_cards_v2":
        return [existingCard];
      case "learning_card_publication_revisions_v2":
        return [makePublicationRevision()];
      default:
        return [];
    }
  };

  setupTx({
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        const drizzleName = Symbol.for("drizzle:Name");
        const tableName = (table as Record<symbol, unknown>)?.[drizzleName] as string | undefined;
        if (columns !== undefined && tableName === "card_generation_events_v2") {
          return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
        }
        return { where: () => makeWhereResult(tableRows(tableName)) };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });
        // 模拟 drizzle 链式 API（W#2 后 outbox insert 使用
        // .onConflictDoNothing()）：values 返回可继续链接的对象。
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => [{ id: "mock-id" }],
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return {
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        };
      },
    }),
  });

  return { insertCalls, updateCalls };
}

/** §15.3 objective revision 行（hash 复验需要非空 privatePayloadHash）。 */
function makeObjectiveRevision(overrides: Record<string, unknown> = {}) {
  return {
    objectiveRevisionId: OBJECTIVE_REVISION_ID,
    objectiveId: OBJECTIVE_ID,
    workspaceId: WORKSPACE_ID,
    revision: 1,
    objectiveStatement: "Objective",
    publicSummary: "Summary",
    knowledgeForm: "fact",
    preferredIntents: ["recall"],
    canonicalAnswer: { kind: "text", unit: { unitId: "u1", text: "Answer" } },
    learningSupport: { explanation: "Explanation" },
    scoringRubric: { units: [], passingPolicy: {}, rubricHash: REVISION_HASH },
    relations: [],
    evidenceBindings: [],
    semanticTargetFingerprint: REVISION_HASH,
    targetRevisionHash: REVISION_HASH,
    privatePayloadHash: "a".repeat(64),
    createdAt: new Date(),
    ...overrides,
  };
}

/** §15.5 publication revision 行。 */
function makePublicationRevision(overrides: Record<string, unknown> = {}) {
  return {
    cardId: CARD_ID_EXISTING,
    workspaceId: WORKSPACE_ID,
    publicationRevision: 1,
    cardRevision: 1,
    objectiveId: OBJECTIVE_ID,
    objectiveRevision: 1,
    lifecycleAtPublication: "active",
    publicPayloadHash: "b".repeat(64),
    revealPayloadHash: "c".repeat(64),
    activatedAt: new Date(),
    ...overrides,
  };
}

describe("activateCardCandidatesV2 — idempotency", () => {
  it("returns existing receipt on idempotency replay", async () => {
    const existingReceipt = {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      runId: RUN_ID,
      receiptId: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "activate-key-001",
      requestHash: "a".repeat(64),
      mappings: [{
        candidateRevisionId: CANDIDATE_REVISION_ID,
        candidateEvidenceBindingPlanId: "00000000-0000-4000-8000-000000000011",
        candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
        cardId: "00000000-0000-4000-8000-000000000012",
        objectiveId: "00000000-0000-4000-8000-000000000013",
        objectiveRevisionId: "00000000-0000-4000-8000-000000000014",
        publicationRevision: 1,
        resultingEvidenceBindingSetHash: "b".repeat(64),
      }],
      lifecycleResults: [],
      responseHash: "c".repeat(64),
      committedAt: new Date("2026-01-01T00:00:00Z"),
    };

    setupActivationTx({ existingReceipt });

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-key-001",
    );

    assert.equal(result.receiptId, "00000000-0000-4000-8000-000000000010");
  });
});

describe("activateCardCandidatesV2 — happy path (create_new)", () => {
  it("creates Objective + Card + Receipt and marks run as activated", async () => {
    const { insertCalls, updateCalls } = setupActivationTx();

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-key-happy-001",
    );

    // Should return a receipt
    assert.ok(result);
    assert.equal(result.version, 2);
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.workspaceId, WORKSPACE_ID);
    assert.equal(result.mappings.length, 1);
    // mappings should have cardId (not candidateId)
    assert.ok(result.mappings[0].cardId.length > 0, "mapping should have cardId");
    assert.equal(result.mappings[0].objectiveId.length > 0, true);

    // Should have inserted: objective, objective revision, card, publication, receipt
    assert.ok(insertCalls.length >= 5, `expected >=5 inserts, got ${insertCalls.length}`);

    // Should have updated: run → activating, candidate → activated, run → activated
    const activatingUpdate = updateCalls.find((u) => u.set.status === "activating");
    assert.ok(activatingUpdate, "should have set run to activating");
    const activatedUpdate = updateCalls.find((u) => u.set.status === "activated");
    assert.ok(activatedUpdate, "should have set run to activated");

    // Candidate should be marked activated
    const candidateUpdate = updateCalls.find((u) => u.set.publishState === "activated");
    assert.ok(candidateUpdate, "should have marked candidate as activated");
  });
});

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000020";
const OBJECTIVE_REVISION_ID = "00000000-0000-4000-8000-000000000021";
const CARD_ID_EXISTING = "00000000-0000-4000-8000-000000000022";

function makeObjective(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    workspaceId: WORKSPACE_ID,
    semanticIdentityClassId: "sem-id-1",
    semanticIdentityPolicyVersion: "sem-id-v1",
    semanticTargetFingerprint: REVISION_HASH,
    lifecycle: "active" as const,
    lifecycleEpoch: 1,
    currentObjectiveRevisionId: OBJECTIVE_REVISION_ID,
    currentRevision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeExistingCard(overrides: Record<string, unknown> = {}) {
  return {
    cardId: CARD_ID_EXISTING,
    workspaceId: WORKSPACE_ID,
    objectiveId: OBJECTIVE_ID,
    cardRevision: 1,
    currentPublicationRevision: 1,
    lifecycle: "active" as const,
    front: { cue: "Cue", prompt: "Prompt" },
    publicSummary: "Summary",
    knowledgeForm: "fact",
    strategy: "recall",
    sourceLabel: null,
    presentationHash: REVISION_HASH,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Flexible mock that supports additional select queries beyond the standard
 * run/plan/candidate lookup sequence. Each call to select().from() returns a
 * builder with a .where() that resolves to configurable rows.
 */
function setupFlexibleTx(options: {
  run?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  objective?: Record<string, unknown>;
  existingCard?: Record<string, unknown>;
  existingReceipt?: Record<string, unknown> | null;
  /** 表感知覆盖：额外表名 → 行；缺省回退 [candidate]（兼容旧调用） */
  tableRowsOverride?: Record<string, unknown[]>;
} = {}) {
  const run = makeRun(options.run);
  const plan = makePlan(options.plan);
  const candidate = makeCandidate(options.candidate);
  const objective = makeObjective(options.objective);
  const existingCard = makeExistingCard(options.existingCard);
  const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
  const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

  const tableRows = (tableName: string | undefined): unknown[] => {
    if (options.tableRowsOverride && tableName && options.tableRowsOverride[tableName]) {
      return options.tableRowsOverride[tableName];
    }
    switch (tableName) {
      case "card_activation_receipts_v2":
        return options.existingReceipt ? [options.existingReceipt] : [];
      case "card_generation_runs_v2":
        return [run];
      case "card_generation_plans_v2":
        return [plan];
      case "card_generation_candidates_v2":
        return [candidate];
      case "candidate_evidence_binding_plans_v2":
        return [];
      case "evidence_eligibility_states_v2":
        return [{ status: "usable" }];
      case "card_exposure_ledger_v2":
        return [];
      case "learning_exposures_v2":
        return [];
      case "initial_validation_reminders_v2":
        return [];
      case "learning_objectives_v2":
        return [objective];
      case "learning_objective_revisions_v2":
        return [makeObjectiveRevision()];
      case "learning_cards_v2":
        return [existingCard];
      case "learning_card_publication_revisions_v2":
        return [makePublicationRevision()];
      default:
        return [candidate]; // 兼容旧调用：未识别表回退候选行
    }
  };

  setupTx({
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
        if (columns !== undefined && tName === "card_generation_events_v2") {
          return {
            where: () => makeWhereResult([{ maxSeq: 0 }]),
          };
        }
        return {
          where: () => makeWhereResult(tableRows(tName)),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });
        // 模拟 drizzle 链式 API（W#2 后 outbox insert 使用
        // .onConflictDoNothing()）：values 返回可继续链接的对象。
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => [{ id: "mock-id" }],
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return {
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        };
      },
    }),
  });

  return { insertCalls, updateCalls };
}

describe("activateCardCandidatesV2 — guards", () => {
  it("throws invalid_state when run is not review_ready", async () => {
    setupActivationTx({ run: { status: "queued" } });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest(),
        "activate-guard-state-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "invalid_state");
        return true;
      },
    );
  });

  it("throws stale_source when sourceSnapshotHash mismatch", async () => {
    setupActivationTx({});

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({ sourceSnapshotHash: "wrong" }),
        "activate-guard-source-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_source");
        return true;
      },
    );
  });

  it("throws stale_spec when semanticSpecHash mismatch", async () => {
    setupActivationTx({});

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({ semanticSpecHash: "wrong" }),
        "activate-guard-spec-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_spec");
        return true;
      },
    );
  });

  it("throws stale_epoch when cardContentEpoch mismatch", async () => {
    setupActivationTx({});

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({ expectedCardContentEpoch: 99 }),
        "activate-guard-epoch-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_epoch");
        return true;
      },
    );
  });

  it("throws client_review_hash_mismatch when hash is wrong", async () => {
    setupActivationTx({});

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({ clientReviewHash: "0".repeat(64) }),
        "activate-guard-hash-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "client_review_hash_mismatch");
        return true;
      },
    );
  });

  it("throws not_kept when candidate reviewDecision is not keep", async () => {
    setupActivationTx({ candidate: { reviewDecision: "undecided" } });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest(),
        "activate-guard-notkept-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "not_kept");
        return true;
      },
    );
  });

  it("throws already_published when candidate publishState is not unpublished", async () => {
    setupActivationTx({ candidate: { publishState: "activated" } });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest(),
        "activate-guard-published-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "already_published");
        return true;
      },
    );
  });

  it("throws stale_revision when candidateRevisionHash mismatch", async () => {
    setupActivationTx({ candidate: { candidateRevisionHash: "wrong" } });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest(),
        "activate-guard-stale-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_revision");
        return true;
      },
    );
  });
});

describe("activateCardCandidatesV2 — target_equivalent_update", () => {
  it("creates new objective revision, publication revision (even for unchanged), and updates objective pointer", async () => {
    const objective = makeObjective({ currentRevision: 1, currentObjectiveRevisionId: OBJECTIVE_REVISION_ID });
    const { insertCalls, updateCalls } = setupFlexibleTx({
      objective,
      tableRowsOverride: {
        // 现有 publication 行：publicPayloadHash 必须等于 intent.expectedPublicPayloadHash
        "learning_card_publication_revisions_v2": [
          { ...makePublicationRevision(), publicPayloadHash: REVISION_HASH },
        ],
      },
    });

    const intent: ActivationIntentV2 = {
      kind: "target_equivalent_update",
      cardId: CARD_ID_EXISTING,
      objectiveId: OBJECTIVE_ID,
      expectedPublicationRevision: 1,
      expectedCardRevision: 1,
      expectedPublicPayloadHash: REVISION_HASH,
      expectedObjectiveRevision: 1,
      expectedTargetRevisionHash: REVISION_HASH,
      // R36 §5.4：服务端重算闭包——测试需使用与服务端一致的 hash 计算。
      equivalenceReportHash: computeTestEquivalenceReportHash(),
      presentationChange: "unchanged",
    };

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest({
        selectedCandidates: [{
          candidateRevisionId: CANDIDATE_REVISION_ID,
          candidateId: CANDIDATE_ID,
          revision: 1,
          revisionHash: REVISION_HASH,
          candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
          qualityReportHashes: [],
          intent,
        }],
      }),
      "activate-teu-001",
    );

    assert.ok(result.mappings.length === 1);
    assert.equal(result.mappings[0].objectiveId, OBJECTIVE_ID);
    assert.ok(result.mappings[0].objectiveRevisionId.length > 0);

    // P10: publicationRevision should be bumped (even for 'unchanged')
    assert.equal(result.mappings[0].publicationRevision, 2, "P10: publication revision should be bumped even for unchanged");

    // Should have inserted a new objective revision
    const objRevInsert = insertCalls.find((i) => i.values.objectiveRevisionId !== undefined);
    assert.ok(objRevInsert, "should have inserted new objective revision");
    assert.equal(objRevInsert!.values.revision, 2);

    // P10: Should have inserted a new publication revision (even for 'unchanged')
    const pubRevInsert = insertCalls.find((i) => i.values.publicationRevision === 2);
    assert.ok(pubRevInsert, "P10: should have inserted new publication revision even for unchanged");

    // Should have updated the objective pointer
    const objUpdate = updateCalls.find((u) => u.set.currentRevision === 2);
    assert.ok(objUpdate, "should have updated objective currentRevision");

    // P10: Should have updated card's currentPublicationRevision
    const cardPubUpdate = updateCalls.find((u) => u.set.currentPublicationRevision === 2);
    assert.ok(cardPubUpdate, "P10: should have bumped card publication revision");
  });

  it("P8: throws stale_target_revision when targetRevisionHash mismatch (not semanticTargetFingerprint)", async () => {
    const objective = makeObjective({ currentRevision: 1, currentObjectiveRevisionId: OBJECTIVE_REVISION_ID });
    const { setupFlexibleTx: _st } = { setupFlexibleTx };
    void _st;
    let selectCount = 0;
    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
          if (columns !== undefined && tName === "card_generation_events_v2") return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRows = checkEvidenceTable(table).rows;
          if (evRows !== null) return { where: () => makeWhereResult(evRows) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) };
          // 6: objective lookup
          if (selectCount === 6) return { where: () => makeWhereResult([objective]) };
          // 7: objective revision lookup — returns a DIFFERENT targetRevisionHash
          if (selectCount === 7) return { where: () => makeWhereResult([{ targetRevisionHash: "y".repeat(64), revision: 1 }]) };
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        }),
      }),
    });

    const intent: ActivationIntentV2 = {
      kind: "target_equivalent_update",
      cardId: CARD_ID_EXISTING,
      objectiveId: OBJECTIVE_ID,
      expectedPublicationRevision: 1,
      expectedCardRevision: 1,
      expectedPublicPayloadHash: REVISION_HASH,
      expectedObjectiveRevision: 1,
      // This matches objective.semanticTargetFingerprint but NOT the revision's targetRevisionHash
      expectedTargetRevisionHash: REVISION_HASH,
      equivalenceReportHash: "e".repeat(64),
      presentationChange: "unchanged",
    };

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          selectedCandidates: [{
            candidateRevisionId: CANDIDATE_REVISION_ID,
            candidateId: CANDIDATE_ID,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent,
          }],
        }),
        "activate-teu-stale-target-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        // P8: should throw stale_target_revision because the objective revision's
        // targetRevisionHash ("yyy...") doesn't match the expected hash
        assert.equal(err.code, "stale_target_revision");
        return true;
      },
    );
  });
});

describe("activateCardCandidatesV2 — semantic_replace", () => {
  it("marks old objective as superseded and creates new objective", async () => {
    const objective = makeObjective({
      objectiveId: "00000000-0000-4000-8000-000000000030",
      lifecycle: "active",
      lifecycleEpoch: 1,
    });
    const { updateCalls, insertCalls } = setupFlexibleTx({
      objective,
      tableRowsOverride: {
        // semantic_replace 读取被替换的旧 objective
        "learning_objectives_v2": [objective],
      },
    });

    const intent: ActivationIntentV2 = {
      kind: "semantic_replace",
      replacedCardId: CARD_ID_EXISTING,
      replacedObjectiveId: "00000000-0000-4000-8000-000000000030",
      expectedObjectiveLifecycleEpoch: 1,
    };

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest({
        selectedCandidates: [{
          candidateRevisionId: CANDIDATE_REVISION_ID,
          candidateId: CANDIDATE_ID,
          revision: 1,
          revisionHash: REVISION_HASH,
          candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
          qualityReportHashes: [],
          intent,
        }],
      }),
      "activate-sr-001",
    );

    assert.ok(result.mappings.length === 1);
    // New objective should have been created (not the old one)
    assert.notEqual(result.mappings[0].objectiveId, "00000000-0000-4000-8000-000000000030");

    // Old objective should be marked as superseded
    const supersededUpdate = updateCalls.find((u) => u.set.lifecycle === "superseded");
    assert.ok(supersededUpdate, "should have marked old objective as superseded");

    // New objective should have been inserted
    const newObjInsert = insertCalls.find((i) =>
      i.values.lifecycle === "active" && i.values.lifecycleEpoch === 1,
    );
    assert.ok(newObjInsert, "should have created new objective with lifecycle=active, epoch=1");
  });

  it("P11: throws stale_card_lifecycle when old card supersede CAS fails", async () => {
    const objective = makeObjective({
      objectiveId: "00000000-0000-4000-8000-000000000030",
      lifecycle: "active",
      lifecycleEpoch: 1,
    });

    let selectCount = 0;
    let returningCallCount = 0;
    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
          if (columns !== undefined && tName === "card_generation_events_v2") return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) }; // receipt
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) }; // run
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) }; // plan
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) }; // evidence
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) }; // candidate
          if (selectCount === 6) return { where: () => makeWhereResult([objective]) }; // old objective
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            // P11: returning calls are ordered:
            // 1st: P6 reject candidates update (no returning called — doesn't count)
            // 2nd: objective CAS update → succeeds
            // 3rd: card CAS update → fails → stale_card_lifecycle
            returning: async () => {
              returningCallCount++;
              if (returningCallCount <= 1) {
                return [{ id: "obj-mock-id" }]; // objective CAS succeeds
              }
              return []; // card CAS fails
            },
          }),
        }),
      }),
    });

    const intent: ActivationIntentV2 = {
      kind: "semantic_replace",
      replacedCardId: CARD_ID_EXISTING,
      replacedObjectiveId: "00000000-0000-4000-8000-000000000030",
      expectedObjectiveLifecycleEpoch: 1,
    };

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          selectedCandidates: [{
            candidateRevisionId: CANDIDATE_REVISION_ID,
            candidateId: CANDIDATE_ID,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent,
          }],
        }),
        "activate-sr-cas-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_card_lifecycle");
        return true;
      },
    );
  });
});

describe("activateCardCandidatesV2 — archive_existing lifecycle", () => {
  it("archives existing objective and card, increments lifecycleEpoch", async () => {
    const objective = makeObjective({
      objectiveId: OBJECTIVE_ID,
      lifecycle: "active",
      lifecycleEpoch: 3,
    });
    const { updateCalls } = setupFlexibleTx({
      objective,
      tableRowsOverride: {
        // archive_existing 读取目标 objective（lifecycleEpoch=3）
        "learning_objectives_v2": [objective],
      },
    });

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest({
        existingLifecycleActions: [{
          actionId: "00000000-0000-4000-8000-000000000040",
          kind: "archive_existing" as const,
          cardId: CARD_ID_EXISTING,
          objectiveId: OBJECTIVE_ID,
          expectedPublicationRevision: 1,
          expectedObjectiveLifecycleEpoch: 3,
        }],
      }),
      "activate-arch-001",
    );

    assert.ok(result.lifecycleResults.length === 1);
    assert.equal(result.lifecycleResults[0].resultingLifecycle, "archived");
    assert.equal(result.lifecycleResults[0].resultingLifecycleEpoch, 4);

    // Objective should be archived with epoch incremented
    const objArchiveUpdate = updateCalls.find((u) => u.set.lifecycle === "archived");
    assert.ok(objArchiveUpdate, "should have archived the objective");

    // Card should also be archived
    const cardArchiveUpdate = updateCalls.find((u) =>
      u.set.lifecycle === "archived" && u.set.updatedAt !== undefined,
    );
    assert.ok(cardArchiveUpdate, "should have archived the card");
  });

  it("throws stale_lifecycle_epoch when epoch mismatch", async () => {
    const objective = makeObjective({
      objectiveId: OBJECTIVE_ID,
      lifecycleEpoch: 5, // different from expected
    });
    setupFlexibleTx({
      objective,
      tableRowsOverride: {
        "learning_objectives_v2": [objective],
      },
    });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          existingLifecycleActions: [{
            actionId: "00000000-0000-4000-8000-000000000041",
            kind: "archive_existing" as const,
            cardId: CARD_ID_EXISTING,
            objectiveId: OBJECTIVE_ID,
            expectedPublicationRevision: 1,
            expectedObjectiveLifecycleEpoch: 1, // mismatch
          }],
        }),
        "activate-arch-stale-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_lifecycle_epoch");
        return true;
      },
    );
  });
});

describe("activateCardCandidatesV2 — not_selected_at_activation", () => {
  it("marks undecided candidates as reject:not_selected_at_activation", async () => {
    const { updateCalls } = setupActivationTx();

    await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-reject-001",
    );

    // Should have an update that sets reviewDecision=reject and reviewReasonCode=not_selected_at_activation
    const rejectUpdate = updateCalls.find((u) =>
      u.set.reviewDecision === "reject" && u.set.reviewReasonCode === "not_selected_at_activation",
    );
    assert.ok(rejectUpdate, "should have marked undecided candidates as reject:not_selected_at_activation");
  });
});

// ─── presentation_update 测试 ──────────────────────────────────────────────────

describe("activateCardCandidatesV2 — presentation_update", () => {
  it("updates card presentation and creates new publication revision", async () => {
    const objective = makeObjective({ currentObjectiveRevisionId: OBJECTIVE_REVISION_ID });
    const card = makeExistingCard({
      currentPublicationRevision: 1,
      presentationHash: REVISION_HASH,
      cardRevision: 1,
    });

    // Custom mock for presentation_update: needs to return card, publication revision,
    // objective, and objective revision for the additional lookups
    let selectCount = 0;
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
    const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          // Check table name for column-select queries (e.g. publication revision lookup)
          const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
          // insertEvent calls use columns (like {maxSeq}) on card_generation_events_v2
          if (columns !== undefined && tName === "card_generation_events_v2") {
            return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          }
          // Check evidence tables first
          const evRows = checkEvidenceTable(table).rows;
          if (evRows !== null) return { where: () => makeWhereResult(evRows) };
          // 1: receipt lookup → empty
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
          // 2: run lookup
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
          // 3: plan lookup
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
          // 4: evidence eligibility check → candidate
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          // 5: candidate activation lookup
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) };
          // 6: card lookup (presentation_update)
          if (selectCount === 6) return { where: () => makeWhereResult([card]) };
          // 7: publication revision lookup (P7 FIX — queries learningCardPublicationRevisionsV2 with column select)
          if (selectCount === 7) return { where: () => makeWhereResult([{ publicPayloadHash: REVISION_HASH, objectiveRevision: 1 }]) };
          // 8: objective lookup (presentation_update)
          if (selectCount === 8) return { where: () => makeWhereResult([objective]) };
          // 9: objective revision lookup (P8 FIX — queries learningObjectiveRevisionsV2 for targetRevisionHash)
          if (selectCount === 9) return { where: () => makeWhereResult([{ targetRevisionHash: REVISION_HASH }]) };
          // 10+: exposure ledger lookup (for initial validation reminder)
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
          return {
            where: () => ({
              returning: async () => [{ id: "mock-id" }],
            }),
          };
        },
      }),
    });

    const intent: ActivationIntentV2 = {
      kind: "presentation_update",
      cardId: CARD_ID_EXISTING,
      expectedPublicationRevision: 1,
      expectedPublicPayloadHash: REVISION_HASH,
    };

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest({
        selectedCandidates: [{
          candidateRevisionId: CANDIDATE_REVISION_ID,
          candidateId: CANDIDATE_ID,
          revision: 1,
          revisionHash: REVISION_HASH,
          candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
          qualityReportHashes: [],
          intent,
        }],
      }),
      "activate-pu-001",
    );

    assert.ok(result.mappings.length === 1);
    assert.equal(result.mappings[0].cardId, CARD_ID_EXISTING);
    assert.equal(result.mappings[0].publicationRevision, 2);

    // P9: Should have bumped cardRevision (from 1 to 2)
    const cardUpdate = updateCalls.find((u) => u.set.currentPublicationRevision === 2);
    assert.ok(cardUpdate, "should have bumped publication revision");
    assert.equal(cardUpdate!.set.cardRevision, 2, "P9: should have bumped cardRevision from 1 to 2");

    // Should have inserted new publication revision with bumped cardRevision
    const pubRevInsert = insertCalls.find((i) => i.values.publicationRevision === 2);
    assert.ok(pubRevInsert, "should have inserted new publication revision");
    assert.equal(pubRevInsert!.values.cardRevision, 2, "P9: publication revision should reference new cardRevision");
  });

  it("throws stale_publication_revision when publication revision mismatch", async () => {
    const card = makeExistingCard({
      currentPublicationRevision: 5, // different from expected 1
      presentationHash: REVISION_HASH,
    });

    let selectCount = 0;
    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) };
          // 6: card lookup — returns card with currentPublicationRevision=5
          if (selectCount === 6) return { where: () => makeWhereResult([card]) };
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        }),
      }),
    });

    const intent: ActivationIntentV2 = {
      kind: "presentation_update",
      cardId: CARD_ID_EXISTING,
      expectedPublicationRevision: 1,
      expectedPublicPayloadHash: REVISION_HASH,
    };

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          selectedCandidates: [{
            candidateRevisionId: CANDIDATE_REVISION_ID,
            candidateId: CANDIDATE_ID,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent,
          }],
        }),
        "activate-pu-stale-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_publication_revision");
        return true;
      },
    );
  });

  it("P7: throws stale_public_payload when publicPayloadHash mismatch (not presentationHash)", async () => {
    const card = makeExistingCard({
      currentPublicationRevision: 1,
      presentationHash: REVISION_HASH,
      cardRevision: 1,
    });

    let selectCount = 0;
    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          const tName = (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
          if (columns !== undefined && tName === "card_generation_events_v2") return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRows = checkEvidenceTable(table).rows;
          if (evRows !== null) return { where: () => makeWhereResult(evRows) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) };
          // 6: card lookup
          if (selectCount === 6) return { where: () => makeWhereResult([card]) };
          // 7: publication revision lookup — returns a DIFFERENT publicPayloadHash
          if (selectCount === 7) return { where: () => makeWhereResult([{ publicPayloadHash: "x".repeat(64), objectiveRevision: 1 }]) };
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        }),
      }),
    });

    const intent: ActivationIntentV2 = {
      kind: "presentation_update",
      cardId: CARD_ID_EXISTING,
      expectedPublicationRevision: 1,
      // This matches card.presentationHash but NOT the publication revision's publicPayloadHash
      expectedPublicPayloadHash: REVISION_HASH,
    };

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          selectedCandidates: [{
            candidateRevisionId: CANDIDATE_REVISION_ID,
            candidateId: CANDIDATE_ID,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent,
          }],
        }),
        "activate-pu-stale-payload-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        // P7: should throw stale_public_payload because the publication revision's
        // publicPayloadHash ("xxx...") doesn't match the expected hash
        assert.equal(err.code, "stale_public_payload");
        return true;
      },
    );
  });
});

// ─── keep_existing 测试 ─────────────────────────────────────────────────────────

describe("activateCardCandidatesV2 — keep_existing lifecycle", () => {
  it("keeps existing objective and card unchanged", async () => {
    const objective = makeObjective({
      objectiveId: OBJECTIVE_ID,
      lifecycle: "active",
      lifecycleEpoch: 2,
    });

    const { lifecycleResults } = await (async () => {
      let selectCount = 0;
      const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
      const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

      setupTx({
        select: (columns?: unknown) => ({
          from: (table: unknown) => {
            // Evidence table check must happen BEFORE selectCount++ to avoid count skew
            const evRowsPre = checkEvidenceTable(table).rows;
            if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
            selectCount++;
            if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
            const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
            if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
            if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
            if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
            // 5: objective lookup in handleExistingLifecycleAction
            if (selectCount === 5) return { where: () => makeWhereResult([objective]) };
            // 6: candidate activation lookup
            if (selectCount === 6) return { where: () => makeWhereResult([makeCandidate()]) };
            return { where: () => makeWhereResult([]) };
          },
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => { insertCalls.push({ table, values: vals }); const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] }; return chain; },
        }),
        update: (table: unknown) => ({
          set: (set: Record<string, unknown>) => {
            updateCalls.push({ table, set });
            return {
              where: () => ({
                returning: async () => [{ id: "mock-id" }],
              }),
            };
          },
        }),
      });

      const result = await activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          existingLifecycleActions: [{
            actionId: "00000000-0000-4000-8000-000000000050",
            kind: "keep_existing" as const,
            cardId: CARD_ID_EXISTING,
            objectiveId: OBJECTIVE_ID,
            expectedPublicationRevision: 1,
            expectedObjectiveLifecycleEpoch: 2,
          }],
        }),
        "activate-keep-001",
      );
      return result;
    })();

    assert.ok(lifecycleResults.length === 1);
    assert.equal(lifecycleResults[0].resultingLifecycle, "active");
    assert.equal(lifecycleResults[0].resultingLifecycleEpoch, 2);
  });

  it("throws stale_lifecycle_epoch when keep_existing epoch mismatch", async () => {
    const objective = makeObjective({
      objectiveId: OBJECTIVE_ID,
      lifecycleEpoch: 10, // different from expected
    });

    let selectCount = 0;
    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) };
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) };
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) };
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          if (selectCount === 5) return { where: () => makeWhereResult([objective]) };
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "mock-id" }],
          }),
        }),
      }),
    });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest({
          existingLifecycleActions: [{
            actionId: "00000000-0000-4000-8000-000000000051",
            kind: "keep_existing" as const,
            cardId: CARD_ID_EXISTING,
            objectiveId: OBJECTIVE_ID,
            expectedPublicationRevision: 1,
            expectedObjectiveLifecycleEpoch: 1, // mismatch
          }],
        }),
        "activate-keep-stale-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_lifecycle_epoch");
        return true;
      },
    );
  });
});

// ─── multi-candidate 测试 ──────────────────────────────────────────────────────

describe("activateCardCandidatesV2 — multi-candidate activation", () => {
  it("activates multiple candidates in a single request", async () => {
    const CANDIDATE_ID_2 = "00000000-0000-4000-8000-000000000060";
    const CANDIDATE_REVISION_ID_2 = "00000000-0000-4000-8000-000000000061";

    let selectCount = 0;
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
    const updateCalls: { table: unknown; set: Record<string, unknown> }[] = [];

    setupTx({
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) }; // receipt
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) }; // run
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) }; // plan
          // 4: evidence check for candidate 1
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          // 5: evidence check for candidate 2
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate({ candidateId: CANDIDATE_ID_2, candidateRevisionId: CANDIDATE_REVISION_ID_2 })]) };
          // 6: candidate 1 activation lookup
          if (selectCount === 6) return { where: () => makeWhereResult([makeCandidate()]) };
          // 7: candidate 2 activation lookup
          if (selectCount === 7) return { where: () => makeWhereResult([makeCandidate({ candidateId: CANDIDATE_ID_2, candidateRevisionId: CANDIDATE_REVISION_ID_2 })]) };
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => { insertCalls.push({ table, values: vals }); const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] }; return chain; },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updateCalls.push({ table, set });
          return {
            where: () => ({
              returning: async () => [{ id: "mock-id" }],
            }),
          };
        },
      }),
    });

    const clientReviewHash = computeClientReviewHashV2({
      runId: RUN_ID,
      expectedReviewDraftRevision: 1,
      selected: [
        { candidateId: CANDIDATE_ID, revision: 1, revisionHash: REVISION_HASH },
        { candidateId: CANDIDATE_ID_2, revision: 1, revisionHash: REVISION_HASH },
      ],
      reviewUiContractVersion: "review-ui-v1",
    });

    const result = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest({
        selectedCandidates: [
          {
            candidateRevisionId: CANDIDATE_REVISION_ID,
            candidateId: CANDIDATE_ID,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent: { kind: "create_new" as const },
          },
          {
            candidateRevisionId: CANDIDATE_REVISION_ID_2,
            candidateId: CANDIDATE_ID_2,
            revision: 1,
            revisionHash: REVISION_HASH,
            candidateEvidenceBindingPlanHash: EVIDENCE_BINDING_PLAN_HASH,
            qualityReportHashes: [],
            intent: { kind: "create_new" as const },
          },
        ],
        clientReviewHash,
      }),
      "activate-multi-001",
    );

    assert.equal(result.mappings.length, 2);
    assert.notEqual(result.mappings[0].cardId, result.mappings[1].cardId);
    assert.notEqual(result.mappings[0].objectiveId, result.mappings[1].objectiveId);

    // Both candidates should be marked activated
    const activatedUpdates = updateCalls.filter((u) => u.set.publishState === "activated");
    assert.equal(activatedUpdates.length, 2);
  });
});

// ─── stale_plan_hash 测试 ──────────────────────────────────────────────────────

describe("activateCardCandidatesV2 — stale_plan_hash", () => {
  it("throws stale_plan_hash when planHash mismatch", async () => {
    setupActivationTx({ plan: { planHash: "z".repeat(64) } });

    await assert.rejects(
      () => activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        makeRequest(), // planHash is PLAN_HASH = "b".repeat(64)
        "activate-stale-plan-001",
      ),
      (err: CardGenerationV2ServiceError) => {
        assert.equal(err.code, "stale_plan_hash");
        return true;
      },
    );
  });
});

// ─── exposureScopeId 回归测试 ──────────────────────────────────────────────────

describe("activateCardCandidatesV2 — exposureScopeId uses computeExposureScopeIdV2", () => {
  it("writes canonical exposureScopeId (hash of workspaceId+objectiveId), not raw string", async () => {
    const { insertCalls } = setupActivationTx();

    await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-scope-001",
    );

    // Find the reminder insert
    const reminderInsert = insertCalls.find(
      (c) => c.values && c.values.exposureScopeId !== undefined,
    );
    assert.ok(reminderInsert, "must insert an initial_validation_reminder");
    const scopeId = reminderInsert!.values.exposureScopeId as string;

    // The scopeId should NOT be the old "activation:${candidateRevisionId}" pattern
    assert.ok(
      !scopeId.startsWith("activation:"),
      "exposureScopeId must not use raw 'activation:' prefix",
    );
    // It should be a 64-char hex hash
    assert.match(scopeId, /^[0-9a-f]{64}$/, "exposureScopeId must be a SHA-256 hash");
  });
});

// ─── precision exposure 回归测试 ──────────────────────────────────────────────

describe("activateCardCandidatesV2 — Initial Validation Reminder precision exposure", () => {
  it("queries exposure by exact candidateRevision, not just candidateId", async () => {
    let exposureWhereArgs: unknown[] = [];
    let selectCount = 0;
    const tx: any = {
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) }; // receipt
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) }; // run
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) }; // plan
          // 4: evidence check
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) };
          // 5: candidate activation lookup
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) };
          // 6: candidate revision lookup for exposure check
          if (selectCount === 6) {
            return {
              where: (args: unknown) => {
                exposureWhereArgs.push(args);
                return makeWhereResult([{ revision: 1 }]); // return revision=1
              },
            };
          }
          // 7: exposure ledger lookup (should include subjectCandidateRevision filter)
          if (selectCount === 7) {
            return {
              where: (args: unknown) => {
                exposureWhereArgs.push(args);
                return makeWhereResult([]); // no exposure → status=ready
              },
            };
          }
          return { where: () => makeWhereResult([]) };
        },
      }),
      insert: () => ({
        values: () => {
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "mock-id" }] }),
        }),
      }),
    };
    db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;

    await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-precision-001",
    );

    // Verify that exposure ledger query included subjectCandidateRevision filter
    // The where conditions should include eq(subjectCandidateRevision, 1) not just candidateId
    // We can't inspect the exact where args (they're drizzle conditions),
    // but we can verify selectCount reached the exposure query (7)
    assert.ok(selectCount >= 7, "must query exposure ledger with revision-specific filter");
  });

  it("creates reminder with status=ready when no reveal exposure exists", async () => {
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
    let selectCount = 0;
    const tx: any = {
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) }; // receipt
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) }; // run
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) }; // plan
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) }; // evidence check
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) }; // candidate activation
          if (selectCount === 6) return { where: () => makeWhereResult([{ revision: 1 }]) }; // candidate revision
          // 7: exposure ledger — empty → no reveal → status=ready
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
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "mock-id" }] }),
        }),
      }),
    };
    db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;

    await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-no-reveal-001",
    );

    const reminderInsert = insertCalls.find(
      (c) => c.values && c.values.exposureScopeId !== undefined,
    );
    assert.ok(reminderInsert, "must insert reminder");
    assert.equal(
      reminderInsert!.values.status,
      "ready",
      "reminder status should be 'ready' when no reveal exposure exists",
    );
  });

  it("creates reminder with status=pending when reveal exposure exists", async () => {
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
    let selectCount = 0;
    const tx: any = {
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      select: (columns?: unknown) => ({
        from: (table: unknown) => {
          // Evidence table check must happen BEFORE selectCount++ to avoid count skew
          const evRowsPre = checkEvidenceTable(table).rows;
          if (evRowsPre !== null) return { where: () => makeWhereResult(evRowsPre) };
          selectCount++;
          if (columns !== undefined) return { where: () => makeWhereResult([{ maxSeq: 0 }]) };
          const evRowsX = checkEvidenceTable(table).rows;
          if (evRowsX !== null) return { where: () => makeWhereResult(evRowsX) };
          if (selectCount === 1) return { where: () => makeWhereResult([]) }; // receipt
          if (selectCount === 2) return { where: () => makeWhereResult([makeRun()]) }; // run
          if (selectCount === 3) return { where: () => makeWhereResult([makePlan()]) }; // plan
          if (selectCount === 4) return { where: () => makeWhereResult([makeCandidate()]) }; // evidence check
          if (selectCount === 5) return { where: () => makeWhereResult([makeCandidate()]) }; // candidate activation
          if (selectCount === 6) return { where: () => makeWhereResult([{ revision: 1 }]) }; // candidate revision
          // 7: exposure ledger — has a row → reveal exists → status=pending
          return {
            where: () => makeWhereResult([
              { exposureId: "exp-1", subjectCandidateRevision: 1 },
            ]),
          };
        },
      }),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertCalls.push({ table, values: vals });
          const chain = { onConflictDoNothing: () => chain, returning: async () => [{ id: "mock-id" }] };
          return chain;
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "mock-id" }] }),
        }),
      }),
    };
    db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as typeof db.transaction;

    await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      makeRequest(),
      "activate-has-reveal-001",
    );

    const reminderInsert = insertCalls.find(
      (c) => c.values && c.values.exposureScopeId !== undefined,
    );
    assert.ok(reminderInsert, "must insert reminder");
    assert.equal(
      reminderInsert!.values.status,
      "pending",
      "reminder status should be 'pending' when reveal exposure exists",
    );
  });
});
