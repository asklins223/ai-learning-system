/**
 * 请求级上下文（设计 P1-15，2026-09-15 审计：跨进程 trace）。
 *
 * 问题：API 用 `genReqId`（server.ts:77）为每个请求分配 id，但该 id 只活在 API
 * 自己的日志里——请求异步创建 job 之后，worker 侧完全不知道它来自哪次请求，
 * "用户操作 → 入队 → worker 执行"这条链在日志上断成两段，跨进程排障只能靠猜
 * （审计原话："跨进程调试靠猜"）。
 *
 * 方案：用 AsyncLocalStorage 保存当前请求 id（在 onRequest 钩子进入上下文），
 * 创建 job 时把它写进 `payload.traceId`；worker 处理该 job 时把同一个 id 打进
 * 自己的日志。两端因此可用一个 id 串起来。
 *
 * 为什么用 ALS 而不是给调用点加参数：`createJob` 有十多处调用（路由层与 service
 * 层都有），逐个加参数既侵入又必然漏；ALS 让"当前请求"对任意深度的调用透明可见。
 * 不在请求上下文（后台任务、测试、worker）时 `currentRequestId()` 返回 null，
 * payload 里就不会出现该字段——不影响既有契约。
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * 在请求上下文中执行 `fn`。
 *
 * 用法（Fastify）：`app.addHook("onRequest", (req, _reply, done) => runWithRequestContext(req.id, done))`
 * ——`done` 在 ALS 上下文内被调用，因此其后续的整个处理链（含异步续体）都能读到该 id。
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run({ requestId }, fn);
}

/** 当前请求 id；不在请求上下文时返回 null。 */
export function currentRequestId(): string | null {
  return requestContextStorage.getStore()?.requestId ?? null;
}

/** 测试钩子：在无请求上下文中确认返回 null / 隔离性。 */
export function hasRequestContext(): boolean {
  return requestContextStorage.getStore() !== undefined;
}
