import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { noteCreateSchema, noteDocUpdateRequestV1Schema, NOTE_DOC_UPDATE_MAX_BYTES } from "./schema.ts";
import {
  createNote,
  getNoteWithVersion,
  listNotes,
  updateNote,
  deleteNote,
  physicalDeleteNote,
  restoreDeletedNote,
  listNoteVersions,
  restoreNoteVersion,
  RevisionConflictError,
  NoteNotDeletedError,
} from "./service.ts";
import { requireSession, requireOwner, isWorkspaceOwner } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { parseBody } from "../../lib/validate.ts";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";
import { deleteObject } from "../../lib/object-storage.ts";
import { logger } from "../../lib/logger.ts";
import { projectNoteDetailV1, projectNoteSaveReceiptV1 } from "./note-projection.ts";
import { applyUploadedDocUpdate } from "./collaboration.ts";
import { readNoteDocState } from "./document-state.ts";
import { noteSaveRequestV1Schema } from "@ailearn/shared/note-save-contracts";

export async function noteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/notes", async (req) => {
    // R-022: 统一 Zod 校验，非法参数返回 400 而非 NaN 进入查询
    // 前端始终发送 trashed 作为 boolean（包括 false），因此需要接受
    // "true"/"1" 和 "false"/"0" 两组合法值。
    const q = parseQuery(app, paginationQuerySchema.extend({
      trashed: z.enum(["true", "1", "false", "0"]).optional(),
    }), req.query);
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => listNotes(transaction, req.session.workspaceId, {
        cursor: q.cursor,
        limit: q.limit,
        trashed: q.trashed === "true" || q.trashed === "1",
      }),
    );
    return result;
  });

  // Desktop NOTE-READ-PROJECTION-01: the desktop adapter consumes this strict
  // public DTO.
  app.get<{ Params: { id: string } }>("/v2/notes/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => getNoteWithVersion(
        transaction,
        req.params.id,
        req.session.workspaceId,
      ),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    const role = isWorkspaceOwner(req.session) ? "owner" : "member";
    const projection = projectNoteDetailV1(result, role);
    reply.header("Cache-Control", "private, no-store");
    reply.header("ETag", `"${projection.revision}"`);
    return projection;
  });

  // Desktop NOTE-DOC-STATE：读"能直接喂给 Y.Doc 的那份状态"。
  // 编辑起点必须是与服务端同源的一份编码，不能由行重建（重建出的文档没有共同祖先，
  // 两边一改就复制块）。凡是要改正文的客户端，先取这个，再决定走 WS 还是走
  // /v2/notes/:id/doc-update。
  app.get<{ Params: { id: string } }>("/v2/notes/:id/doc-state", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const state = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => readNoteDocState(transaction, {
        workspaceId: req.session.workspaceId,
        noteId: params.data.id,
      }),
    );
    if (!state) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    reply.header("Cache-Control", "private, no-store");
    return {
      update: Buffer.from(state.update).toString("base64"),
      revision: state.revision,
      // true = 这篇还没有快照（建得比 0244 早），返回的是从行里补齐后重新编码的一份。
      backfilled: state.backfilled,
    };
  });

  app.patch<{ Params: { id: string } }>("/v2/notes/:id", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const body = parseBody(app, noteSaveRequestV1Schema, req.body);
    try {
      const result = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (transaction) => updateNote(
          transaction,
          req.params.id,
          req.session.workspaceId,
          req.session.userId,
          {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.blocks !== undefined ? { blocks: body.blocks } : {}),
            baseVersionId: body.baseVersionId,
            isAutosave: body.isAutosave,
          },
        ),
      );
      if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      const receipt = projectNoteSaveReceiptV1(result, body.baseVersionId, body.isAutosave);
      reply.header("Cache-Control", "private, no-store");
      return receipt;
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        return reply.code(409).send({
          error: "revision_conflict",
          currentVersionId: err.currentVersionId,
          message: "笔记已被改动，请刷新后重试",
        });
      }
      if (err && typeof err === "object" && "code" in err && err.code === "23505") {
        return reply.code(409).send({
          error: "revision_conflict",
          message: "版本冲突，请刷新后重试",
        });
      }
      throw err;
    }
  });

  // POST /v2/notes/:id/doc-update — 正文增量的 HTTP 上送口（批次 4.3）。
  // personal 空间与离线重连的队列都走这里，与 WS 共用同一份内存文档：增量并进
  // 活文档（或按 onLoadDocument 从库里补齐后的文档），再经同一个 onStoreDocument
  // 落盘并投影。这里**不**接受整篇正文——整篇写入在并发下会复制块（4.0 实测）。
  // RBAC: 与 WS 的只读判定同一个谓词（requireOwner === !readOnly）。
  app.post<{ Params: { id: string } }>(
    "/v2/notes/:id/doc-update",
    // bodyLimit 是粗筛（防止无界字符串进 JSON 解析）：合法增量的 base64 约 2.7MB，
    // 这里留到 8MB。真正的尺寸判据是下面按**解码后字节数**的那条，它才能给出
    // `update_too_large`——框架的 413 只会说 "Payload Too Large"，客户端无从分辨。
    { preHandler: [requireOwner], bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
      const body = parseBody(app, noteDocUpdateRequestV1Schema, req.body);
      const decoded = Buffer.from(body.update, "base64");
      if (decoded.byteLength > NOTE_DOC_UPDATE_MAX_BYTES) {
        return reply.code(413).send({ error: "update_too_large", message: "增量过大，请拆分后重试" });
      }
      // `Buffer.from(_, 'base64')` 会静默吃掉非法字符，所以解码结果不能当合法性用；
      // 编码回去比对一次才是。
      if (decoded.toString("base64") !== body.update) {
        return reply.code(400).send({ error: "invalid_base64", message: "update 不是规范的 base64" });
      }
      const outcome = await applyUploadedDocUpdate({
        workspaceId: req.session.workspaceId,
        userId: req.session.userId,
        noteId: params.data.id,
        update: new Uint8Array(decoded),
      });
      if (outcome.status === "not_found") return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      if (outcome.status === "no_version") {
        return reply.code(409).send({ error: "note_has_no_version", message: "笔记没有当前版本" });
      }
      reply.header("Cache-Control", "private, no-store");
      return { revision: outcome.revision };
    },
  );

  // RBAC: 笔记增删改仅 owner 可执行，member 只读
  app.post("/notes", { preHandler: [requireOwner] }, async (req) => {
    const body = parseBody(app, noteCreateSchema, req.body);
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => createNote(
        transaction,
        req.session.workspaceId,
        req.session.userId,
        body,
      ),
    );
    return {
      note: result?.note,
      version: result?.version,
      blocks: result?.blocks,
    };
  });

  // DELETE /notes/:id — 删除笔记（CONC-03: 软删除，设置 deleted_at）
  // RBAC: 仅 owner 可删除
  app.delete<{ Params: { id: string } }>("/notes/:id", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => deleteNote(transaction, req.params.id, req.session.workspaceId),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return reply.code(204).send();
  });

  // §3.11: DELETE /notes/:id/permanent — 物理删除已软删除的笔记并清理对象存储图片
  // 管理员手动触发；定时任务 cleanup-soft-deleted-notes.ts 自动执行相同逻辑
  // RBAC: 仅 owner 可物理删除
  app.delete<{ Params: { id: string } }>("/notes/:id/permanent", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => physicalDeleteNote(transaction, req.params.id, req.session.workspaceId),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });

    // 事务已提交，fire-and-forget 清理对象存储中的图片（§3.11）
    if (result.imageObjectKeys?.length > 0) {
      void Promise.allSettled(
        result.imageObjectKeys.map((key) => deleteObject(key)),
      ).then((results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          logger.warn(
            { failed, total: result.imageObjectKeys.length, noteId: req.params.id },
            "some image objects failed to delete after permanent note deletion",
          );
        }
      });
    }

    return reply.code(204).send();
  });

  // CONC-03: POST /notes/:id/restore — 恢复软删除的笔记
  // RBAC: 仅 owner 可恢复
  app.post<{ Params: { id: string } }>("/notes/:id/restore", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    try {
      const result = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (transaction) => restoreDeletedNote(transaction, req.params.id, req.session.workspaceId),
      );
      if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      return result;
    } catch (err) {
      // P2-3: 笔记未删除时返回 409 Conflict，而非 404
      if (err instanceof NoteNotDeletedError) {
        return reply.code(409).send({ error: "note_not_deleted", message: "该笔记未被删除，无需恢复" });
      }
      throw err;
    }
  });

  // §2.5: GET /notes/:id/versions — 笔记版本历史列表（不含 blocks 详情）
  // 2026-08-11（性能专项）：支持 limit/offset 分页（默认 100/0）
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>("/notes/:id/versions", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const versions = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => listNoteVersions(transaction, req.params.id, req.session.workspaceId, limit, offset),
    );
    if (!versions) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return { items: versions };
  });

  // POST /notes/:id/versions/:versionId/restore — 恢复到指定版本
  // CONC-05: 可选 baseVersionId 乐观检查，不匹配时返回 409
  // RBAC: 仅 owner 可恢复版本
  const restoreSchema = z.object({
    baseVersionId: z.string().uuid().optional(),
  }).default({});
  app.post<{ Params: { id: string; versionId: string } }>(
    "/notes/:id/versions/:versionId/restore",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
      // versionId 也必须是合法 UUID，否则返回 400 而非进入 DB 查询
      if (!z.string().uuid().safeParse(req.params.versionId).success) {
        return reply.code(400).send({ error: "invalid versionId format" });
      }
      const body = parseBody(app, restoreSchema, req.body);

      try {
        const result = await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (transaction) => restoreNoteVersion(
            transaction,
            req.params.id,
            req.params.versionId,
            req.session.workspaceId,
            req.session.userId,
            body.baseVersionId,
          ),
        );

        if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
        return result;
      } catch (err) {
        if (err instanceof RevisionConflictError) {
          return reply.code(409).send({
            error: "revision_conflict",
            currentVersionId: err.currentVersionId,
            message: "内容已被改动，请刷新后重试",
          });
        }
        throw err;
      }
    },
  );

}
