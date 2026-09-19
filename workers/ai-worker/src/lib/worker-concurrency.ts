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

/**
 * 未配置时的默认并发。
 *
 * 2026-09-19：3 → 4。claim 现在为交互车道保留一个槽位（见
 * `INTERACTIVE_RESERVE_SLOTS`），后台 job 的上限因此变成 `并发 - 1`；
 * 默认提到 4 是为了让后台（解析/记忆/念头）仍保有原来的 3 条车道，
 * 而不是用"砍后台吞吐"来换对话延迟。
 */
export const DEFAULT_QUEUE_CONCURRENCY = 4;

/** 并发上限：与 SQL LIMIT 和连接池推导保持一致的上界。 */
export const MAX_QUEUE_CONCURRENCY = 16;

/**
 * 为交互车道（`interactive_ai`：伴星对话 / 表单校验问答）保留的槽位数。
 *
 * 动机：后台 job 的 handler 超时可达 110s（念头生成、记忆重建），此前它们
 * 可以占满全部槽位——用户发消息时 turn job 只能排在后面，表现为"有时候要等
 * 很久才回"。`ailearn_claim_jobs` 现在按类别限流，后台同时最多占用
 * `并发 - 保留` 个槽位，交互 job 永远有槽可领。
 */
export const INTERACTIVE_RESERVE_SLOTS = 1;

/** 一次 claim 的两个名额。 */
export interface ClaimLimits {
  /** 本轮最多认领的 job 总数（= 当前空闲槽位）。 */
  readonly interactiveLimit: number;
  /** 其中后台类 job 的名额；`interactive_ai` 不受它约束。 */
  readonly backgroundLimit: number;
}

/**
 * 计算一次 claim 的名额分配（纯函数，可单测）。
 *
 * - 总数 = 空闲槽位；
 * - 后台名额 = (并发 - 保留) - 在跑后台数，下限 0：后台已经占满非保留区时，
 *   最后一个空槽只对 `interactive_ai` 开放；
 * - `concurrency <= 1` 的小部署无法保留（保留会让后台永久停摆），退化为不保留。
 */
export function computeClaimLimits(args: {
  readonly concurrency: number;
  readonly inflightTotal: number;
  readonly inflightBackground: number;
}): ClaimLimits {
  const interactiveLimit = Math.max(0, args.concurrency - args.inflightTotal);
  const reserve = args.concurrency > 1 ? INTERACTIVE_RESERVE_SLOTS : 0;
  const backgroundLimit = Math.max(0, args.concurrency - reserve - args.inflightBackground);
  return { interactiveLimit, backgroundLimit: Math.min(backgroundLimit, interactiveLimit) };
}

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
