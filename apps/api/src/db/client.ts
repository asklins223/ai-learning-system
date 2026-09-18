import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { DomainError } from "@ailearn/shared";
import * as schema from "@ailearn/shared/db-schema";
// 稳定 P0-4（2026-09-15 审计）：事务内 workspace/user 上下文（UUID 校验、
// 嵌套兼容性断言、set_config 回读校验、AsyncLocalStorage）的唯一实现已下沉到
// packages/shared/src/workspace-transaction.ts，与 worker 共用。此处只保留
// API 侧的角色差异（必须带已认证 actor）与连接策略（隔离级别、慢事务日志）。
import {
  WorkspaceTransactionScope,
  type ActiveWorkspaceTransaction,
  type WorkspaceScopeContext,
} from "@ailearn/shared/workspace-transaction";
// 设计 P1-15（2026-09-15 审计）：指标此前经 `import("../lib/metrics.ts").then(...)`
// 异步自增——关停窗口内到达的失败会被丢掉（增量永远记不上），且 `.catch(()=>{})`
// 连丢都看不见。metrics.ts 只依赖 prom-client 与 @ailearn/shared，无循环风险，
// 改为静态导入同步自增。
import { dbTransactionFailuresTotal } from "../lib/metrics.ts";
import { logger } from "../lib/logger.ts";

// v0.4: the API must use its own database role in production.  The shared
// DATABASE_URL remains a development/test compatibility path only.
function resolveConnectionString(): string {
  const roleUrl = process.env.DATABASE_URL_API?.trim();
  if (roleUrl) return roleUrl;

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_API is required when NODE_ENV=production");
  }

  return (
    process.env.DATABASE_URL?.trim() ??
    "postgres://ailearn:ailearn_dev@postgres:5432/ailearn"
  );
}

const connectionString = resolveConnectionString();

/**
 * 语句超时（稳定 P0-5 / P1-6，2026-09-15 审计）：此前 API 侧所有连接池都没有
 * statement_timeout（实测 `SHOW statement_timeout` = 0，即无限制）。一条挂起的
 * 语句（锁等待、半开连接）会**永久**占住一个池连接；API 单池只有 25 个连接，
 * 且后台 tick 与请求共用同一池。给出确定上界。
 *
 * 只设 statement_timeout，**刻意不设** idle_in_transaction_session_timeout：
 * V2 制卡管道会在事务内做分钟级 LLM HTTP 调用（见 card-generation-v2-handler.ts
 * 的 H4 说明），事务在调用期间处于 idle-in-transaction 状态，设短了会把整条
 * 管道掐断。
 *
 * 该值也是 run-processing-tick 的 private-solution 池（P1-2）共用的唯一解析点，
 * 避免第二处 env 解析漂移。
 */
export function resolveApiStatementTimeoutMs(
  raw: string | undefined = process.env.API_STATEMENT_TIMEOUT_MS,
): number {
  const parsed = Number(raw ?? 60_000);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
}

// PERF-WN: 单 postgres 池承载常规请求 + SSE 轮询 + 后台任务；max=10 在大量
// 长连接轮询/并发请求时成为瓶颈（配合 inbox/companion SSE 连接上限使用）。
// 提到 25 摊薄峰值排队，仍受 DB 端 max_connections 约束。
const queryClient = postgres(connectionString, {
  max: 25,
  connection: { statement_timeout: resolveApiStatementTimeoutMs() },
});
let closePromise: Promise<void> | null = null;

export const db = drizzle(queryClient, { schema });

// 2026-08-11（可观测性）：包装 transaction——失败时累加 dbTransactionFailuresTotal
//（此前指标定义后从未 set，空转）。
const originalTransaction = db.transaction.bind(db);
db.transaction = ((...args: Parameters<typeof originalTransaction>) =>
  originalTransaction(...args).catch((error: unknown) => {
    // 同步自增（原先经动态 import 异步自增，关停窗口会丢计数）。
    dbTransactionFailuresTotal.inc();
    throw error;
  })) as typeof originalTransaction;

export type ApiTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type WorkspaceTransactionContext = WorkspaceScopeContext<string>;
export type NormalizedWorkspaceTransactionContext = WorkspaceScopeContext<string>;

export class WorkspaceTransactionContextError extends DomainError {
  constructor(message: string) {
    super({ name: "WorkspaceTransactionContextError", code: "workspace_transaction_context_error", message, statusCode: 500 });
  }
}

/**
 * 无具体 actor 的工作区级操作使用固定的系统身份（nil UUID）。
 * 满足 RLS 上下文的 UUID 校验；生产路由总是传入已认证的 session user，
 * 该常量只服务于测试/内部调用方按工作区聚合、不带用户过滤的路径。
 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const apiScope = new WorkspaceTransactionScope<string, ApiTransaction>({
  label: "workspace",
  // API 业务工作总是有已认证 actor；无 actor 的系统工作属于受控函数或 Worker。
  allowNullUserId: false,
  createError: (message) => new WorkspaceTransactionContextError(message),
});

type ActiveApiWorkspaceTransaction = ActiveWorkspaceTransaction<string, ApiTransaction>;

/** Pure validation used by both the runtime helper and unit tests. */
export function normalizeWorkspaceTransactionContext(
  context: WorkspaceTransactionContext,
): NormalizedWorkspaceTransactionContext {
  return apiScope.normalize(context);
}

