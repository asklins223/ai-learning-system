import { z } from "zod";
import { paginationQuerySchema } from "../../lib/pagination.ts";

export const sourceCreateSchema = z.object({
  type: z.enum(["text", "markdown", "code", "url"]).optional(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
  // 审计 F33：用户明确说"再采一次"时才绕过同网址查重。
  force: z.boolean().optional(),
}).refine(
  (data) => {
    // IR2: 采用严格校验——非 url 类型要求 content 必填，防止
    // { type: "text", url: "..." } 无 content 组合产生空 source
    if (data.type && data.type !== "url") return Boolean(data.content?.trim());
    return Boolean(data.url?.trim() || data.content?.trim());
  },
  { message: "url or content is required" },
);

export const sourceUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  // F-021: 状态只允许服务端状态机改变，客户端不能直接设置 status
  // status 字段从 schema 中移除
  metadata: z.record(z.unknown()).optional(),
});

export const sourceListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["draft", "processing", "ready", "failed", "archived"]).optional(),
});

export type SourceCreateInput = z.output<typeof sourceCreateSchema>;
export type SourceUpdateInput = z.input<typeof sourceUpdateSchema>;
