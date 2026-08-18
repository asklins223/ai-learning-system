import assert from "node:assert/strict";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  HandlerTimeoutError,
  runWithAbortTimeout,
} from "../lib/handler-timeout.ts";
import {
  JobLeaseLostError,
  throwIfJobAborted,
} from "../lib/job-lease.ts";
import {
  DEFAULT_AI_DATA_POLICY,
  logAICall,
  normalizeWorkspaceAIPolicy,
} from "../lib/governance.ts";
import { DashScopeProvider } from "../lib/providers/dashscope.ts";
import { evaluateValidationViaChat } from "../lib/business-ai-ops.ts";
import {
  assertWorkerWorkspaceTransactionContextCompatible,
  normalizeWorkerWorkspaceTransactionContext,
  resolveWorkerDatabaseUrl,
  WorkerWorkspaceTransactionContextError,
} from "../db.ts";
import { retryBackoffMs } from "../lib/job-retry.ts";
import {
  claimJobs,
  createDrizzleQueueJobUpdater,
  markJobFailed,
  markJobSucceeded,
  reapStaleJobs,
  type ClaimedJob,
  type QueueJobUpdate,
  type QueueJobUpdater,
  type QueueSqlExecutor,
  type QueueTransactionRunner,
} from "../queue.ts";
import * as schema from "../schema/index.ts";

const claimedJobFixture: ClaimedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "execute_card_agent_turn",
  payload: { noteVersionId: "note-1" },
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  requestedBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  attempts: 0,
  leaseToken: "lease-token-1",
};

function queueExecutorWithRows(rows: Record<string, unknown>[]): QueueSqlExecutor {
  return {
    execute: async <T extends Record<string, unknown>>() => rows as T[],
  };
}

test("queue claim maps database rows to trusted worker jobs", async () => {
  const jobs = await claimJobs(queueExecutorWithRows([
    {
      id: "job-1",
      type: "parse_source",
      payload: { sourceId: "source-1" },
      workspace_id: "workspace-1",
      requested_by: "actor-1",
      attempts: 2,
      lease_token: "lease-1",
    },
    {
      id: "job-2",
      type: "execute_card_agent_turn",
      payload: null,
      workspace_id: "workspace-2",
      requested_by: null,
      attempts: null,
      lease_token: "lease-2",
    },
  ]));

  assert.deepEqual(jobs, [
    {
      id: "job-1",
      type: "parse_source",
      payload: { sourceId: "source-1" },
      workspaceId: "workspace-1",
      requestedBy: "actor-1",
      attempts: 2,
      leaseToken: "lease-1",
    },
    {
      id: "job-2",
      type: "execute_card_agent_turn",
      payload: {},
      workspaceId: "workspace-2",
      requestedBy: null,
      attempts: 0,
      leaseToken: "lease-2",
    },
  ]);
});

test("queue reaper summarizes pending and dead results", async () => {
  const result = await reapStaleJobs(queueExecutorWithRows([
    { id: "job-pending", status: "pending" },
    { id: "job-dead", status: "dead" },
    { id: "job-other", status: "failed" },
  ]));

  assert.deepEqual(result, {
    total: 3,
    pending: 1,
    dead: 1,
    ids: ["job-pending", "job-dead", "job-other"],
  });
});

test("successful queue updates are fenced by workspace, running state, and lease token", async () => {
  let context: unknown;
  let values: unknown;
  let predicate: SQL | undefined;
  let returnedRows = [{ id: claimedJobFixture.id }];
  const transaction = {
    update: (table: unknown) => {
      assert.equal(table, schema.jobs);
      return {
        set: (nextValues: unknown) => {
          values = nextValues;
          return {
            where: (nextPredicate: SQL) => {
              predicate = nextPredicate;
              return {
                returning: () => Promise.resolve(returnedRows),
              };
            },
          };
        },
      };
    },
  };
  const runTransaction: QueueTransactionRunner = async (nextContext, operation) => {
    context = nextContext;
    return operation(transaction as never);
  };
  const updateJob = createDrizzleQueueJobUpdater(runTransaction);
  const finishedAt = new Date("2026-07-18T12:00:00.000Z");

  assert.equal(await markJobSucceeded(claimedJobFixture, updateJob, () => finishedAt), true);
  assert.deepEqual(context, {
    workspaceId: claimedJobFixture.workspaceId,
    userId: claimedJobFixture.requestedBy,
  });
  assert.deepEqual(values, {
    status: "succeeded",
    finishedAt,
    leaseToken: null,
  });

  assert.ok(predicate);
  const query = new PgDialect().sqlToQuery(predicate);
  assert.match(query.sql, /"jobs"\."id" = \$1/);
  assert.match(query.sql, /"jobs"\."workspace_id" = \$2/);
  assert.match(query.sql, /"jobs"\."status" = \$3/);
  assert.match(query.sql, /"jobs"\."lease_token" = \$4/);
  assert.deepEqual(query.params, [
    claimedJobFixture.id,
    claimedJobFixture.workspaceId,
    "running",
    claimedJobFixture.leaseToken,
  ]);

  // A reaped/re-claimed job changes the lease, so the fenced UPDATE returns no
  // row and the adapter reports that the success transition was not applied.
  returnedRows = [];
  assert.equal(await markJobSucceeded(claimedJobFixture, updateJob, () => finishedAt), false);
});

