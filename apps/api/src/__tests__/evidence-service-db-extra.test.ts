import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { evidenceOverrides, understandingEvents } from "../db/schema/evidence.ts";
import { evidenceRoutes } from "../modules/evidence/routes.ts";
import {
  getCardEvidence,
  overrideEvidence,
  removeEvidenceOverride,
} from "../modules/evidence/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000004";

const mutableDb = db as any;
const original = {
  transaction: mutableDb.transaction,
  delete: mutableDb.delete,
  cardsFindFirst: mutableDb.query.learningCards.findFirst,
  keyPointsFindMany: mutableDb.query.cardKeyPoints.findMany,
  keyPointsFindFirst: mutableDb.query.cardKeyPoints.findFirst,
  evidencesFindMany: mutableDb.query.evidences.findMany,
  evidencesFindFirst: mutableDb.query.evidences.findFirst,
  blocksFindMany: mutableDb.query.noteBlocks.findMany,
  overridesFindMany: mutableDb.query.evidenceOverrides.findMany,
};

// BUG-71 测试适配：withWorkspaceTransaction 内部调用 db.transaction 并执行
// setApiTransactionContext（需要 tx.execute），因此 mock 的 tx 必须提供 execute 方法
// 以及 query 委托到 db.query，使现有 mock 继续生效。
function passthroughTransaction(): any {
  return async (run: (tx: any) => Promise<any>) => run({
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    query: mutableDb.query,
    select: mutableDb.select,
    insert: mutableDb.insert,
    update: mutableDb.update,
    delete: mutableDb.delete,
  });
}

function restoreDatabase(): void {
  mutableDb.transaction = original.transaction;
  mutableDb.delete = original.delete;
  mutableDb.query.learningCards.findFirst = original.cardsFindFirst;
  mutableDb.query.cardKeyPoints.findMany = original.keyPointsFindMany;
  mutableDb.query.cardKeyPoints.findFirst = original.keyPointsFindFirst;
  mutableDb.query.evidences.findMany = original.evidencesFindMany;
  mutableDb.query.evidences.findFirst = original.evidencesFindFirst;
  mutableDb.query.noteBlocks.findMany = original.blocksFindMany;
  mutableDb.query.evidenceOverrides.findMany = original.overridesFindMany;
}

beforeEach(() => {
  restoreDatabase();
  // BUG-71 测试适配：默认使用 passthroughTransaction 支持 withWorkspaceTransaction
  mutableDb.transaction = passthroughTransaction();
});
after(restoreDatabase);

