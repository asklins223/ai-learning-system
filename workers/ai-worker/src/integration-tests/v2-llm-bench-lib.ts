/**
 * V2 LLM 基准的纯辅助：worker 日志解析 + 统计。
 *
 * 单独成模块（而不是留在 `v2-llm-bench.ts` 里）有两个原因：
 * 1. 基准脚本主体在 import 时就会跑起来（顶层副作用），解析逻辑必须能被单测
 *    单独 import；
 * 2. 解析规则来自 pino-pretty 的**具体输出形状**（含 ANSI 颜色码），是最容易
 *    静默失效的一环——2026-09-17 首次实现就因为没有剥离 ANSI 而解析出 0 条调用。
 */

export interface LlmCall {
  /** 归一化阶段名：planner / author / grounding / pedagogy。 */
  stage: string;
  elapsedMs: number;
}

/**
 * 解析 pino pretty 输出里的 `[v2-llm] chatJson response` 块。
 *
 * dev 下的真实形状（`\u001b[35m` 等是 pino-pretty 给字段名加的颜色码）：
 *   [13:57:11] INFO (163): [v2-llm] chatJson response
 *       stage: "card-generation-v2/v4/author"
 *       elapsedMs: 12345
 *       contentLen: 678
 * 字段在后续缩进行里，直到下一行以 `[`（下一条日志的时间戳）开头为止。
 * `stage` 是带 prompt 版本的完整串，这里归一到末段。
 */
export function parseChatJsonCalls(logText: string): LlmCall[] {
  const clean = logText.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  const calls: LlmCall[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("[v2-llm] chatJson response")) continue;
    let stage = "unknown";
    let elapsedMs: number | null = null;
    for (let j = i + 1; j < Math.min(i + 15, lines.length); j += 1) {
      const line = lines[j];
      if (/^\[/.test(line)) break;
      const stageMatch = /^\s+stage:\s*"?([\w/-]+)"?/.exec(line);
      if (stageMatch) stage = stageMatch[1].split("/").pop() ?? stageMatch[1];
      const elapsedMatch = /^\s+elapsedMs:\s*(\d+)/.exec(line);
      if (elapsedMatch) elapsedMs = Number(elapsedMatch[1]);
    }
    if (elapsedMs !== null) calls.push({ stage, elapsedMs });
  }
  return calls;
}

/** 最近秩百分位（小样本下不做插值，避免制造虚假精度）。 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
