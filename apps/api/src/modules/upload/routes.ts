/**
 * 图片上传与下载路由。
 *
 * - POST /uploads/images   — 笔记图片上传（需 noteId，校验归属）
 * - POST /uploads/avatars  — 用户头像上传
 * - GET  /uploads/*        — 图片下载（租户/用户隔离校验）
 *
 * 业务/存储逻辑见 ./upload-service.ts；本文件只保留 HTTP 关注点（路由注册、
 * preHandler 链、multipart 解析、限流 429 与状态码/响应头映射）。
 */
import type { FastifyInstance } from "fastify";
import { requireSession, requireOwner, getRequestCredential } from "../identity/middleware.ts";
import { hasValidCookieCsrf } from "../identity/session-auth.ts";
import { isStorageConfigured } from "../../lib/object-storage.ts";
import {
  RateLimiter,
  createRateLimitStoreFromEnv,
  type RateLimitStore,
} from "../identity/rate-limit.ts";
import {
  MAX_IMAGE_SIZE,
  MAX_AVATAR_SIZE,
  fileTooLargeError,
  uploadNoteImage,
  uploadAvatar,
  downloadUploadObject,
} from "./upload-service.ts";

/**
 * PERF-B4 修复：@fastify/multipart 在正常 4xx 早返回时不会自动消费内存态
 * file 流。显式 resume() 把 body 流读到结尾，避免请求体未读完导致 keep-alive
 * 连接无法干净复用 / socket 挂起。
 */
function drainMultipartFile(
  file: { file: { resume: () => unknown } } | null | undefined,
): void {
  if (file?.file?.resume) {
    try {
      file.file.resume();
    } catch {
      // 流已结束/损坏时静默忽略，仅作排空兜底。
    }
  }
}

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

    // R3（round-3 审计）：req.file()/toBuffer() 在超限（>10MB 全局 / >2MB 头像）时
    // 抛 FST_REQ_FILE_TOO_LARGE → 此前落入 Fastify 默认 500。参照 voice-routes 转 413。
    let file;
    try {
      file = await req.file({ limits: { fileSize: MAX_IMAGE_SIZE } });
    } catch (err) {
      if (fileTooLargeError(err)) {
        return reply.code(413).send({ error: "file too large (max 10MB)", code: "FST_REQ_FILE_TOO_LARGE" });
      }
      throw err;
    }
    if (!file) return reply.code(400).send({ error: "no file provided" });

    // noteId is required
    const noteIdField = file.fields["noteId"];
    const noteId = noteIdField && "value" in noteIdField ? String(noteIdField.value) : undefined;
    if (!noteId || !noteId.trim()) {
      drainMultipartFile(file);
      return reply.code(400).send({ error: "noteId is required" });
    }

    // 业务/存储逻辑：笔记归属校验 → 文件校验 → 对象存储写入 → noteImageAssets 登记
    const outcome = await uploadNoteImage(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      { noteId, file },
    );
    if (outcome.ok) {
      return reply.code(201).send(outcome.body);
    }
    // 排空点与失败点一致：note_not_found / unsupported_type / file_read_too_large
    // 均发生在 file 流读完之前；其后的失败已消费完请求体，无需 resume()。
    switch (outcome.reason) {
      case "note_not_found":
        drainMultipartFile(file);
        return reply.code(404).send({ error: "note not found in current workspace" });
      case "unsupported_type":
        drainMultipartFile(file);
        return reply.code(415).send({ error: "unsupported file type" });
      case "file_read_too_large":
        drainMultipartFile(file);
        return reply.code(413).send({ error: "file too large (max 10MB)", code: "FST_REQ_FILE_TOO_LARGE" });
      case "content_type_mismatch":
        return reply.code(415).send({ error: "file content does not match declared type" });
      case "too_large":
        return reply.code(413).send({ error: "file too large (max 10MB)" });
      case "dimensions_undecodable":
        return reply.code(415).send({ error: "image dimensions could not be decoded" });
      case "pixel_count_exceeded":
        return reply.code(413).send({ error: "image pixel count exceeds 40 megapixels" });
      case "storage_upload_failed":
        return reply.code(503).send({ error: "failed to upload image" });
      case "asset_persist_failed":
        return reply.code(503).send({ error: "failed to register uploaded image" });
    }
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

    let avFile;
    try {
      avFile = await req.file({ limits: { fileSize: MAX_AVATAR_SIZE } });
    } catch (err) {
      // R3：req.file() 超限抛 FST_REQ_FILE_TOO_LARGE → 413（非 500）。
      if (fileTooLargeError(err)) {
        return reply.code(413).send({ error: "file too large (max 2MB)", code: "FST_REQ_FILE_TOO_LARGE" });
      }
      throw err;
    }
    if (!avFile) return reply.code(400).send({ error: "no file provided" });
    const file = avFile;

    // 业务/存储逻辑：文件校验 → 对象存储写入 → avatarUrl 行锁读改写 → 旧头像回收
    const outcome = await uploadAvatar(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      { file },
    );
    if (outcome.ok) {
      return reply.code(201).send(outcome.body);
    }
    switch (outcome.reason) {
      case "unsupported_type":
        drainMultipartFile(file);
        return reply.code(415).send({ error: "unsupported file type" });
      case "file_read_too_large":
        drainMultipartFile(file);
        return reply.code(413).send({ error: "file too large (max 2MB)", code: "FST_REQ_FILE_TOO_LARGE" });
      case "content_type_mismatch":
        return reply.code(415).send({ error: "file content does not match declared type" });
      case "too_large":
        return reply.code(413).send({ error: "file too large (max 2MB)" });
      case "dimensions_undecodable":
        return reply.code(415).send({ error: "image dimensions could not be decoded" });
      case "pixel_count_exceeded":
        return reply.code(413).send({ error: "image pixel count exceeds 40 megapixels" });
      case "storage_upload_failed":
        return reply.code(503).send({ error: "failed to upload avatar" });
      case "persist_failed":
        return reply.code(503).send({ error: "failed to persist avatar" });
    }
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

    // 业务/存储逻辑：路径遍历防御 → 租户/用户归属校验 → 登记校验 → ETag/304 → 对象读取
    const outcome = await downloadUploadObject(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      path,
      { ifNoneMatch: req.headers["if-none-match"] },
    );
    if (!outcome.ok) {
      if (outcome.reason === "not_found") {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      return reply.code(503).send({ error: "storage unavailable" });
    }

    if (outcome.notModified) {
      reply.header("Cache-Control", `private, max-age=${outcome.maxAge}`);
      if (outcome.etag) reply.header("ETag", outcome.etag);
      return reply.code(304).send();
    }

    // Set response headers
    reply.header("Content-Type", outcome.contentType);
    reply.header("Cache-Control", `private, max-age=${outcome.maxAge}`);
    reply.header("X-Content-Type-Options", "nosniff");
    if (outcome.etag) {
      reply.header("ETag", outcome.etag);
    }

    return reply.send(outcome.body);
  });
}
