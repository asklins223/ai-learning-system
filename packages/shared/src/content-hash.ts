import { createRequire } from "node:module";

// 2026-08-13（web 客户端打包修复）：node:crypto 惰性获取——客户端
// bundle（IgnorePlugin 置空 node: 模块）顶层 createRequire 为 undefined，
// nodeRequire 为 null；这些函数仅服务端调用，客户端不触发。CJS 桌面
// bundle 没有可用的 import.meta.url，因此用当前文件路径作为 require 基准。
const nodeRequire = typeof createRequire === "function"
  ? createRequire(typeof __filename === "string" ? __filename : `${process.cwd()}/package.json`)
  : null;

/**
 * 内容哈希单一来源（阶段 04 收口，security_review HIGH #2 修复）
 *
 * 音频/文本 content hash 的权威实现：voice-service（生产填充）与
 * assessment-critic（完整性重建校验）必须引用同一实现，避免格式断裂
 * （如裸 SHA-256 vs `sha256:` 前缀 + 域分隔），否则音频替换 / replay
 * 防护会短路或误伤。格式约定：`sha256:<64 hex>`（见 voice-artifact-contracts.ts
 * 的 SHA256_HASH_PATTERN）。
 */

/** 裸 SHA-256 hex（内部工具；对外一律使用带前缀的 computeVoiceContentHash 等） */
export function sha256Hex(value: string): string {
  if (!nodeRequire) throw new Error("node:crypto unavailable in this environment");
  const { createHash } = nodeRequire("node:crypto");
  const hash = createHash("sha256");
  const hashUpdate = hash.update.bind(hash);
  hashUpdate(value, "utf8");
  return hash.digest("hex");
}

/** 03 合同 §2.1：精确 UTF-8 bytes 的 SHA-256（小写 64 hex）。 */
export function sha256Utf8V1(value: string): string {
  return sha256Hex(value);
}

/**
 * 03 合同 §2.1：canonical JSON（供 request_body_hash/create_body_hash/
 * payload_sha256/contextRevision 等使用）。
 * 规则：object key 按 Unicode code point 升序递归排序；array 保持顺序；
 * string/boolean/null 用标准 JSON token；number 必须是 finite safe integer
 * 且 -0 规范为 0；输出 UTF-8、无 BOM、无额外空白、末尾无换行。
 */
function canonicalizeValueV1(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValueV1);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort((a, b) => {
      // Unicode code point 升序（对非 BMP key 也稳定）
      const aCode = a.codePointAt(0) ?? 0;
      const bCode = b.codePointAt(0) ?? 0;
      if (aCode !== bCode) return aCode - bCode;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = canonicalizeValueV1(source[key]);
    }
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("canonicalJsonV1: number must be a finite safe integer");
    }
    return value === 0 ? 0 : value; // -0 → 0
  }
  return value;
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalizeValueV1(value));
}

/** voice canonical transcript 的确定性 hash（transcript 属于敏感学习数据，进导出/删除边界） */
export function computeVoiceContentHash(transcript: string): string {
  return `sha256:${sha256Hex(`voice-transcript-v1:${transcript}`)}`;
}

/** text_or_mixed 原始文本的确定性 hash */
export function computeTextContentHash(text: string): string {
  return `sha256:${sha256Hex(`text-or-mixed-v1:${text}`)}`;
}

/**
 * 稳定化 JSON 序列化：对象键按字典序排序（递归）、数组保持顺序、
 * 值为 undefined 的属性跳过。使同一契约的键序差异不改变序列化结果。
 *
 * 与 canonicalJsonV1 不同：不强制 safe-integer 约束，适用于一般用途。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(",")}}`;
}
