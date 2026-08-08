/**
 * 内容哈希单一来源（阶段 04 收口，security_review HIGH #2 修复）
 *
 * 音频/文本 content hash 的权威实现：voice-service（生产填充）与
 * assessment-critic（完整性重建校验）必须引用同一实现，避免格式断裂
 * （如裸 SHA-256 vs `sha256:` 前缀 + 域分隔），否则音频替换 / replay
 * 防护会短路或误伤。格式约定：`sha256:<64 hex>`（见 voice-artifact-contracts.ts
 * 的 SHA256_HASH_PATTERN）。
 */
import { createHash } from "node:crypto";

/** 裸 SHA-256 hex（内部工具；对外一律使用带前缀的 computeVoiceContentHash 等） */
export function sha256Hex(value: string): string {
  const hash = createHash("sha256");
  const update = hash.update.bind(hash);
  update(value, "utf8");
  return hash.digest("hex");
}

/** voice canonical transcript 的确定性 hash（transcript 属于敏感学习数据，进导出/删除边界） */
export function computeVoiceContentHash(transcript: string): string {
  return `sha256:${sha256Hex(`voice-transcript-v1:${transcript}`)}`;
}

/** text_or_mixed 原始文本的确定性 hash */
export function computeTextContentHash(text: string): string {
  return `sha256:${sha256Hex(`text-or-mixed-v1:${text}`)}`;
}
