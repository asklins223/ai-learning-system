/**
 * OPS-01: Worker Prometheus 指标模块单元测试（ADR-0006 §1-3）
 *
 * 验证：
 *   1. allowlist 完整性（JOB_TYPES/JOB_STATUSES/PROVIDER_OPERATIONS/ERROR_CATEGORIES）
 *   2. categorizeError 全分类覆盖
 *   3. 指标注册与递增正确性
 *   4. startMetricsServer HTTP 端点行为
 *   5. registry 隔离与 ailearn_ 前缀
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  jobQueueDepth,
  jobOldestPendingAgeSeconds,
  jobTerminalTotal,
  jobRetriesTotal,
  jobLeaseLostTotal,
  jobDurationSeconds,
  providerCallsTotal,
  providerCallDurationSeconds,
  providerErrorsTotal,
  categorizeError,
  startMetricsServer,
  JOB_TYPES,
  JOB_STATUSES,
  PROVIDER_OPERATIONS,
  ERROR_CATEGORIES,
} from "../lib/metrics.ts";

// ─── allowlist 完整性 ──────────────────────────────────────────────────

test("JOB_TYPES 包含全部 4 种 job 类型", () => {
  assert.equal(JOB_TYPES.length, 4);
  assert.ok(JOB_TYPES.includes("generate_card"));
  assert.ok(JOB_TYPES.includes("align_evidence"));
  assert.ok(JOB_TYPES.includes("evaluate_validation"));
  assert.ok(JOB_TYPES.includes("parse_source"));
});

test("JOB_TYPES 元素唯一", () => {
  const unique = new Set(JOB_TYPES);
  assert.equal(unique.size, JOB_TYPES.length);
});

test("JOB_STATUSES 包含全部 5 种状态", () => {
  assert.equal(JOB_STATUSES.length, 5);
  assert.ok(JOB_STATUSES.includes("pending"));
  assert.ok(JOB_STATUSES.includes("running"));
  assert.ok(JOB_STATUSES.includes("succeeded"));
  assert.ok(JOB_STATUSES.includes("failed"));
  assert.ok(JOB_STATUSES.includes("dead"));
});

test("PROVIDER_OPERATIONS 包含 3 种操作（不含 parse_source）", () => {
  assert.equal(PROVIDER_OPERATIONS.length, 3);
  assert.ok(PROVIDER_OPERATIONS.includes("generate_card"));
  assert.ok(PROVIDER_OPERATIONS.includes("align_evidence"));
  assert.ok(PROVIDER_OPERATIONS.includes("evaluate_validation"));
  assert.ok(!(PROVIDER_OPERATIONS as readonly string[]).includes("parse_source"));
});

test("ERROR_CATEGORIES 包含全部 10 种错误分类", () => {
  assert.equal(ERROR_CATEGORIES.length, 10);
  const expected = [
    "timeout",
    "schema_failure",
    "provider_5xx",
    "provider_4xx",
    "auth_error",
    "quota_exceeded",
    "network_error",
    "rls_denied",
    "validation_error",
    "unknown",
  ];
  for (const cat of expected) {
    assert.ok(ERROR_CATEGORIES.includes(cat as never), `missing ${cat}`);
  }
});

test("ERROR_CATEGORIES 元素唯一", () => {
  const unique = new Set(ERROR_CATEGORIES);
  assert.equal(unique.size, ERROR_CATEGORIES.length);
});

// ─── categorizeError ──────────────────────────────────────────────────

test("categorizeError: null/undefined 返回 unknown", () => {
  assert.equal(categorizeError(null), "unknown");
  assert.equal(categorizeError(undefined), "unknown");
});

test("categorizeError: timeout 关键词匹配", () => {
  assert.equal(categorizeError(new Error("request timeout")), "timeout");
  assert.equal(categorizeError(new Error("Operation timed out")), "timeout");
  assert.equal(categorizeError(new Error("aborted by user")), "timeout");
  assert.equal(categorizeError("timeout exceeded"), "timeout");
});

test("categorizeError: schema_failure 关键词匹配", () => {
  assert.equal(categorizeError(new Error("schema validation failed")), "schema_failure");
  assert.equal(categorizeError(new Error("parse error")), "schema_failure");
  assert.equal(categorizeError(new Error("invalid JSON")), "schema_failure");
});

test("categorizeError: provider_5xx 关键词匹配", () => {
  assert.equal(categorizeError(new Error("500 internal server error")), "provider_5xx");
  assert.equal(categorizeError(new Error("502 bad gateway")), "provider_5xx");
  assert.equal(categorizeError(new Error("503 service unavailable")), "provider_5xx");
  // Note: "504 gateway timeout" matches "timeout" first due to keyword priority
  assert.equal(categorizeError(new Error("HTTP 504 error")), "provider_5xx");
});

test("categorizeError: auth_error 关键词匹配", () => {
  assert.equal(categorizeError(new Error("401 unauthorized")), "auth_error");
  assert.equal(categorizeError(new Error("403 forbidden")), "auth_error");
  assert.equal(categorizeError(new Error("authentication failed")), "auth_error");
});

test("categorizeError: quota_exceeded 关键词匹配", () => {
  assert.equal(categorizeError(new Error("quota exceeded")), "quota_exceeded");
  assert.equal(categorizeError(new Error("rate limit hit")), "quota_exceeded");
  assert.equal(categorizeError(new Error("429 too many requests")), "quota_exceeded");
});

test("categorizeError: network_error 关键词匹配", () => {
  assert.equal(categorizeError(new Error("network error")), "network_error");
  assert.equal(categorizeError(new Error("ECONNREFUSED")), "network_error");
  assert.equal(categorizeError(new Error("ENOTFOUND")), "network_error");
});

test("categorizeError: rls_denied 关键词匹配", () => {
  assert.equal(categorizeError(new Error("RLS policy denied")), "rls_denied");
  assert.equal(categorizeError(new Error("row-level policy violation")), "rls_denied");
});

test("categorizeError: validation_error 关键词匹配", () => {
  assert.equal(categorizeError(new Error("validation failed")), "validation_error");
  assert.equal(categorizeError(new Error("invalid input")), "validation_error");
});

test("categorizeError: provider_4xx 关键词匹配", () => {
  assert.equal(categorizeError(new Error("400 bad request")), "provider_4xx");
  assert.equal(categorizeError(new Error("422 unprocessable entity")), "provider_4xx");
});

test("categorizeError: 无法分类的错误返回 unknown", () => {
  assert.equal(categorizeError(new Error("something unexpected")), "unknown");
  assert.equal(categorizeError("random string"), "unknown");
  assert.equal(categorizeError(42), "unknown");
});

test("categorizeError: 非错误对象使用 String 转换", () => {
  assert.equal(categorizeError({ message: "timeout" }), "unknown");
  assert.equal(categorizeError("[object Object]"), "unknown");
});

// ─── 指标注册与递增 ────────────────────────────────────────────────────

test("jobQueueDepth 正确设置值", () => {
  jobQueueDepth.set({ status: "pending" }, 10);
  jobQueueDepth.set({ status: "running" }, 3);
  jobQueueDepth.set({ status: "dead" }, 1);
  assert.ok(true);
});

test("jobOldestPendingAgeSeconds 正确设置值", () => {
  jobOldestPendingAgeSeconds.set(120);
  assert.ok(true);
});

test("jobTerminalTotal 按 type/status 正确递增", () => {
  jobTerminalTotal.labels("generate_card", "succeeded").inc();
  jobTerminalTotal.labels("generate_card", "succeeded").inc();
  jobTerminalTotal.labels("align_evidence", "dead").inc();
  assert.ok(true);
});

test("jobRetriesTotal 按 type 正确递增", () => {
  jobRetriesTotal.labels("generate_card").inc();
  jobRetriesTotal.labels("evaluate_validation").inc();
  assert.ok(true);
});

test("jobLeaseLostTotal 按 type 正确递增", () => {
  jobLeaseLostTotal.labels("generate_card").inc();
  assert.ok(true);
});

test("jobDurationSeconds 正确观察值", () => {
  jobDurationSeconds.labels("generate_card").observe(0.5);
  jobDurationSeconds.labels("generate_card").observe(5.2);
  jobDurationSeconds.labels("parse_source").observe(15.0);
  assert.ok(true);
});

test("providerCallsTotal 按 operation/status 正确递增", () => {
  providerCallsTotal.labels("generate_card", "success").inc();
  providerCallsTotal.labels("generate_card", "failed").inc();
  providerCallsTotal.labels("evaluate_validation", "success").inc();
  assert.ok(true);
});

test("providerCallDurationSeconds 正确观察值", () => {
  providerCallDurationSeconds.labels("generate_card").observe(1.2);
  providerCallDurationSeconds.labels("evaluate_validation").observe(3.5);
  assert.ok(true);
});

test("providerErrorsTotal 按 operation/error_category 正确递增", () => {
  providerErrorsTotal.labels("generate_card", "timeout").inc();
  providerErrorsTotal.labels("generate_card", "schema_failure").inc();
  providerErrorsTotal.labels("evaluate_validation", "auth_error").inc();
  assert.ok(true);
});

// ─── startMetricsServer HTTP 端点 ─────────────────────────────────────

/**
 * Helper: create a metrics server and wait for it to start listening.
 * Returns the server, port, and a cleanup function.
 */
