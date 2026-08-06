/**
 * 卡片生成共享哈希工具。
 *
 * 此前包含 V2 管道的共享类型、调度器和基础设施函数。
 * V2 管道已移除，仅保留 Agent V1 依赖的 hashJson / sha256 工具。
 */

import { createHash } from "node:crypto";

// ─── 哈希工具 ──────────────────────────────────────────────────────────────

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// QUAL-19 fix: Use stable JSON serialization (key-sorted) to ensure
// cross-process hash consistency. Previously used JSON.stringify which
// depends on V8 key insertion order and can produce different hashes
// for logically identical objects across different code paths.
function stableJsonStringifyLocal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map(stableJsonStringifyLocal).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableJsonStringifyLocal(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function hashJson(value: unknown): string {
  return sha256(stableJsonStringifyLocal(value));
}
