import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";

/**
 * 工作区事务作用域的唯一实现（稳定 P0-4，2026-09-15 审计：RLS 双实现合一）。
 *
 * 背景：`apps/api/src/db/client.ts` 与 `workers/ai-worker/src/db.ts` 各自维护了
 * 一份"事务内 workspace/user 上下文"实现——两份 UUID 规范化、两份兼容性断言、
 * 两份 `set_config` + 回读校验、两份 `AsyncLocalStorage`。二者唯一的真实差异是：
 *
 *   - API 要求 `userId` 必须是 UUID（业务请求总有已认证 actor）；
 *   - Worker 允许 `userId === null`（系统任务没有 actor）；
 *   - API 额外支持事务隔离级别与慢事务日志（属于连接策略，不属于上下文逻辑）。
 *
 * 重复已经开始产生漂移：NULL 而不是空串必须传给 `set_config` 这个坑
 * （空串会命中 `user_id = ''::uuid` 的计划期常量转换并抛
 * `invalid input syntax for type uuid: ""`）此前只在 worker 侧被修过。
 *
 * 本模块把**不变量**收敛到一处，把**角色差异**变成构造参数：
 * 错误信息前缀、是否允许 null actor、以及错误类型工厂。
 *
 * 该模块是服务端专用（`node:async_hooks` + drizzle-orm），**不要**从
 * `packages/shared/src/index.ts` 重导出——index 会被 Electron 渲染进程等
 * 浏览器安全入口消费。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceScopeContext<TUserId extends string | null> {
  workspaceId: string;
  userId: TUserId;
}

/**
 * 事务对象需要满足的最小结构。
 *
 * 刻意**不**给 `execute` 加行类型泛型：postgres.js 驱动的真实返回类型是
 * `RowList<Assume<TRow, Row>[]>`（postgres.js 自己的数组子类），与朴素
 * `TRow[]` 并不互相赋值，加泛型会让 `PgTransaction` 无法满足约束。这里只承诺
 * "可以用 SQL 语句查询并拿到一个行数组"，行形状在唯一的调用点收窄一次。
 */
export interface WorkspaceContextQueryable {
  execute(query: SQL): PromiseLike<readonly unknown[]>;
}

export interface ActiveWorkspaceTransaction<
  TUserId extends string | null,
  TTransaction extends WorkspaceContextQueryable,
> {
  context: WorkspaceScopeContext<TUserId>;
  transaction: TTransaction;
  /** 事务体是否仍在执行；结束后置 false，防止逃逸的闭包继续借用该上下文。 */
  open: boolean;
}

export interface WorkspaceTransactionScopeOptions {
  /** 错误信息里的角色前缀，例如 `workspace` / `worker workspace`。 */
  label: string;
  /** `userId === null` 是否合法（系统/无 actor 工作）。 */
  allowNullUserId: boolean;
  createError: (message: string) => Error;
}

export class WorkspaceTransactionScope<
  TUserId extends string | null,
  TTransaction extends WorkspaceContextQueryable = WorkspaceContextQueryable,
> {
  private readonly storage: AsyncLocalStorage<
    ActiveWorkspaceTransaction<TUserId, TTransaction>
  >;

  constructor(private readonly options: WorkspaceTransactionScopeOptions) {
    this.storage = new AsyncLocalStorage();
  }

  private reject(field: "workspaceId" | "userId"): never {
    throw this.options.createError(`${field} must be a UUID`);
  }

  private normalizeUuid(value: string, field: "workspaceId" | "userId"): string {
    const normalized = value.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) this.reject(field);
    return normalized;
  }

  /** 纯校验：运行时 helper 与单元测试共用。 */
  normalize(context: WorkspaceScopeContext<TUserId>): WorkspaceScopeContext<TUserId> {
    const { label, allowNullUserId } = this.options;
    if (!context || typeof context !== "object") {
      throw this.options.createError(`${label} transaction context is required`);
    }
    if (typeof context.workspaceId !== "string") this.reject("workspaceId");
    if (context.userId !== null && typeof context.userId !== "string") this.reject("userId");
    if (context.userId === null && !allowNullUserId) this.reject("userId");
    return {
      workspaceId: this.normalizeUuid(context.workspaceId, "workspaceId"),
      userId: context.userId === null
        ? (null as TUserId)
        : (this.normalizeUuid(context.userId, "userId") as TUserId),
    };
  }

  /** 嵌套工作可以复用同一事务，但绝不允许换租户或换 actor。 */
  assertCompatible(
    active: WorkspaceScopeContext<TUserId>,
    requested: WorkspaceScopeContext<TUserId>,
  ): void {
    if (active.workspaceId !== requested.workspaceId || active.userId !== requested.userId) {
      throw this.options.createError(
        `nested ${this.options.label} database work cannot change workspace or user context`,
      );
    }
  }

  current(): ActiveWorkspaceTransaction<TUserId, TTransaction> | undefined {
    return this.storage.getStore();
  }

  /** 取当前活跃事务，校验仍开启且上下文兼容；无活跃事务时返回 undefined。 */
  requireActive(
    normalized: WorkspaceScopeContext<TUserId>,
  ): ActiveWorkspaceTransaction<TUserId, TTransaction> | undefined {
    const active = this.storage.getStore();
    if (!active) return undefined;
    if (!active.open) {
      throw this.options.createError(`${this.options.label} transaction is no longer active`);
    }
    this.assertCompatible(active.context, normalized);
    return active;
  }

  run<T>(
    active: ActiveWorkspaceTransaction<TUserId, TTransaction>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.storage.run(active, operation);
  }

  /**
   * 以**事务局部**自定义设置写入双方上下文，并回读校验 PostgreSQL 确实接受了
   * 归一化后的值。
   *
   * `userId === null` 必须传 NULL 而不是空串：RLS 策略里的 `user_id = ''::uuid`
   * 是计划期常量转换，空串会直接抛 `invalid input syntax for type uuid: ""`，
   * 与 OR 短路无关（0138 审查修复后验证到的真实故障）。
   */
  async applyContext(
    transaction: WorkspaceContextQueryable,
    context: WorkspaceScopeContext<TUserId>,
  ): Promise<WorkspaceScopeContext<TUserId>> {
    const normalized = this.normalize(context);
    this.requireActive(normalized);

    const rows = await transaction.execute(sql`
      SELECT
        pg_catalog.set_config('app.workspace_id', ${normalized.workspaceId}, true) AS workspace_id,
        pg_catalog.set_config('app.user_id', ${normalized.userId ?? null}, true) AS user_id
    `);
    // 唯一的行形状收窄点（见 WorkspaceContextQueryable 的类型说明）。
    const applied = rows[0] as
      | { workspace_id?: string | null; user_id?: string | null }
      | undefined;
    if (
      applied?.workspace_id?.toLowerCase() !== normalized.workspaceId
      || (applied?.user_id ?? "").toLowerCase() !== (normalized.userId ?? "")
    ) {
      throw this.options.createError(
        `database rejected ${this.options.label} transaction context`,
      );
    }
    return normalized;
  }
}
