/**
 * Phase C（设计 §5.4）：run 视图 metrics 聚合测试。
 *
 * 通过 mock db.transaction 验证 toRunView 的 buildRunMetrics：
 * - bundles / childTasks / candidates 计数来自对应表聚合
 * - draft.version + producedByRole 来自 drafts + units
 * - critic status/hard/soft 来自最新 quality report
 * - verify passed/total 来自 verify:* 事件
 * - semanticIndex.mode 来自 run.embeddingProfileVersion
 * - usageTokens 来自 run.usageSummary
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { getCardGenerationRun } from "../modules/card-generation/service.ts";
import { cardGenerationSourceBundles, cardGenerationUnits, cardGenerationCandidates } from "../db/schema/card-generation.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const mutableDb = db as unknown as { transaction: unknown };

interface MockMetricsTxOptions {
  run?: Record<string, unknown>;
  bundles?: Array<Record<string, number>>;
  units?: Array<Record<string, number>>;
  candidates?: Array<Record<string, number>>;
  draft?: Record<string, unknown> | null;
  producer?: Record<string, unknown> | null;
  report?: Record<string, unknown> | null;
  verifyEvent?: Record<string, unknown> | null;
}

function makeMockTx(opts: MockMetricsTxOptions = {}) {
  const tx: Record<string, unknown> = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    query: {
      cardGenerationRuns: {
        findFirst: async () => opts.run ?? null,
      },
      noteVersions: {
        findFirst: async () => ({ id: "v1", workspaceId: WORKSPACE_ID, versionNo: 3 }),
      },
      cardGenerationUnits: {
        findFirst: async () => opts.producer ?? null,
      },
      cardGenerationDrafts: {
        findFirst: async () => opts.draft ?? null,
      },
      cardGenerationQualityReports: {
        findFirst: async () => opts.report ?? null,
      },
      cardGenerationAgentEvents: {
        findFirst: async () => opts.verifyEvent ?? null,
      },
    },
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === cardGenerationSourceBundles ? (opts.bundles ?? [])
            : table === cardGenerationUnits ? (opts.units ?? [])
              : table === cardGenerationCandidates ? (opts.candidates ?? [])
                : [];
        return { where: async () => rows };
      },
    }),
  };
  return async (operation: (t: unknown) => Promise<unknown>) => operation(tx);
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    noteId: "00000000-0000-4000-8000-000000000010",
    noteVersionId: "00000000-0000-4000-8000-000000000011",
    status: "running",
    stage: "generating",
    stateVersion: 2,
    nextEventSequence: 5,
    engineMode: "supervisor_agent_v1",
    shellStage: "generating",
    sourceContentHash: "hash",
    sourceSnapshot: {},
    titleSnapshot: "t",
    blockManifestHash: "bm",
    assetManifestHash: "am",
    blockManifest: [],
    assetManifest: [],
    generationEpoch: 1,
    generationFingerprint: "fp",
    requestIdempotencyKey: "key",
    requestedBy: USER_ID,
    retryable: false,
    resultCardId: null,
    resultCardSetId: null,
    errorCode: null,
    requiredImages: 0,
    requiredUnits: 0,
    completedUnits: 0,
    completedImages: 0,
    sourceCoverageBps: null,
    imageCoverageBps: null,
    coverageReport: {},
    providerCapabilityFingerprint: null,
    embeddingProfileVersion: "vector",
    usageSummary: { inputTokens: 80_000, outputTokens: 40_000 },
    createdAt: new Date("2026-08-06T08:00:00Z"),
    updatedAt: new Date("2026-08-06T08:00:00Z"),
    startedAt: new Date("2026-08-06T08:00:01Z"),
    finishedAt: null,
    ...overrides,
  };
}

const originalTransaction = mutableDb.transaction;

beforeEach(() => {
  mutableDb.transaction = makeMockTx();
});

afterEach(() => {
  mutableDb.transaction = originalTransaction;
});

describe("toRunView — metrics 聚合", () => {
  it("聚合全部计数维度", async () => {
    mutableDb.transaction = makeMockTx({
      run: makeRunRow(),
      bundles: [{ planned: 3, assigned: 9, decided: 8, required: 12 }],
      units: [{ pending: 1, running: 2, completed: 4, failed: 0 }],
      candidates: [{ extracted: 5, canonical: 3, eligible: 4, rejected: 1 }],
      draft: { draftVersion: 2, producedByUnitId: "unit-deck" },
      producer: { kind: "deck_composer" },
      report: { criticStatus: "passed", hardIssues: [], softIssues: [{}, {}] },
      verifyEvent: { safePayload: { passed: true, checks: [{ passed: true }, { passed: true }, { passed: false }] } },
    });

    const view = await getCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(view);
    assert.deepEqual(view!.metrics?.bundles, { planned: 3, assigned: 9, decided: 8, required: 12 });
    assert.deepEqual(view!.metrics?.childTasks, { pending: 1, running: 2, completed: 4, failed: 0 });
    assert.deepEqual(view!.metrics?.candidates, { extracted: 5, canonical: 3, eligible: 4, rejected: 1 });
    assert.equal(view!.metrics?.draft.version, 2);
    assert.equal(view!.metrics?.draft.producedByRole, "deck_composer");
    assert.equal(view!.metrics?.critic.status, "passed");
    assert.equal(view!.metrics?.critic.hardIssues, 0);
    assert.equal(view!.metrics?.critic.softIssues, 2);
    assert.deepEqual(view!.metrics?.verify, { passedChecks: 2, totalChecks: 3 });
    assert.equal(view!.metrics?.semanticIndex.mode, "vector");
    assert.equal(view!.metrics?.usageTokens, 120_000);
  });

  it("空数据时全部回退 0/null", async () => {
    mutableDb.transaction = makeMockTx({
      run: makeRunRow({ embeddingProfileVersion: null, usageSummary: null }),
      draft: null,
      report: null,
      verifyEvent: null,
    });

    const view = await getCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(view);
    assert.deepEqual(view!.metrics?.bundles, { planned: 0, assigned: 0, decided: 0, required: 0 });
    assert.deepEqual(view!.metrics?.childTasks, { pending: 0, running: 0, completed: 0, failed: 0 });
    assert.deepEqual(view!.metrics?.candidates, { extracted: 0, canonical: 0, eligible: 0, rejected: 0 });
    assert.equal(view!.metrics?.draft.version, 0);
    assert.equal(view!.metrics?.draft.producedByRole, null);
    assert.equal(view!.metrics?.critic.status, null);
    assert.equal(view!.metrics?.verify, null);
    assert.equal(view!.metrics?.semanticIndex.mode, null);
    assert.equal(view!.metrics?.usageTokens, null);
  });
});
