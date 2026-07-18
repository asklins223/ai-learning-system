import { z } from "zod";
import { paginationQuerySchema } from "../../lib/pagination.ts";

export const sourceCreateSchema = z.object({
  type: z.enum(["text", "markdown", "code", "url"]),
  title: z.string().min(1).max(500),
  content: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
}).refine(
  (data) => {
    // F-021: url 类型时 url 或 content 至少一项必须有值
    if (data.type === "url") {
      return Boolean(data.url?.trim() || data.content?.trim());
    }
    // 非 url 类型时 content 必须有值
    return Boolean(data.content?.trim());
  },
  { message: "url or content is required" },
);

export const sourceUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  // F-021: 状态只允许服务端状态机改变，客户端不能直接设置 status
  // status 字段从 schema 中移除
  metadata: z.record(z.any()).optional(),
});

export const sourceListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["draft", "processing", "ready", "failed", "archived"]).optional(),
});

export const sourceStatusBatchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export type SourceCreateInput = z.output<typeof sourceCreateSchema>;
export type SourceUpdateInput = z.input<typeof sourceUpdateSchema>;
export type SourceListQuery = z.output<typeof sourceListQuerySchema>;