describe("evidence service hydration", () => {
  it("rejects a card outside the workspace before related reads", async () => {
    let relatedRead = false;
    mutableDb.query.learningCards.findFirst = async () => undefined;
    mutableDb.query.cardKeyPoints.findMany = async () => {
      relatedRead = true;
      return [];
    };

    assert.equal(await getCardEvidence(CARD_ID, WORKSPACE_ID, USER_ID), null);
    assert.equal(relatedRead, false);
  });

  it("returns early when a card has no key points without issuing empty related queries", async () => {
    mutableDb.query.learningCards.findFirst = async () => ({ id: CARD_ID });
    mutableDb.query.cardKeyPoints.findMany = async () => [];
    mutableDb.query.evidences.findMany = async () => {
      throw new Error("empty evidence query must be skipped");
    };
    mutableDb.query.noteBlocks.findMany = async () => {
      throw new Error("empty block query must be skipped");
    };
    mutableDb.query.evidenceOverrides.findMany = async () => {
      throw new Error("empty override query must be skipped");
    };

    assert.deepEqual(await getCardEvidence(CARD_ID, WORKSPACE_ID, USER_ID), []);
  });

  it("batches evidence and blocks, de-duplicates block ids, and applies user overrides", async () => {
    const queried = { blockReads: 0, overrideReads: 0 };
    mutableDb.query.learningCards.findFirst = async () => ({ id: CARD_ID });
    mutableDb.query.cardKeyPoints.findMany = async () => [
      { id: "kp-1", ordinal: 0 },
      { id: "kp-2", ordinal: 1 },
    ];
    mutableDb.query.evidences.findMany = async () => [
      {
        id: "ev-1",
        keyPointId: "kp-1",
        blockId: "block-1",
        userOverride: "downgraded",
      },
      {
        id: "ev-2",
        keyPointId: "kp-1",
        blockId: "block-1",
        userOverride: null,
      },
      {
        id: "ev-3",
        keyPointId: "kp-2",
        blockId: null,
        userOverride: "confirmed",
      },
    ];
    mutableDb.query.noteBlocks.findMany = async () => {
      queried.blockReads++;
      return [{ id: "block-1", content: "Grounded quote", type: "paragraph" }];
    };
    mutableDb.query.evidenceOverrides.findMany = async () => {
      queried.overrideReads++;
      return [
        { evidenceId: "ev-1", override: "rejected" },
        { evidenceId: "ev-3", override: "downgraded" },
      ];
    };

    const result = await getCardEvidence(CARD_ID, WORKSPACE_ID, USER_ID);

    assert.equal(queried.blockReads, 1);
    assert.equal(queried.overrideReads, 1);
    assert.deepEqual(result?.map((entry) => entry.evidences.map((ev: any) => ({
      id: ev.id,
      effectiveOverride: ev.effectiveOverride,
      blockContent: ev.blockContent,
      blockType: ev.blockType,
    }))), [
      [
        { id: "ev-1", effectiveOverride: "rejected", blockContent: "Grounded quote", blockType: "paragraph" },
        { id: "ev-2", effectiveOverride: null, blockContent: "Grounded quote", blockType: "paragraph" },
      ],
      [{ id: "ev-3", effectiveOverride: "downgraded", blockContent: null, blockType: null }],
    ]);
  });

  it("uses the legacy override when user has no overrides and tolerates missing blocks", async () => {
    mutableDb.query.learningCards.findFirst = async () => ({ id: CARD_ID });
    mutableDb.query.cardKeyPoints.findMany = async () => [{ id: "kp-1", ordinal: 0 }];
    mutableDb.query.evidences.findMany = async () => [{
      id: "ev-legacy",
      keyPointId: "kp-1",
      blockId: "missing-block",
      userOverride: "confirmed",
    }];
    mutableDb.query.noteBlocks.findMany = async () => [];
    // BUG-71 修复后 userId 必传，返回空数组模拟无用户级 override
    mutableDb.query.evidenceOverrides.findMany = async () => [];

    const result = await getCardEvidence(CARD_ID, WORKSPACE_ID, USER_ID);
    assert.deepEqual(result?.[0]?.evidences.map((ev: any) => ({
      effectiveOverride: ev.effectiveOverride,
      blockContent: ev.blockContent,
      blockType: ev.blockType,
    })), [{ effectiveOverride: "confirmed", blockContent: null, blockType: null }]);
  });
});

type OverrideTransactionFixture = {
  evidence?: any;
  keyPoint?: any;
  card?: any | null;
};

function installOverrideTransaction(fixture: OverrideTransactionFixture) {
  const inserts: Array<{ table: unknown; value: unknown; conflict?: unknown }> = [];
  const deletes: unknown[] = [];
  mutableDb.transaction = async (run: (tx: any) => Promise<unknown>) => run({
    // BUG-71 测试适配：withWorkspaceTransaction 需要 tx.execute
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    query: {
      evidences: { findFirst: async () => fixture.evidence },
      cardKeyPoints: { findFirst: async () => fixture.keyPoint },
      learningCards: {
        findFirst: async () => fixture.card === null
          ? undefined
          : fixture.card ?? (fixture.keyPoint ? { id: fixture.keyPoint.cardId } : undefined),
      },
      // BUG-71 测试适配：passthrough 查询委托
      learningCardsFindMany: async () => [],
      cardKeyPointsFindMany: async () => [],
      evidencesFindMany: async () => [],
      noteBlocksFindMany: async () => [],
      evidenceOverrides: { findMany: async () => [] },
    },
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        const entry: { table: unknown; value: unknown; conflict?: unknown } = { table, value };
        inserts.push(entry);
        return {
          onConflictDoUpdate: async (conflict: unknown) => {
            entry.conflict = conflict;
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deletes.push(table);
      },
    }),
  });
  return { inserts, deletes };
}

