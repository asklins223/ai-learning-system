import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  assertWorkerWorkspaceTransactionContextCompatible,
  normalizeWorkerWorkspaceTransactionContext,
  resolveWorkerDatabaseUrl,
  WorkerWorkspaceTransactionContextError,
} from "../db.ts";
import {
  claimJobs,
  markJobFailed,
  reapStaleJobs,
  type ClaimedJob,
  type QueueJobUpdate,
  type QueueJobUpdater,
  type JobUpdateResult,
  type QueueSqlExecutor,
} from "../queue.ts";

const claimedJobFixture: ClaimedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "parse_source",
  payload: { noteVersionId: "note-1" },
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  requestedBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  attempts: 0,
  leaseToken: "lease-token-1",
  resourceClass: "card_foreground",
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
      resource_class: "card_foreground",
    },
    {
      id: "job-2",
      type: "companion_agent",
      payload: null,
      workspace_id: "workspace-2",
      requested_by: null,
      attempts: null,
      lease_token: "lease-2",
      resource_class: "interactive_ai",
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
      resourceClass: "card_foreground",
    },
    {
      id: "job-2",
      type: "companion_agent",
      payload: {},
      workspaceId: "workspace-2",
      requestedBy: null,
      attempts: 0,
      leaseToken: "lease-2",
      resourceClass: "interactive_ai",
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

test("failed jobs below the attempt limit return to pending with backoff", async () => {
  const updates: QueueJobUpdate[] = [];
  const updateJob: QueueJobUpdater = async (update) => {
    updates.push(update);
    return { updated: true, status: "pending", attempts: 1, backoffMs: 2_000 } satisfies JobUpdateResult;
  };
  const transition = await markJobFailed(
    claimedJobFixture,
    "provider unavailable",
    updateJob,
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
      lastError: "operational_error:provider:Error",
      startedAt: null,
      leaseToken: null,
      finishedAt: null,
    },
  }]);
});

test("queue persistence redacts SQL parameters and answer content", async () => {
  let update: QueueJobUpdate | undefined;
  const updateJob: QueueJobUpdater = async (nextUpdate) => {
    update = nextUpdate;
    return { updated: true, status: "pending", attempts: 1, backoffMs: 2_000 };
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
    return { updated: true, status: "dead", attempts: 3, backoffMs: 0 };
  };
  const exhaustedJob = { ...claimedJobFixture, attempts: 2 };

  const transition = await markJobFailed(
    exhaustedJob,
    "model deadline exceeded",
    updateJob,
  );

  assert.deepEqual(transition, {
    updated: true,
    status: "dead",
    attempts: 3,
    backoffMs: 0,
  });
  assert.equal(update?.values.status, "pending");
  assert.equal(update?.values.attempts, undefined);
  assert.equal(update?.values.finishedAt, null);
  assert.equal(update?.values.scheduledAt, undefined);
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

test("auditLogging policy disables writes without changing attribution", async () => {
  const writes: unknown[] = [];
  const params = {
    workspaceId: "workspace-1",
    userId: "initiator-1",
    jobId: "job-1",
    provider: "mock",
    modelId: "mock-v1",
      operation: "companion_agent",
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
