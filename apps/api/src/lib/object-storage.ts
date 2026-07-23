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
} from "@aws-sdk/client-s3";
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
let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    const endpoint = process.env.STORAGE_ENDPOINT ?? "http://minio:9000";
    const region = process.env.S3_REGION ?? "us-east-1";
    const accessKeyId = getRequiredEnv("MINIO_ROOT_USER");
    const secretAccessKey = getRequiredEnv("MINIO_ROOT_PASSWORD");
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
 * Used by the readiness check to determine if upload endpoints should be available.
 */
export function isStorageConfigured(): boolean {
  return Boolean(process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD);
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
 */
export async function getObject(objectKey: string): Promise<DownloadResult> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  const result = await getClient().send(command);
  const body = Buffer.from(await result.Body!.transformToByteArray());
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
  } catch {
    return null;
  }
}

/**
 * Delete a file from object storage.
 * Used for note deletion cleanup and old avatar cleanup.
 */
export async function deleteObject(objectKey: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  await getClient().send(command);
  logger.debug({ objectKey }, "object deleted from storage");
}