describe("evidence override mutations", () => {
  it("returns null without writing when the evidence is outside the workspace", async () => {
    const { inserts } = installOverrideTransaction({});
    assert.equal(
      await overrideEvidence(EVIDENCE_ID, WORKSPACE_ID, USER_ID, "confirmed"),
      null,
    );
    assert.equal(inserts.length, 0);
  });

  it("upserts a user override and emits the derived understanding event atomically", async () => {
    const { inserts } = installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-1" },
      keyPoint: { id: "kp-1", cardId: CARD_ID },
    });

    assert.deepEqual(
      await overrideEvidence(EVIDENCE_ID, WORKSPACE_ID, USER_ID, "rejected"),
      { ok: true },
    );
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0]?.table, evidenceOverrides);
    assert.deepEqual(inserts[0]?.value, {
      evidenceId: EVIDENCE_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      override: "rejected",
    });
    assert.ok(inserts[0]?.conflict);
    assert.equal(inserts[1]?.table, understandingEvents);
    assert.deepEqual(inserts[1]?.value, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      subjectType: "card",
      subjectId: CARD_ID,
      eventType: "evidence_overridden",
      payload: { evidenceId: EVIDENCE_ID, override: "rejected", keyPointId: "kp-1" },
    });
  });

  it("rejects an override when its key point no longer exists", async () => {
    const { inserts } = installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-deleted" },
    });
    assert.equal(
      await overrideEvidence(EVIDENCE_ID, WORKSPACE_ID, USER_ID, "downgraded"),
      null,
    );
    assert.equal(inserts.length, 0);
  });

  it("rejects an override when the target card is not consumer-active", async () => {
    const { inserts } = installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-1" },
      keyPoint: { id: "kp-1", cardId: CARD_ID },
      card: null,
    });
    assert.equal(
      await overrideEvidence(EVIDENCE_ID, WORKSPACE_ID, USER_ID, "confirmed"),
      null,
    );
    assert.equal(inserts.length, 0);
  });

  it("removes only the current user's override and handles missing evidence", async () => {
    let fixture = installOverrideTransaction({});
    assert.equal(await removeEvidenceOverride(EVIDENCE_ID, WORKSPACE_ID, USER_ID), null);
    assert.equal(fixture.deletes.length, 0);

    fixture = installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-1" },
      keyPoint: { id: "kp-1", cardId: CARD_ID },
    });
    assert.deepEqual(await removeEvidenceOverride(EVIDENCE_ID, WORKSPACE_ID, USER_ID), { ok: true });
    assert.deepEqual(fixture.deletes, [evidenceOverrides]);
  });
});

type RouteHandler = (request: any, reply: any) => Promise<unknown>;

function createRouteApp() {
  const handlers = new Map<string, RouteHandler>();
  let hook: unknown;
  const app = {
    httpErrors: {
      badRequest(message: string) {
        const error = new Error(message) as Error & { statusCode: number };
        error.statusCode = 400;
        return error;
      },
    },
    addHook(name: string, value: unknown) {
      assert.equal(name, "preHandler");
      hook = value;
    },
    get(path: string, handler: RouteHandler) { handlers.set(`GET ${path}`, handler); },
    post(path: string, handler: RouteHandler) { handlers.set(`POST ${path}`, handler); },
    delete(path: string, handler: RouteHandler) { handlers.set(`DELETE ${path}`, handler); },
  };
  return { app: app as any, handlers, getHook: () => hook };
}

