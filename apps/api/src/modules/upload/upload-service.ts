/**
 * 上传业务/存储服务。
 *
 * routes.ts 只保留 HTTP 关注点（路由注册、preHandler 链、multipart 解析、
 * 限流 429 映射、状态码/响应头映射）；本模块承载三个入口的业务与存储逻辑：
 *
 * - uploadNoteImage      — POST /uploads/images：笔记归属校验 → 类型/magic bytes/
 *                          尺寸校验 → 对象存储写入 → noteImageAssets 登记；
 * - uploadAvatar         — POST /uploads/avatars：同上校验 → 对象存储写入 →
 *                          users.avatarUrl 行锁读改写 → 旧头像回收；
 * - downloadUploadObject — GET /uploads/*：路径遍历防御 → 租户/用户归属校验 →
 *                          登记校验 → ETag/304 条件请求 → 对象读取。
 *
 * 入口返回判别联合结果（成功为响应体，失败为原因），由路由层决定状态码、
 * 响应头与 multipart 流排空；本模块不感知 HTTP 状态码。
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db, withWorkspaceTransaction, type WorkspaceTransactionContext } from "../../db/client.ts";
import { noteImageAssets, notes } from "@ailearn/shared/db-schema/note";
import { users } from "@ailearn/shared/db-schema/identity";
import {
  uploadObject,
  getObject,
  headObject,
  deleteObject,
} from "../../lib/object-storage.ts";
import {
  validateImageMagicBytes,
  ALLOWED_IMAGE_TYPES,
  extFromMimeType,
  readImageDimensions,
} from "../../lib/file-validation.ts";
import { logger } from "../../lib/logger.ts";

// 上传体积上限：路由层用于 multipart limits，服务层用于 toBuffer() 后的双重校验。
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * R3（round-3 审计）：@fastify/multipart 在 fileSize 超限时，req.file()/toBuffer()
 * 抛 error.code = "FST_REQ_FILE_TOO_LARGE"。识别并转 413（与 voice-routes 一致），
 * 避免落入 Fastify 默认 500。也可识别错误类名 RequestFileTooLargeError。
 */
export function fileTooLargeError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") return true;
    if (err.constructor.name === "RequestFileTooLargeError") return true;
  }
  return false;
}

/**
 * 2026-08-12（存储面审计）：区分“对象不存在/无权限”（折叠为 404，防
 * 存在性 oracle）与“S3 服务端故障/网络错误”（503 + 日志，此前一律 404，
 * MinIO 故障不可观测）。
 */
function isObjectMissingError(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  // 仅 S3 明确返回 403/404（对象不存在或无权限）折叠为 404；
  // 网络错误/超时等无 $metadata 的错误走 503 分支（可观测）。
  return status === 403 || status === 404;
}

/** 上传文件的最小结构（@fastify/multipart 的 MultipartFile 满足该形状）。 */
export interface UploadFileHandle {
  mimetype: string;
  toBuffer(): Promise<Buffer>;
}

/** POST /uploads/images 成功响应体。 */
export interface NoteImageUploadBody {
  assetId: string;
  url: string;
  objectKey: string;
  size: number;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
}

/** POST /uploads/images 失败原因（routes.ts 映射为状态码/错误体）。 */
export type NoteImageUploadFailure =
  | "note_not_found"
  | "unsupported_type"
  | "file_read_too_large"
  | "content_type_mismatch"
  | "too_large"
  | "dimensions_undecodable"
  | "pixel_count_exceeded"
  | "storage_upload_failed"
  | "asset_persist_failed";

export type NoteImageUploadResult =
  | { ok: true; body: NoteImageUploadBody }
  | { ok: false; reason: NoteImageUploadFailure };

/** POST /uploads/avatars 成功响应体。 */
export interface AvatarUploadBody {
  url: string;
  objectKey: string;
  size: number;
  mimeType: string;
}

/** POST /uploads/avatars 失败原因（routes.ts 映射为状态码/错误体）。 */
export type AvatarUploadFailure =
  | "unsupported_type"
  | "file_read_too_large"
  | "content_type_mismatch"
  | "too_large"
  | "dimensions_undecodable"
  | "pixel_count_exceeded"
  | "storage_upload_failed"
  | "persist_failed";

