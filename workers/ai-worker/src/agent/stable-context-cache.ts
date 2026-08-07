/**
 * P4-1: 稳定上下文缓存(实施计划 §5.4)。
 *
 * 缓存"稳定上下文段"(系统提示/工具 schema/预算/策略),避免每个 turn 重建。
 * - 键 = stableContextCacheKey(runId + shellVersion + policyVersion + toolSchemaVersion)
 * - LRU 逐出(内存,最小版);缓存命中返回同一稳定段(字节级一致)
 * - 稳定段**绝不包含**状态信息(状态走 stateVersion 增量,见 run-phase-context)
 * - 诊断:命中/写入记录计数(metrics 由调用方可选接入)
 */

export interface StableContextCacheEntry {
  /** 稳定段构建结果(系统提示 + 工具 schema + 预算 + 策略文本) */
  value: string;
  contentHash: string;
  builtAtMs: number;
}

/** 最小版 LRU 缓存(有界,防内存膨胀) */
export class StableContextCache {
  private readonly entries = new Map<string, StableContextCacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries = 128) {}

  get(key: string): StableContextCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    // LRU:重新插入到末尾
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry;
  }

  set(key: string, value: string, contentHash: string, builtAtMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      // 逐出最久未用(首个插入项)
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, contentHash, builtAtMs });
  }

  /** 命中/未命中计数(供指标/日志) */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
