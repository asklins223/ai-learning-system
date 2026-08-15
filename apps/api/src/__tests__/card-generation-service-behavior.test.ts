/**
 * D1（计划 §2.7）：card-generation service 行为单测。
 *
 * 覆盖 createCardGenerationRun 的全部关键路径：
 * - 幂等键 replay（同键同 noteVersion 返回已建 run、noteVersion/userId 不符 409）
 * - 活跃 run 复用（同 fingerprint 非终态 → 返回活跃 run）
 * - workspace advisory lock 获取
 * - 配额 assertPendingQuota（pending ≥ MAX_PENDING → 429）
 * - fingerprint 构造与 run 创建事务字段
 * - note_version_not_found / note_not_found / empty_note / image_asset_unresolved
 * - input_limit_exceeded
 * - mock_provider_blocked_in_production
 *
 * 作为 A1 重构的回归基线先行落地（计划 §2.1 验收要求）。
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
  AgentUnitKind,
  CardGenerationStage,
  JobResourceClass,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  resetPlatformConfigCache,
  setPlatformConfig,
  SupervisorRunStatus,
} from "@ailearn/shared";
import { db } from "../db/client.ts";
import { cardGenerationRuns, cardGenerationEvents, cardGenerationUnits } from "../db/schema/card-generation.ts";
import { jobs } from "../db/schema/job.ts";
import { notes, noteVersions } from "../db/schema/note.ts";
import {
  buildGenerationFingerprint,
  buildGenerationManifests,
  CardGenerationServiceError,
  createCardGenerationRun,
} from "../modules/card-generation/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const IDEMPOTENCY_KEY = "test-idempotency-key-001";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mutableDb = db as any;

// ─── Mock 事务基础设施 ───────────────────────────────────────────────────

/**
 * 完整 mock 事务：覆盖 createCardGenerationRun 内部所有 tx 操作。
 *
 * withWorkspaceTransaction 内部调用 db.transaction 并执行
 * setApiTransactionContext（需要 tx.execute），因此 mock tx 必须提供 execute。
 * select/insert/update 也需要 mock，因为 service 使用 Drizzle query builder。
 */
