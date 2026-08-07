import type { ArtifactCache } from "./unit-artifact-cache.ts";
import { claimHash, getCriticVerdict } from "./incremental-caches.ts";
import type { NoteDiffResult } from "./note-diff.ts";

/**
 * P5-5: Changed Claim Review(实施计划 §5.5)。
 *
 * 只审查**变化 span 关联的 claim**;未变化 claim 直接引用旧 verdict
 * (从 P5-3 Critic Cache 读取),实现"无重复审查"。
 *
 * 输入:
 * - diff(P5-4 输出):changedSpans / unchangedSpans;
 * - span→claims 映射:给定 spanKey 返回其 claim 文本列表;
 * - criticCache + criticCacheKey 函数:取旧 verdict。
 * 输出:
 * - toReview:需审查的 claim(变化 span 关联且无有效旧 verdict 缓存);
 * - reuseVerdicts:未变化 claim 的旧 verdict(直接复用,不审查);
 * - 命中统计:审查列表必须排除已缓存 claim(无重复审查验收)。
 */

export interface ClaimRef {
  claim: string;
  spanKey: string;
}

export interface ChangedClaimReviewInput {
  diff: NoteDiffResult;
  /** spanKey → 该 span 产出的 claim 文本 */
  claimsBySpan: Map<string, string[]>;
  criticCache: ArtifactCache;
  /** 计算该 claim 的 critic 缓存 key(含 mode/promptVersion) */
  criticCacheKeyFor: (claim: string, criticMode: "light" | "claim" | "full") => string;
  /** 本次审查模式 */
  criticMode: "light" | "claim" | "full";
}

export interface ChangedClaimReviewResult {
  toReview: ClaimRef[];
  reuseVerdicts: Array<{ claim: string; verdict: unknown }>;
  /** 未变化 span 的 claim 数(引用旧 verdict,不审查) */
  reusedCount: number;
}

export function planChangedClaimReview(input: ChangedClaimReviewInput): ChangedClaimReviewResult {
  const changedSpanSet = new Set(input.diff.changedSpans.map((s) => s.spanKey));
  const toReview: ClaimRef[] = [];
  const reuseVerdicts: Array<{ claim: string; verdict: unknown }> = [];
  let reusedCount = 0;

  for (const [spanKey, claims] of input.claimsBySpan) {
    const isChanged = changedSpanSet.has(spanKey);
    for (const claim of claims) {
      const key = input.criticCacheKeyFor(claim, input.criticMode);
      const cached = getCriticVerdict(input.criticCache, key);

      if (!isChanged && cached !== undefined) {
        // 未变化 + 有旧 verdict → 直接复用,不审查
        reuseVerdicts.push({ claim, verdict: cached });
        reusedCount += 1;
        continue;
      }
      if (isChanged) {
        // 变化 span 的 claim:一律重新审查(无重复审查 = 变化 claim 不命中旧 verdict)
        toReview.push({ claim, spanKey });
      } else if (cached === undefined) {
        // 未变化但无旧 verdict(冷启动):仍需审查一次(后续版本可复用)
        toReview.push({ claim, spanKey });
      }
    }
  }

  return { toReview, reuseVerdicts, reusedCount };
}

/** 断言辅助:全部 claim 都有结论(审查或复用),无遗漏 */
export function assertNoUnreviewedClaims(
  allClaims: string[],
  result: ChangedClaimReviewResult,
): boolean {
  const covered = new Set<string>([
    ...result.toReview.map((c) => c.claim),
    ...result.reuseVerdicts.map((c) => c.claim),
  ]);
  return allClaims.every((c) => covered.has(c));
}

/** 供测试/调用方:claim 文本 hash(与 P5-3 同规则) */
export { claimHash };
