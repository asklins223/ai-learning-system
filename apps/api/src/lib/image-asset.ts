/**
 * 图片对象下载/校验/预注册工具（PERF 专项遗留修复）。
 *
 * 背景：ensureImageAssetsForBlocks（note/service.ts）在调用方事务内做
 * MinIO 下载（网络 IO 占持事务连接）——批量导入 100 篇时每篇内嵌事务
 * 都被下载阻塞。修复：把下载/校验抽成纯 IO helper，并提供事务外的
 * 批量预注册入口（preRegisterImageAssetsForImport），导入主事务之前
 * 完成注册，事务内仅剩 missingKeys 查询。
 *
 * 约束：本模块使用全局 db（drizzle client）做预注册 INSERT——note/service.ts
 * 受"内容服务禁全局 db"契约约束，因此此入口放在 lib 层，由 import 路由调用。
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { noteImageAssets } from "../db/schema/note.ts";
import { getObject } from "./object-storage.ts";
import { validateImageMagicBytes, readImageDimensions } from "./file-validation.ts";
import { logger } from "./logger.ts";

const MAX_IMAGE_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB

export interface ValidatedImageAsset {
  objectKey: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
}

/**
 * 下载并校验单个图片对象（MinIO 网络 IO + magic bytes + 尺寸读取）。
 * 纯 IO 无 DB 副作用，供事务内兜底与事务外批量预注册共用——
 * 保证同一张图在同一时刻最多一份 Buffer 驻留内存（BUG-01 约束）。
 */
export async function downloadAndValidateImageAsset(objectKey: string): Promise<ValidatedImageAsset | null> {
  let body: Buffer | null = null;
  try {
    const result = await getObject(objectKey);
    body = result.body;
    // 防御：跳过异常大图片，避免单张图片耗尽内存
    if (body.length > MAX_IMAGE_BUFFER_BYTES) {
      logger.warn(
        { objectKey, byteSize: body.length, maxAllowed: MAX_IMAGE_BUFFER_BYTES },
        "source-imported image exceeds size limit, skipping asset registration",
      );
      return null;
    }
    const contentType = result.contentType;
    if (!validateImageMagicBytes(body, contentType)) {
      logger.warn({ objectKey, contentType }, "source-imported image failed magic bytes validation");
      return null;
    }
    const dimensions = readImageDimensions(body, contentType);
    if (!dimensions) {
      logger.warn({ objectKey, contentType }, "source-imported image dimensions could not be read");
      return null;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const byteSize = body.length;
    // 在返回前释放 Buffer 引用，让 V8 可尽早回收
    body = null;
    return {
      objectKey,
      sha256,
      mimeType: contentType,
      byteSize,
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch (err) {
    logger.warn({ objectKey, err }, "failed to download/validate source-imported image asset");
    return null;
  }
}

/**
 * 批量导入场景的图片资产预注册：在**业务事务外**完成 MinIO 下载/校验/入库，
 * 让事务内 ensureImageAssetsForBlocks 退化为纯查询（missingKeys=0），
 * 消灭"网络 IO 占持事务连接"问题（PERF 专项遗留）。
 * 幂等：ON CONFLICT DO NOTHING；预注册成功但后续导入失败的孤儿 asset 行
 * 会被下一次导入复用，无功能影响。
 */
export async function preRegisterImageAssetsForImport(
  workspaceId: string,
  objectKeys: string[],
  userId: string,
): Promise<void> {
  const rows: Array<{
    workspaceId: string;
    uploadedForNoteId: null;
    objectKey: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
    width: number;
    height: number;
    status: "ready";
    createdBy: string;
  }> = [];
  for (const objectKey of objectKeys) {
    const validated = await downloadAndValidateImageAsset(objectKey);
    if (!validated) {
      continue;
    }
    rows.push({
      workspaceId,
      uploadedForNoteId: null,
      ...validated,
      status: "ready",
      createdBy: userId,
    });
  }
  if (rows.length === 0) {
    return;
  }
  // note_image_assets FORCE RLS（0046）：ailearn_api 无 BYPASSRLS，INSERT 必须
  // 带 workspace 上下文——包一个短事务设置 app.workspace_id（与
  // withWorkspaceTransaction 同语义；下载/校验已在前方事务外完成）。
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.insert(noteImageAssets).values(rows).onConflictDoNothing();
  });
}
