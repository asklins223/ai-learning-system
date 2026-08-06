/**
 * retryCardGenerationRun 行为单测（检查点恢复）。
 *
 * 覆盖：
 * - 正常路径：存在 terminal_failed 检查点 → 重排队该 unit，不触发回退
 * - 检查点丢失回退：无 failed/pending/running unit，但存在顶层 supervisor unit
 *   （legacy 数据：早期 reconciler 把 needs_attention run 的 unit 全取消）→
 *   回退恢复 supervisor，不再抛 generation_checkpoint_missing
 * - 真正无检查点：连 supervisor 都不存在 → 抛 generation_checkpoint_missing
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  AgentUnitKind,
  SupervisorRunStatus,
} from "@ailearn/shared";
import { db } from "../db/client.ts";
import {
  cardGenerationRuns,
  cardGenerationUnits,
} from "../db/schema/card-generation.ts";
import { jobs } from "../db/schema/job.ts";
import { notes } from "../db/schema/note.ts";
import {
  CardGenerationServiceError,
  retryCardGenerationRun,
} from "../modules/card-generation/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const RUN_ID = "00000000-0000-4000-8000-000000000010";
const SUPERVISOR_UNIT_ID = "00000000-0000-4000-8000-000000000020";
const FAILED_UNIT_ID = "00000000-0000-4000-8000-000000000021";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mutableDb = db as any;

const runRow = {
  id: RUN_ID,
  workspaceId: WORKSPACE_ID,
  noteId: NOTE_ID,
  noteVersionId: NOTE_VERSION_ID,
  status: SupervisorRunStatus.NEEDS_ATTENTION,
  stage: "snapshot",
  generationEpoch: 1,
  generationFingerprint: "fp-retry-test",
  stateVersion: 1,
  nextEventSequence: 5,
  retryable: true,
  resultCardId: null,
  resultCardSetId: null,
  errorCode: "provider_unavailable",
  requiredImages: 0,
  requiredUnits: 0,
  completedUnits: 0,
  completedImages: 0,
  sourceCoverageBps: 0,
  imageCoverageBps: 10000,
  finishedAt: new Date(),
  startedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  coverageReport: {},
  providerCapabilityFingerprint: null,
  sourceContentHash: "h",
  titleSnapshot: "T",
  blockManifestHash: "b",
  assetManifestHash: "a",
  blockManifest: [],
  assetManifest: [],
  providerSnapshot: { executionMode: "supervisor_agent_v1" },
  governancePolicyVersion: "workspace-policy-snapshot-v1",
  supersedesRunId: null,
  requestedBy: USER_ID,
  requestIdempotencyKey: "retry-idem",
  cancelRequestedAt: null,
  usageSummary: null,
};

function makeUnit(overrides: Record<string, unknown>) {
  return {
    id: SUPERVISOR_UNIT_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    parentUnitId: null,
    kind: AgentUnitKind.AGENT_RUN,
    level: 0,
    ordinal: 1,
    unitKey: `supervisor:${RUN_ID}`,
    required: true,
    inputManifest: { agentRole: "generation_supervisor" },
    inputHash: "h",
    tokenEstimate: 0,
    status: "pending",
    attempts: 0,
    scheduledAt: new Date(),
    startedAt: null,
    finishedAt: null,
    artifactJson: null,
    artifactHash: null,
    errorCode: null,
    nodeContractVersion: null,
    budgetJson: {},
    usageJson: {},
    cursorJson: { turnNo: 3 },
    retryPolicyJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── 原始方法备份 ──────────────────────────────────────────────────────────

const original = {
  transaction: mutableDb.transaction,
  cardGenRunsFindFirst: mutableDb.query.cardGenerationRuns.findFirst,
  noteVersionsFindFirst: mutableDb.query.noteVersions.findFirst,
  notesFindFirst: mutableDb.query.notes.findFirst,
  cardGenUnitsFindMany: mutableDb.query.cardGenerationUnits.findMany,
  cardGenUnitsFindFirst: mutableDb.query.cardGenerationUnits.findFirst,
  cardGenDraftsFindFirst: mutableDb.query.cardGenerationDrafts.findFirst,
  cardGenQualityReportsFindFirst: mutableDb.query.cardGenerationQualityReports.findFirst,
  cardGenAgentEventsFindFirst: mutableDb.query.cardGenerationAgentEvents.findFirst,
};

after(() => {
  mutableDb.transaction = original.transaction;
  mutableDb.query.cardGenerationRuns.findFirst = original.cardGenRunsFindFirst;
  mutableDb.query.noteVersions.findFirst = original.noteVersionsFindFirst;
  mutableDb.query.notes.findFirst = original.notesFindFirst;
  mutableDb.query.cardGenerationUnits.findMany = original.cardGenUnitsFindMany;
  mutableDb.query.cardGenerationUnits.findFirst = original.cardGenUnitsFindFirst;
  mutableDb.query.cardGenerationDrafts.findFirst = original.cardGenDraftsFindFirst;
  mutableDb.query.cardGenerationQualityReports.findFirst = original.cardGenQualityReportsFindFirst;
  mutableDb.query.cardGenerationAgentEvents.findFirst = original.cardGenAgentEventsFindFirst;
});

// ─── Retry 专用 mock 事务 ─────────────────────────────────────────────────

/**
 * 覆盖 retryCardGenerationRun 内部的全部 tx 操作：
 * - execute(sql advisory lock)
 * - select().from(cardGenerationRuns).where().for("update")
 * - select({...}).from(notes).where().for("update")
 * - select({count}).from(jobs)
 * - select().from(cardGenerationUnits).where().for("update")
 * - update(cardGenerationUnits).set().where()
 * - insert(jobs).values().returning()
 * - update(cardGenerationRuns).set().where().returning()
 */
