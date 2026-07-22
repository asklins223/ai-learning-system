/**
 * 图片上传与下载路由。
 *
 * - POST /uploads/images   — 笔记图片上传（需 noteId，校验归属）
 * - POST /uploads/avatars  — 用户头像上传
 * - GET  /uploads/*        — 图片下载（租户/用户隔离校验）
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { notes } from "../../db/schema/note.ts";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { hasValidCookieCsrf } from "../identity/session-auth.ts";
import {
  uploadObject,
  getObject,
  headObject,
  isStorageConfigured,
} from "../../lib/object-storage.ts";
import {
  validateImageMagicBytes,
  ALLOWED_IMAGE_TYPES,
  extFromMimeType,
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

const defaultRateLimitStore = createRateLimitStoreFromEnv();

export interface UploadRoutesOptions {
  rateLimitStore?: RateLimitStore;
  imageRateLimitWindowMs?: number;
  imageRateLimitMaxAttempts?: number;
  avatarRateLimitWindowMs?: number;
  avatarRateLimitMaxAttempts?: number;
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

  // ─── POST /uploads/images — 笔记图片上传 ───────────────────────
  // RBAC: 仅 owner 可上传笔记图片（笔记增删改属于 owner 权限）
  app.post("/uploads/images", { preHandler: [requireOwner] }, async (req, reply) => {
    // Rate limit (§7.7): 20 requests/min per user
    const imageDecision = await imageLimiter.consume(`upload:image:user:${req.session.userId}`);
    if (!imageDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(imageDecision.resetAt));
      return reply.code(429).send({ error: "Too many image uploads. Please try again later." });
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
    const note = await db.query.notes.findFirst({
      where: and(eq(notes.id, noteId), eq(notes.workspaceId, req.session.workspaceId), isNull(notes.deletedAt)),
    });
    if (!note) {
      return reply.code(404).send({ error: "note not found in current workspace" });
    }

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as typeof ALLOWED_IMAGE_TYPES[number])) {
      return reply.code(415).send({ error: "unsupported file type" });
    }

    const buffer = await file.toBuffer();

    // Validate magic bytes
    if (!validateImageMagicBytes(buffer, file.mimetype)) {
      return reply.code(415).send({ error: "file content does not match declared type" });
    }

    // Double-check file size
    if (buffer.length > MAX_IMAGE_SIZE) {
      return reply.code(413).send({ error: "file too large (max 10MB)" });
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

    const url = `/api/uploads/${objectKey}`;
    return reply.code(201).send({
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
    });
  });

  // ─── POST /uploads/avatars — 用户头像上传 ──────────────────────
  app.post("/uploads/avatars", async (req, reply) => {
    // Rate limit (§7.7): 5 requests/min per user
    const avatarDecision = await avatarLimiter.consume(`upload:avatar:user:${req.session.userId}`);
    if (!avatarDecision.allowed) {
      reply.header("Retry-After", retryAfterSeconds(avatarDecision.resetAt));
      return reply.code(429).send({ error: "Too many avatar uploads. Please try again later." });
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

    const buffer = await file.toBuffer();

    // Validate magic bytes
    if (!validateImageMagicBytes(buffer, file.mimetype)) {
      return reply.code(415).send({ error: "file content does not match declared type" });
    }

    // Double-check file size
    if (buffer.length > MAX_AVATAR_SIZE) {
      return reply.code(413).send({ error: "file too large (max 2MB)" });
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

    const url = `/api/uploads/${objectKey}`;
    return reply.code(201).send({
      url,
      objectKey,
      size: buffer.length,
      mimeType: file.mimetype,
    });
  });

  // ─── GET /uploads/* — 图片下载（租户/用户隔离） ────────────────
  app.get("/uploads/*", async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    if (!path) return reply.code(404).send({ error: "not found" });

    // Validate path format and enforce tenant isolation
    if (path.startsWith("avatars/")) {
      // Avatar path: avatars/{userId}/{uuid}.{ext}
      const parts = path.split("/");
      if (parts.length < 3) return reply.code(404).send({ error: "not found" });
      const pathUserId = parts[1];
      if (pathUserId !== req.session.userId) {
        return reply.code(403).send({ error: "forbidden" });
      }
    } else {
      // Note image path: {workspaceId}/notes/{noteId}/{uuid}.{ext}
      const parts = path.split("/");
      if (parts.length < 4 || parts[1] !== "notes") {
        return reply.code(404).send({ error: "not found" });
      }
      const pathWorkspaceId = parts[0];
      if (pathWorkspaceId !== req.session.workspaceId) {
        return reply.code(403).send({ error: "forbidden" });
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
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!headResult) {
        return reply.code(404).send({ error: "not found" });
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
    } catch {
      return reply.code(404).send({ error: "not found" });
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