import { createHash } from "node:crypto";

/**
 * P4-1: 稳定上下文指纹(实施计划 §5.4)。
 *
 * 上下文增量构建的核心:稳定上下文(系统提示/工具 schema/预算/策略)
 * 不随 run 状态变化,按 `缓存键 = runId + shellVersion + policyVersion + toolSchemaVersion`
 * 缓存;状态上下文(ledger/events/结果)按 stateVersion 增量更新。
 */

export interface StableContextFingerprintInput {
  runId: string;
  shellVersion: string;
  policyVersion: string;
  toolSchemaVersion: string;
}

/** 稳定上下文缓存键(§5.4 P4-1 验收) */
export function stableContextCacheKey(input: StableContextFingerprintInput): string {
  const canonical = [
    input.runId,
    input.shellVersion,
    input.policyVersion,
    input.toolSchemaVersion,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 稳定上下文(系统提示等)本身的内容 hash,供日志审计 */
export function stableContextContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
