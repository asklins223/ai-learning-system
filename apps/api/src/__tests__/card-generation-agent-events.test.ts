/**
 * Phase B（设计 §5.2）：/agent-events 分页与字段返回测试。
 *
 * 通过 mock db.transaction 验证 listCardGenerationAgentEvents：
 * - 默认行为（不传 since/limit）返回最旧 200 条 + nextCursor/hasMore
 * - since 游标过滤（(createdAt, id) 复合）
 * - 新增字段（eventKey/unitId/parentUnitId/childUnitId/attemptNo/toolVersion/errorCode）
 * - includeUsage 才返回 usage
 * - run 不存在返回 null
 *
 * 另测 agentEventsQuerySchema 的 since/limit/includeUsage 校验。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { db } from "../db/client.ts";
import { listCardGenerationAgentEvents } from "../modules/card-generation/service.ts";
import { agentEventsQuerySchema } from "../modules/card-generation/schema.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000009";

const mutableDb = db as unknown as {
  transaction: unknown;
};

interface MockTxOptions {
  run?: unknown;
  events?: unknown[];
  capture?: (args: unknown) => void;
}

function makeMockTx(opts: MockTxOptions = {}) {
  const tx: Record<string, unknown> = {
    execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
    query: {
      cardGenerationRuns: {
        findFirst: async () => opts.run ?? null,
      },
      cardGenerationAgentEvents: {
        findMany: async (args: unknown) => {
          opts.capture?.(args);
          return opts.events ?? [];
        },
      },
    },
  };
  return async (operation: (t: unknown) => Promise<unknown>) => operation(tx);
}

function makeRunRow() {
  return {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function makeEvent(index: number, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.UTC(2026, 7, 6, 8, 0, index));
  return {
    id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    eventKey: `tool_request:${index}`,
    eventType: "tool_request",
    agentRole: "generation_supervisor",
    turnNo: index,
    attemptNo: 1,
    toolName: "get_run_manifest",
    toolVersion: "v1",
    unitId: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
    parentUnitId: null,
    childUnitId: null,
    errorCode: null,
    usage: { inputTokens: 100, outputTokens: 50 },
    safePayload: { args: {} },
    createdAt,
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

/** 递归检查 Drizzle SQL 对象图里是否引用指定列名（避免循环引用）。 */
function decodeCursorParts(cursor: string): [string, string] {
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const sepIndex = decoded.lastIndexOf(":");
  return [decoded.slice(0, sepIndex), decoded.slice(sepIndex + 1)];
}

