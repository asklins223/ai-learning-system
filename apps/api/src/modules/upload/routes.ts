/**
 * 图片上传与下载路由。
 *
 * - POST /uploads/images   — 笔记图片上传（需 noteId，校验归属）
 * - POST /uploads/avatars  — 用户头像上传
 * - GET  /uploads/*        — 图片下载（租户/用户隔离校验）
 */
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { noteImageAssets, notes } from "../../db/schema/note.ts";
import { users } from "../../db/schema/identity.ts";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { hasValidCookieCsrf } from "../identity/session-auth.ts";
import {
  uploadObject,
  getObject,
  headObject,
  deleteObject,
  isStorageConfigured,
} from "../../lib/object-storage.ts";

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
import {
  validateImageMagicBytes,
  ALLOWED_IMAGE_TYPES,
  extFromMimeType,
  readImageDimensions,
} from "../../lib/file-validation.ts";
import { getRequestCredential } from "../identity/middleware.ts";
import { logger } from "../../lib/logger.ts";
import {
  RateLimiter,
  createRateLimitStoreFromEnv,
  type RateLimitStore,
} from "../identity/rate-limit.ts";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

// Rate limit defaults (§7.7): images 20/min, avatars 5/min
const DEFAULT_IMAGE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_IMAGE_RATE_LIMIT_MAX = 20;
const DEFAULT_AVATAR_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AVATAR_RATE_LIMIT_MAX = 5;
// 2026-08-12（存储面审计）：下载路由此前无限流——单请求峰值 50MB 内存
// 读取，无并发上限时构成内存压力面。60/min per user（可配）足够正常
// 多图笔记场景，同时限制异常拉取。
const DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_DOWNLOAD_RATE_LIMIT_MAX = 60;

const defaultRateLimitStore = createRateLimitStoreFromEnv();

export interface UploadRoutesOptions {
  rateLimitStore?: RateLimitStore;
  imageRateLimitWindowMs?: number;
  imageRateLimitMaxAttempts?: number;
  avatarRateLimitWindowMs?: number;
  avatarRateLimitMaxAttempts?: number;
  downloadRateLimitWindowMs?: number;
  downloadRateLimitMaxAttempts?: number;
}

function retryAfterSeconds(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
}

