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

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read dimensions directly from a validated PNG/JPEG/GIF/WebP header. This is
 * deliberately metadata-only: uploads do not decode attacker-controlled image
 * pixels in the API process.
 */
export function readImageDimensions(buf: Buffer, mimeType: string): ImageDimensions | null {
  let dimensions: ImageDimensions | null = null;
  if (mimeType === "image/png" && buf.length >= 24) {
    dimensions = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } else if (mimeType === "image/gif" && buf.length >= 10) {
    dimensions = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  } else if (mimeType === "image/jpeg") {
    dimensions = readJpegDimensions(buf);
  } else if (mimeType === "image/webp") {
    dimensions = readWebpDimensions(buf);
  }
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  return dimensions;
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < buf.length) {
    while (offset < buf.length && buf[offset] !== 0xff) offset += 1;
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) return null;
    const marker = buf[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: buf.readUInt16BE(offset + 3),
        width: buf.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readUInt24LE(buf: Buffer, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function readWebpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return { width: readUInt24LE(buf, 24) + 1, height: readUInt24LE(buf, 27) + 1 };
  }
  if (kind === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (kind === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}
