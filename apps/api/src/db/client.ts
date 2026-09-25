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

/**
 * 当前异步作用域里有没有活动的 API 事务（`undefined` = 没有）。
 *
 * 给**公共外部调用边界**用的那一个读数（D5 §5.2 第二件、39d W3-2）——API 与 worker
 * 两侧都要覆盖（39c §5.2）。判据是"当前作用域有没有活动事务"，不是"代码文本里有没有
 * `transaction`"：`AsyncLocalStorage` 沿 await 链传播，隐式嵌套一样读得到。
 * worker 侧的同一条读数是 `workers/ai-worker/src/db.ts` 的
 * `currentWorkerWorkspaceTransaction`。
 */
export function currentApiWorkspaceTransaction(): unknown {
  return apiScope.current();
}

type ActiveApiWorkspaceTransaction = ActiveWorkspaceTransaction<string, ApiTransaction> & {
  /**
   * 当前请求的令牌哈希（`sessions.token`）。只有 actor 事务会写它；
   * `withWorkspaceTransaction` 开的业务事务没有这一项——业务请求已经过了
   * `decodeToken`，不再需要按令牌读会话行。
   */
  sessionToken?: string | null;
  /**
   * `app.workspace_id` 是否真的设过。
   *
   * `WorkspaceScopeContext<string>` 要求 workspaceId 非空，所以"还没有当前空间"
   * 只能用 nil UUID 占位——但占位值与真实值必须能分辨，否则 `assumeActor`
   * （"令牌读到主人了，从现在起代表他"）会分不清"当前 actor 是占位符"还是
   * "当前 actor 是另一个人"。实测：`decodeToken` 的 actor 是 SYSTEM_USER_ID，
   * 读回会话行里的真实 user_id 后要换 actor，被嵌套校验判成"一条请求里两个身份"
   * 而拒绝——那会让**每一个**已认证请求 401。
   */
  workspaceBound?: boolean;
};

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

/**
 * 工作区**建立之前**的 actor 事务（SEC-01 重开 RLS 的第二条上下文）。
 *
 * 为什么需要它：`sessions` / `workspace_members` / `workspaces` 三张表上挂的是
 * RESTRICTIVE 的租户守卫（`workspace_id = app.workspace_id`）。登录、令牌解析、
 * 空间列表这三条路都发生在"还不知道当前空间"的时刻——它们要做的第一件事**就是**
 * 把"这个人属于哪些空间"读出来。没有第二条上下文，这三条路在 RLS 下全是 0 行：
 * 实测把 `workspace_members` 一开，`POST /auth/login` 立刻 401。
 *
 * 因此 actor 事务设置三个事务局部变量：
 *   - `app.user_id`      —— 策略里"这一行是不是我自己的"；
 *   - `app.workspace_id` —— 会话行自带的空间（`decodeToken` 要连 `workspaces`）；
 *   - `app.session_token`—— 令牌哈希（`sessions` 的键就是它，见 db-schema/session.ts）。
 *
 * 与 `withWorkspaceTransaction` 的分工：那条路服务"已经在某个空间里"的业务请求，
 * 必须同时有 workspace 与 actor；这条只服务边界动作。两者共用同一份 `set_config`
 * 与回读校验，不各写一套。
 */
export type ActorTransactionContext = {
  userId: string;
  workspaceId?: string | null;
  sessionToken?: string | null;
};

/** `sessions.token` 存的是 sha256 十六进制；格式错了说明调用方拼错了字段。 */
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export async function withActorTransaction<T>(
  context: ActorTransactionContext,
  operation: (transaction: ApiTransaction) => Promise<T>,
): Promise<T> {
  // actor 上下文**允许没有空间**：`app.workspace_id` 留空是"还没选空间"这个
  // 状态本身，也是 `workspace_members` / `workspaces` 的租户守卫让开的那个分支
  // （迁移 0257）。这里绝不能拿 nil UUID 顶替——那是一个"存在的空间"，
  // 守卫会照着它去比，实测结果是登录读到 0 条成员行。
  const userId = apiScope.normalize({
    workspaceId: context.workspaceId ?? SYSTEM_USER_ID,
    userId: context.userId,
  }).userId;
  const sessionToken = context.sessionToken ?? null;
  if (sessionToken !== null && !SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new WorkspaceTransactionContextError("sessionToken must be a sha256 hex digest");
  }

  // 嵌套：已经在同一个 actor 的上下文里就不另开事务。换人或换令牌是调用错误——
  // 那意味着同一条请求里有两个身份，宁可当场报错也不要静默用错的那个。
  const active: ActiveApiWorkspaceTransaction | undefined = apiScope.current();
  if (active?.open) {
    // SYSTEM_USER_ID 是"还没有身份"的占位（`decodeToken` 在读到会话行之前就是它），
    // 不是一个人。嵌套进占位上下文时允许把 actor 定成真人——否则"先按令牌读会话行、
    // 再按行里的 user_id 继续"这条唯一的路会被自己的校验判死。
    const activeIsPlaceholder = active.context.userId === SYSTEM_USER_ID;
    if (!activeIsPlaceholder && active.context.userId !== userId) {
      throw new WorkspaceTransactionContextError(
        "nested actor transaction cannot change the acting user",
      );
    }
    if (sessionToken !== null && active.sessionToken !== sessionToken) {
      throw new WorkspaceTransactionContextError(
        "nested actor transaction cannot change the session token",
      );
    }
    return operation(active.transaction);
  }

  return db.transaction(async (transaction) => {
    const applied = await applyActorConfig(transaction, {
      userId,
      workspaceId: context.workspaceId ?? null,
      sessionToken,
    });

    const scoped: ActiveApiWorkspaceTransaction = {
      context: {
        userId: applied.userId,
        // 内存里的 workspaceId 仍要满足 `WorkspaceScopeContext<string>`（非空），
        // 所以空值时用 nil UUID 占位——它只用于嵌套兼容性比较，不写进数据库。
        workspaceId: applied.workspaceId ?? SYSTEM_USER_ID,
      },
      transaction,
      open: true,
      sessionToken: applied.sessionToken,
      workspaceBound: applied.workspaceId !== null,
    };
    try {
      return await apiScope.run(scoped, () => operation(transaction));
    } finally {
      scoped.open = false;
    }
  });
}