test("failed jobs below the attempt limit return to pending with backoff", async () => {
  const updates: QueueJobUpdate[] = [];
  const updateJob: QueueJobUpdater = async (update) => {
    updates.push(update);
    return true;
  };
  const epochMs = Date.parse("2026-07-18T12:00:00.000Z");

  const transition = await markJobFailed(
    claimedJobFixture,
    "provider unavailable",
    updateJob,
    () => new Date(epochMs),
    () => epochMs,
  );

  assert.deepEqual(transition, {
    updated: true,
    status: "pending",
    attempts: 1,
    backoffMs: 2_000,
  });
  assert.deepEqual(updates, [{
    context: {
      workspaceId: claimedJobFixture.workspaceId,
      userId: claimedJobFixture.requestedBy,
    },
    fence: {
      id: claimedJobFixture.id,
      workspaceId: claimedJobFixture.workspaceId,
      status: "running",
      leaseToken: claimedJobFixture.leaseToken,
    },
    values: {
      status: "pending",
      attempts: 1,
      lastError: "operational_error:provider:Error",
      startedAt: null,
      leaseToken: null,
      finishedAt: null,
      scheduledAt: new Date(epochMs + 2_000),
    },
  }]);
});

test("queue persistence redacts SQL parameters and answer content", async () => {
  let update: QueueJobUpdate | undefined;
  const updateJob: QueueJobUpdater = async (nextUpdate) => {
    update = nextUpdate;
    return true;
  };
  const secret = "用户答案：不应进入 last_error";

  await markJobFailed(
    claimedJobFixture,
    `DrizzleQueryError: Failed query: INSERT params: ${secret}`,
    updateJob,
  );

  assert.equal(update?.values.lastError, "operational_error:database:Error");
  assert.ok(!update?.values.lastError?.includes(secret));
  assert.ok(!update?.values.lastError?.includes("INSERT"));
  assert.ok(!update?.values.lastError?.includes("params"));
});

test("failed jobs at the attempt limit become dead without retry delay", async () => {
  let update: QueueJobUpdate | undefined;
  const updateJob: QueueJobUpdater = async (nextUpdate) => {
    update = nextUpdate;
    return true;
  };
  const epochMs = Date.parse("2026-07-18T12:00:00.000Z");
  const exhaustedJob = { ...claimedJobFixture, attempts: 2 };

  const transition = await markJobFailed(
    exhaustedJob,
    "model deadline exceeded",
    updateJob,
    () => new Date(epochMs),
    () => epochMs,
  );

  assert.deepEqual(transition, {
    updated: true,
    status: "dead",
    attempts: 3,
    backoffMs: 0,
  });
  assert.equal(update?.values.status, "dead");
  assert.equal(update?.values.attempts, 3);
  assert.deepEqual(update?.values.finishedAt, new Date(epochMs));
  assert.deepEqual(update?.values.scheduledAt, new Date(epochMs));
  assert.equal(update?.fence.leaseToken, exhaustedJob.leaseToken);
});

test("production workers fail closed when the dedicated database role is missing", () => {
  assert.throws(
    () => resolveWorkerDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://shared" }),
    /DATABASE_URL_WORKER is required when NODE_ENV=production/,
  );
  assert.equal(
    resolveWorkerDatabaseUrl({ NODE_ENV: "production", DATABASE_URL_WORKER: "postgres://worker" }),
    "postgres://worker",
  );
  assert.equal(
    resolveWorkerDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: "   " }),
    "postgres://ailearn:ailearn_dev@postgres:5432/ailearn",
  );
});

