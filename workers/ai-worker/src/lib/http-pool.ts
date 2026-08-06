/**
 * A3（计划 §2.3）：fetch 连接池显式调优。
 *
 * Node.js 20+ 内置 undici 默认池（keep-alive 默认开启），但参数不可调。
 * 本模块通过 setGlobalDispatcher 显式配置连接池参数，使生产环境可通过
 * 环境变量调参而无需改代码。
 *
 * 环境变量（全部可选，有合理默认值）：
 *   AI_WORKER_HTTP_POOL_CONNECTIONS    每个源最大连接数（默认: 10）
 *   AI_WORKER_HTTP_POOL_PIPELINING     管道深度（默认: 1，保守不管道）
 *   AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT  keep-alive 超时秒（默认: 30）
 *   AI_WORKER_HTTP_POOL_TIMEOUT        请求超时秒（默认: 300，与 handler-timeout 对齐）
 *
 * 仅影响全局 fetch（生产路径 postJsonToPublicEndpoint）。
 * 测试路径使用注入的 fetchFn / PublicJsonRequester，不走全局 dispatcher。
 */

import { Agent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.ts";

export interface HttpPoolConfig {
  connections: number;
  pipelining: number;
  keepAliveTimeout: number;
  timeout: number;
}

export function resolveHttpPoolConfig(): HttpPoolConfig {
  return {
    connections: Math.max(1, Number(process.env.AI_WORKER_HTTP_POOL_CONNECTIONS ?? 10)),
    pipelining: Math.max(0, Number(process.env.AI_WORKER_HTTP_POOL_PIPELINING ?? 1)),
    keepAliveTimeout: Math.max(1, Number(process.env.AI_WORKER_HTTP_POOL_KEEPALIVE_TIMEOUT ?? 30)) * 1000,
    timeout: Math.max(10, Number(process.env.AI_WORKER_HTTP_POOL_TIMEOUT ?? 300)) * 1000,
  };
}

let initialized = false;

/**
 * 初始化全局 HTTP 连接池。
 *
 * 幂等：多次调用安全，仅第一次实际执行。
 * 在 worker 入口（index.ts）启动时调用一次。
 */
export function initHttpPool(): void {
  if (initialized) return;
  initialized = true;

  const config = resolveHttpPoolConfig();

  const dispatcher = new Agent({
    connections: config.connections,
    pipelining: config.pipelining,
    keepAliveTimeout: config.keepAliveTimeout,
    headersTimeout: config.timeout,
    bodyTimeout: config.timeout,
    connect: {
      timeout: 10_000, // 10s connect timeout
    },
  });

  setGlobalDispatcher(dispatcher);

  logger.info(
    {
      connections: config.connections,
      pipelining: config.pipelining,
      keepAliveTimeoutMs: config.keepAliveTimeout,
      timeoutMs: config.timeout,
    },
    "A3: HTTP 连接池已显式配置（undici setGlobalDispatcher）",
  );
}