function createRetryMockTransaction(options: {
  units?: Array<Record<string, unknown>>;
  run?: Record<string, unknown>;
} = {}) {
  const units = options.units ?? [];
  const run = options.run ?? runRow;

  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    query: mutableDb.query,
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        // buildRunMetrics 的聚合查询：select({planned/pending/...}).from(table).where()
        // 返回计数数组；各表在此测试中视为空。
        const aggKeys = columns && typeof columns === "object"
          ? Object.keys(columns as Record<string, unknown>)
          : [];
        const isMetricsAggregate = aggKeys.some((k) =>
          ["planned", "assigned", "decided", "required", "pending", "running", "completed", "failed", "extracted", "canonical", "eligible", "rejected"].includes(k),
        );
        if (isMetricsAggregate) {
          return { where: async () => [] };
        }
        if (columns && typeof columns === "object" && "count" in (columns as Record<string, unknown>)) {
          return { where: async () => [{ count: "0" }] };
        }
        if (table === cardGenerationRuns) {
          return { where: () => ({ for: async () => (run ? [run] : []) }) };
        }
        if (table === notes) {
          return {
            where: () => ({
              for: async () => [{ epoch: run.generationEpoch, latestRunId: run.id }],
            }),
          };
        }
        if (table === cardGenerationUnits) {
          return {
            where: () => ({
              orderBy: () => ({
                for: async () => units,
              }),
            }),
          };
        }
        return { where: async () => [] };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        return { returning: async () => [{ id: "job-retry-new" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => {
        updates.push({ table, values });
        const updatedRun = {
          ...run,
          status: SupervisorRunStatus.RUNNING,
          stateVersion: (run.stateVersion as number) + 1,
        };
        // `.where()` 返回值必须同时支持两种用法：
        //   1. `await update().set().where(...)`          → thenable
        //   2. `update().set().where(...).returning()`    → .returning()
        const result = {
          returning: async () => [updatedRun],
          then: (resolve: (value?: unknown) => void) => { resolve(undefined); },
        };
        return { where: () => result };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => { inserts.push({ table, values: "deleted" }); },
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tx as any).captures = { inserts, updates };

  return {
    transactionFn: async (runOp: (t: unknown) => Promise<unknown>) => runOp(tx),
    captures: { inserts, updates },
  };
}

/** 安装 toRunView 所需的 db.query 读取 mock。 */
function installRetryReads(supervisor: Record<string, unknown> | null) {
  mutableDb.query.noteVersions.findFirst = async () => ({ versionNo: 1 });
  mutableDb.query.notes.findFirst = async () => null;
  mutableDb.query.cardGenerationUnits.findMany = async () => [];
  mutableDb.query.cardGenerationUnits.findFirst = async () => supervisor;
  // Phase C metrics 聚合（buildRunMetrics）所需的新表查询 stub：
  // 正常路径下这些表为空，返回 undefined/[]。
  mutableDb.query.cardGenerationDrafts.findFirst = async () => undefined;
  mutableDb.query.cardGenerationQualityReports.findFirst = async () => undefined;
  mutableDb.query.cardGenerationAgentEvents.findFirst = async () => undefined;
}

// ═════════════════════════════════════════════════════════════════════════
// 测试用例
// ═════════════════════════════════════════════════════════════════════════

describe("retryCardGenerationRun — 检查点恢复", () => {
  it("正常路径：terminal_failed 检查点存在时直接重排队该 unit", async () => {
    const failedUnit = makeUnit({
      id: FAILED_UNIT_ID,
      status: "terminal_failed",
      errorCode: "provider_unavailable",
      finishedAt: new Date(),
    });
    const supervisor = makeUnit({ status: "cancelled" });
    const { transactionFn, captures } = createRetryMockTransaction({
      units: [failedUnit],
    });
    installRetryReads(supervisor);
    mutableDb.transaction = transactionFn;

    const view = await retryCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(view, "retry 应返回 run view");
    assert.equal(view.status, SupervisorRunStatus.RUNNING);
    // 应创建 retry job，且 primary unit 是失败的 terminal_failed unit
    const jobInsert = captures.inserts.find((i) => i.table === jobs);
    assert.ok(jobInsert, "应插入 retry job");
    const payload = (jobInsert.values as { payload: { agentUnitId: string } }).payload;
    assert.equal(payload.agentUnitId, FAILED_UNIT_ID);
  });

  it("检查点丢失回退：无 failed unit 但有 supervisor → 恢复 supervisor 而非报错", async () => {
    const supervisor = makeUnit({ status: "cancelled" });
    const { transactionFn, captures } = createRetryMockTransaction({
      units: [], // 无任何 failed/pending/running 检查点
    });
    installRetryReads(supervisor);
    mutableDb.transaction = transactionFn;

    const view = await retryCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(view, "回退应成功，不再抛 generation_checkpoint_missing");
    assert.equal(view.status, SupervisorRunStatus.RUNNING);
    const jobInsert = captures.inserts.find((i) => i.table === jobs);
    assert.ok(jobInsert, "应创建 retry job");
    const payload = (jobInsert.values as { payload: { agentUnitId: string } }).payload;
    assert.equal(payload.agentUnitId, SUPERVISOR_UNIT_ID, "回退应重排队 supervisor");
  });

  it("回退恢复的 supervisor 若已 succeeded → 清空 cursor 重新决策", async () => {
    const supervisor = makeUnit({ status: "succeeded", cursorJson: { turnNo: 9, state: "completed" } });
    const { transactionFn, captures } = createRetryMockTransaction({
      units: [],
    });
    installRetryReads(supervisor);
    mutableDb.transaction = transactionFn;

    const view = await retryCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(view);
    // 应有对 supervisor unit 的 cursorJson 清空更新
    const cursorUpdate = captures.updates.find((u) => {
      if (u.table !== cardGenerationUnits) return false;
      const vals = u.values as { cursorJson?: Record<string, unknown> };
      return vals.cursorJson !== undefined;
    });
    assert.ok(cursorUpdate, "completed supervisor 回退应清空 cursorJson");
    assert.deepEqual((cursorUpdate!.values as { cursorJson: unknown }).cursorJson, {});
  });

  it("真正无检查点：无 failed unit 也无 supervisor → 抛 generation_checkpoint_missing", async () => {
    const { transactionFn } = createRetryMockTransaction({
      units: [],
    });
    installRetryReads(null);
    mutableDb.transaction = transactionFn;

    await assert.rejects(
      retryCardGenerationRun({ workspaceId: WORKSPACE_ID, userId: USER_ID }, RUN_ID),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "generation_checkpoint_missing");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("run 不在 needs_attention → 抛 run_not_retryable", async () => {
    const runningRun = { ...runRow, status: SupervisorRunStatus.RUNNING };
    const { transactionFn } = createRetryMockTransaction({ run: runningRun });
    installRetryReads(makeUnit({}));
    mutableDb.transaction = transactionFn;

    await assert.rejects(
      retryCardGenerationRun({ workspaceId: WORKSPACE_ID, userId: USER_ID }, RUN_ID),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "run_not_retryable");
        return true;
      },
    );
  });

  it("预算耗尽的 needs_attention run → 拒绝重试（run_not_retryable）", async () => {
    const budgetRun = { ...runRow, errorCode: "budget_exhausted" };
    const { transactionFn } = createRetryMockTransaction({ run: budgetRun });
    installRetryReads(makeUnit({}));
    mutableDb.transaction = transactionFn;

    await assert.rejects(
      retryCardGenerationRun({ workspaceId: WORKSPACE_ID, userId: USER_ID }, RUN_ID),
      (err: unknown) => {
        assert.ok(err instanceof CardGenerationServiceError);
        assert.equal(err.code, "run_not_retryable");
        return true;
      },
    );
  });
});