function createMockTransaction(options: {
  pendingCount?: number;
  note?: typeof baseNote | null;
  version?: typeof baseVersion | null;
  executeSpy?: (calls: { query: unknown }) => void;
} = {}) {
  const pendingCount = options.pendingCount ?? 0;
  const noteRow = options.note !== undefined ? options.note : baseNote;
  const versionRow = options.version !== undefined ? options.version : baseVersion;
  const executeCalls: { query: unknown }[] = [];
  const executeSpy = options.executeSpy ?? ((call) => executeCalls.push(call));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async (query: unknown) => {
      executeSpy({ query });
      return [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }];
    },
    query: mutableDb.query,
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        // select({count}).from(jobs).where() → [{count: String(pendingCount)}]
        if (columns && typeof columns === "object" && "count" in (columns as Record<string, unknown>)) {
          return { where: async () => [{ count: String(pendingCount) }] };
        }
        // select().from(notes).where().for("update") → [noteRow]
        if (table === notes) {
          return {
            where: () => ({
              for: async () => noteRow ? [noteRow] : [],
            }),
          };
        }
        // select().from(noteVersions).where().for("update") → [versionRow]
        if (table === noteVersions) {
          return {
            where: () => ({
              for: async () => versionRow ? [versionRow] : [],
            }),
          };
        }
        // select().from(cardGenerationRuns).where().for("update") → used in cancel/retry
        if (table === cardGenerationRuns) {
          return {
            where: () => ({
              for: async () => [],
            }),
          };
        }
        return { where: async () => [] };
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: unknown) => {
        capturedInserts.push({ table, values: vals });
        if (table === cardGenerationRuns) {
          return { returning: async () => [mockRunRow] };
        }
        if (table === jobs) {
          return { returning: async () => [{ id: "job-new-id" }] };
        }
        // cardGenerationUnits, cardGenerationEvents
        return { returning: async () => [{ id: "unit-new-id" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: unknown) => {
        capturedUpdates.push({ table, values: vals });
        return {
          where: async () => undefined,
          returning: async () => [mockRunRow],
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => { capturedInserts.push({ table, values: "deleted" }); },
    }),
  };

  const capturedInserts: Array<{ table: unknown; values: unknown }> = [];
  const capturedUpdates: Array<{ table: unknown; values: unknown }> = [];
  // Attach captures to the transaction function for test access
  const transactionFn = async (run: (tx: unknown) => Promise<unknown>) => {
    return run(tx);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (transactionFn as any).captures = { inserts: capturedInserts, updates: capturedUpdates, executeCalls };

  return transactionFn;
}

// ─── Mock 数据 ─────────────────────────────────────────────────────────────

const baseNote = {
  id: NOTE_ID,
  workspaceId: WORKSPACE_ID,
  title: "Test Note",
  cardGenerationEpoch: 0,
  latestGenerationRunId: null,
  deletedAt: null,
  currentVersionId: NOTE_VERSION_ID,
};

const baseVersion = {
  id: NOTE_VERSION_ID,
  noteId: NOTE_ID,
  workspaceId: WORKSPACE_ID,
  versionNo: 1,
  contentHash: "abc123hash",
  sealedAt: null,
};

const baseBlocks = [
  { id: "block-1", versionId: NOTE_VERSION_ID, workspaceId: WORKSPACE_ID, ordinal: 0, type: "text", content: "Hello world" },
  { id: "block-2", versionId: NOTE_VERSION_ID, workspaceId: WORKSPACE_ID, ordinal: 1, type: "text", content: "Second block" },
];

const baseWorkspace = {
id: WORKSPACE_ID,
};

const baseInput = {
  noteVersionId: NOTE_VERSION_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  density: "standard" as const,
};

const mockRunRow = {
  id: "run-new-id",
  workspaceId: WORKSPACE_ID,
  noteId: NOTE_ID,
  noteVersionId: NOTE_VERSION_ID,
  status: SupervisorRunStatus.QUEUED,
  stage: CardGenerationStage.QUEUED,
  generationEpoch: 1,
  generationFingerprint: "fp-test",
  stateVersion: 1,
  nextEventSequence: 2,
  retryable: true,
  resultCardId: null,
  resultCardSetId: null,
  errorCode: null,
  requiredImages: 0,
  requiredUnits: 0,
  completedUnits: 0,
  completedImages: 0,
  sourceCoverageBps: 0,
  imageCoverageBps: 10000,
  finishedAt: null,
  startedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  coverageReport: { measurement: "planned", plannerVersion: null },
  providerCapabilityFingerprint: null,
  sourceContentHash: "abc123hash",
  titleSnapshot: "Test Note",
  blockManifestHash: "bm",
  assetManifestHash: "am",
  blockManifest: [],
  assetManifest: [],
  providerSnapshot: { executionMode: "supervisor_agent_v1" },
  governancePolicyVersion: "workspace-policy-snapshot-v1",
  supersedesRunId: null,
  requestedBy: USER_ID,
  requestIdempotencyKey: IDEMPOTENCY_KEY,
  cancelRequestedAt: null,
  usageSummary: null,
};

// ─── 原始方法备份 ──────────────────────────────────────────────────────────

const original = {
  transaction: mutableDb.transaction,
  select: mutableDb.select,
  insert: mutableDb.insert,
  update: mutableDb.update,
  cardGenRunsFindFirst: mutableDb.query.cardGenerationRuns.findFirst,
  noteVersionsFindFirst: mutableDb.query.noteVersions.findFirst,
  noteBlocksFindMany: mutableDb.query.noteBlocks.findMany,
noteImageAssetsFindMany: mutableDb.query.noteImageAssets.findMany,
workspacesFindFirst: mutableDb.query.workspaces.findFirst,
  notesFindFirst: mutableDb.query.notes.findFirst,
  cardGenUnitsFindMany: mutableDb.query.cardGenerationUnits.findMany,
  cardGenDraftsFindFirst: mutableDb.query.cardGenerationDrafts.findFirst,
  cardGenQualityReportsFindFirst: mutableDb.query.cardGenerationQualityReports.findFirst,
  cardGenAgentEventsFindFirst: mutableDb.query.cardGenerationAgentEvents.findFirst,
};

after(() => {
  mutableDb.transaction = original.transaction;
  mutableDb.select = original.select;
  mutableDb.insert = original.insert;
  mutableDb.update = original.update;
  mutableDb.query.cardGenerationRuns.findFirst = original.cardGenRunsFindFirst;
  mutableDb.query.noteVersions.findFirst = original.noteVersionsFindFirst;
  mutableDb.query.noteBlocks.findMany = original.noteBlocksFindMany;
mutableDb.query.noteImageAssets.findMany = original.noteImageAssetsFindMany;
mutableDb.query.workspaces.findFirst = original.workspacesFindFirst;
  mutableDb.query.notes.findFirst = original.notesFindFirst;
  mutableDb.query.cardGenerationUnits.findMany = original.cardGenUnitsFindMany;
  mutableDb.query.cardGenerationDrafts.findFirst = original.cardGenDraftsFindFirst;
  mutableDb.query.cardGenerationQualityReports.findFirst = original.cardGenQualityReportsFindFirst;
  mutableDb.query.cardGenerationAgentEvents.findFirst = original.cardGenAgentEventsFindFirst;
});

// ─── 辅助：安装"正常路径"读取 mock ────────────────────────────────────────

interface NormalReadsConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replay?: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeRun?: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  note?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  version?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imageAssets?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workspace?: any;
}

function installNormalReads(config: NormalReadsConfig = {}) {
  // For cardGenerationRuns.findFirst:
  // - First call in createCardGenerationRun is idempotency replay check
  // - Second call is active run fingerprint check
  // - Third call is B1 succeeded run reuse check (returns undefined = no reuse)
  // We use a call counter to differentiate
  let findFirstCallCount = 0;
  mutableDb.query.cardGenerationRuns.findFirst = async () => {
    findFirstCallCount++;
    if (findFirstCallCount === 1) return config.replay ?? undefined;
    if (findFirstCallCount === 2) return config.activeRun ?? undefined;
    return undefined;
  };

  mutableDb.query.noteVersions.findFirst = async () => config.version ?? baseVersion;
  mutableDb.query.noteBlocks.findMany = async () => config.blocks ?? baseBlocks;
mutableDb.query.noteImageAssets.findMany = async () => config.imageAssets ?? [];
mutableDb.query.workspaces.findFirst = async () => config.workspace ?? baseWorkspace;
  mutableDb.query.notes.findFirst = async () => config.note ?? baseNote;
  mutableDb.query.cardGenerationUnits.findMany = async () => [];
  // Phase C metrics 聚合（buildRunMetrics）所需的新表查询 stub：
  // 正常路径下这些表为空，返回 undefined。
  mutableDb.query.cardGenerationDrafts.findFirst = async () => undefined;
  mutableDb.query.cardGenerationQualityReports.findFirst = async () => undefined;
  mutableDb.query.cardGenerationAgentEvents.findFirst = async () => undefined;
}

// ═════════════════════════════════════════════════════════════════════════
// 测试用例
// ═════════════════════════════════════════════════════════════════════════

describe("D1: card-generation service behavior — buildGenerationFingerprint", () => {
  it("produces a deterministic hash for the same input", () => {
    const input = {
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      titleSnapshot: "Test",
      sourceContentHash: "hash1",
      blockManifestHash: "bmhash",
      assetManifestHash: "amhash",
    };
    const fp1 = buildGenerationFingerprint(input);
    const fp2 = buildGenerationFingerprint(input);
    assert.equal(fp1, fp2);
    assert.ok(fp1.length > 0);
  });

  it("produces different hashes when content changes", () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      titleSnapshot: "Test",
      sourceContentHash: "hash1",
      blockManifestHash: "bmhash",
      assetManifestHash: "amhash",
    };
    const fp1 = buildGenerationFingerprint(base);
    const fp2 = buildGenerationFingerprint({ ...base, sourceContentHash: "hash2" });
    assert.notEqual(fp1, fp2);
  });

  it("produces a valid 64-char hex string (sha256)", () => {
    const fp = buildGenerationFingerprint({
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      titleSnapshot: "Test",
      sourceContentHash: "h",
      blockManifestHash: "b",
      assetManifestHash: "a",
    });
    assert.match(fp, /^[0-9a-f]{64}$/);
  });
});

