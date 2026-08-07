/**
 * P2-7：Unit Artifact Cache 最小版（实施计划 §3.4, P2-7）。
 *
 * 内容寻址缓存：
 * - cacheKey = sha256(inputHash + modelVersion + promptVersion + unitKind)
 *   （与 B1 共享 Hash 规则但**独立存储**：B1 是 run 级 fingerprint 去重，
 *    本模块是 unit 级 artifact 缓存）
 * - 命中重放 artifact(不重跑 Provider);force 重算可用(绕过缓存)
 * - 审计:命中/写入均记录日志
 *
 * 存储:内存 Map + 可选 DB 持久化(最小版先内存;DB 持久化由 Phase 5 增量复用扩展)。
 */

import { createHash } from "node:crypto";
import { logger } from "../lib/logger.ts";

export interface ArtifactCacheKeyInput {
  inputHash: string;
  modelVersion: string;
  promptVersion: string;
  unitKind: string;
}

export interface ArtifactCacheEntry {
  cacheKey: string;
  artifact: unknown;
  cachedAt: number;
  modelVersion: string;
  promptVersion: string;
  unitKind: string;
}

export interface ArtifactCache {
  get(cacheKey: string): ArtifactCacheEntry | undefined;
  put(entry: ArtifactCacheEntry): void;
  /** force 重算:命中但被绕过时调用方直接重算并覆盖 */
  clear(cacheKey?: string): void;
  stats(): { hits: number; writes: number; size: number };
}

/** 计算内容寻址 cacheKey(与 B1 共享 Hash 规则) */
export function computeArtifactCacheKey(input: ArtifactCacheKeyInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      inputHash: input.inputHash,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      unitKind: input.unitKind,
    }))
    .digest("hex");
}

/** 最小版内存缓存(单 worker 进程内) */
export function createMemoryArtifactCache(): ArtifactCache {
  const store = new Map<string, ArtifactCacheEntry>();
  let hits = 0;
  let writes = 0;

  return {
    get(cacheKey) {
      const entry = store.get(cacheKey);
      if (entry) {
        hits += 1;
        logger.debug({ cacheKey: cacheKey.slice(0, 12), unitKind: entry.unitKind }, "P2-7: artifact 缓存命中");
      }
      return entry;
    },
    put(entry) {
      store.set(entry.cacheKey, entry);
      writes += 1;
      logger.info({ cacheKey: entry.cacheKey.slice(0, 12), unitKind: entry.unitKind }, "P2-7: artifact 缓存写入");
    },
    clear(cacheKey) {
      if (cacheKey) store.delete(cacheKey);
      else store.clear();
    },
    stats() {
      return { hits, writes, size: store.size };
    },
  };
}