function createReply() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    code(statusCode: number) { this.statusCode = statusCode; return this; },
    send(payload: unknown) { this.payload = payload; return payload; },
  };
}

describe("evidence routes", () => {
  it("registers the session hook and all three endpoints", async () => {
    const routeApp = createRouteApp();
    await evidenceRoutes(routeApp.app);
    assert.equal(typeof routeApp.getHook(), "function");
    assert.deepEqual([...routeApp.handlers.keys()], [
      "GET /cards/:cardId/evidence",
      "POST /evidences/:id/override",
      "DELETE /evidences/:id/override",
    ]);
  });

  it("validates card ids and returns not found or hydrated evidence", async () => {
    const routeApp = createRouteApp();
    await evidenceRoutes(routeApp.app);
    const handler = routeApp.handlers.get("GET /cards/:cardId/evidence")!;
    const session = { workspaceId: WORKSPACE_ID, userId: USER_ID };

    let reply = createReply();
    await handler({ params: { cardId: "bad" }, session }, reply);
    assert.equal(reply.statusCode, 400);

    mutableDb.query.learningCards.findFirst = async () => undefined;
    reply = createReply();
    await handler({ params: { cardId: CARD_ID }, session }, reply);
    assert.equal(reply.statusCode, 404);

    mutableDb.query.learningCards.findFirst = async () => ({ id: CARD_ID });
    mutableDb.query.cardKeyPoints.findMany = async () => [];
    reply = createReply();
    assert.deepEqual(await handler({ params: { cardId: CARD_ID }, session }, reply), []);
    assert.equal(reply.statusCode, 200);
  });

  it("validates override ids and bodies and maps mutation misses to 404", async () => {
    const routeApp = createRouteApp();
    await evidenceRoutes(routeApp.app);
    const post = routeApp.handlers.get("POST /evidences/:id/override")!;
    const remove = routeApp.handlers.get("DELETE /evidences/:id/override")!;
    const session = { workspaceId: WORKSPACE_ID, userId: USER_ID };

    let reply = createReply();
    await post({ params: { id: "bad" }, body: { override: "confirmed" }, session }, reply);
    assert.equal(reply.statusCode, 400);

    await assert.rejects(
      post({ params: { id: EVIDENCE_ID }, body: { override: "invalid" }, session }, createReply()),
      (error: any) => error.statusCode === 400,
    );

    mutableDb.transaction = async (run: (tx: any) => Promise<unknown>) => run({
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      query: { evidences: { findFirst: async () => undefined } },
    });
    reply = createReply();
    await post({ params: { id: EVIDENCE_ID }, body: { override: "confirmed" }, session }, reply);
    assert.equal(reply.statusCode, 404);

    reply = createReply();
    await remove({ params: { id: "bad" }, session }, reply);
    assert.equal(reply.statusCode, 400);

    mutableDb.query.evidences.findFirst = async () => undefined;
    reply = createReply();
    await remove({ params: { id: EVIDENCE_ID }, session }, reply);
    assert.equal(reply.statusCode, 404);
  });

  it("returns successful override and removal results", async () => {
    const routeApp = createRouteApp();
    await evidenceRoutes(routeApp.app);
    const post = routeApp.handlers.get("POST /evidences/:id/override")!;
    const remove = routeApp.handlers.get("DELETE /evidences/:id/override")!;
    const session = { workspaceId: WORKSPACE_ID, userId: USER_ID };

    installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-1" },
      keyPoint: { id: "kp-1", cardId: CARD_ID },
    });
    assert.deepEqual(
      await post({ params: { id: EVIDENCE_ID }, body: { override: "confirmed" }, session }, createReply()),
      { ok: true },
    );

    installOverrideTransaction({
      evidence: { id: EVIDENCE_ID, keyPointId: "kp-1" },
      keyPoint: { id: "kp-1", cardId: CARD_ID },
    });
    assert.deepEqual(
      await remove({ params: { id: EVIDENCE_ID }, session }, createReply()),
      { ok: true },
    );
  });
});