test("worker transaction context validates UUIDs and forbids nested context changes", () => {
  const active = normalizeWorkerWorkspaceTransactionContext({
    workspaceId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    userId: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
  });
  assert.deepEqual(active, {
    workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  });
  assert.doesNotThrow(() => {
    assertWorkerWorkspaceTransactionContextCompatible(active, { ...active });
  });
  assert.throws(
    () => assertWorkerWorkspaceTransactionContextCompatible(active, {
      workspaceId: active.workspaceId,
      userId: null,
    }),
    WorkerWorkspaceTransactionContextError,
  );
  assert.throws(
    () => normalizeWorkerWorkspaceTransactionContext({
      workspaceId: "not-a-uuid",
      userId: null,
    }),
    WorkerWorkspaceTransactionContextError,
  );
});

test("retry backoff starts at two seconds and doubles per previous failure", () => {
  assert.deepEqual([0, 1, 2].map(retryBackoffMs), [2_000, 4_000, 8_000]);
  assert.throws(() => retryBackoffMs(-1), RangeError);
  assert.throws(() => retryBackoffMs(0.5), RangeError);
});

test("timeout aborts the provider signal and fences late handler work", async () => {
  let observedSignal: AbortSignal | undefined;
  let lateSideEffect = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const result = runWithAbortTimeout(
    async (signal) => {
      observedSignal = signal;
      await gate;
      if (!signal.aborted) lateSideEffect = true;
      return "late";
    },
    20,
  );

  await assert.rejects(result, (error: unknown) => error instanceof HandlerTimeoutError);
  assert.equal(observedSignal?.aborted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateSideEffect, false);
});

test("an aborted lease fails closed before a transaction can commit", () => {
  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  assert.throws(
    () => throwIfJobAborted({
      id: "job-1",
      workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      requestedBy: null,
      leaseToken: "lease-1",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof JobLeaseLostError,
  );
});

test("DashScope forwards the worker AbortSignal to the HTTP request", async () => {
  let requestSignal: AbortSignal | undefined;
  const request: typeof globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    await new Promise<never>((_, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
    throw new Error("request should have been aborted");
  };
  const provider = new DashScopeProvider({ apiKey: "test-key", request });
  const controller = new AbortController();
  const pending = evaluateValidationViaChat(
    provider,
    { question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A" },
    controller.signal,
  );
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(requestSignal, controller.signal);
});

test("DashScope compatible HTTP path preserves the generation request contract", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const request: typeof globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            outcome: "preliminary_understanding",
            confidence: 0.85,
            feedback: "Good",
            covered_points: [],
            missing_points: [],
            misunderstandings: [],
            evidence_refs: [],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = new DashScopeProvider({
    apiKey: "test-key",
    basePath: "https://dashscope.invalid/api/v1/",
    request,
  });

  await evaluateValidationViaChat(provider, {
    question: "Q", questionType: "t", claim: "C", quote: "R", userAnswer: "A",
  });

  assert.equal(requestedUrl, "https://dashscope.invalid/compatible-mode/v1/chat/completions");
  assert.equal(requestBody?.model, "qwen-plus");
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
});

test("auditLogging policy disables writes without changing attribution", async () => {
  const writes: unknown[] = [];
  const params = {
    workspaceId: "workspace-1",
    userId: "initiator-1",
    jobId: "job-1",
    provider: "mock",
    modelId: "mock-v1",
      operation: "execute_card_agent_turn",
  };

  const disabled = await logAICall(params, {
    getPolicy: async () => ({ ...DEFAULT_AI_DATA_POLICY, auditLogging: false }),
    write: async (row) => {
      writes.push(row);
    },
  });
  assert.equal(disabled, false);
  assert.equal(writes.length, 0);

  const enabled = await logAICall(params, {
    getPolicy: async () => ({ ...DEFAULT_AI_DATA_POLICY, auditLogging: true }),
    write: async (row) => {
      writes.push(row);
    },
  });
  assert.equal(enabled, true);
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as { userId: string }).userId, "initiator-1");
});

test("workspace policy normalization preserves explicit false values", () => {
  assert.deepEqual(
    normalizeWorkspaceAIPolicy({ sendToExternal: true, piiDetection: false, auditLogging: false }),
    { sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: false },
  );
  assert.deepEqual(normalizeWorkspaceAIPolicy({ auditLogging: false }), {
    ...DEFAULT_AI_DATA_POLICY,
    auditLogging: false,
  });
});
