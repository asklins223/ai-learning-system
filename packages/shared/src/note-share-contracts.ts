/** 「共享给空间」/「取消共享」那一个显式动作的契约（批次 4.5）。 */

import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });

export const noteShareScopeValuesV1 = ["private", "shared"] as const;
export type NoteShareScopeV1 = (typeof noteShareScopeValuesV1)[number];

export const noteShareScopeRequestV1Schema = z.strictObject({
  shareScope: z.enum(noteShareScopeValuesV1),
});
export type NoteShareScopeRequestV1 = z.infer<typeof noteShareScopeRequestV1Schema>;

export const noteShareScopeReceiptV1Schema = z.strictObject({
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
  /** 设成同一个值时是 false：幂等，不写行也不推更新时间。 */
  changed: z.boolean(),
  updatedAt: isoTimestampSchema,
});
export type NoteShareScopeReceiptV1 = z.infer<typeof noteShareScopeReceiptV1Schema>;
