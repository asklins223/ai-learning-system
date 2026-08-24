/**
 * Golden Slice Note detail read projection.
 *
 * This is deliberately smaller than the persistence model.  A Note detail
 * consumer receives the current version and renderable blocks, but never raw
 * database rows, image object identities, or source binding internals.
 */

import { z } from "zod";

const uuidSchema = z.string().uuid();
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const contentHashSchema = z.string().regex(/^[a-f0-9]{32}$/, "invalid note content hash");

export const noteBlockTypeV1Schema = z.enum([
  "paragraph",
  "heading",
  "code",
  "list",
  "quote",
  "image",
]);

export const noteBlockProjectionV1Schema = z.strictObject({
  ordinal: nonNegativeIntSchema,
  type: noteBlockTypeV1Schema,
  content: z.string().max(50_000),
});
export type NoteBlockProjectionV1 = z.infer<typeof noteBlockProjectionV1Schema>;

export const noteVersionProjectionV1Schema = z.strictObject({
  versionId: uuidSchema,
  noteId: uuidSchema,
  versionNo: positiveIntSchema,
  contentHash: contentHashSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  blocks: z.array(noteBlockProjectionV1Schema).max(10_000),
});
export type NoteVersionProjectionV1 = z.infer<typeof noteVersionProjectionV1Schema>;

export const notePermissionProjectionV1Schema = z.strictObject({
  canRead: z.literal(true),
  canEdit: z.boolean(),
  canSave: z.boolean(),
});
export type NotePermissionProjectionV1 = z.infer<typeof notePermissionProjectionV1Schema>;

export const noteDetailV1Schema = z
  .strictObject({
    version: z.literal(1),
    noteId: uuidSchema,
    workspaceId: uuidSchema,
    title: z.string().max(200),
    titleSource: z.enum(["manual", "auto"]),
    sourceId: uuidSchema.nullable(),
    currentVersionId: uuidSchema,
    currentVersion: noteVersionProjectionV1Schema,
    permissions: notePermissionProjectionV1Schema,
    // The current version ID is the OCC/read revision for the frozen Note
    // surface.  It is opaque to the renderer and must be echoed as
    // baseVersionId by a future save adapter.
    revision: uuidSchema,
    snapshotAt: isoTimestampSchema,
  })
  .superRefine((value, context) => {
    if (value.currentVersionId !== value.currentVersion.versionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentVersionId"],
        message: "currentVersionId must match currentVersion.versionId",
      });
    }
    if (value.noteId !== value.currentVersion.noteId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentVersion", "noteId"],
        message: "currentVersion.noteId must match noteId",
      });
    }
    if (value.revision !== value.currentVersionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "revision must match currentVersionId",
      });
    }
  });
export type NoteDetailV1 = z.infer<typeof noteDetailV1Schema>;

