/**
 * markdown-image.ts 单元测试
 *
 * 覆盖 extractObjectKeyFromMarkdownImage 函数：
 * 1. 从标准 Markdown 图片语法中正确提取站内 objectKey
 * 2. 有 alt text 的图片正确提取 objectKey
 * 3. 无 alt text 的图片正确提取 objectKey
 * 4. 外部 URL 返回 null（不处理）
 * 5. 非 Markdown 图片语法返回 null
 * 6. 带空格/换行的 content 能正确处理（trim）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractObjectKeyFromMarkdownImage } from "../lib/markdown-image.ts";

// ─── 正常提取 ────────────────────────────────────────────────────────────

test("extractObjectKeyFromMarkdownImage: 标准 Markdown 图片 → 提取 objectKey", () => {
  const content = "![架构图](/api/uploads/ws-123/notes/note-456/abc-def.png)";
  assert.equal(
    extractObjectKeyFromMarkdownImage(content),
    "ws-123/notes/note-456/abc-def.png",
  );
});

test("extractObjectKeyFromMarkdownImage: 有 alt text 的图片 → 提取 objectKey", () => {
  const content = "![数据流程图](/api/uploads/ws/notes/n/uuid.webp)";
  assert.equal(
    extractObjectKeyFromMarkdownImage(content),
    "ws/notes/n/uuid.webp",
  );
});

test("extractObjectKeyFromMarkdownImage: 空 alt text 的图片 → 提取 objectKey", () => {
  const content = "![](/api/uploads/ws/notes/n/uuid.jpg)";
  assert.equal(
    extractObjectKeyFromMarkdownImage(content),
    "ws/notes/n/uuid.jpg",
  );
});

test("extractObjectKeyFromMarkdownImage: 带空格的 alt text → 提取 objectKey", () => {
  const content = "![系统 架构 图](/api/uploads/w/n/u.png)";
  assert.equal(extractObjectKeyFromMarkdownImage(content), "w/n/u.png");
});

// ─── 外部 URL ────────────────────────────────────────────────────────────

test("extractObjectKeyFromMarkdownImage: 外部 HTTPS URL → 返回 null", () => {
  const content = "![外部图片](https://example.com/image.png)";
  assert.equal(extractObjectKeyFromMarkdownImage(content), null);
});

test("extractObjectKeyFromMarkdownImage: 非 /api/uploads/ 前缀的站内路径 → 返回 null", () => {
  const content = "![](/images/local.png)";
  assert.equal(extractObjectKeyFromMarkdownImage(content), null);
});

// ─── 非图片语法 ──────────────────────────────────────────────────────────

test("extractObjectKeyFromMarkdownImage: 普通文本 → 返回 null", () => {
  assert.equal(extractObjectKeyFromMarkdownImage("这是一段普通文本"), null);
});

test("extractObjectKeyFromMarkdownImage: 空字符串 → 返回 null", () => {
  assert.equal(extractObjectKeyFromMarkdownImage(""), null);
});

test("extractObjectKeyFromMarkdownImage: 链接语法（非图片）→ 返回 null", () => {
  const content = "[链接文字](/api/uploads/some/path)";
  assert.equal(extractObjectKeyFromMarkdownImage(content), null);
});

// ─── 边界情况 ────────────────────────────────────────────────────────────

test("extractObjectKeyFromMarkdownImage: 带前后空白的 content → 正确提取", () => {
  const content = "  ![图](/api/uploads/w/n/u.png)  \n";
  assert.equal(extractObjectKeyFromMarkdownImage(content), "w/n/u.png");
});

test("extractObjectKeyFromMarkdownImage: URL 中含特殊字符 → 正确提取", () => {
  const content = "![](/api/uploads/ws-id/notes/note-id/abc-123_v2.png)";
  assert.equal(
    extractObjectKeyFromMarkdownImage(content),
    "ws-id/notes/note-id/abc-123_v2.png",
  );
});

test("extractObjectKeyFromMarkdownImage: 多行 content（图片不在第一行）→ 返回 null", () => {
  // 函数只匹配以 ![ 开头的行（trim 后）
  const content = "一些文本\n![图](/api/uploads/w/n/u.png)";
  assert.equal(extractObjectKeyFromMarkdownImage(content), null);
});
