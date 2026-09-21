/** Strict Note save request/receipt for the Owner branch of Golden Slice. */

import { z } from "zod";

const uuidSchema = z.string().uuid();
const positiveIntSchema = z.number().int().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const noteBlockTypeSchema = z.enum([
  "paragraph",
  "heading",
  "code",
  "list",
  "quote",
  "image",
]);

export const noteBlockWriteV1Schema = z.strictObject({
  type: noteBlockTypeSchema,
  content: z.string().max(50_000),
});
export type NoteBlockWriteV1 = z.infer<typeof noteBlockWriteV1Schema>;

/**
 * 「提交并确认」的请求体。**没有 `blocks` 字段**——这是刻意的，不是漏了。
 *
 * 这条路上曾经同时收整篇正文和一个版本指针当 OCC 令牌：两扇窗口拿同一个令牌时两边
 * 都能通过检查，后写的那一次把前一次的正文原地覆盖掉，且没有版本可恢复。现在正文
 * 只从文档来（`POST /v2/notes/:id/doc-update` / WS 增量），这里只负责把"文档此刻"
 * 定成一个版本，所以能传的东西只剩下"要不要顺便改名"。
 */
export const noteSaveRequestV1Schema = z.strictObject({
  version: z.literal(1),
  title: z.string().max(200).optional(),
  baseVersionId: uuidSchema,
});
export type NoteSaveRequestV1 = z.infer<typeof noteSaveRequestV1Schema>;

export const noteSaveReceiptV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.literal("committed"),
  noteId: uuidSchema,
  workspaceId: uuidSchema,
  baseVersionId: uuidSchema,
  versionId: uuidSchema,
  currentVersionId: uuidSchema,
  versionNo: positiveIntSchema,
  revision: uuidSchema,
  savedAt: isoTimestampSchema,
});
export type NoteSaveReceiptV1 = z.infer<typeof noteSaveReceiptV1Schema>;

