import { z } from "zod";

import { SOURCE_IMAGE_MAX_BYTES, SOURCE_IMAGE_MIME_TYPES, SOURCE_IMAGE_UPLOAD_PREFIX } from "./source-image-contracts.ts";

/**
 * 笔记图片上传合同（`note.image.upload`）。
 *
 * Web 端的笔记编辑器一直是「图片先进文件夹/剪贴板 → 上传到对象存储 → 正文里
 * 留下 `/api/uploads/{objectKey}`」，桌面端此前只做了读取那一半：正文里的站内
 * 图片已经能经 `source.image.get` 取回字节（见 `source-image-contracts.ts`），
 * 但没有任何通道能把一张图送上去。本模块补上写入那一半。
 *
 * 渲染层永远不持有会话令牌，也不直接够到 API 源：它把文件字节交给 main，
 * main 以 multipart 形式 POST `/uploads/images`，再把服务端确认的站内地址投影
 * 回渲染层。校验规则（类型、体积）在这里收窄一次，main 侧按同一份 schema 复核，
 * 服务端仍保留它自己的 magic bytes / 尺寸 / 解码炸弹防线。
 */

/**
 * 上传上限。
 *
 * 刻意等于读取通道的 `SOURCE_IMAGE_MAX_BYTES`：如果允许上传比读取上限更大的
 * 图，用户会得到一次成功的上传和一页永远渲染不出来的正文——那是两个合同之间
 * 的自相矛盾，不是用户的错误。要放宽就同时放宽两侧。
 */
export const NOTE_IMAGE_UPLOAD_MAX_BYTES = SOURCE_IMAGE_MAX_BYTES;

/**
 * 可上传的图片类型。与 API 的 `ALLOWED_IMAGE_TYPES` 一致：四种光栅图，
 * 不含 SVG（SVG 可内嵌 `<script>`，渲染层会把它当文档执行）。
 */
export const NOTE_IMAGE_UPLOAD_MIME_TYPES = SOURCE_IMAGE_MIME_TYPES;

/** base64 展开后的上界：4/3 膨胀 + 换行余量。 */
const BASE64_MAX_LENGTH = Math.ceil(NOTE_IMAGE_UPLOAD_MAX_BYTES / 3) * 4 + 8;

export const noteImageUploadRequestV1Schema = z.strictObject({
  version: z.literal(1),
  /** 仅用于让消息里能报出文件名，服务端不落盘这个名字。 */
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(NOTE_IMAGE_UPLOAD_MIME_TYPES),
  bytesBase64: z.string().min(1).max(BASE64_MAX_LENGTH),
});
export type NoteImageUploadRequestV1 = z.infer<typeof noteImageUploadRequestV1Schema>;

export const noteImageUploadResultV1Schema = z.strictObject({
  version: z.literal(1),
  /** 服务端确认的站内地址；正文里写入的就是它。 */
  url: z.string().min(1).max(512).startsWith(SOURCE_IMAGE_UPLOAD_PREFIX),
  byteLength: z.number().int().positive().max(NOTE_IMAGE_UPLOAD_MAX_BYTES),
  mimeType: z.enum(NOTE_IMAGE_UPLOAD_MIME_TYPES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type NoteImageUploadResultV1 = z.infer<typeof noteImageUploadResultV1Schema>;

/**
 * 一次上传失败时渲染层该说的话。服务端把原因折叠成状态码，这里只保留用户
 * 能据此行动的那几种；其余一律回落到一句可重试的说明。
 */
export function noteImageUploadFailureMessage(input: {
  readonly httpStatus?: number;
  readonly fileName?: string;
}): string {
  if (input.httpStatus === 413) return "图片超过 5MB，请压缩后重试";
  if (input.httpStatus === 422 || input.httpStatus === 400) return "这张图片的格式或尺寸不受支持";
  if (input.httpStatus === 429) return "上传太频繁，稍后再试一次";
  return "图片上传失败，请重试";
}