/** Nested work may reuse one transaction, but it may never change its tenant or actor. */
export function assertWorkspaceTransactionContextCompatible(
  active: NormalizedWorkspaceTransactionContext,
  requested: NormalizedWorkspaceTransactionContext,
): void {
  apiScope.assertCompatible(active, requested);
}

/**
 * Set both custom settings transaction-locally and verify PostgreSQL returned
 * the exact normalized values. API business work always has an authenticated
 * actor; actor-less system work belongs to controlled functions or the Worker.
 */
export async function setApiTransactionContext(
  transaction: ApiTransaction,
  context: WorkspaceTransactionContext,
): Promise<NormalizedWorkspaceTransactionContext> {
  return apiScope.applyContext(transaction, context);
}

/**
 * Run one application unit of work with transaction-local tenant context.
 * Same-context nesting reuses the active transaction; context changes fail
 * before any query can execute.
 *
 * ─── QUAL-58/SEC-26 修复完成 ───────────────────────────────────────────
 * `withWorkspaceTransaction` 现已在所有需要 workspace 隔离的 API 模块中使用
 * （note、card、evidence、job、export、stats、understanding、
 * review、benchmark 等）。
 *
 * 已完成的统一工作：
 *   1. benchmark/service.ts 的 3 处 db.transaction 已转为 withWorkspaceTransaction
 *   2. stats/service.ts 的裸 db 查询已包裹在 withWorkspaceTransaction 内
 *   3. understanding/service.ts 的裸 db 查询已包裹在 withWorkspaceTransaction 内
 *   4. 所有模块的裸 db 查询都必须包裹在 withWorkspaceTransaction 内
 *   5. review/service.ts 的 tx ?? db 回退模式已改为 withWorkspaceTransaction 包裹
 *
 * 保留直接使用 `db` 的场景（有意为之）：
 *   - identity/service.ts：注册/登录等操作在 workspace 建前执行
 *   - 系统级函数（maintenance、seed 等）
 *
 * 最终目标：启用 RLS FORCE 模式后，所有运行时查询自动受 RLS 保护
 * ──────────────────────────────────────────────────────────────────────
 */
export async function withWorkspaceTransaction<T>(
  context: WorkspaceTransactionContext,
  operation: (transaction: ApiTransaction) => Promise<T>,
  options?: { isolationLevel?: "repeatable read" | "read committed" | "serializable" },
): Promise<T> {
  const normalized = normalizeWorkspaceTransactionContext(context);
  const active: ActiveApiWorkspaceTransaction | undefined = apiScope.requireActive(normalized);
  if (active) {
    if (options?.isolationLevel) {
      throw new WorkspaceTransactionContextError(
        "cannot change isolation level inside an already-open workspace transaction",
      );
    }
    return operation(active.transaction);
  }

  return db.transaction(async (transaction) => {
    // SET TRANSACTION 必须是事务内第一条语句：必须在 set_config 查询之前执行。
    if (options?.isolationLevel) {
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL ${sql.raw(options.isolationLevel.toUpperCase())}`);
    }
    await setApiTransactionContext(transaction, normalized);
    const scopedTransaction: ActiveApiWorkspaceTransaction = {
      context: normalized,
      transaction,
      open: true,
    };
    // 2026-08-14（16-remaining-issues #2）：慢响应可观测性——记录事务耗时，
    // 定位"DB 侧无慢查询但 API 偶发 20-207s"的连接池/事件循环排队。
    const startedAt = performance.now();
    try {
      return await apiScope.run(
        scopedTransaction,
        () => operation(transaction),
      );
    } finally {
      scopedTransaction.open = false;
      const elapsedMs = performance.now() - startedAt;
      // 设计 P1-15（2026-09-15 审计）：此前经动态 import 异步记日志——关停窗口
      // （正是慢事务/卡死最需要证据的时刻）会丢掉这些行。logger.ts 只依赖 pino 与
      // @ailearn/shared，无循环风险，改为静态导入同步落日志。
      if (elapsedMs >= 5000) {
        logger.error(
          { elapsedMs, context: normalized, poolMax: queryClient.options.max },
          "workspace transaction slow (>5s)",
        );
      } else if (elapsedMs >= 1000) {
        logger.warn(
          { elapsedMs, context: normalized },
          "workspace transaction slow (>1s)",
        );
      }
    }
  });
}

export function closeDatabase(): Promise<void> {
  closePromise ??= queryClient.end({ timeout: 5 });
  return closePromise;
}

export { schema };