/**
 * 把事务的 actor 从"还不知道是谁"换成"令牌真正的主人"。
 *
 * 唯一调用点是 `decodeToken`：它必须先按令牌哈希读到会话行，才知道 user_id 与
 * workspace_id，而这两张表（`workspace_members` / `workspaces`）的策略要的正是
 * 它们。这是"从已认证凭据里读出来的事实"，不是调用方传进来的参数——所以这里
 * 允许换 actor，而 `withActorTransaction` 的嵌套校验不允许。
 *
 * 顺序不能反：先把新的 user_id 写进配置，再更新内存里的 context——否则两次
 * `set_config` 之间若抛错，内存说 A、数据库说 B。
 */
export async function assumeActor(
  transaction: ApiTransaction,
  userId: string,
  workspaceId: string,
): Promise<void> {
  const active: ActiveApiWorkspaceTransaction | undefined = apiScope.current();
  if (!active?.open || active.transaction !== transaction) {
    throw new WorkspaceTransactionContextError("assumeActor requires the active actor transaction");
  }
  const applied = await applyActorConfig(transaction, {
    userId,
    workspaceId,
    sessionToken: active.sessionToken ?? null,
  });
  active.context.userId = applied.userId;
  // assumeActor 的 workspaceId 参数是非空的，所以这里一定拿得到值。
  active.context.workspaceId = applied.workspaceId ?? SYSTEM_USER_ID;
}

/** `app.*` 三个事务局部变量的唯一写入点，带回读校验。 */
async function applyActorConfig(
  transaction: ApiTransaction,
  input: { userId: string; workspaceId: string | null; sessionToken: string | null },
): Promise<{ userId: string; workspaceId: string | null; sessionToken: string | null }> {
  const userId = apiScope.normalize({ userId: input.userId, workspaceId: SYSTEM_USER_ID }).userId;
  const workspaceId = input.workspaceId === null
    ? null
    : apiScope.normalize({ userId: input.userId, workspaceId: input.workspaceId }).workspaceId;
  const rows = await transaction.execute(sql`
    SELECT
      pg_catalog.set_config('app.workspace_id', ${workspaceId ?? ""}, true) AS workspace_id,
      pg_catalog.set_config('app.user_id', ${userId}, true) AS user_id,
      pg_catalog.set_config('app.session_token', ${input.sessionToken ?? ""}, true) AS session_token
  `);
  const applied = rows[0] as
    | { workspace_id?: string | null; user_id?: string | null; session_token?: string | null }
    | undefined;
  if (
    (applied?.workspace_id ?? "") !== (workspaceId ?? "")
    || (applied?.user_id ?? "").toLowerCase() !== userId
    || (applied?.session_token ?? "") !== (input.sessionToken ?? "")
  ) {
    throw new WorkspaceTransactionContextError("database rejected actor transaction context");
  }
  return { userId, workspaceId, sessionToken: input.sessionToken };
}

/**
 * 在**同一条事务里**把租户切到刚建出来的空间。
 *
 * 建空间的路径（注册、`POST /workspaces`、接受邀请）天生是两段：先插入
 * `workspaces` 行才知道新空间的 id，然后才能写它的成员行与引导行。而
 * `withWorkspaceTransaction` 要求进入事务时就知道 workspace——它拒绝中途换租户
 * （`assertCompatible`），这是对的：业务事务不该换空间。
 *
 * 所以这条 helper 只服务"边界事务"：调用方已经用 `withActorTransaction` 定好了
 * actor，这里补上 `app.workspace_id`，让随后对 `workspace_members` /
 * `onboarding_states` / `jobs` 的写入能过租户守卫。它不改变 actor，也不允许
 * 在业务事务里调用（那种情况应当直接用 `withWorkspaceTransaction`）。
 */
export async function adoptWorkspaceContext(
  transaction: ApiTransaction,
  workspaceId: string,
): Promise<void> {
  const active: ActiveApiWorkspaceTransaction | undefined = apiScope.current();
  if (!active?.open || active.transaction !== transaction) {
    throw new WorkspaceTransactionContextError(
      "adoptWorkspaceContext requires the active actor transaction",
    );
  }
  const applied = await applyActorConfig(transaction, {
    userId: active.context.userId,
    workspaceId,
    sessionToken: active.sessionToken ?? null,
  });
  // adoptWorkspaceContext 的 workspaceId 参数是非空的，所以这里一定拿得到值。
  active.context.workspaceId = applied.workspaceId ?? SYSTEM_USER_ID;
  active.workspaceBound = applied.workspaceId !== null;
}

export function closeDatabase(): Promise<void> {
  closePromise ??= queryClient.end({ timeout: 5 });
  return closePromise;
}

export { schema };
