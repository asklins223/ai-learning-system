/**
 * A3（计划 §2.3）测试：HTTP 连接池配置解析。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHttpPoolConfig } from "../lib/http-pool.ts";

test("A3: 默认配置合理", () => {
  // 清除环境变量
  const oldVals = {
    c: process.env.AI_WORKER_HTTP_POOL_CONNECTIONS,
    p: process.env.AI_WORKER_HTTP_POOL_PIPELINING,
    k: process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT,
    t: process.env.AI_WORKER_HTTP_POOL_TIMEOUT,
  };
  delete process.env.AI_WORKER_HTTP_POOL_CONNECTIONS;
  delete process.env.AI_WORKER_HTTP_POOL_PIPELINING;
  delete process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT;
  delete process.env.AI_WORKER_HTTP_POOL_TIMEOUT;

  const config = resolveHttpPoolConfig();
  assert.equal(config.connections, 10);
  assert.equal(config.pipelining, 1);
  assert.equal(config.keepAliveTimeout, 30_000);
  assert.equal(config.timeout, 300_000);

  // 恢复环境变量
  if (oldVals.c) process.env.AI_WORKER_HTTP_POOL_CONNECTIONS = oldVals.c;
  if (oldVals.p) process.env.AI_WORKER_HTTP_POOL_PIPELINING = oldVals.p;
  if (oldVals.k) process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT = oldVals.k;
  if (oldVals.t) process.env.AI_WORKER_HTTP_POOL_TIMEOUT = oldVals.t;
});

test("A3: 环境变量覆盖配置", () => {
  process.env.AI_WORKER_HTTP_POOL_CONNECTIONS = "20";
  process.env.AI_WORKER_HTTP_POOL_PIPELINING = "5";
  process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT = "60";
  process.env.AI_WORKER_HTTP_POOL_TIMEOUT = "120";

  const config = resolveHttpPoolConfig();
  assert.equal(config.connections, 20);
  assert.equal(config.pipelining, 5);
  assert.equal(config.keepAliveTimeout, 60_000);
  assert.equal(config.timeout, 120_000);

  delete process.env.AI_WORKER_HTTP_POOL_CONNECTIONS;
  delete process.env.AI_WORKER_HTTP_POOL_PIPELINING;
  delete process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT;
  delete process.env.AI_WORKER_HTTP_POOL_TIMEOUT;
});

test("A3: 无效值被 clamp 到安全范围", () => {
  process.env.AI_WORKER_HTTP_POOL_CONNECTIONS = "0";
  process.env.AI_WORKER_HTTP_POOL_PIPELINING = "-1";
  process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT = "0";
  process.env.AI_WORKER_HTTP_POOL_TIMEOUT = "1";

  const config = resolveHttpPoolConfig();
  assert.equal(config.connections, 1, "connections 最小 1");
  assert.equal(config.pipelining, 0, "pipelining 最小 0");
  assert.equal(config.keepAliveTimeout, 1_000, "keepAliveTimeout 最小 1s");
  assert.equal(config.timeout, 10_000, "timeout 最小 10s");

  delete process.env.AI_WORKER_HTTP_POOL_CONNECTIONS;
  delete process.env.AI_WORKER_HTTP_POOL_PIPELINING;
  delete process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT;
  delete process.env.AI_WORKER_HTTP_POOL_TIMEOUT;
});