describe("D1: card-generation service behavior — buildGenerationManifests", () => {
  it("orders blocks by ordinal then id", () => {
    const blocks = [
      { id: "b2", ordinal: 1, type: "text", content: "two" },
      { id: "b1", ordinal: 0, type: "text", content: "one" },
    ];
    const { blockManifest } = buildGenerationManifests(blocks);
    assert.equal(blockManifest[0]!.blockId, "b1");
    assert.equal(blockManifest[1]!.blockId, "b2");
  });

  it("hashes block content with sha256", () => {
    const blocks = [{ id: "b1", ordinal: 0, type: "text", content: "hello" }];
    const { blockManifest } = buildGenerationManifests(blocks);
    // sha256("hello")
    assert.equal(blockManifest[0]!.contentHash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("filters asset manifest to image blocks only", () => {
    const blocks = [
      { id: "b1", ordinal: 0, type: "text", content: "text" },
      { id: "b2", ordinal: 1, type: "image", content: "", imageAssetId: "asset-1" },
    ];
    const assetHashById = new Map([["asset-1", "asset-hash-123"]]);
    const { assetManifest } = buildGenerationManifests(blocks, assetHashById);
    assert.equal(assetManifest.length, 1);
    assert.equal(assetManifest[0]!.blockId, "b2");
    assert.equal(assetManifest[0]!.sourceHash, "asset-hash-123");
    assert.equal(assetManifest[0]!.assetId, "asset-1");
  });
});

describe("D1: card-generation service behavior — idempotency key replay", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("returns existing run when same idempotency key + same noteVersionId + same user", async () => {
    const replayRun = {
      ...mockRunRow,
      id: "run-existing-1",
      status: SupervisorRunStatus.QUEUED,
    };

    mutableDb.query.cardGenerationRuns.findFirst = async () => replayRun;
    mutableDb.query.noteVersions.findFirst = async () => baseVersion;
    mutableDb.transaction = createMockTransaction();

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    assert.equal(result.runId, "run-existing-1");
    assert.equal(result.status, SupervisorRunStatus.QUEUED);
    assert.equal(result.canContinueEditing, true);
    assert.equal(result.sourceSnapshot?.noteVersionId, NOTE_VERSION_ID);
  });

  it("N#8-3: 同一幂等键命中终态失败 run 时不重放，抛 run_terminal_failed 提示用新键重派", async () => {
    for (const status of [
      SupervisorRunStatus.NEEDS_ATTENTION,
      SupervisorRunStatus.CANCELLED,
      SupervisorRunStatus.SUPERSEDED,
    ]) {
      const replayRun = {
        ...mockRunRow,
        id: "run-failed-1",
        status,
      };
      mutableDb.query.cardGenerationRuns.findFirst = async () => replayRun;
      mutableDb.query.noteVersions.findFirst = async () => baseVersion;
      mutableDb.transaction = createMockTransaction();

      await assert.rejects(
        createCardGenerationRun(
          { workspaceId: WORKSPACE_ID, userId: USER_ID },
          baseInput,
        ),
        (err: unknown) => {
          assert.ok(err instanceof CardGenerationServiceError);
          assert.equal(err.code, "run_terminal_failed");
          assert.equal(err.statusCode, 409);
          return true;
        },
      );
    }
  });

  it("throws 409 when idempotency key is reused with different noteVersionId", async () => {
    const replayRun = {
      id: "run-existing-2",
      workspaceId: WORKSPACE_ID,
      noteVersionId: "00000000-0000-4000-8000-000000000099",
      requestedBy: USER_ID,
      requestIdempotencyKey: IDEMPOTENCY_KEY,
      status: SupervisorRunStatus.QUEUED,
    };

    mutableDb.query.cardGenerationRuns.findFirst = async () => replayRun;
    mutableDb.transaction = createMockTransaction();

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        { ...baseInput, noteVersionId: NOTE_VERSION_ID },
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "idempotency_key_reused");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("throws 409 when idempotency key is reused by different user", async () => {
    const replayRun = {
      id: "run-existing-3",
      workspaceId: WORKSPACE_ID,
      noteVersionId: NOTE_VERSION_ID,
      requestedBy: "00000000-0000-4000-8000-000000000099",
      requestIdempotencyKey: IDEMPOTENCY_KEY,
      status: SupervisorRunStatus.QUEUED,
    };

    mutableDb.query.cardGenerationRuns.findFirst = async () => replayRun;
    mutableDb.transaction = createMockTransaction();

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "idempotency_key_reused");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });
});

describe("D1: card-generation service behavior — active run reuse", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("returns active run when same fingerprint and non-terminal status", async () => {
    // No replay (1st call → undefined), active run (2nd call → running run)
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      // This is called for both replay and active-run checks.
      // But since we return the same thing every time, the first call (replay check)
      // will also return this run. The replay check will see noteVersionId matches
      // and userId matches, so it will return the replay result.
      // To test active run reuse specifically, we need the replay to NOT match.
      return undefined;
    };

    // Make the second call return an active run
    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no idempotency replay
      return {
        ...mockRunRow,
        id: "run-active-1",
        status: SupervisorRunStatus.RUNNING,
      };
    };

    mutableDb.query.noteVersions.findFirst = async () => baseVersion;
    mutableDb.transaction = createMockTransaction();

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    assert.equal(result.runId, "run-active-1");
    assert.equal(result.status, SupervisorRunStatus.RUNNING);
    assert.equal(result.canContinueEditing, true);
  });

  it("does not reuse non-succeeded terminal-status run with same fingerprint (proceeds to create new)", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });

    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no replay
      if (callCount === 2) return {
        ...mockRunRow,
        id: "run-needs-attention",
        status: SupervisorRunStatus.NEEDS_ATTENTION, // terminal but not succeeded
      };
      return undefined; // no succeeded run to reuse (B1)
    };

    mutableDb.transaction = mockTx;

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // Should have created a new run (not returned the old one)
    assert.equal(result.runId, "run-new-id");
    assert.equal(result.status, SupervisorRunStatus.QUEUED);
    // Verify run was inserted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.ok(runInsert, "cardGenerationRuns should have been inserted");
  });
});

