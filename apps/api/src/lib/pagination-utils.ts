/**
 * F-024: 统一分页参数 clamp 工具。
 *
 * limit 限定到 1–100，offset/cursor 限定到 ≥0。
 * 负值或 NaN 会被纠正为默认值，而非触发 500。
 */
export function clampLimit(value: number | undefined, defaultValue = 100): number {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function clampOffset(value: number | undefined, defaultValue = 0): number {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.max(0, Math.floor(value));
}

export function clampPagination(opts?: { cursor?: number; limit?: number }, defaults?: { limit?: number; cursor?: number }) {
  return {
    limit: clampLimit(opts?.limit, defaults?.limit ?? 100),
    offset: clampOffset(opts?.cursor, defaults?.cursor ?? 0),
  };
}

/**
 * R-019: Cursor 分页工具。
 *
 * 将 offset 分页迁移为基于 (timestamp, id) 的 cursor 分页。
 * cursor 是 base64 编码的 "timestamp:id" 字符串。
 * 避免并发插入/更新导致的重复或遗漏。
 */

/**
 * 编码 cursor：将 timestamp 和 id 编码为 base64 字符串。
 */
export function encodeCursor(timestamp: string | Date, id: string): string {
  const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  return Buffer.from(`${ts}:${id}`).toString("base64");
}

/**
 * 解码 cursor：将 base64 字符串解码为 { timestamp, id }。
 * 返回 null 表示无效 cursor（等价于第一页）。
 */
export function decodeCursor(cursor: string | undefined | null): { timestamp: string; id: string } | null {
  if (!cursor) return null;
  try {
    if (
      cursor.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)
    ) return null;
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    // Buffer's base64 decoder is deliberately forgiving. Require the canonical
    // representation emitted by encodeCursor so garbage is not treated as page 1.
    if (Buffer.from(decoded, "utf-8").toString("base64") !== cursor) return null;
    const sepIndex = decoded.lastIndexOf(":");
    if (sepIndex <= 0) return null;
    const timestamp = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (
      !timestamp ||
      Number.isNaN(Date.parse(timestamp)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

/**
 * R-022: 统一 Zod query schema — 所有列表端点共用。
 * 校验失败时返回 400，而非静默退回默认值。
 */
import { z } from "zod";

// R-019: cursor 改为 string 类型（base64 编码的 timestamp:id）
export const paginationQuerySchema = z.object({
  cursor: z.string().max(200).refine((value) => decodeCursor(value) !== null, {
    message: "invalid cursor",
  }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

// R-022: cardId 路径参数校验
export const cardIdParamSchema = z.object({
  cardId: z.string().uuid(),
});
