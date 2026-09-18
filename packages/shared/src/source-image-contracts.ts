import { z } from "zod";

/**
 * 站内图片对象读取合同（`source.image.get`）。
 *
 * 来源解析会把网页内嵌图片下载后写进对象存储，正文引用随之被改写成
 * `/api/uploads/{objectKey}`。桌面渲染层跑在 `ailearn-app://` 下：相对路径会
 * 落到应用包内（404），而外链地址又会被渲染层 CSP（`img-src 'self' data: blob:`）
 * 拦掉。因此站内图片由 main 带 Bearer 取回原始字节，投影为本模块的 strict
 * result；渲染层只拿到 mime 与 base64，自己转成 blob URL 交给 `<img>`。
 *
 * 渲染层永远不持有会话令牌，也不直接够到 API 源——这也是本项目既有语音通道
 * （`companion.voice.speak`）的处理方式。
 */

/** main 侧图片硬上限（字节）：与 worker 侧 `IMAGE_MAX_BYTES` 对齐。 */
export const SOURCE_IMAGE_MAX_BYTES = 5_000_000;

/**
 * 站内图片在**内容**里出现的前缀（worker 改写后的 markdown 引用、上传回执的
 * `url`）。这是 Web 端的代理约定：`/api/*` 由 Web 边缘层转发到 API 根。
 *
 * 它不是 API 路由本身——API 的下载路由注册在 `GET /uploads/*`（无前缀），桌面
 * 网关取字节时必须剥掉 `/api`，见 `desktop-gateway.ts` 的 `getSourceImage`。
 */
export const SOURCE_IMAGE_UPLOAD_PREFIX = "/api/uploads/";

/** 与 API 下载路由接受的对象键形状一致：{workspaceId}/{notes|sources}/{ownerId}/{uuid}.{ext}。 */
const SOURCE_IMAGE_OBJECT_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:notes|sources)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg|gif|webp)$/;

/** worker 只按这四种 content-type 落盘（见 `EXT_FROM_MIME`），据此收窄通道。 */
export const SOURCE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const sourceImageGetRequestV1Schema = z.strictObject({
  version: z.literal(1),
  objectKey: z.string().min(1).max(512).regex(SOURCE_IMAGE_OBJECT_KEY_PATTERN),
});
export type SourceImageGetRequestV1 = z.infer<typeof sourceImageGetRequestV1Schema>;

export const sourceImageGetResultV1Schema = z.strictObject({
  version: z.literal(1),
  mimeType: z.enum(SOURCE_IMAGE_MIME_TYPES),
  imageBase64: z.string().min(1),
  byteLength: z.number().int().positive().max(SOURCE_IMAGE_MAX_BYTES),
});
export type SourceImageGetResultV1 = z.infer<typeof sourceImageGetResultV1Schema>;

/**
 * 从一段 URL 里取出站内 objectKey；外链、`data:` 与形状不符的一律返回 null。
 *
 * 渲染层用它决定"这张图要不要走通道"，main 侧再用同一份正则复核，所以两边
 * 不可能对同一串地址得出不同结论。
 */
export function sourceImageObjectKeyFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(SOURCE_IMAGE_UPLOAD_PREFIX)) return null;
  const objectKey = trimmed.slice(SOURCE_IMAGE_UPLOAD_PREFIX.length);
  return SOURCE_IMAGE_OBJECT_KEY_PATTERN.test(objectKey) ? objectKey : null;
}
