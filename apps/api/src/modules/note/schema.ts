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

export const noteUpdateSchema = z.object({
  title: z.string().max(200).optional(),
  blocks: z
    .array(
      z.object({
        type: z.enum(["paragraph", "heading", "code", "list", "quote", "image"]),
        content: z.string().max(50_000),
      }),
    )
    .optional(),
  /**
   * 乐观并发控制：客户端传当前持有的 versionId。
   * 若与 note.currentVersionId 不一致，说明内容已被另一端改动，拒绝写入（409）。
   * R-008: 当 blocks 存在时 baseVersionId 为必填，防止静默覆盖。
   */
  baseVersionId: z.string().uuid().optional(),
  /**
   * 自动保存模式：true 时原地更新当前版本的 blocks，不创建新 note_version。
   * 仅在显式保存快照时传 false（或不传），创建新版本。
   */
  isAutosave: z.boolean().optional().default(false),
}).refine(
  (data) => !data.blocks || data.baseVersionId,
  { message: "baseVersionId is required when updating blocks", path: ["baseVersionId"] },
);

export type NoteCreateInput = z.output<typeof noteCreateSchema>;
/**
 * 使用 z.output 而非 z.input，使 isAutosave 类型为 boolean（含默认值 false）。
 * 路由层 parseBody 已应用 schema.parse()，service 收到的始终是完整 output。
 */
export type NoteUpdateInput = z.output<typeof noteUpdateSchema>;
