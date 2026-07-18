import assert from "node:assert/strict";
import { test } from "node:test";
import { requireAuditUserId } from "../handlers/index.ts";
import {
  HandlerTimeoutError,
  runWithAbortTimeout,
} from "./handler-timeout.ts";
import {
  JobLeaseLostError,
  throwIfJobAborted,
} from "./job-lease.ts";
import {
  DEFAULT_AI_DATA_POLICY,
  logAICall,
  normalizeWorkspaceAIPolicy,
} from "./governance.ts";
import { DashScopeProvider } from "./providers/dashscope.ts";
import {
  assertWorkerWorkspaceTransactionContextCompatible,
  normalizeWorkerWorkspaceTransactionContext,
  resolveWorkerDatabaseUrl,
  WorkerWorkspaceTransactionContextError,
} from "../db.ts";
import { retryBackoffMs } from "./job-retry.ts";

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

test("retry backoff starts at ten seconds and doubles per previous failure", () => {
  assert.deepEqual([0, 1, 2].map(retryBackoffMs), [10_000, 20_000, 40_000]);
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
  const pending = provider.generateCard({ noteTitle: "N", blocks: [] }, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(requestSignal, controller.signal);
});

test("DashScope direct HTTP path preserves the generation request contract", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const request: typeof globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: {
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Card",
              summary: "Summary",
              key_points: [{ ordinal: 0, claim: "Claim", quote_text: "Quote" }],
            }),
          },
        }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = new DashScopeProvider({
    apiKey: "test-key",
    basePath: "https://dashscope.invalid/api/v1/",
    request,
  });

  const output = await provider.generateCard({ noteTitle: "N", blocks: [] });

  assert.equal(requestedUrl, "https://dashscope.invalid/api/v1/services/aigc/text-generation/generation");
  assert.equal(requestBody?.model, "qwen-plus");
  assert.equal((requestBody?.parameters as { result_format?: string }).result_format, "message");
  assert.equal(output.title, "Card");
});

test("auditLogging policy disables writes without changing attribution", async () => {
  const writes: unknown[] = [];
  const params = {
    workspaceId: "workspace-1",
    userId: "initiator-1",
    jobId: "job-1",
    provider: "mock",
    modelId: "mock-v1",
    operation: "generate_card",
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

test("job actor attribution trusts requestedBy and rejects payload overrides", () => {
  assert.throws(
    () => requireAuditUserId({ requestedBy: null, payload: { userId: "payload-actor" } }),
    /refusing to fabricate AI audit attribution/,
  );
  assert.equal(
    requireAuditUserId({ requestedBy: "initiator-1", payload: {} }),
    "initiator-1",
  );
  assert.throws(
    () => requireAuditUserId({
      requestedBy: "trusted-actor",
      payload: { userId: "payload-actor" },
    }),
    /does not match trusted requestedBy/,
  );
});

test("workspace policy normalization preserves explicit false values", () => {
  assert.deepEqual(
    normalizeWorkspaceAIPolicy({ sendToExternal: true, piiDetection: false, auditLogging: false }),
    { sendToExternal: true, piiDetection: false, auditLogging: false },
  );
  assert.deepEqual(normalizeWorkspaceAIPolicy({ auditLogging: false }), {
    ...DEFAULT_AI_DATA_POLICY,
    auditLogging: false,
  });
});