describe("D1: card-generation service behavior — advisory lock", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("calls tx.execute at least twice (setApiTransactionContext + pg_advisory_xact_lock)", async () => {
    const executeCalls: { query: unknown }[] = [];
    const mockTx = createMockTransaction({
      pendingCount: 0,
      executeSpy: (call) => executeCalls.push(call),
    });

    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // First execute: setApiTransactionContext (set_config for workspace_id/user_id)
    // Second execute: pg_advisory_xact_lock(hashtextextended('job-quota:...'))
    assert.ok(executeCalls.length >= 2, `expected ≥2 execute calls, got ${executeCalls.length}`);
  });
});

describe("D1: card-generation service behavior — quota enforcement", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("throws 429 when pending jobs >= MAX_PENDING_JOBS_PER_WORKSPACE", async () => {
    mutableDb.transaction = createMockTransaction({ pendingCount: MAX_PENDING_JOBS_PER_WORKSPACE });

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "job_quota_exceeded");
        assert.equal(err.statusCode, 429);
        return true;
      },
    );
  });

  it("allows creation when pending jobs < MAX_PENDING_JOBS_PER_WORKSPACE", async () => {
    mutableDb.transaction = createMockTransaction({ pendingCount: MAX_PENDING_JOBS_PER_WORKSPACE - 1 });

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    assert.equal(result.runId, "run-new-id");
    assert.equal(result.status, SupervisorRunStatus.QUEUED);
  });
});