export type AvatarUploadResult =
  | { ok: true; body: AvatarUploadBody }
  | { ok: false; reason: AvatarUploadFailure };

/** GET /uploads/* 结果：304/200（含响应头取值）或错误原因。 */
export type UploadDownloadResult =
  | { ok: true; notModified: true; maxAge: number; etag: string | undefined }
  | { ok: true; notModified: false; body: Buffer; contentType: string; maxAge: number; etag: string }
  | { ok: false; reason: "not_found" | "storage_unavailable" };

/**
 * 笔记图片上传：校验笔记归属（提前校验，避免无效请求浪费内存读取文件）、
 * 文件类型/magic bytes/尺寸，写入对象存储并登记 noteImageAssets。
 */
export async function uploadNoteImage(
  scope: WorkspaceTransactionContext,
  input: { noteId: string; file: UploadFileHandle },
): Promise<NoteImageUploadResult> {
  const { noteId, file } = input;

  // Validate noteId belongs to current workspace (提前校验，避免无效请求浪费内存读取文件)
  // CONC-03: 不允许向已软删除的笔记上传图片，避免产生孤儿图片对象
  const transactionContext = {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  };
  const note = await withWorkspaceTransaction(
    transactionContext,
    (tx) => tx.query.notes.findFirst({
      where: and(
        eq(notes.id, noteId),
        eq(notes.workspaceId, scope.workspaceId),
        isNull(notes.deletedAt),
      ),
    }),
  );
  if (!note) {
    return { ok: false, reason: "note_not_found" };
  }

  // Validate file type
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as typeof ALLOWED_IMAGE_TYPES[number])) {
    return { ok: false, reason: "unsupported_type" };
  }

  // QUAL-48 安全注释：file.toBuffer() 将整个文件读入内存。
  // 防护措施：
  //   1. req.file({ limits: { fileSize: MAX_IMAGE_SIZE } }) 已在上游设置
  //      10MB 限制，Fastify 会在流式读取时自动截断并拒绝超大文件
  //   2. toBuffer() 后的双重校验（buffer.length > MAX_IMAGE_SIZE）作为
  //      第二道防线，防止 limits 配置被绕过
  //   3. magic bytes 校验在 toBuffer 后进行，因为需要检查前几字节
  //   4. 图片尺寸校验防止 decode-bomb（40 megapixel 限制）
  let buffer;
  try {
    buffer = await file.toBuffer();
  } catch (err) {
    // R3：读取阶段超限同样抛 FST_REQ_FILE_TOO_LARGE → 413（非 500）。
    if (fileTooLargeError(err)) {
      return { ok: false, reason: "file_read_too_large" };
    }
    throw err;
  }

  // Validate magic bytes
  if (!validateImageMagicBytes(buffer, file.mimetype)) {
    return { ok: false, reason: "content_type_mismatch" };
  }

  // Double-check file size
  if (buffer.length > MAX_IMAGE_SIZE) {
    return { ok: false, reason: "too_large" };
  }

  const dimensions = readImageDimensions(buffer, file.mimetype);
  if (!dimensions) {
    return { ok: false, reason: "dimensions_undecodable" };
  }
  // Decode-bomb guard: reject before any downstream normalizer opens pixels.
  if (dimensions.width * dimensions.height > 40_000_000) {
    return { ok: false, reason: "pixel_count_exceeded" };
  }

  // Generate objectKey: {workspaceId}/notes/{noteId}/{uuid}.{ext}
  const ext = extFromMimeType(file.mimetype);
  const objectKey = `${scope.workspaceId}/notes/${noteId}/${randomUUID()}.${ext}`;

  try {
    await uploadObject(objectKey, buffer, file.mimetype);
  } catch (err) {
    logger.error({ err, objectKey }, "failed to upload image to storage");
    return { ok: false, reason: "storage_upload_failed" };
  }

  let asset: typeof noteImageAssets.$inferSelect;
  try {
    asset = await withWorkspaceTransaction(transactionContext, async (tx) => {
      const liveNote = await tx.query.notes.findFirst({
        columns: { id: true },
        where: and(
          eq(notes.id, note.id),
          eq(notes.workspaceId, scope.workspaceId),
          isNull(notes.deletedAt),
        ),
      });
      if (!liveNote) throw new Error("note was deleted before image asset registration");
      const [registered] = await tx
        .insert(noteImageAssets)
        .values({
          workspaceId: scope.workspaceId,
          uploadedForNoteId: liveNote.id,
          objectKey,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          mimeType: file.mimetype,
          byteSize: buffer.length,
          width: dimensions.width,
          height: dimensions.height,
          status: "ready",
          createdBy: scope.userId,
        })
        .returning();
      if (!registered) throw new Error("image asset insert returned no row");
      return registered;
    });
  } catch (err) {
    await deleteObject(objectKey).catch((cleanupError) => {
      logger.error({ err: cleanupError, objectKey }, "failed to clean up image after asset persistence failure");
    });
    logger.error({ err, objectKey }, "failed to persist uploaded image asset");
    return { ok: false, reason: "asset_persist_failed" };
  }

  const url = `/api/uploads/${objectKey}`;
  return {
    ok: true,
    body: {
      assetId: asset.id,
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
      sha256: asset.sha256,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

/**
 * 用户头像上传：校验文件后写入对象存储，事务内行锁读改写 users.avatarUrl，
 * 并在成功后异步回收旧头像对象（仅限本人名下）。
 */
export async function uploadAvatar(
  scope: WorkspaceTransactionContext,
  input: { file: UploadFileHandle },
): Promise<AvatarUploadResult> {
  const file = input.file;

  // Validate file type
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as typeof ALLOWED_IMAGE_TYPES[number])) {
    return { ok: false, reason: "unsupported_type" };
  }

  // QUAL-48 安全注释：file.toBuffer() 将整个文件读入内存。
  // 防护措施：
  //   1. req.file({ limits: { fileSize: MAX_AVATAR_SIZE } }) 已在上游设置
  //      2MB 限制，Fastify 会在流式读取时自动截断并拒绝超大文件
  //   2. toBuffer() 后的双重校验（buffer.length > MAX_AVATAR_SIZE）作为
  //      第二道防线，防止 limits 配置被绕过
  //   3. magic bytes 校验在 toBuffer 后进行，因为需要检查前几字节
  //   4. 图片尺寸校验防止 decode-bomb（40 megapixel 限制）
  let buffer;
  try {
    buffer = await file.toBuffer();
  } catch (err) {
    // R3：读取阶段超限同样抛 FST_REQ_FILE_TOO_LARGE → 413（非 500）。
    if (fileTooLargeError(err)) {
      return { ok: false, reason: "file_read_too_large" };
    }
    throw err;
  }

  // Validate magic bytes
  if (!validateImageMagicBytes(buffer, file.mimetype)) {
    return { ok: false, reason: "content_type_mismatch" };
  }

  // Double-check file size
  if (buffer.length > MAX_AVATAR_SIZE) {
    return { ok: false, reason: "too_large" };
  }

  // BUG-26 修复：头像上传也需 decode-bomb 防护，与笔记图片上传保持一致
  const avatarDimensions = readImageDimensions(buffer, file.mimetype);
  if (!avatarDimensions) {
    return { ok: false, reason: "dimensions_undecodable" };
  }
  if (avatarDimensions.width * avatarDimensions.height > 40_000_000) {
    return { ok: false, reason: "pixel_count_exceeded" };
  }

  // Generate objectKey: avatars/{userId}/{uuid}.{ext}
  const ext = extFromMimeType(file.mimetype);
  const objectKey = `avatars/${scope.userId}/${randomUUID()}.${ext}`;

  try {
    await uploadObject(objectKey, buffer, file.mimetype);
  } catch (err) {
    logger.error({ err, objectKey }, "failed to upload avatar to storage");
    return { ok: false, reason: "storage_upload_failed" };
  }

  // BUG-21/SEC-31 修复：持久化 avatarUrl 到 users 表，并清理旧头像存储
  const url = `/api/uploads/${objectKey}`;
  let oldAvatarUrl: string | undefined;
  try {
    // 稳定 P1-10（2026-09-15 审计）：读-改-写必须原子化并加行锁。
    // 此前 select 与 update 是两条独立语句且无锁：两个并发换头像请求都会读到同一个
    // 旧值，后写者覆盖先写者 → **先写者的新对象从此无人引用、也无人回收**（头像没有
    // 登记表、没有 sweeper），成为永久孤儿。现在在事务内 SELECT ... FOR UPDATE 锁住
    // users 行（与 identity/service.ts 对同一张表的做法一致）：后到者读到的是先到者
    // 刚写入的值，于是各自只回收"自己真正替换掉"的那个对象。
    oldAvatarUrl = await db.transaction(async (tx) => {
      const [userRow] = await tx
        .select({ avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, scope.userId))
        .for("update");
      await tx
        .update(users)
        .set({ avatarUrl: url, updatedAt: new Date() })
        .where(eq(users.id, scope.userId));
      return userRow?.avatarUrl ?? undefined;
    });
  } catch (err) {
    // 2026-08-12（存储面审计）：DB 更新失败时回收已上传的新头像对象，
    // 否则成为永久孤儿（头像无 DB 登记表，无其他回收路径）。
    deleteObject(objectKey).catch((cleanupError) => {
      logger.warn({ cleanupError, objectKey }, "failed to clean up orphan avatar after DB update failure");
    });
    logger.error({ err, objectKey }, "failed to persist avatarUrl");
    return { ok: false, reason: "persist_failed" };
  }

  // 异步清理旧头像存储对象（不阻塞响应）
  if (oldAvatarUrl) {
    const oldObjectKey = oldAvatarUrl.replace(/^\/api\/uploads\//, "");
    // SEC 修复（2026-09 后端审查）：只允许回收本人名下的头像对象。
    // avatarUrlSchema 仅校验 `/api/uploads/avatars/` 前缀，任何用户都能把
    // 自己的 avatarUrl 指向他人对象键（avatars/{otherUserId}/...），此前
    // 的 `startsWith("avatars/")` 会在换头像时删除他人头像对象。
    if (oldObjectKey && oldObjectKey.startsWith(`avatars/${scope.userId}/`)) {
      deleteObject(oldObjectKey).catch((err) => {
        logger.warn({ err, oldObjectKey }, "failed to delete old avatar from storage");
      });
    }
  }

  return {
    ok: true,
    body: {
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
    },
  };
}

/**
 * 图片下载：路径遍历防御 → 租户/用户归属校验（不匹配一律 not_found，
 * 不暴露资源存在性）→ noteImageAssets 登记校验 → If-None-Match 预检
 * （HEAD + 304，不下载对象体）→ 对象读取。
 */
export async function downloadUploadObject(
  scope: WorkspaceTransactionContext,
  path: string,
  request: { ifNoneMatch?: string },
): Promise<UploadDownloadResult> {
  // SEC-21 修复：拒绝包含路径遍历字符的请求，防止跨 workspace 文件访问
  if (path.includes("..") || path.includes("\\")) {
    return { ok: false, reason: "not_found" };
  }

  // Validate path format and enforce tenant isolation
  // 归属不匹配一律 404（不暴露资源存在性，避免 403 oracle）
  if (path.startsWith("avatars/")) {
    // Avatar path: avatars/{userId}/{uuid}.{ext}
    const parts = path.split("/");
    if (parts.length < 3) return { ok: false, reason: "not_found" };
    const pathUserId = parts[1];
    if (pathUserId !== scope.userId) {
      return { ok: false, reason: "not_found" };
    }
  } else {
    // Note/source image path: {workspaceId}/notes/{noteId}/{uuid}.{ext}
    //   or: {workspaceId}/sources/{sourceId}/{uuid}.{ext}
    const parts = path.split("/");
    if (parts.length < 4 || (parts[1] !== "notes" && parts[1] !== "sources")) {
      return { ok: false, reason: "not_found" };
    }
    const pathWorkspaceId = parts[0];
    if (pathWorkspaceId !== scope.workspaceId) {
      return { ok: false, reason: "not_found" };
    }
    // 登记校验：对象必须在 noteImageAssets 中登记，且所属笔记存在且未软删。
    // 防止软删/物理删笔记的图片、以及从未登记的孤儿对象仍可被直连下载。
    //
    // SEC/RLS 修复（2026-09 后端审查）：note_image_assets 是 FORCE RLS 表，
    // 策略要求 workspace_id = current_setting('app.workspace_id')。裸 db 句柄
    // （连接池连接）没有事务级 GUC，在 ailearn_api（NOBYPASSRLS）下此处恒返回
    // 0 行 → 生产环境所有图片下载 404（dev/CI 用 superuser 掩盖了该缺陷）。
    // 与上传路径一致，改走 withWorkspaceTransaction 设置租户上下文。
    const assetRow = await withWorkspaceTransaction(
      { workspaceId: scope.workspaceId, userId: scope.userId },
      async (tx) => {
        const row = await tx.query.noteImageAssets.findFirst({
          where: and(
            eq(noteImageAssets.workspaceId, parts[0]),
            or(
              eq(noteImageAssets.objectKey, path),
              and(isNotNull(noteImageAssets.normalizedObjectKey), eq(noteImageAssets.normalizedObjectKey, path)),
              and(isNotNull(noteImageAssets.thumbnailObjectKey), eq(noteImageAssets.thumbnailObjectKey, path)),
            ),
          ),
        });
        if (!row) return { row: null, noteExists: false as const };
        if (parts[1] !== "notes") return { row, noteExists: true };
        // 笔记物理删除后 uploadedForNoteId 已置 NULL；软删除需显式排除
        if (!row.uploadedForNoteId) return { row, noteExists: false as const };
        const note = await tx.query.notes.findFirst({
          where: and(
            eq(notes.id, row.uploadedForNoteId),
            isNull(notes.deletedAt),
          ),
        });
        return { row, noteExists: Boolean(note) };
      },
    );
    if (!assetRow.row || !assetRow.noteExists) {
      return { ok: false, reason: "not_found" };
    }
  }

  // Check If-None-Match for conditional requests.
  // Use HEAD request for pre-check: if the ETag matches, return 304
  // without downloading the full object body.
  const ifNoneMatch = request.ifNoneMatch;

  if (ifNoneMatch) {
    let headResult;
    try {
      headResult = await headObject(path);
    } catch (err) {
      // 2026-08-12：S3 故障/网络错误 → 503（对象不存在已被 headObject 折叠为 null）
      logger.error({ err, path }, "headObject failed in upload download route");
      return { ok: false, reason: "storage_unavailable" };
    }
    if (!headResult) {
      return { ok: false, reason: "not_found" };
    }

    // RFC 7232: If-None-Match can be "*" (match any existing resource)
    // or a comma-separated list of ETags.
    if (ifNoneMatch.trim() === "*") {
      // Object exists → 304
      const isAvatarHead = path.startsWith("avatars/");
      return { ok: true, notModified: true, maxAge: isAvatarHead ? 604800 : 86400, etag: headResult.etag };
    }
    const requestedETags = ifNoneMatch.split(",").map((e) => e.trim());
    if (headResult.etag && requestedETags.includes(headResult.etag)) {
      const isAvatarHead = path.startsWith("avatars/");
      return { ok: true, notModified: true, maxAge: isAvatarHead ? 604800 : 86400, etag: headResult.etag };
    }
  }

  let downloadResult;
  try {
    downloadResult = await getObject(path);
  } catch (err) {
    // 2026-08-12：对象缺失/无权限 → 404（防 oracle）；S3 故障/网络 → 503
    if (isObjectMissingError(err)) {
      return { ok: false, reason: "not_found" };
    }
    logger.error({ err, path }, "getObject failed in upload download route");
    return { ok: false, reason: "storage_unavailable" };
  }

  const isAvatar = path.startsWith("avatars/");
  const maxAge = isAvatar ? 604800 : 86400; // 7 days for avatars, 1 day for note images

  return {
    ok: true,
    notModified: false,
    body: downloadResult.body,
    contentType: downloadResult.contentType,
    maxAge,
    etag: downloadResult.etag,
  };
}
