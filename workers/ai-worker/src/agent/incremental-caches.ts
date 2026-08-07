import { createHash } from "node:crypto";
import type { ArtifactCache } from "./unit-artifact-cache.ts";

/**
 * P5-1/P5-2/P5-3: 增量 Artifact 缓存(实施计划 §5.5)。
 *
 * 与 P2-7 unit-artifact-cache 共用 ArtifactCache 接口与内容寻址风格,
 * 但**语义不同**:
 * - P2-7: run 内 unit 级缓存(key 含 inputHash/unitKind);
 * - P5-1: **跨版本** Bundle 级提取缓存(key 含 bundleContentHash,内容变化自动失效,
 *   配合 P5-4 diff 只重算变化 Bundle,命中重放);
 * - P5-2: Candidate 级缓存(key 含源证据 hash,同源同内容命中);
 * - P5-3: Critic verdict 缓存(key 含 claimHash + criticMode,同 Claim 重复审查命中)。
 *
 * 全部为内存缓存(单 worker 进程内),DB 持久化留待跨进程阶段。
 */

export interface BundleCacheKeyInput {
  workspaceId: string;
  runId: string;
  bundleId: string;
  /** bundle 覆盖 span 的内容 hash(来自 P5-4 diff/快照)——变化即失效 */
  bundleContentHash: string;
  modelVersion: string;
  promptVersion: string;
}

export function computeBundleCacheKey(input: BundleCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: input.workspaceId,
    runId: input.runId,
    bundleId: input.bundleId,
    bundleContentHash: input.bundleContentHash,
    modelVersion: input.modelVersion,
    promptVersion: input.promptVersion,
    unitKind: "bundle_extraction",
  })).digest("hex");
}

export interface CandidateCacheKeyInput {
  workspaceId: string;
  runId: string;
  /** 源证据(span)内容 hash——版本变化失效 */
  evidenceContentHash: string;
  promptVersion: string;
}

export function computeCandidateCacheKey(input: CandidateCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: input.workspaceId,
    runId: input.runId,
    evidenceContentHash: input.evidenceContentHash,
    promptVersion: input.promptVersion,
    unitKind: "candidate",
  })).digest("hex");
}

export interface CriticCacheKeyInput {
  workspaceId: string;
  runId: string;
  /** claim 文本规范化后的 sha256 */
  claimHash: string;
  criticMode: "light" | "claim" | "full";
  promptVersion: string;
}

export function computeCriticCacheKey(input: CriticCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: input.workspaceId,
    runId: input.runId,
    claimHash: input.claimHash,
    criticMode: input.criticMode,
    promptVersion: input.promptVersion,
    unitKind: "critic_verdict",
  })).digest("hex");
}

/** claim 文本规范化(去首尾空白、折叠空白)后哈希——同 Claim 同 hash */
export function claimHash(claim: string): string {
  const normalized = claim.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// ─── 语义封装(P5-1/P5-2/P5-3) ───────────────────────────────────────────

/** P5-1: 提取 bundle → 命中重放/写入 */
export function getBundleExtraction(cache: ArtifactCache, key: string): unknown {
  return cache.get(key)?.artifact;
}
export function putBundleExtraction(cache: ArtifactCache, cacheKey: string, artifact: unknown, modelVersion: string, promptVersion: string): void {
  cache.put({ cacheKey, artifact, cachedAt: Date.now(), modelVersion, promptVersion, unitKind: "bundle_extraction" });
}

/** P5-2: candidate 级缓存 */
export function getCandidate(cache: ArtifactCache, key: string): unknown {
  return cache.get(key)?.artifact;
}
export function putCandidate(cache: ArtifactCache, cacheKey: string, artifact: unknown, modelVersion: string, promptVersion: string): void {
  cache.put({ cacheKey, artifact, cachedAt: Date.now(), modelVersion, promptVersion, unitKind: "candidate" });
}

/** P5-3: critic verdict 缓存 */
export function getCriticVerdict(cache: ArtifactCache, key: string): unknown {
  return cache.get(key)?.artifact;
}
export function putCriticVerdict(cache: ArtifactCache, cacheKey: string, verdict: unknown, modelVersion: string, promptVersion: string): void {
  cache.put({ cacheKey, artifact: verdict, cachedAt: Date.now(), modelVersion, promptVersion, unitKind: "critic_verdict" });
}
