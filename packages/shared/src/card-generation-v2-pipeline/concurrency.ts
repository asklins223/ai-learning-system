/**
 * V2 管线阶段内**有界并发**工具（2026-09-17 性能改造）。
 *
 * 背景：planner→author→grounding→pedagogy 四阶段里，author 与 grounding 都是
 * **逐候选串行** `await`——墙钟 = N × 单次 provider 延迟（dev 实测 N=5 时 12 次调用
 * 合计 93.1s，端到端 93.7s，即 overlap≈0.99，几乎没有重叠）。候选之间**没有**数据
 * 依赖（各自独立读同一个 sealed evidence manifest，产出各自的报告），因此可以并发。
 *
 * 本模块只做"有界并发 + 保序"这一件事，不引入任何 DB/provider 依赖：
 * - **保序**：返回值下标与输入下标严格对应，调用方可以继续按 authoring 顺序处理
 *   结果（dedup/事件/落库顺序与串行版本逐字一致）；
 * - **有界**：同时最多 `limit` 个在途调用，避免 N=20 时把 provider 打满触发 429；
 * - **快速失败**：任一调用失败时 `Promise.all` 立刻向上抛错（与串行版本一致），
 *   其余在途调用由调用方决定是否 abort（见 handler 的 stageAbort）。
 */

/** 阶段内默认并发上限。保守取值：N≤4 时一波跑完，N=20 时 5 波。 */
export const DEFAULT_V2_STAGE_CONCURRENCY = 4;

/** 并发上限的硬上界（防御性：env 写错不该把 provider 打挂）。 */
export const MAX_V2_STAGE_CONCURRENCY = 32;

/** 解析并发配置：非法值（NaN/小数/非正数/超上界）一律回退默认。 */
export function resolveV2StageConcurrency(raw: unknown): number {
  const parsed = Number(raw ?? DEFAULT_V2_STAGE_CONCURRENCY);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_V2_STAGE_CONCURRENCY;
  return Math.min(parsed, MAX_V2_STAGE_CONCURRENCY);
}

/**
 * 有界并发 map：保持输入顺序返回结果。
 *
 * 任一 `fn` 抛错时整体 reject（错误即第一个 reject 的那个，不保证是下标最小的）；
 * 已在途的调用不会被取消——调用方若要止损，应把取消信号传进 `fn`（handler 的
 * grounding 阶段就是这么做的：可重试错误立即 abort 其余在途调用）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