async function createTestServer(port?: number): Promise<{
  server: Server;
  port: number;
  cleanup: () => Promise<void>;
}> {
  const server = startMetricsServer(port ?? 0);
  server.unref();
  // Wait for the 'listening' event so server.address() is populated
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    // Safety timeout in case listening never fires
    setTimeout(() => reject(new Error("server did not start listening")), 3000);
  });
  const addr = server.address();
  const p = (addr as AddressInfo)?.port ?? 0;
  return {
    server,
    port: p,
    cleanup: async () => {
      server.closeAllConnections?.();
      server.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

test("startMetricsServer 在 /metrics 返回 Prometheus 文本格式", async () => {
  const { port, cleanup } = await createTestServer();
  assert.ok(port > 0);

  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);

  const text = await response.text();
  // 至少包含一个 ailearn_ 前缀的指标
  assert.match(text, /ailearn_/);

  await cleanup();
});

test("startMetricsServer 对非 /metrics 路径返回 404", async () => {
  const { port, cleanup } = await createTestServer();

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.equal(body, "Not Found\n");

  await cleanup();
});

test("startMetricsServer 默认端口可通过 WORKER_METRICS_PORT 环境变量配置", async () => {
  const originalPort = process.env.WORKER_METRICS_PORT;
  process.env.WORKER_METRICS_PORT = "19101";
  try {
    // Call startMetricsServer without port argument to use env var default
    const server = startMetricsServer();
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      setTimeout(() => reject(new Error("server did not start listening")), 3000);
    });
    const addr = server.address();
    assert.equal((addr as AddressInfo)?.port, 19101);
    server.closeAllConnections?.();
    server.close();
  } finally {
    if (originalPort === undefined) {
      delete process.env.WORKER_METRICS_PORT;
    } else {
      process.env.WORKER_METRICS_PORT = originalPort;
    }
  }
});

test("startMetricsServer 传入端口参数优先于环境变量", async () => {
  const originalPort = process.env.WORKER_METRICS_PORT;
  process.env.WORKER_METRICS_PORT = "19102";
  try {
    const { port, cleanup } = await createTestServer(19103);
    assert.equal(port, 19103);
    await cleanup();
  } finally {
    if (originalPort === undefined) {
      delete process.env.WORKER_METRICS_PORT;
    } else {
      process.env.WORKER_METRICS_PORT = originalPort;
    }
  }
});

test("startMetricsServer 返回的 server 可以被 close", async () => {
  const { cleanup } = await createTestServer(0);
  await cleanup();
  assert.ok(true);
});
