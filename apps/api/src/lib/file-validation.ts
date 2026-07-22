/**
 * 校验文件头 magic bytes 与声明的 MIME type 一致，防止文件类型伪装。
 * 浏览器发送的 mimetype 可被任意修改，必须独立验证。
 */
export function validateImageMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 4) return false;
  switch (mimeType) {
    case "image/png":
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "image/jpeg":
      // JPEG: FF D8 FF
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/gif":
      // GIF: 47 49 46 38 (GIF8)
      return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
    case "image/webp":
      // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 (RIFF....WEBP)
      return buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    default:
      return false;
  }
}

/**
 * Allowed image MIME types for upload.
 * SVG is NOT included — SVG can embed <script> tags causing XSS.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * Get file extension from MIME type.
 */
export function extFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}
