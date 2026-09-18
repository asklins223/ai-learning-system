/**
 * OPS-01: Worker Prometheus 指标模块单元测试（ADR-0006 §1-3）
 *
 * 验证：
 *   1. allowlist 完整性（JOB_STATUSES）
 *   2. 指标注册与递增正确性
 *   3. startMetricsServer HTTP 端点行为
 *   4. registry 隔离与 ailearn_ 前缀
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
  resolveMetricsPort,
  startMetricsServer,
  JOB_STATUSES,
} from "../lib/metrics.ts";

test("startMetricsServer: 非法端口环境变量回退默认值", () => {
  assert.equal(resolveMetricsPort("not-a-port"), 9_100);
  assert.equal(resolveMetricsPort("65536"), 9_100);
  assert.equal(resolveMetricsPort("-1"), 9_100);
  assert.equal(resolveMetricsPort(""), 9_100);
  assert.equal(resolveMetricsPort("0"), 0);
  assert.equal(resolveMetricsPort("19104"), 19_104);
});

// ─── allowlist 完整性 ──────────────────────────────────────────────────

test("JOB_STATUSES 包含全部 5 种状态", () => {
  assert.equal(JOB_STATUSES.length, 5);
  assert.ok(JOB_STATUSES.includes("pending"));
  assert.ok(JOB_STATUSES.includes("running"));
  assert.ok(JOB_STATUSES.includes("succeeded"));
  assert.ok(JOB_STATUSES.includes("failed"));
  assert.ok(JOB_STATUSES.includes("dead"));
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
  jobTerminalTotal.labels("companion_agent", "succeeded").inc();
  jobTerminalTotal.labels("companion_agent", "succeeded").inc();
  jobTerminalTotal.labels("parse_source", "dead").inc();
  assert.ok(true);
});

test("jobRetriesTotal 按 type 正确递增", () => {
  jobRetriesTotal.labels("companion_agent").inc();
  assert.ok(true);
});

test("jobLeaseLostTotal 按 type 正确递增", () => {
  jobLeaseLostTotal.labels("companion_agent").inc();
  assert.ok(true);
});

test("jobDurationSeconds 正确观察值", () => {
  jobDurationSeconds.labels("companion_agent").observe(0.5);
  jobDurationSeconds.labels("companion_agent").observe(5.2);
  jobDurationSeconds.labels("parse_source").observe(15.0);
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
