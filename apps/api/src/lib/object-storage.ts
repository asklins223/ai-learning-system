/**
 * MinIO/S3 兼容对象存储封装。
 *
 * 复用已有的 MINIO_ROOT_USER / MINIO_ROOT_PASSWORD / S3_BUCKET 环境变量，
 * 仅新增 STORAGE_ENDPOINT 配置端点地址。
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { logger } from "./logger.ts";

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Lazy initialization — env vars are read on first actual use, not at module
// load time. This allows tests that transitively import this module (via
// identity/service.ts) to run without MINIO_* env vars set.
//
// QUAL-62 修复：原代码的懒初始化无并发保护。在 Node.js 单线程模型中，
// 虽然 S3Client 构造是同步的，但如果 getRequiredEnv 抛出异常后 client
// 仍为 null，后续重试可能因为状态不一致而失败。
// 改为使用 Promise 缓存模式，确保只构造一次。
//
// 2026-08-12（存储面审计）：
// - 独立凭证支持：MINIO_ACCESS_KEY/MINIO_SECRET_KEY 优先（最小权限原则，
//   建议用仅限目标 bucket 的 access key），回退 MINIO_ROOT_USER/PASSWORD。
// - 请求超时：S3Client 默认无 requestTimeout，MinIO 半挂时请求无限挂起
//   （50MB 内存 buffer 无法释放）。加 NodeHttpHandler 连接 10s/请求超时
//   （STORAGE_REQUEST_TIMEOUT_MS 可配，默认 120s）。
let client: S3Client | null = null;
let clientInitError: Error | null = null;

function storageCredentials(): { accessKeyId: string; secretAccessKey: string } {
  // 2026-08-12 review：`||` 而非 `??`——MINIO_ACCESS_KEY="" 空串时回退 root，
  // 与 isStorageConfigured 的 truthy 语义一致（空串按未配置处理）。
  const accessKeyId = process.env.MINIO_ACCESS_KEY?.trim()
    || getRequiredEnv("MINIO_ROOT_USER");
  const secretAccessKey = process.env.MINIO_SECRET_KEY?.trim()
    || getRequiredEnv("MINIO_ROOT_PASSWORD");
  return { accessKeyId, secretAccessKey };
}

function storageRequestTimeoutMs(): number {
  const raw = process.env.STORAGE_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return 120_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? value : 120_000;
}

function getClient(): S3Client {
  // 如果已有客户端实例，直接返回
  if (client) return client;
  // 如果之前初始化失败，直接抛出缓存的错误
  // （避免每次请求都尝试重新构造，产生重复的错误日志）
  if (clientInitError) throw clientInitError;

  try {
    const endpoint = process.env.STORAGE_ENDPOINT ?? "http://minio:9000";
    const region = process.env.S3_REGION ?? "us-east-1";
    const { accessKeyId, secretAccessKey } = storageCredentials();
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10_000,
        requestTimeout: storageRequestTimeoutMs(),
      }),
    });
    logger.info({ endpoint, region }, "S3 client initialized");
    return client;
  } catch (err) {
    clientInitError = err instanceof Error ? err : new Error(String(err));
    throw clientInitError;
  }
}

function getBucket(): string {
  return process.env.S3_BUCKET ?? "ailearn-workspaces";
}

/**
 * Check if storage is configured (all required env vars present).
 * Used by the readiness check to determine if upload endpoints should be available.
 */
export function isStorageConfigured(): boolean {
  // 2026-08-12：独立凭证与 root 凭证任一齐全即视为已配置
  return Boolean(
    (process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY)
    || (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD),
  );
}

export interface UploadResult {
  etag: string;
}

/**
 * Upload a file to object storage.
 */
export async function uploadObject(
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<UploadResult> {
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    Body: body,
    ContentType: contentType,
  });
  const result = await getClient().send(command);
  return { etag: result.ETag ?? "" };
}

export interface DownloadResult {
  body: Buffer;
  contentType: string;
  etag: string;
}

/**
 * Download a file from object storage.
 *
 * PERF-58 修复：添加最大下载大小限制（50MB），防止恶意或误操作
 * 下载超大文件导致 API 进程 OOM。对于图片等合法用途，50MB 足够；
 * 如需下载更大文件，应使用流式处理而非全量加载到内存。
 *
 * SEC-30 修复：校验 objectKey 不包含路径遍历字符（..），
 * 防止通过构造恶意 objectKey 访问其他 workspace 的对象。
 */
const MAX_DOWNLOAD_SIZE_BYTES = 50 * 1024 * 1024;

export async function getObject(objectKey: string): Promise<DownloadResult> {
  // SEC-30 修复：拒绝包含路径遍历字符的 objectKey
  if (objectKey.includes("..")) {
    throw new Error(`invalid object key: path traversal detected in "${objectKey}"`);
  }
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  const result = await getClient().send(command);

  // 检查 ContentLength，如果超过限制则提前拒绝
  const contentLength = result.ContentLength ?? 0;
  if (contentLength > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `object size ${contentLength} bytes exceeds maximum download size ${MAX_DOWNLOAD_SIZE_BYTES} bytes`,
    );
  }

  const body = Buffer.from(await result.Body!.transformToByteArray());

  // 二次检查实际 buffer 大小（ContentLength 可能缺失或不准确）
  if (body.length > MAX_DOWNLOAD_SIZE_BYTES) {
    throw new Error(
      `downloaded buffer ${body.length} bytes exceeds maximum download size ${MAX_DOWNLOAD_SIZE_BYTES} bytes`,
    );
  }

  return {
    body,
    contentType: result.ContentType ?? "application/octet-stream",
    etag: result.ETag ?? "",
  };
}

/**
 * Get object metadata (for ETag/conditional requests).
 */
export async function headObject(
  objectKey: string,
): Promise<{ etag: string | undefined; contentType: string | undefined; contentLength: number | undefined } | null> {
  // 2026-08-12（存储面审计）：与 getObject 同款路径遍历防御（纵深——所有
  // 调用方当前已在路由层校验，新增调用方不易踩坑）。
  if (objectKey.includes("..")) {
    throw new Error(`invalid object key: path traversal detected in "${objectKey}"`);
  }
  const command = new HeadObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  try {
    const result = await getClient().send(command);
    return {
      etag: result.ETag,
      contentType: result.ContentType,
      contentLength: result.ContentLength,
    };
  } catch (err) {
    // 2026-08-12（存储面审计）：只把“对象不存在”折叠为 null；
    // S3 服务端故障/网络错误向上抛，路由层可区分 404 与 503（此前
    // 一律吞成 null，MinIO 故障不可观测）。403 保持折叠（防存在性 oracle）。
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 403 || status === 404 || err instanceof NoSuchKey) {
      return null;
    }
    throw err;
  }
}

/**
 * Delete a file from object storage.
 * Used for note deletion cleanup and old avatar cleanup.
 */
export async function deleteObject(objectKey: string): Promise<void> {
  // SEC 修复（2026-09 后端审查）：与 getObject/headObject 同款路径遍历防御。
  // 此前 deleteObject 无任何校验，而调用方（note 级联清理）的键可能来自客户端
  // 笔记正文，纵深防御必须在此处也拦住 `..`。
  if (objectKey.includes("..")) {
    throw new Error(`invalid object key: path traversal detected in "${objectKey}"`);
  }
  const command = new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  await getClient().send(command);
  logger.debug({ objectKey }, "object deleted from storage");
}