export async function uploadRoutes(
  app: FastifyInstance,
  options: UploadRoutesOptions = {},
) {
  app.addHook("preHandler", requireSession);

  const imageLimiter = new RateLimiter(options.rateLimitStore ?? defaultRateLimitStore, {
    windowMs: options.imageRateLimitWindowMs ?? DEFAULT_IMAGE_RATE_LIMIT_WINDOW_MS,
    maxAttempts: options.imageRateLimitMaxAttempts ?? DEFAULT_IMAGE_RATE_LIMIT_MAX,
  });
  const avatarLimiter = new RateLimiter(options.rateLimitStore ?? defaultRateLimitStore, {
    windowMs: options.avatarRateLimitWindowMs ?? DEFAULT_AVATAR_RATE_LIMIT_WINDOW_MS,
    maxAttempts: options.avatarRateLimitMaxAttempts ?? DEFAULT_AVATAR_RATE_LIMIT_MAX,
  });
  const downloadLimiter = new RateLimiter(options.rateLimitStore ?? defaultRateLimitStore, {
    windowMs: options.downloadRateLimitWindowMs ?? DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS,
    maxAttempts: options.downloadRateLimitMaxAttempts ?? DEFAULT_DOWNLOAD_RATE_LIMIT_MAX,
  });

  // ─── POST /uploads/images — 笔记图片上传 ───────────────────────
  // RBAC: 仅 owner 可上传笔记图片（笔记增删改属于 owner 权限）
  app.post("/uploads/images", { preHandler: [requireOwner] }, async (req, reply) => {
    // Rate limit (§7.7): 20 requests/min per user
    const imageDecision = await imageLimiter.consume(`upload:image:user:${req.session.userId}`);
    if (!imageDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(imageDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "上传过于频繁，请稍后重试" });
    }

    // CSRF check for cookie-authenticated requests
    const credential = getRequestCredential(req);
    if (credential?.source === "cookie" && !hasValidCookieCsrf(req.method, req.headers)) {
      return reply.code(403).send({ error: "csrf token required" });
    }

    if (!isStorageConfigured()) {
      return reply.code(503).send({ error: "object storage is not configured" });
    }

    const file = await req.file({ limits: { fileSize: MAX_IMAGE_SIZE } });
    if (!file) return reply.code(400).send({ error: "no file provided" });

    // noteId is required
    const noteIdField = file.fields["noteId"];
    const noteId = noteIdField && "value" in noteIdField ? String(noteIdField.value) : undefined;
    if (!noteId || !noteId.trim()) {
      return reply.code(400).send({ error: "noteId is required" });
    }

    // Validate noteId belongs to current workspace (提前校验，避免无效请求浪费内存读取文件)
    // CONC-03: 不允许向已软删除的笔记上传图片，避免产生孤儿图片对象
    const transactionContext = {
      workspaceId: req.session.workspaceId,
      userId: req.session.userId,
    };
    const note = await withWorkspaceTransaction(
      transactionContext,
      (tx) => tx.query.notes.findFirst({
        where: and(
          eq(notes.id, noteId),
          eq(notes.workspaceId, req.session.workspaceId),
          isNull(notes.deletedAt),
        ),
      }),
    );
    if (!note) {
      return reply.code(404).send({ error: "note not found in current workspace" });
    }

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as typeof ALLOWED_IMAGE_TYPES[number])) {
      return reply.code(415).send({ error: "unsupported file type" });
    }

    // QUAL-48 安全注释：file.toBuffer() 将整个文件读入内存。
    // 防护措施：
    //   1. req.file({ limits: { fileSize: MAX_IMAGE_SIZE } }) 已在上游设置
    //      10MB 限制，Fastify 会在流式读取时自动截断并拒绝超大文件
    //   2. toBuffer() 后的双重校验（buffer.length > MAX_IMAGE_SIZE）作为
    //      第二道防线，防止 limits 配置被绕过
    //   3. magic bytes 校验在 toBuffer 后进行，因为需要检查前几字节
    //   4. 图片尺寸校验防止 decode-bomb（40 megapixel 限制）
    const buffer = await file.toBuffer();

    // Validate magic bytes
    if (!validateImageMagicBytes(buffer, file.mimetype)) {
      return reply.code(415).send({ error: "file content does not match declared type" });
    }

    // Double-check file size
    if (buffer.length > MAX_IMAGE_SIZE) {
      return reply.code(413).send({ error: "file too large (max 10MB)" });
    }

    const dimensions = readImageDimensions(buffer, file.mimetype);
    if (!dimensions) {
      return reply.code(415).send({ error: "image dimensions could not be decoded" });
    }
    // Decode-bomb guard: reject before any downstream normalizer opens pixels.
    if (dimensions.width * dimensions.height > 40_000_000) {
      return reply.code(413).send({ error: "image pixel count exceeds 40 megapixels" });
    }

    // Generate objectKey: {workspaceId}/notes/{noteId}/{uuid}.{ext}
    const ext = extFromMimeType(file.mimetype);
    const objectKey = `${req.session.workspaceId}/notes/${noteId}/${randomUUID()}.${ext}`;

    try {
      await uploadObject(objectKey, buffer, file.mimetype);
    } catch (err) {
      logger.error({ err, objectKey }, "failed to upload image to storage");
      return reply.code(503).send({ error: "failed to upload image" });
    }

    let asset: typeof noteImageAssets.$inferSelect;
    try {
      asset = await withWorkspaceTransaction(transactionContext, async (tx) => {
        const liveNote = await tx.query.notes.findFirst({
          columns: { id: true },
          where: and(
            eq(notes.id, note.id),
            eq(notes.workspaceId, req.session.workspaceId),
            isNull(notes.deletedAt),
          ),
        });
        if (!liveNote) throw new Error("note was deleted before image asset registration");
        const [registered] = await tx
          .insert(noteImageAssets)
          .values({
            workspaceId: req.session.workspaceId,
            uploadedForNoteId: liveNote.id,
            objectKey,
            sha256: createHash("sha256").update(buffer).digest("hex"),
            mimeType: file.mimetype,
            byteSize: buffer.length,
            width: dimensions.width,
            height: dimensions.height,
            status: "ready",
            createdBy: req.session.userId,
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
      return reply.code(503).send({ error: "failed to register uploaded image" });
    }

    const url = `/api/uploads/${objectKey}`;
    return reply.code(201).send({
      assetId: asset.id,
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
      sha256: asset.sha256,
      width: dimensions.width,
      height: dimensions.height,
    });
  });

  // ─── POST /uploads/avatars — 用户头像上传 ──────────────────────
  app.post("/uploads/avatars", async (req, reply) => {
    // Rate limit (§7.7): 5 requests/min per user
    const avatarDecision = await avatarLimiter.consume(`upload:avatar:user:${req.session.userId}`);
    if (!avatarDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(avatarDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "上传过于频繁，请稍后重试" });
    }

    const credential = getRequestCredential(req);
    if (credential?.source === "cookie" && !hasValidCookieCsrf(req.method, req.headers)) {
      return reply.code(403).send({ error: "csrf token required" });
    }

    if (!isStorageConfigured()) {
      return reply.code(503).send({ error: "object storage is not configured" });
    }

    const file = await req.file({ limits: { fileSize: MAX_AVATAR_SIZE } });
    if (!file) return reply.code(400).send({ error: "no file provided" });

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as typeof ALLOWED_IMAGE_TYPES[number])) {
      return reply.code(415).send({ error: "unsupported file type" });
    }

    // QUAL-48 安全注释：file.toBuffer() 将整个文件读入内存。
    // 防护措施：
    //   1. req.file({ limits: { fileSize: MAX_AVATAR_SIZE } }) 已在上游设置
    //      2MB 限制，Fastify 会在流式读取时自动截断并拒绝超大文件
    //   2. toBuffer() 后的双重校验（buffer.length > MAX_AVATAR_SIZE）作为
    //      第二道防线，防止 limits 配置被绕过
    //   3. magic bytes 校验在 toBuffer 后进行，因为需要检查前几字节
    //   4. 图片尺寸校验防止 decode-bomb（40 megapixel 限制）
    const buffer = await file.toBuffer();

    // Validate magic bytes
    if (!validateImageMagicBytes(buffer, file.mimetype)) {
      return reply.code(415).send({ error: "file content does not match declared type" });
    }

    // Double-check file size
    if (buffer.length > MAX_AVATAR_SIZE) {
      return reply.code(413).send({ error: "file too large (max 2MB)" });
    }

    // BUG-26 修复：头像上传也需 decode-bomb 防护，与笔记图片上传保持一致
    const avatarDimensions = readImageDimensions(buffer, file.mimetype);
    if (!avatarDimensions) {
      return reply.code(415).send({ error: "image dimensions could not be decoded" });
    }
    if (avatarDimensions.width * avatarDimensions.height > 40_000_000) {
      return reply.code(413).send({ error: "image pixel count exceeds 40 megapixels" });
    }

    // Generate objectKey: avatars/{userId}/{uuid}.{ext}
    const ext = extFromMimeType(file.mimetype);
    const objectKey = `avatars/${req.session.userId}/${randomUUID()}.${ext}`;

    try {
      await uploadObject(objectKey, buffer, file.mimetype);
    } catch (err) {
      logger.error({ err, objectKey }, "failed to upload avatar to storage");
      return reply.code(503).send({ error: "failed to upload avatar" });
    }

    // BUG-21/SEC-31 修复：持久化 avatarUrl 到 users 表，并清理旧头像存储
    // 查询旧头像 objectKey
    const [userRow] = await db
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, req.session.userId))
      .limit(1);
    const oldAvatarUrl = userRow?.avatarUrl;

    // 更新 users.avatarUrl
    const url = `/api/uploads/${objectKey}`;
    try {
      await db
        .update(users)
        .set({ avatarUrl: url, updatedAt: new Date() })
        .where(eq(users.id, req.session.userId));
    } catch (err) {
      // 2026-08-12（存储面审计）：DB 更新失败时回收已上传的新头像对象，
      // 否则成为永久孤儿（头像无 DB 登记表，无其他回收路径）。
      deleteObject(objectKey).catch((cleanupError) => {
        logger.warn({ cleanupError, objectKey }, "failed to clean up orphan avatar after DB update failure");
      });
      logger.error({ err, objectKey }, "failed to persist avatarUrl");
      return reply.code(503).send({ error: "failed to persist avatar" });
    }

    // 异步清理旧头像存储对象（不阻塞响应）
    if (oldAvatarUrl) {
      const oldObjectKey = oldAvatarUrl.replace(/^\/api\/uploads\//, "");
      if (oldObjectKey && oldObjectKey.startsWith("avatars/")) {
        deleteObject(oldObjectKey).catch((err) => {
          logger.warn({ err, oldObjectKey }, "failed to delete old avatar from storage");
        });
      }
    }

    return reply.code(201).send({
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
    });
  });

  // ─── GET /uploads/* — 图片下载（租户/用户隔离） ────────────────
  app.get("/uploads/*", async (req, reply) => {
    // 2026-08-12（存储面审计）：下载限流（60/min per user，防并发大 buffer 内存压力）
    const downloadDecision = await downloadLimiter.consume(`upload:download:user:${req.session.userId}`);
    if (!downloadDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(downloadDecision.resetAt));
      return reply.code(429).send({ error: "rate_limited", message: "下载过于频繁，请稍后重试" });
    }
    const path = (req.params as { "*": string })["*"];
    if (!path) return reply.code(404).send({ error: "not_found", message: "资源不存在" });

    // SEC-21 修复：拒绝包含路径遍历字符的请求，防止跨 workspace 文件访问
    if (path.includes("..") || path.includes("\\")) {
      return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    }

    // Validate path format and enforce tenant isolation
    // 归属不匹配一律 404（不暴露资源存在性，避免 403 oracle）
    if (path.startsWith("avatars/")) {
      // Avatar path: avatars/{userId}/{uuid}.{ext}
      const parts = path.split("/");
      if (parts.length < 3) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      const pathUserId = parts[1];
      if (pathUserId !== req.session.userId) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
    } else {
      // Note/source image path: {workspaceId}/notes/{noteId}/{uuid}.{ext}
      //   or: {workspaceId}/sources/{sourceId}/{uuid}.{ext}
      const parts = path.split("/");
      if (parts.length < 4 || (parts[1] !== "notes" && parts[1] !== "sources")) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      const pathWorkspaceId = parts[0];
      if (pathWorkspaceId !== req.session.workspaceId) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      // 登记校验：对象必须在 noteImageAssets 中登记，且所属笔记存在且未软删。
      // 防止软删/物理删笔记的图片、以及从未登记的孤儿对象仍可被直连下载。
      const assetRow = await db.query.noteImageAssets.findFirst({
        where: and(
          eq(noteImageAssets.workspaceId, parts[0]),
          or(
            eq(noteImageAssets.objectKey, path),
            and(isNotNull(noteImageAssets.normalizedObjectKey), eq(noteImageAssets.normalizedObjectKey, path)),
            and(isNotNull(noteImageAssets.thumbnailObjectKey), eq(noteImageAssets.thumbnailObjectKey, path)),
          ),
        ),
      });
      if (!assetRow) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      if (parts[1] === "notes") {
        // 笔记物理删除后 uploadedForNoteId 已置 NULL；软删除需显式排除
        if (!assetRow.uploadedForNoteId) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
        const note = await db.query.notes.findFirst({
          where: and(
            eq(notes.id, assetRow.uploadedForNoteId),
            isNull(notes.deletedAt),
          ),
        });
        if (!note) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
    }

    // Check If-None-Match for conditional requests.
    // Use HEAD request for pre-check: if the ETag matches, return 304
    // without downloading the full object body.
    const ifNoneMatch = req.headers["if-none-match"];

    if (ifNoneMatch) {
      let headResult;
      try {
        headResult = await headObject(path);
      } catch (err) {
        // 2026-08-12：S3 故障/网络错误 → 503（对象不存在已被 headObject 折叠为 null）
        logger.error({ err, path }, "headObject failed in upload download route");
        return reply.code(503).send({ error: "storage unavailable" });
      }
      if (!headResult) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }

      // RFC 7232: If-None-Match can be "*" (match any existing resource)
      // or a comma-separated list of ETags.
      if (ifNoneMatch.trim() === "*") {
        // Object exists → 304
        const isAvatarHead = path.startsWith("avatars/");
        reply.header("Cache-Control", `private, max-age=${isAvatarHead ? 604800 : 86400}`);
        if (headResult.etag) reply.header("ETag", headResult.etag);
        return reply.code(304).send();
      }
      const requestedETags = ifNoneMatch.split(",").map((e) => e.trim());
      if (headResult.etag && requestedETags.includes(headResult.etag)) {
        const isAvatarHead = path.startsWith("avatars/");
        reply.header("Cache-Control", `private, max-age=${isAvatarHead ? 604800 : 86400}`);
        reply.header("ETag", headResult.etag);
        return reply.code(304).send();
      }
    }

    let downloadResult;
    try {
      downloadResult = await getObject(path);
    } catch (err) {
      // 2026-08-12：对象缺失/无权限 → 404（防 oracle）；S3 故障/网络 → 503
      if (isObjectMissingError(err)) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      logger.error({ err, path }, "getObject failed in upload download route");
      return reply.code(503).send({ error: "storage unavailable" });
    }

    // Set response headers
    const isAvatar = path.startsWith("avatars/");
    const maxAge = isAvatar ? 604800 : 86400; // 7 days for avatars, 1 day for note images
    reply.header("Content-Type", downloadResult.contentType);
    reply.header("Cache-Control", `private, max-age=${maxAge}`);
    reply.header("X-Content-Type-Options", "nosniff");
    if (downloadResult.etag) {
      reply.header("ETag", downloadResult.etag);
    }

    return reply.send(downloadResult.body);
  });
}
