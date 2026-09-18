import { z } from "zod";

export interface NoteBlock {
  ordinal: number;
  type: "paragraph" | "heading" | "code" | "list" | "quote" | "image";
  content: string;
}

export const noteCreateSchema = z.object({
  // 可省略，自动从 blocks 第一个 heading/paragraph 提取
  title: z.string().max(200).optional().default(""),
  blocks: z
    .array(
      z.object({
        type: z.enum(["paragraph", "heading", "code", "list", "quote", "image"]),
        content: z.string().max(50_000),
      }),
    )
    .optional()
    .default([]),
});

export type NoteCreateInput = z.output<typeof noteCreateSchema>;
