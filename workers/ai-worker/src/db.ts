import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@ailearn/shared/db-schema";
// 稳定 P0-4（2026-09-15 审计）：事务内 workspace/user 上下文（UUID 校验、
// 嵌套兼容性断言、set_config 回读校验、AsyncLocalStorage）的唯一实现已下沉到
// packages/shared/src/workspace-transaction.ts，与 API 共用——此前两侧各有一份
// 逐字拷贝，且 NULL vs 空串的 set_config 坑只在 worker 侧被修过。
import {
  WorkspaceTransactionScope,
  type ActiveWorkspaceTransaction,
  type WorkspaceScopeContext,
} from "@ailearn/shared/workspace-transaction";
import { parseQueueConcurrency } from "./lib/worker-concurrency.ts";

const DEFAULT_DATABASE_URL = "postgres://ailearn:ailearn_dev@postgres:5432/ailearn";

export function resolveWorkerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const roleUrl = env.DATABASE_URL_WORKER?.trim();
  if (roleUrl) return roleUrl;
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_WORKER is required when NODE_ENV=production");
  }
  return env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

const connectionString = resolveWorkerDatabaseUrl();

// Pool size is derived from QUEUE_CONCURRENCY so the connection capacity stays
// coupled to the actual parallel-job demand (W3). Each claimed job may issue up
// to ~4 concurrent queries via Promise.all fan-out (version+blocks+governance
// reads) plus lifecycle queries (claim/reap/metrics) running alongside handlers.
//   pool = clamp(QUEUE_CONCURRENCY * 4, 15, 64)
// 设计 P1-13（2026-09-15 审计）：并发解析改用 lib/worker-concurrency.ts 的
// **同一实现**（此前本文件与 queue.ts 各有一份逐字拷贝，注释却声称"永不漂移"）。
// 本文件不能 import queue.ts（queue 依赖本文件，会成环），故解析逻辑独立成模块。
// Default concurrency 3 → 3×4=12 → min floor 15.
const workerConcurrency = parseQueueConcurrency(process.env.QUEUE_CONCURRENCY);
const poolMax = Math.max(15, Math.min(64, workerConcurrency * 4));

/**
 * 语句超时（稳定 P0-5，2026-09-15 审计）：此前 worker 池没有任何
 * statement_timeout（实测 `SHOW statement_timeout` = 0）。终态转换
 * （ailearn_finish_job / ailearn_fail_job）走的是普通 `await`、没有 signal，
 * 一条挂起的语句会让该 job 的 promise 永不 settle → `inflight` 槽不释放 →
 * `available <= 0` → worker 永久停止 claim，而 /metrics 仍返回 200、编排器
 * 不会重启。给出确定上界（默认 60s，须小于 120s 租约，使语句先报错再由
 * 租约/reaper 兜底，而不是静默占槽）。
 *
 * 只设 statement_timeout，**刻意不设** idle_in_transaction_session_timeout：
 * V2 管道（H4）在事务内做 LLM HTTP 调用，事务此时 idle-in-transaction，
 * 设短了会掐断整条管道。
 */
export function resolveWorkerStatementTimeoutMs(
  raw: string | undefined = process.env.WORKER_STATEMENT_TIMEOUT_MS,
): number {
  const parsed = Number(raw ?? 60_000);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
}

const queryClient = postgres(connectionString, {
  max: poolMax,
  connection: { statement_timeout: resolveWorkerStatementTimeoutMs() },
});
export const db = drizzle(queryClient, { schema });

export type WorkerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type WorkerWorkspaceTransactionContext = WorkspaceScopeContext<string | null>;
export type NormalizedWorkerWorkspaceTransactionContext = WorkspaceScopeContext<string | null>;

export class WorkerWorkspaceTransactionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerWorkspaceTransactionContextError";
  }
}

const workerScope = new WorkspaceTransactionScope<string | null, WorkerTransaction>({
  label: "worker workspace",
  // worker 处理系统票（reaper、归档、伴星后台任务）时没有 actor，userId 允许 null。
  allowNullUserId: true,
  createError: (message) => new WorkerWorkspaceTransactionContextError(message),
});

type ActiveWorkerWorkspaceTransaction = ActiveWorkspaceTransaction<
  string | null,
  WorkerTransaction
>;

export function normalizeWorkerWorkspaceTransactionContext(
  context: WorkerWorkspaceTransactionContext,
): NormalizedWorkerWorkspaceTransactionContext {
  return workerScope.normalize(context);
}

export function assertWorkerWorkspaceTransactionContextCompatible(
  active: NormalizedWorkerWorkspaceTransactionContext,
  requested: NormalizedWorkerWorkspaceTransactionContext,
): void {
  workerScope.assertCompatible(active, requested);
}

/**
 * `userId === null` 必须设 NULL 而非空串：RLS 策略中 `user_id = ''::uuid`
 * 是计划期常量转换，空串会直接抛 "invalid input syntax for type uuid: """，
 * 与 OR 短路无关（0138 审查修复后验证到的真实故障）。该不变量现在由
 * packages/shared/src/workspace-transaction.ts 统一实现。
 */
export async function setWorkerTransactionContext(
  transaction: WorkerTransaction,
  context: WorkerWorkspaceTransactionContext,
): Promise<NormalizedWorkerWorkspaceTransactionContext> {
  return workerScope.applyContext(transaction, context);
}

export interface WorkerWorkspaceTransactionOptions {
  /**
   * 强制开一条**独立**事务，即使当前已经处在 worker 事务作用域里（默认会加入它）。
   *
   * 存在的理由（2026-09-21 实测）：V2 生成管道整条跑在一个分钟级事务里，实时进度
   * 读数若跟着它提交，就要等整批 LLM 跑完才对外可见——那正是复盘 #2「进度不逐格走」
   * 的成因（124 秒里 HTTP 只采到 0 和 8 两个值）。凡是"必须让**另一个连接**立刻
   * 看见"的写入都要走这个开关。
   */
  isolated?: boolean;
}

export async function withWorkerWorkspaceTransaction<T>(
  context: WorkerWorkspaceTransactionContext,
  operation: (transaction: WorkerTransaction) => Promise<T>,
  options: WorkerWorkspaceTransactionOptions = {},
): Promise<T> {
  const normalized = normalizeWorkerWorkspaceTransactionContext(context);
  if (!options.isolated) {
    const active = workerScope.requireActive(normalized);
    if (active) {
      return operation(active.transaction);
    }
  }

  return db.transaction(async (transaction) => {
    await setWorkerTransactionContext(transaction, normalized);
    const scopedTransaction: ActiveWorkerWorkspaceTransaction = {
      context: normalized,
      transaction,
      open: true,
    };
    try {
      return await workerScope.run(scopedTransaction, () => operation(transaction));
    } finally {
      scopedTransaction.open = false;
    }
  });
}

/** Stop accepting new queries and drain the Postgres.js pool on shutdown. */
export async function closeDatabase(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