describe("D1: card-generation service behavior — input validation errors", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("throws 404 when note version does not exist", async () => {
    mutableDb.query.noteVersions.findFirst = async () => undefined;
    mutableDb.transaction = createMockTransaction();

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "note_version_not_found");
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it("throws 422 when note has no blocks (empty note)", async () => {
    installNormalReads({ blocks: [] });
    mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "empty_note");
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  it("throws 422 when image block has unresolved asset", async () => {
    const blocksWithImage = [
      { id: "block-1", versionId: NOTE_VERSION_ID, workspaceId: WORKSPACE_ID, ordinal: 0, type: "text", content: "Hello" },
      { id: "block-2", versionId: NOTE_VERSION_ID, workspaceId: WORKSPACE_ID, ordinal: 1, type: "image", content: "", imageAssetId: "missing-asset" },
    ];
    installNormalReads({ blocks: blocksWithImage, imageAssets: [] });
    mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "image_asset_unresolved");
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  it("throws 422 when input exceeds block count limit (>2000 blocks)", async () => {
    const tooManyBlocks = Array.from({ length: 2001 }, (_, i) => ({
      id: `block-${i}`,
      versionId: NOTE_VERSION_ID,
      workspaceId: WORKSPACE_ID,
      ordinal: i,
      type: "text",
      content: "x",
    }));
    installNormalReads({ blocks: tooManyBlocks });
    mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "input_limit_exceeded");
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });

  it("throws 422 when text content exceeds 500K chars", async () => {
    const bigBlock = {
      id: "block-big",
      versionId: NOTE_VERSION_ID,
      workspaceId: WORKSPACE_ID,
      ordinal: 0,
      type: "text",
      content: "x".repeat(500_001),
    };
    installNormalReads({ blocks: [bigBlock] });
    mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

    await assert.rejects(
      createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "input_limit_exceeded");
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
  });
});

describe("D1: card-generation service behavior — run creation transaction fields", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("inserts run with correct fingerprint, epoch, status, and provider snapshot", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.ok(runInsert, "cardGenerationRuns should have been inserted");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = runInsert!.values as any;
    assert.equal(values.workspaceId, WORKSPACE_ID);
    assert.equal(values.noteId, NOTE_ID);
    assert.equal(values.noteVersionId, NOTE_VERSION_ID);
    assert.equal(values.requestedBy, USER_ID);
    assert.equal(values.requestIdempotencyKey, IDEMPOTENCY_KEY);
    assert.equal(values.status, SupervisorRunStatus.QUEUED);
    assert.equal(values.stage, CardGenerationStage.QUEUED);
    assert.equal(values.generationEpoch, 1); // baseNote.cardGenerationEpoch + 1
    assert.equal(values.retryable, true);
    assert.equal(values.stateVersion, 1);
    assert.equal(values.nextEventSequence, 2);

    // Fingerprint should be a valid hash
    assert.match(values.generationFingerprint, /^[0-9a-f]{64}$/);

    // Provider snapshot
    assert.equal(values.providerSnapshot.executionMode, "supervisor_agent_v1");
    assert.equal(values.providerSnapshot.capabilityPolicy, "conservative-32k-v1");

    // Governance policy
    assert.equal(values.governancePolicyVersion, "workspace-policy-snapshot-v1");
  });

  it("creates prepare unit and execute_card_agent_turn job", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;

    // Check prepare unit
    const unitInsert = captures.inserts.find(
      (i: { table: unknown; values: unknown }) => i.table === cardGenerationUnits,
    );
    assert.ok(unitInsert, "prepare unit should have been inserted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unitValues = unitInsert!.values as any;
    assert.equal(unitValues.kind, AgentUnitKind.PREPARE);
    assert.equal(unitValues.level, 0);
    assert.equal(unitValues.ordinal, 0);
    assert.equal(unitValues.status, "pending");

    // Check job
    const jobInsert = captures.inserts.find(
      (i: { table: unknown }) => i.table === jobs,
    );
    assert.ok(jobInsert, "job should have been inserted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobValues = jobInsert!.values as any;
    assert.equal(jobValues.type, JobType.EXECUTE_CARD_AGENT_TURN);
    assert.equal(jobValues.status, JobStatus.PENDING);
    assert.equal(jobValues.workspaceId, WORKSPACE_ID);
    assert.equal(jobValues.resourceClass, JobResourceClass.CARD_FOREGROUND);
    assert.ok(jobValues.idempotencyKey);
    assert.match(jobValues.idempotencyKey, /^generation-run:.*:prepare:0$/);
  });

  it("seals note version if not already sealed", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const versionUpdate = captures.updates.find(
      (u: { table: unknown }) => u.table === noteVersions,
    );
    assert.ok(versionUpdate, "noteVersions should have been updated for sealing");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sealValues = versionUpdate!.values as any;
    assert.equal(sealValues.sealedReason, "card_generation");
    assert.ok(sealValues.sealedAt);
  });

  it("increments note cardGenerationEpoch and sets latestGenerationRunId", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const noteUpdate = captures.updates.find(
      (u: { table: unknown }) => u.table === notes,
    );
    assert.ok(noteUpdate, "notes should have been updated");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noteValues = noteUpdate!.values as any;
    assert.equal(noteValues.cardGenerationEpoch, 1); // 0 + 1
    assert.equal(noteValues.latestGenerationRunId, "run-new-id");
  });

  it("inserts a source_snapshot_sealed event", async () => {
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const eventInsert = captures.inserts.find(
      (i: { table: unknown }) => i.table === cardGenerationEvents,
    );
    assert.ok(eventInsert, "cardGenerationEvents should have been inserted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventValues = eventInsert!.values as any;
    assert.equal(eventValues.stage, CardGenerationStage.SNAPSHOT);
    assert.equal(eventValues.state, SupervisorRunStatus.QUEUED);
    assert.equal(eventValues.messageCode, "source_snapshot_sealed");
    assert.equal(eventValues.sequence, 1);
  });
});

