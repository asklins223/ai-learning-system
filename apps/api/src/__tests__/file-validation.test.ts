/**
 * file-validation.ts 单元测试
 *
 * 覆盖 validateImageMagicBytes 函数：
 * 1. 正确识别 PNG / JPEG / GIF / WebP 文件头
 * 2. 拒绝文件头与声明 MIME type 不匹配的伪装文件
 * 3. 拒绝过短的 buffer（< 4 bytes）
 * 4. 拒绝不支持的 MIME type（如 SVG）
 * 5. extFromMimeType 正确返回扩展名
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateImageMagicBytes,
  ALLOWED_IMAGE_TYPES,
  extFromMimeType,
} from "../lib/file-validation.ts";

// ─── 真实文件头 magic bytes ──────────────────────────────────────────────

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // file size (placeholder)
  0x57, 0x45, 0x42, 0x50, // WEBP
]);

// ─── validateImageMagicBytes: 正确识别 ───────────────────────────────────

test("validateImageMagicBytes: 正确识别 PNG", () => {
  assert.equal(validateImageMagicBytes(PNG_HEADER, "image/png"), true);
});

test("validateImageMagicBytes: 正确识别 JPEG", () => {
  assert.equal(validateImageMagicBytes(JPEG_HEADER, "image/jpeg"), true);
});

test("validateImageMagicBytes: 正确识别 GIF", () => {
  assert.equal(validateImageMagicBytes(GIF_HEADER, "image/gif"), true);
});

test("validateImageMagicBytes: 正确识别 WebP（需 ≥ 12 bytes）", () => {
  assert.equal(validateImageMagicBytes(WEBP_HEADER, "image/webp"), true);
});

// ─── validateImageMagicBytes: 伪装文件检测 ───────────────────────────────

test("validateImageMagicBytes: PNG 声明但实际是 JPEG → 拒绝", () => {
  assert.equal(validateImageMagicBytes(JPEG_HEADER, "image/png"), false);
});

test("validateImageMagicBytes: JPEG 声明但实际是 PNG → 拒绝", () => {
  assert.equal(validateImageMagicBytes(PNG_HEADER, "image/jpeg"), false);
});

test("validateImageMagicBytes: WebP 声明但 buffer 不足 12 bytes → 拒绝", () => {
  const shortWebp = WEBP_HEADER.subarray(0, 8); // 只有 RIFF + size，没有 WEBP
  assert.equal(validateImageMagicBytes(shortWebp, "image/webp"), false);
});

test("validateImageMagicBytes: 可执行文件伪装为 PNG → 拒绝", () => {
  // MZ header (Windows PE executable)
  const exeHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  assert.equal(validateImageMagicBytes(exeHeader, "image/png"), false);
});

test("validateImageMagicBytes: HTML 伪装为 JPEG → 拒绝", () => {
  const htmlHeader = Buffer.from("<!DOCTYPE html>");
  assert.equal(validateImageMagicBytes(htmlHeader, "image/jpeg"), false);
});

// ─── validateImageMagicBytes: 边界情况 ──────────────────────────────────

test("validateImageMagicBytes: buffer < 4 bytes → 拒绝", () => {
  assert.equal(validateImageMagicBytes(Buffer.from([0x89, 0x50]), "image/png"), false);
});

test("validateImageMagicBytes: buffer 恰好 4 bytes → PNG 通过", () => {
  assert.equal(validateImageMagicBytes(PNG_HEADER.subarray(0, 4), "image/png"), true);
});

test("validateImageMagicBytes: 不支持的 MIME type (SVG) → 拒绝", () => {
  const svgHeader = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\">");
  assert.equal(validateImageMagicBytes(svgHeader, "image/svg+xml"), false);
});

test("validateImageMagicBytes: 空 MIME type → 拒绝", () => {
  assert.equal(validateImageMagicBytes(PNG_HEADER, ""), false);
});

// ─── ALLOWED_IMAGE_TYPES 常量 ────────────────────────────────────────────

test("ALLOWED_IMAGE_TYPES 不包含 SVG", () => {
  assert.ok(!ALLOWED_IMAGE_TYPES.includes("image/svg+xml" as never));
});

test("ALLOWED_IMAGE_TYPES 包含 PNG/JPEG/GIF/WebP", () => {
  assert.deepEqual([...ALLOWED_IMAGE_TYPES], [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
});

// ─── extFromMimeType ─────────────────────────────────────────────────────

test("extFromMimeType: PNG → png", () => {
  assert.equal(extFromMimeType("image/png"), "png");
});

test("extFromMimeType: JPEG → jpg", () => {
  assert.equal(extFromMimeType("image/jpeg"), "jpg");
});

test("extFromMimeType: GIF → gif", () => {
  assert.equal(extFromMimeType("image/gif"), "gif");
});

test("extFromMimeType: WebP → webp", () => {
  assert.equal(extFromMimeType("image/webp"), "webp");
});

test("extFromMimeType: 不支持的类型 → bin", () => {
  assert.equal(extFromMimeType("image/svg+xml"), "bin");
  assert.equal(extFromMimeType("application/octet-stream"), "bin");
});
