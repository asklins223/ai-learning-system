/**
 * Worker 队列并发的**唯一**解析点（设计 P1-13，2026-09-15 审计）。
 *
 * 背景：`QUEUE_CONCURRENCY` 此前被解析两次——`queue.ts`（队列槽位数）与
 * `db.ts`（连接池池宽按并发推导）各写了一份**逐字相同**的实现，而 db.ts 的注释
 * 还写着"两个常量永不漂移"。两份拷贝本身就是漂移的来源。
 *
 * 为什么单独一个模块：`db.ts` 不能 import `queue.ts`（queue 依赖 db，会成环），
 * 所以把解析逻辑抽到这里，两侧都从这里取。
 */

/** 未配置时的默认并发（保守值）。 */
export const DEFAULT_QUEUE_CONCURRENCY = 3;

/** 并发上限：与 SQL LIMIT 和连接池推导保持一致的上界。 */
export const MAX_QUEUE_CONCURRENCY = 16;

/**
 * 解析 QUEUE_CONCURRENCY。
 *
 * 非法值（NaN/小数/非正数）一律回退默认：小数不能作为 SQL LIMIT 或并发槽位数，
 * NaN 会让可用槽位计算恒为 0（worker 停摆）。
 */
export function parseQueueConcurrency(input: string | undefined): number {
  const raw = Number(input ?? DEFAULT_QUEUE_CONCURRENCY);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_QUEUE_CONCURRENCY;
  return Math.min(MAX_QUEUE_CONCURRENCY, raw);
}