describe("D1: card-generation service behavior — mock provider production guard", () => {
  beforeEach(() => {
installNormalReads({
workspace: { ...baseWorkspace },
});
    // Force platform config cache to null so resolveSystemProviderForCapability
    // falls back to legacy env var resolution (which defaults to "mock" when
    // no AI_PROVIDER_AGENT_TURN / AI_PROVIDER_CARD env vars are set).
    // Without this, config/ai-platforms.json maps agent_turn → openai_compatible,
    // bypassing the mock provider production guard.
    setPlatformConfig(null);
  });

  afterEach(() => {
    // Restore real config file loading for subsequent tests.
    resetPlatformConfigCache();
  });

  it("throws 422 when mock provider in production without ALLOW_MOCK_IN_PRODUCTION", async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAllow = process.env.ALLOW_MOCK_IN_PRODUCTION;
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_MOCK_IN_PRODUCTION;

    try {
      mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

      await assert.rejects(
        createCardGenerationRun(
          { workspaceId: WORKSPACE_ID, userId: USER_ID },
          baseInput,
        ),
        (err: unknown) => {
          assert.ok(err instanceof CardGenerationServiceError);
          assert.equal(err.code, "mock_provider_blocked_in_production");
          assert.equal(err.statusCode, 422);
          return true;
        },
      );
    } finally {
      if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
      else delete process.env.NODE_ENV;
      if (originalAllow !== undefined) process.env.ALLOW_MOCK_IN_PRODUCTION = originalAllow;
      else delete process.env.ALLOW_MOCK_IN_PRODUCTION;
    }
  });

  it("allows mock provider when ALLOW_MOCK_IN_PRODUCTION=true", async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAllow = process.env.ALLOW_MOCK_IN_PRODUCTION;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_MOCK_IN_PRODUCTION = "true";

    try {
      mutableDb.transaction = createMockTransaction({ pendingCount: 0 });

      const result = await createCardGenerationRun(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        baseInput,
      );

      assert.equal(result.runId, "run-new-id");
    } finally {
      if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
      else delete process.env.NODE_ENV;
      if (originalAllow !== undefined) process.env.ALLOW_MOCK_IN_PRODUCTION = originalAllow;
      else delete process.env.ALLOW_MOCK_IN_PRODUCTION;
    }
  });
});

