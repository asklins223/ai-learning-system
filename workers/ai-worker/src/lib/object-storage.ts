/**
 * Worker 端 MinIO/S3 对象存储封装。
 *
 * 用于 URL 来源解析时下载页面内嵌图片并上传到 MinIO，
 * 使图片可通过 /api/uploads/{objectKey} 访问。
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { logger } from "./logger.ts";

// 2026-08-12（存储面审计，与 API 侧对齐）：
// - 独立凭证优先（MINIO_ACCESS_KEY/SECRET_KEY，最小权限），回退 root；
// - 请求超时（S3Client 默认无 requestTimeout，MinIO 半挂时请求无限挂起）；
// - 初始化失败缓存（此前 env 缺失时每次调用重复构造报错）。
let client: S3Client | null = null;
let clientInitError: Error | null = null;

function storageCredentials(): { accessKeyId: string; secretAccessKey: string } {
  // 2026-08-12 review：`||` 而非 `??`——空串按未配置处理，回退 root 凭证
  // （与 isStorageConfigured 的 truthy 语义一致）。
  const accessKeyId = process.env.MINIO_ACCESS_KEY?.trim() || process.env.MINIO_ROOT_USER?.trim();
  const secretAccessKey = process.env.MINIO_SECRET_KEY?.trim() || process.env.MINIO_ROOT_PASSWORD?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("STORAGE not configured: MINIO_ACCESS_KEY/MINIO_SECRET_KEY (or MINIO_ROOT_USER/MINIO_ROOT_PASSWORD) missing");
  }
  return { accessKeyId, secretAccessKey };
}

function getClient(): S3Client {
  if (client) return client;
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
        requestTimeout: 120_000,
      }),
    });
  } catch (err) {
    clientInitError = err instanceof Error ? err : new Error(String(err));
    throw clientInitError;
  }
  return client;
}

function getBucket(): string {
  return process.env.S3_BUCKET ?? "ailearn-workspaces";
}

/**
 * Check if storage is configured (all required env vars present).
 */
export function isStorageConfigured(): boolean {
  return Boolean(
    (process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY)
    || (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD),
  );
}

const EXT_FROM_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Upload a source image to object storage.
 * Object key: {workspaceId}/sources/{sourceId}/{uuid}.{ext}
 * Returns the object key (consumable via /api/uploads/{objectKey}).
 */
export async function uploadSourceImage(
  workspaceId: string,
  sourceId: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const ext = EXT_FROM_MIME[contentType] ?? "bin";
  const uuid = crypto.randomUUID();
  const objectKey = `${workspaceId}/sources/${sourceId}/${uuid}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    Body: body,
    ContentType: contentType,
  });
  await getClient().send(command);
  logger.debug({ objectKey, size: body.length }, "source image uploaded to storage");
  return objectKey;
}
