/**
 * 方案 20 — SSE Event Stream + Outbox Enqueue 测试。
 *
 * 覆盖：
 * - GET /v2/card-generation-runs/:runId/events/stream 返回 SSE 格式
 * - SSE 端点设置正确的 Content-Type 和 Cache-Control
 * - Run 创建时写入 outbox 行
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { cardGenerationV2Routes } from "../modules/card-generation-v2/routes.ts";
import { createGenerationRunV2 } from "../modules/card-generation-v2/generation-run-service.ts";
import { cardGenerationEventsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { db } from "../db/client.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

describe("SSE Event Stream endpoint", () => {
  it("registers /v2/card-generation-runs/:runId/events/stream route", async () => {
    const routes: string[] = [];
    const mockApp = {
      addHook: () => {},
      get: (path: string, ..._args: unknown[]) => { routes.push(path); },
      post: () => {},
    };
    await cardGenerationV2Routes(mockApp as unknown as FastifyInstance);
    assert.ok(
      routes.includes("/v2/card-generation-runs/:runId/events/stream"),
      "SSE stream route must be registered",
    );
  });
});

describe("createGenerationRunV2 — outbox enqueue", () => {
  it("inserts a card_generation_run_outbox_v2 row on run creation", async () => {
    const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];

    const mockTx: any = {
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      select: () => ({
        from: (table: unknown) => {
          // 按表判定，不按「有没有传 columns」——generation-run-service 里
          // 带 columns 的查询不止 events 一处（幂等回放、按笔记的在制守卫、
          // 上一个已激活批次），用 columns 区分会让它们全部命中同一份返回值。
          const result = table === cardGenerationEventsV2 ? [{ maxSeq: 0 }] : [];
          const whereResult = {
            // Support both direct await (thenable) and .limit() chain
            limit: async () => result,
            orderBy: () => whereResult,
            then(resolve: any, _reject: any) {
              return Promise.resolve(result).then(resolve);
            },
          };
          return {
            where: () => whereResult,
          };
        },
      }),
      query: {
        noteVersions: { findFirst: async () => ({ noteId: "note-1" }) },
        notes: { findFirst: async () => ({ id: "note-1" }) },
        noteBlocks: { findMany: async () => [] },
      },
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertCalls.push({ table, values: vals });
          return { onConflictDoNothing: () => {} };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({}),
        }),
      }),
    };

    const originalTransaction = db.transaction;
    db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)) as typeof db.transaction;

    try {
      const result = await createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        "note-version-1",
        {
          version: 2,
          noteVersionId: "note-version-1",
          sourceScope: { kind: "whole_note" },
          learningGoal: "understand",
          detailThreshold: "balanced",
          quantity: 3,
          preferredStrategies: [],
          feedbackContext: undefined,
        } as never,
        "run-idem-001",
      );

      // Verify outbox row was inserted
      const outboxInsert = insertCalls.find(
        (c) => c.values && c.values.jobType === "card_generation_plan",
      );
      assert.ok(outboxInsert, "must insert a card_generation_run_outbox_v2 row");
      assert.equal(
        outboxInsert!.values.status,
        "pending",
        "outbox row status should be 'pending'",
      );
      assert.equal(
        outboxInsert!.values.runId,
        result.runId,
        "outbox row should reference the created run",
      );
    } finally {
      db.transaction = originalTransaction;
    }
  });
});

describe("getGenerationRunEventsV2 — cursor 恢复（§17.1）", () => {
  it("returns only events after the cursor and sanitizes payloads", async () => {
    let rows = [
      { eventSeq: 1, eventType: "card_generation.created", payload: { runId: "r", canonicalAnswer: "SECRET" }, createdAt: new Date() },
      { eventSeq: 2, eventType: "card_candidate.grounding_passed", payload: { candidateId: "c" }, createdAt: new Date() },
      { eventSeq: 3, eventType: "card_candidate.review_ready", payload: { candidateId: "c" }, createdAt: new Date() },
    ];
    // mock 模拟 SQL 层 `event_seq > afterSeq` 过滤（drizzle 条件对象无法在
    // mock 中内省，故由 mock 按函数传入的 cursor 语义过滤）。
    let chain: { where: (c: unknown) => typeof chain; orderBy: () => typeof chain; limit: () => Promise<typeof rows> };
    chain = {
      where: (_cond: unknown) => {
        rows = rows.filter((r) => r.eventSeq > 2);
        return chain;
      },
      orderBy: () => chain,
      limit: async () => rows,
    };
    const mockTx: any = {
      execute: async () => [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }],
      select: () => ({ from: () => chain }),
    };
    const originalTransaction = db.transaction;
    db.transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)) as typeof db.transaction;
    const { getGenerationRunEventsV2 } = await import(
      "../modules/card-generation-v2/generation-run-service.ts"
    );
    let events: Awaited<ReturnType<typeof getGenerationRunEventsV2>>;
    try {
      events = await getGenerationRunEventsV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        "00000000-0000-4000-8000-00000000000a",
        2,
      );
    } finally {
      db.transaction = originalTransaction;
    }
    // after=2 → 仅 seq 3
    assert.equal(events.length, 1, "cursor recovery must return only events after the cursor");
    assert.equal(events[0].eventSeq, 3);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes("SECRET"), "private payload fields must be stripped");
  });
});