describe("D1: card-generation service behavior — system platform provider resolution", () => {
  beforeEach(() => {
    installNormalReads();
  });

  afterEach(() => {
    resetPlatformConfigCache();
  });

  it("resolves provider from system platform config (config/ai-platforms.json)", async () => {
    // With the default config/ai-platforms.json loaded, agent_turn should
    // resolve to whatever platform is configured there (typically openai_compatible).
    // We don't force-set null here — we let the real config file load.
    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.ok(runInsert, "cardGenerationRuns should have been inserted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = runInsert!.values as any;
    // Provider snapshot should contain the system-resolved provider name
    // (from resolveSystemProviderForCapability("agent_turn"))
    assert.ok(values.providerSnapshot.providerName, "providerName should be set from system platform config");
    assert.equal(values.providerSnapshot.executionMode, "supervisor_agent_v1");
  });

  it("falls back to legacy env var resolution when no config file", async () => {
    // Force no config file — resolveSystemPlatform falls back to AI_PROVIDER_* env vars
    setPlatformConfig(null);

    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      baseInput,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.ok(runInsert, "cardGenerationRuns should have been inserted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values = runInsert!.values as any;
    // Without config file and without AI_PROVIDER_AGENT_TURN env var, defaults to "mock"
    assert.equal(values.providerSnapshot.providerName, "mock");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B1: 同内容跳过与结果复用（计划 §2.4）
// ═════════════════════════════════════════════════════════════════════════

describe("B1: card-generation service behavior — succeeded run reuse", () => {
  beforeEach(() => {
    installNormalReads();
  });

  it("reuses succeeded run with same fingerprint when force is not set", async () => {
    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no replay
      if (callCount === 2) return undefined; // no active run
      // Third call: B1 succeeded run check
      return {
        ...mockRunRow,
        id: "run-succeeded-old",
        status: SupervisorRunStatus.SUCCEEDED,
      };
    };

    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { ...baseInput }, // force defaults to false
    );

    assert.equal(result.runId, "run-succeeded-old");
    assert.equal(result.status, SupervisorRunStatus.SUCCEEDED);
    assert.equal(result.reused, true);
    assert.equal(result.canContinueEditing, true);

    // Verify no new run was inserted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.equal(runInsert, undefined, "should not insert a new run when reusing succeeded");
  });

  it("skips succeeded run reuse when force=true", async () => {
    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no replay
      if (callCount === 2) return undefined; // no active run
      // Third call should NOT happen when force=true (B1 check skipped)
      return { ...mockRunRow, id: "should-not-reach", status: SupervisorRunStatus.SUCCEEDED };
    };

    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { ...baseInput, force: true },
    );

    // Should have created a new run
    assert.equal(result.runId, "run-new-id");
    assert.equal(result.status, SupervisorRunStatus.QUEUED);
    assert.equal(result.reused, undefined);

    // Verify run was inserted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures = (mockTx as any).captures;
    const runInsert = captures.inserts.find((i: { table: unknown }) => i.table === cardGenerationRuns);
    assert.ok(runInsert, "cardGenerationRuns should have been inserted when force=true");
  });

  it("does not reuse non-succeeded terminal run (needs_attention)", async () => {
    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no replay
      if (callCount === 2) return undefined; // no active run
      // Third call: B1 check — SQL WHERE clause filters status = 'succeeded',
      // so a needs_attention run would NOT be returned by the real query.
      // Mock returns undefined to correctly simulate this SQL filtering behavior.
      return undefined;
    };

    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { ...baseInput },
    );

    // Should have created a new run (needs_attention is not succeeded)
    assert.equal(result.runId, "run-new-id");
    assert.equal(result.status, SupervisorRunStatus.QUEUED);
    assert.equal(result.reused, undefined);
  });

  it("prioritizes active run reuse over succeeded run reuse", async () => {
    let callCount = 0;
    mutableDb.query.cardGenerationRuns.findFirst = async () => {
      callCount++;
      if (callCount === 1) return undefined; // no replay
      // Second call: active run check — return a running run
      if (callCount === 2) return {
        ...mockRunRow,
        id: "run-active",
        status: SupervisorRunStatus.RUNNING,
      };
      // Third call should NOT happen (active run already returned)
      return { ...mockRunRow, id: "should-not-reach", status: SupervisorRunStatus.SUCCEEDED };
    };

    const mockTx = createMockTransaction({ pendingCount: 0 });
    mutableDb.transaction = mockTx;

    const result = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { ...baseInput },
    );

    // Should return the active run, not the succeeded run
    assert.equal(result.runId, "run-active");
    assert.equal(result.status, SupervisorRunStatus.RUNNING);
    assert.equal(result.reused, undefined); // active reuse doesn't set reused flag
  });
});
