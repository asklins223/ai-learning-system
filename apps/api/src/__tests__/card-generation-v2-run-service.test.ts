/**
 * 方案 20 — Card Generation V2 generation-run-service 单测。
 *
 * 覆盖：
 * - createGenerationRunV2 幂等 replay（同 idempotencyKey 返回已建 run）
 * - createGenerationRunV2 note_version_not_found
 * - createGenerationRunV2 happy path（seal → planning + outbox 入队；终态由 worker 推进）
 * - getGenerationRunV2 查询（存在 / 不存在）
 * - getGenerationRunCandidatesV2（最新 revision 去重 + 整批练习件配额结算）
 * - closeGenerationRunV2 状态守卫（非 review_ready → 409）
 * - cancelGenerationRunV2 可取消状态守卫
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { db } from "../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationPlansV2,
  cardGenerationEventsV2,
  cardGenerationRunOutboxV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
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
                // 「上一个已激活批次」查询走 orderBy().limit()
                orderBy: () => ({ limit: async () => [] }),
                // 在制守卫现在直接 await where()（一次取回全部在制行），
                // 所以这条链本身也要可 await。
                then: (resolve: (value: unknown) => void) => Promise.resolve([]).then(resolve),
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

  /**
   * 2026-09-20（实走复盘 #5）：一篇笔记同时只允许一批在制的学习卡。
   * 此前配额只在 workspace 维度（在途数 + 日次数），同一篇笔记可以被反复点
   * 「生成学习卡」，每点一次多一批候选卡。
   *
   * 两个新查询都打在 card_generation_runs_v2 上，所以替身按**调用顺序**发牌：
   *   1 幂等回放（取锁前）· 2 幂等回放（取锁后）· 3 按笔记的在制守卫 ·
   *   4 上一个已激活批次
   */
  function setupRunQuerySequence(results: unknown[][], inserted?: Record<string, unknown>[]) {
    let callIndex = 0;
    return setupTx({
      select: () => ({
        from: (table: unknown) => {
          const next = () => {
            if (table === cardGenerationRunsV2) return results[callIndex++] ?? [];
            if (table === cardGenerationEventsV2) return [{ maxSeq: 0 }];
            return [];
          };
          const chain: Record<string, unknown> = {
            limit: async () => next(),
            orderBy: () => chain,
            // insertEvent 走 `await select().from(events).where(...)`（不经 limit），
            // 所以链条本身必须可 await。events 不推进计数，只有 runs 推进。
            then: (resolve: (value: unknown) => void) => Promise.resolve(next()).then(resolve),
          };
          chain.where = () => chain;
          return chain;
        },
      }),
      query: {
        noteVersions: { findFirst: async () => makeBaseVersion() },
        notes: { findFirst: async () => makeBaseNote() },
        noteBlocks: { findMany: async () => [] },
      },
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserted?.push({ ...values, table });
          return { onConflictDoNothing: () => {} };
        },
      }),
      update: () => ({ set: () => ({ where: () => ({}) }) }),
    });
  }

  it("同一篇笔记已有在制批次时拒绝再次生成", async () => {
    setupRunQuerySequence([[], [], [{ id: RUN_ID }], []]);

    await assert.rejects(
      () => createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        NOTE_VERSION_ID,
        makeBaseRequest(),
        "test-key-note-in-flight",
      ),
      (error: unknown) => {
        const e = error as { code?: string; statusCode?: number };
        assert.equal(e.code, "note_generation_in_flight");
        assert.equal(e.statusCode, 409);
        return true;
      },
    );
  });

  it("失败到没法就地重试的批次不把笔记永久锁死", async () => {
    // needs_attention 且失败原因不是质量门禁时，retry 端点自己会拒绝
    // （not_retryable），cancel 也判 invalid_state —— 只剩"重新生成"这一条路，
    // 而在制守卫正是拦它的。判据与 retry 端点同一句话。
    const inserted: Record<string, unknown>[] = [];
    setupRunQuerySequence(
      [[], [], [{ id: RUN_ID, status: "needs_attention", errorCode: "generation_failed" }], []],
      inserted,
    );

    await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      NOTE_VERSION_ID,
      makeBaseRequest(),
      "test-key-dead-batch",
    );

    assert.ok(
      inserted.some((values) => values.table === cardGenerationRunsV2),
      "上一个批次已经救不回来时，应当允许重新生成",
    );
  });

  it("在审的旧批次和已死的批次并存时，仍然算在制", async () => {
    // 2026-09-21 真实生成实测抓到：守卫原先只取**一行**判死活，而这一行是 Postgres
    // 任意给的（无 ORDER BY）。同篇笔记既有救不回来的失败批次、又有一批还没审完的
    // 候选时，只要先摸到失败那行就放行，于是新旧两批 review_ready 并存——正是用户
    // 抱怨的"旧卡不废弃"。判据必须看**全部**在制行：只要有一行还活着就挡住。
    setupRunQuerySequence([[], [], [
      { id: RUN_ID, status: "needs_attention", errorCode: "generation_failed" },
      { id: "run-review-ready", status: "review_ready", errorCode: null },
    ], []]);

    await assert.rejects(
      () => createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        NOTE_VERSION_ID,
        makeBaseRequest(),
        "test-key-mixed-batches",
      ),
      (error: unknown) => (error as { code?: string }).code === "note_generation_in_flight",
    );
  });

  it("质量门禁造成的 needs_attention 仍然算在制（就地重试还有效）", async () => {
    setupRunQuerySequence([[], [], [{ id: RUN_ID, status: "needs_attention", errorCode: "quality_gate_failed" }], []]);

    await assert.rejects(
      () => createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        NOTE_VERSION_ID,
        makeBaseRequest(),
        "test-key-quality-gate-in-flight",
      ),
      (error: unknown) => (error as { code?: string }).code === "note_generation_in_flight",
    );
  });

  it("记录被替代的上一个已激活批次，供激活时废弃旧卡", async () => {
    const previousRunId = "88888888-0000-4000-8000-000000000008";
    const inserted: Record<string, unknown>[] = [];
    setupRunQuerySequence([[], [], [], [{ id: previousRunId }]], inserted);

    await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      NOTE_VERSION_ID,
      makeBaseRequest(),
      "test-key-supersedes",
    );

    const runInsert = inserted.find((values) => values.table === cardGenerationRunsV2);
    assert.ok(runInsert, "should have inserted the run row");
    assert.equal(runInsert.supersedesRunId, previousRunId);
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

  it("把「每个候选只取最新修订」下推给 SQL，不把全部修订搬回内存再筛", async () => {
    let candidatesFilter: unknown = null;

    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return {
              where: () => ({
                limit: async () => [{ id: RUN_ID, currentPlanVersion: 1 }],
              }),
            };
          }
          if (table === cardGenerationPlansV2) {
            return { where: () => ({ limit: async () => [] }) };
          }
          // candidates query：新形状是 `select().from().where(...)`，没有 orderBy 层。
          return {
            where: (filter: unknown) => {
              candidatesFilter = filter;
              return [
                { ...makeBaseCandidateRow(), candidateId: "c1", revision: 2 },
                { ...makeBaseCandidateRow(), candidateId: "c2", revision: 3 },
              ];
            },
          };
        },
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);

    /**
     * 判据钉在**发给数据库的 SQL 文本**上：把那段 `NOT EXISTS` 删掉这条就红。
     *
     * 为什么不再断言"去重结果对不对"（这条测试以前干的是这个）：去重现在由 Postgres
     * 执行，mock 只会把 service 原样收到的行交回去——那样的断言无论实现对不对都永远
     * 绿，是假保证。真正的端到端去重要靠 postgres 集成测（见本轮交付说明的欠账清单）。
     */
    const collectSqlText = (node: unknown, depth = 0): string => {
      if (node === null || node === undefined || depth > 12) return "";
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map((n) => collectSqlText(n, depth + 1)).join(" ");
      if (typeof node === "object") {
        const record = node as Record<string, unknown>;
        if ("queryChunks" in record) return collectSqlText(record.queryChunks, depth + 1);
        if ("value" in record) return collectSqlText(record.value, depth + 1);
      }
      return "";
    };
    const sqlText = collectSqlText(candidatesFilter);
    assert.match(sqlText, /NOT EXISTS/);
    assert.match(sqlText, /card_generation_candidates_v2 newer/);
    assert.match(sqlText, /newer\.revision >/);
    assert.equal(result!.candidates[1].candidateId, "c2");
    assert.equal(result!.candidates[1].revision, 3);
  });

  /**
   * D6 缺额要看得见（2026-09-21 决定：显示在审核页头部），所以整批结算必须走
   * 候选列表这一条读路径——审核页此前只有一张一张的随卡练习，没有任何一处说
   * "整批点名要几张、缺几张"。
   *
   * 三个目标分别盯三件事：形状对上才算兑现、形状交错算缺额、没点名的自愿交不算数。
   */
  it("reports the batch practice quota next to the candidates", async () => {
    const planResult = {
      kind: "author_candidates",
      recommendedCardCount: 3,
      activationHardMax: 3,
      existingActions: [],
      objectives: [
        makePlanObjective("obj-1", "single_choice"),
        makePlanObjective("obj-2", "true_false"),
        makePlanObjective("obj-3", null),
      ],
    };
    const base = makeBaseCandidateRow();
    const candidates = [
      { ...base, candidateId: "c1", planObjectiveLocalId: "obj-1", objectiveDraft: { ...base.objectiveDraft, practiceItem: { kind: "single_choice", options: [{ unitId: "u1", text: "对" }, { unitId: "u2", text: "错" }, { unitId: "u3", text: "也许" }] } } },
      { ...base, candidateId: "c2", planObjectiveLocalId: "obj-2", objectiveDraft: { ...base.objectiveDraft, practiceItem: { kind: "ordering", units: [{ unitId: "u1", text: "一" }, { unitId: "u2", text: "二" }, { unitId: "u3", text: "三" }, { unitId: "u4", text: "四" }] } } },
      { ...base, candidateId: "c3", planObjectiveLocalId: "obj-3", objectiveDraft: { ...base.objectiveDraft, practiceItem: { kind: "matching", pairs: [{ left: "a", right: "b" }, { left: "c", right: "d" }] } } },
    ];

    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return { where: () => ({ limit: async () => [{ id: RUN_ID, currentPlanVersion: 1 }] }) };
          }
          if (table === cardGenerationPlansV2) {
            return { where: () => ({ limit: async () => [{ result: planResult }] }) };
          }
          return { where: () => candidates };
        },
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    // 点名 2 张（obj-3 没点名），其中只有 obj-1 按形状配上。
    assert.deepEqual(result!.practiceQuota, { requiredCount: 2, metCount: 1 });
  });

  /**
   * §56：读路径只数进了牌堆的那些。牌堆外的那张（`dropped`）行上虽然也带着
   * 形状正确的练习件，但它不是这一批要交付的东西 —— 把它算进 metCount，
   * 头部就会与管道内结算给出两个答案（真跑 4938cf7f 实测 {3,3} vs {3,1}）。
   */
  it("counts the quota over deck members only, not over every stored revision", async () => {
    const planResult = {
      kind: "author_candidates",
      recommendedCardCount: 2,
      activationHardMax: 2,
      existingActions: [],
      objectives: [
        makePlanObjective("obj-1", "single_choice"),
        makePlanObjective("obj-2", "true_false"),
      ],
    };
    const base = makeBaseCandidateRow();
    const candidates = [
      { ...base, candidateId: "c1", planObjectiveLocalId: "obj-1", objectiveDraft: { ...base.objectiveDraft, practiceItem: { kind: "single_choice", options: [{ unitId: "u1", text: "甲" }, { unitId: "u2", text: "乙" }, { unitId: "u3", text: "丙" }] } } },
      // 形状对、内容也对，但 pedagogy 把它丢出了牌堆。
      { ...base, candidateId: "c2", planObjectiveLocalId: "obj-2", qualityState: "dropped", objectiveDraft: { ...base.objectiveDraft, practiceItem: { kind: "true_false", proposition: "乙", expected: true } } },
    ];
    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return { where: () => ({ limit: async () => [{ id: RUN_ID, currentPlanVersion: 1 }] }) };
          }
          if (table === cardGenerationPlansV2) {
            return { where: () => ({ limit: async () => [{ result: planResult }] }) };
          }
          return { where: () => candidates };
        },
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    assert.deepEqual(result!.practiceQuota, { requiredCount: 2, metCount: 1 });
  });

  /**
   * D6 之前封存的 plan 行没有 `practiceForm`。这种批次不能被报成"缺额 0"以外的
   * 任何数——更准确地说，它压根没有过这个要求，头部就不该出现这一行。
   */
  it("reports no quota for a plan sealed before practice forms existed", async () => {
    const { practiceForm: _droppedForm, ...legacyObjective } = makePlanObjective("obj-1", "single_choice");
    const planResult = {
      kind: "author_candidates",
      recommendedCardCount: 1,
      activationHardMax: 1,
      existingActions: [],
      objectives: [legacyObjective],
    };
    setupTx({
      select: () => ({
        from: (table: unknown) => {
          if (table === cardGenerationRunsV2) {
            return { where: () => ({ limit: async () => [{ id: RUN_ID, currentPlanVersion: 1 }] }) };
          }
          if (table === cardGenerationPlansV2) {
            return { where: () => ({ limit: async () => [{ result: planResult }] }) };
          }
          return {
            where: () => [makeBaseCandidateRow()],
          };
        },
      }),
    });

    const result = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.ok(result);
    assert.deepEqual(result!.practiceQuota, { requiredCount: 0, metCount: 0 });
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

/**
 * 计划目标夹具：走 `plannedObjectiveV2Schema` 认得的字段形状，因为配额结算是
 * 先按计划合同解析 `result` 再算的——夹具过不了合同，测出来的就是"解析失败"而不是配额。
 */
function makePlanObjective(objectiveLocalId: string, practiceForm: string | null) {
  return {
    objectiveLocalId,
    objectiveStatement: `目标 ${objectiveLocalId}`,
    priority: "important" as const,
    knowledgeForm: "fact" as const,
    strategy: "recall" as const,
    practiceForm,
    sourceAtomIds: ["atom-1"],
    reasonCodes: ["knowledge_form_fit"],
    estimatedReviewCostSeconds: 30,
    changeContext: { kind: "create_new" as const },
  };
}
