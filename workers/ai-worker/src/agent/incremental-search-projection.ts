import { createHash } from "node:crypto";
import type { NoteDiffResult } from "./note-diff.ts";

/**
 * P5-6: Incremental Search Projection(实施计划 §5.5)。
 *
 * 增量搜索索引:基于 P5-4 diff,只更新**变化 span** 对应的索引条目,
 * 保证索引与增量 Cache(P5-1/2/3)的失效键一致(相同 span/claim 语义,
 * 索引更新与缓存失效同步,避免"缓存命中但索引陈旧"的不一致)。
 *
 * 纯函数:输入 diff + 旧索引投影,输出应更新/应删除/应新增的条目计划。
 */

export interface SearchIndexEntry {
  entryKey: string;
  spanKey: string;
  /** 索引内容(如分词后的 claim 文本) */
  indexedText: string;
  version: number;
}

export interface SearchIndexState {
  /** entryKey → 索引条目(当前已发布状态) */
  entries: Map<string, SearchIndexEntry>;
}

export interface IndexUpdatePlan {
  upsert: SearchIndexEntry[];
  remove: string[];
}

/** span 内容 → 索引内容 hash(失效键与 P5-1 bundleContentHash 同源:内容寻址) */
export function indexedTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 增量投影:对变化 span 生成 upsert(文本变化 → 新版本条目),
 * 对 removed span 生成 remove;未变化 span 不动(索引零成本)。
 *
 * @param spanIndexedText spanKey → 该 span 的索引文本(当前版本)
 * @param nextVersion 本次索引版本(单调递增)
 */
export function planIncrementalIndexUpdate(
  diff: NoteDiffResult,
  spanIndexedText: Map<string, string>,
  nextVersion: number,
): IndexUpdatePlan {
  const upsert: SearchIndexEntry[] = [];
  const remove: string[] = [];

  for (const span of diff.changedSpans) {
    const text = spanIndexedText.get(span.spanKey);
    if (span.change === "removed" || text === undefined) {
      // removed 或该 span 已无文本(内容被删)→ 移除索引条目
      remove.push(span.spanKey);
      continue;
    }
    upsert.push({
      entryKey: span.spanKey,
      spanKey: span.spanKey,
      indexedText: text,
      version: nextVersion,
    });
  }

  return { upsert, remove };
}

/** 应用更新计划到索引状态(纯函数,返回新状态) */
export function applyIndexUpdate(
  state: SearchIndexState,
  plan: IndexUpdatePlan,
): SearchIndexState {
  const entries = new Map(state.entries);
  for (const key of plan.remove) entries.delete(key);
  for (const e of plan.upsert) entries.set(e.entryKey, e);
  return { entries };
}

/**
 * 一致性校验:索引条目与增量 Cache 失效键一致
 * (entryKey 与 claim/span 级缓存同语义;此处校验无孤儿/无缺失)。
 */
export function verifyIndexConsistency(
  state: SearchIndexState,
  expectedEntryKeys: Set<string>,
): { orphan: string[]; missing: string[] } {
  const actual = new Set(state.entries.keys());
  const orphan = [...actual].filter((k) => !expectedEntryKeys.has(k));
  const missing = [...expectedEntryKeys].filter((k) => !actual.has(k));
  return { orphan, missing };
}
