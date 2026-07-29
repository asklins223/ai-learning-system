/**
 * Worker 端 MinIO/S3 对象存储封装。
 *
 * 用于 URL 来源解析时下载页面内嵌图片并上传到 MinIO，
 * 使图片可通过 /api/uploads/{objectKey} 访问。
 */
import { GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "./logger.ts";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    const endpoint = process.env.STORAGE_ENDPOINT ?? "http://minio:9000";
    const region = process.env.S3_REGION ?? "us-east-1";
    const accessKeyId = process.env.MINIO_ROOT_USER?.trim();
    const secretAccessKey = process.env.MINIO_ROOT_PASSWORD?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("STORAGE not configured: MINIO_ROOT_USER/MINIO_ROOT_PASSWORD missing");
    }
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
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
  return Boolean(process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD);
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

/** Download a workspace-owned immutable image asset for OCR/vision analysis. */
export async function downloadImageAsset(objectKey: string): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const result = await getClient().send(new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  }));
  if (!result.Body) throw new Error("image asset object has no body");
  return {
    body: Buffer.from(await result.Body.transformToByteArray()),
    contentType: result.ContentType ?? "application/octet-stream",
  };
}