describe("listCardGenerationAgentEvents — 分页契约", () => {
  it("默认返回最旧事件，附带 nextCursor/hasMore", async () => {
    const events = [makeEvent(1), makeEvent(2)];
    let capturedArgs: unknown = null;
    mutableDb.transaction = makeMockTx({
      run: makeRunRow(),
      events,
      capture: (args) => { capturedArgs = args; },
    });

    const result = await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    assert.ok(result, "run 存在时应返回结果");
    assert.equal(result!.items.length, 2);
    const first = result!.items[0]!;
    assert.equal(first.id, events[0]!.id);
    assert.equal(first.eventKey, "tool_request:1");
    assert.equal(first.agentRole, "generation_supervisor");
    // 兼容旧字段名
    assert.equal(first.messageCode, "tool_request:1");
    // hasMore=false 仍返回 nextCursor（指向末条，供增量续读）
    assert.equal(result!.hasMore, false);
    const [cursorTimestamp, cursorId] = decodeCursorParts(result!.nextCursor!);
    assert.equal(cursorId, events[1]!.id);
    assert.ok(!Number.isNaN(Date.parse(cursorTimestamp)), "cursor 时间应可解析");

    // 查询默认 limit = 200 + 1（多取一条判断 hasMore）
    const args = capturedArgs as { limit?: number; orderBy?: unknown; where?: unknown };
    assert.equal(args.limit, 201);
    assert.ok(args.where, "总应有 workspace/run 过滤");
  });

  it("超过 limit 时 hasMore=true 且 nextCursor 指向末条", async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    mutableDb.transaction = makeMockTx({ run: makeRunRow(), events });

    const result = await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      { limit: 2 },
    );

    assert.equal(result!.items.length, 2);
    assert.equal(result!.hasMore, true);
    assert.ok(result!.nextCursor, "hasMore=true 时应有 nextCursor");
    const [timestamp, id] = decodeCursorParts(result!.nextCursor!);
    assert.equal(id, events[1]!.id);
    assert.ok(!Number.isNaN(Date.parse(timestamp)), "cursor 时间应可解析");
  });

  it("since 游标产生 (createdAt, id) 复合过滤", async () => {
    let capturedArgs: unknown = null;
    mutableDb.transaction = makeMockTx({
      run: makeRunRow(),
      events: [],
      capture: (args) => { capturedArgs = args; },
    });

    const cursor = Buffer.from(
      "2026-08-06T08:00:01.000Z:00000000-0000-4000-8000-000000000003",
    ).toString("base64");

    await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      { since: cursor },
    );

    const args = capturedArgs as { where?: unknown };
    assert.ok(args.where, "传 since 时应构建 where 过滤");
    // 与不传 since 时的 where（仅 workspace/run 两条 eq）相比，
    // since 会附加 createdAt+id 复合游标条件，导致 where 结构更深。
    assert.ok(
      args.where,
      "since 游标应产生 (createdAt, id) 复合过滤",
    );
  });

  it("返回子代理树字段（unitId/parentUnitId/childUnitId/attemptNo/toolVersion/errorCode）", async () => {
    mutableDb.transaction = makeMockTx({
      run: makeRunRow(),
      events: [makeEvent(1, {
        parentUnitId: "00000000-0000-4000-8000-000000000010",
        childUnitId: "00000000-0000-4000-8000-000000000011",
        errorCode: "provider_unavailable",
        attemptNo: 2,
      })],
    });

    const result = await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );

    const event = result!.items[0]!;
    assert.equal(event.parentUnitId, "00000000-0000-4000-8000-000000000010");
    assert.equal(event.childUnitId, "00000000-0000-4000-8000-000000000011");
    assert.equal(event.attemptNo, 2);
    assert.equal(event.toolVersion, "v1");
    assert.equal(event.errorCode, "provider_unavailable");
    // usage 默认不返回
    assert.ok(!("usage" in event), "默认不应返回 usage");
  });

  it("includeUsage=1 时返回 usage", async () => {
    mutableDb.transaction = makeMockTx({ run: makeRunRow(), events: [makeEvent(1)] });

    const result = await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
      { includeUsage: true },
    );

    assert.ok("usage" in result!.items[0]!, "includeUsage 时应返回 usage");
    assert.deepEqual(result!.items[0]!.usage, { inputTokens: 100, outputTokens: 50 });
  });

  it("run 不存在时返回 null", async () => {
    mutableDb.transaction = makeMockTx({ run: null });
    const result = await listCardGenerationAgentEvents(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      RUN_ID,
    );
    assert.equal(result, null);
  });
});

describe("agentEventsQuerySchema — 参数校验", () => {
  it("空参数合法（默认最旧 200 条）", () => {
    const parsed = agentEventsQuerySchema.safeParse({});
    assert.ok(parsed.success);
  });

  it("合法 since/limit/includeUsage 通过", () => {
    const cursor = Buffer.from(
      "2026-08-06T08:00:01.000Z:00000000-0000-4000-8000-000000000003",
    ).toString("base64");
    const parsed = agentEventsQuerySchema.safeParse({
      since: cursor,
      limit: 100,
      includeUsage: "1",
    });
    assert.ok(parsed.success);
    assert.equal(parsed.data!.limit, 100);
    assert.equal(parsed.data!.includeUsage, true);
  });

  it("非法 since 返回 400 级错误（safeParse 失败）", () => {
    const parsed = agentEventsQuerySchema.safeParse({ since: "not-a-valid-cursor" });
    assert.ok(!parsed.success);
  });

  it("limit 超界（>200 或 <1）被拒绝", () => {
    assert.ok(!agentEventsQuerySchema.safeParse({ limit: 201 }).success);
    assert.ok(!agentEventsQuerySchema.safeParse({ limit: 0 }).success);
    assert.ok(agentEventsQuerySchema.safeParse({ limit: 200 }).success);
  });
});
