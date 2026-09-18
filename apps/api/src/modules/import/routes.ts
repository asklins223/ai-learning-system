import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import {
  prepareMarkdownImport,
  importMarkdownNotes,
  finalizeMarkdownImport,
} from "./markdown-import-service.ts";

const importMarkdownSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().max(200).optional().default(""),
        content: z.string().min(1).max(500_000),
      }),
    )
    .min(1)
    .max(100),
  // F-033: 幂等键，相同 importId 的重复请求不会创建重复笔记
  // 客户端在重试时应传入相同的 importId
  importId: z.string().max(100).optional(),
});

export async function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // POST /import/markdown — 批量导入 Markdown 笔记
  // F-033: 支持幂等键（importId），中途失败时重试不会创建重复笔记
  // G-006: 使用 advisory lock + itemKey 实现并发安全的幂等导入
  // RBAC: 仅 owner 可导入笔记（数据写入操作，member 只读）
  // BUG-25 修复：bodyLimit 与 schema 最大容量对齐（100 items × 500KB ≈ 50MB）
  app.post("/import/markdown", { preHandler: [requireOwner], bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const body = parseBody(app, importMarkdownSchema, req.body);
    const { workspaceId, userId } = req.session;
    const scope = { workspaceId, userId };
    // 解析/itemKey/图片预注册在业务事务外完成；幂等锁与写入在事务内完成。
    const items = await prepareMarkdownImport(scope, body.items);
    const outcome = await withWorkspaceTransaction(scope, (tx) =>
      importMarkdownNotes(tx, scope, { items, importId: body.importId ?? null }));
    // 搜索索引是可重建投影，事务提交后再刷新。
    return finalizeMarkdownImport(outcome);
  });
}
