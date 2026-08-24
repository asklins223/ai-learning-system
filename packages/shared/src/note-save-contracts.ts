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

export const noteSaveRequestV1Schema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().max(200).optional(),
    blocks: z.array(noteBlockWriteV1Schema).max(10_000).optional(),
    baseVersionId: uuidSchema,
    isAutosave: z.boolean().default(false),
  })
  .refine(
    (value) => value.title !== undefined || value.blocks !== undefined,
    "title or blocks is required",
  );
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
  isAutosave: z.boolean(),
  revision: uuidSchema,
  savedAt: isoTimestampSchema,
});
export type NoteSaveReceiptV1 = z.infer<typeof noteSaveReceiptV1Schema>;

