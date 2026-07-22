/**
 * 并发上传占位符替换单元测试
 *
 * 测试 NoteEditor 中的并发上传占位符替换逻辑：
 * 1. 单个上传：占位符被正确替换为实际 URL
 * 2. 多个并发上传：各自占位符互不干扰（唯一 ID 确保不冲突）
 * 3. 上传失败：占位符被移除
 * 4. 占位符唯一性：crypto.randomUUID() 生成不同 ID
 *
 * 此测试复现 NoteEditor.tsx 中的占位符逻辑，验证唯一占位符不冲突。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";

// ─── 复现 NoteEditor.tsx 中的占位符逻辑 ──────────────────────────────────

/**
 * 模拟 NoteEditor.uploadAndInsertImage 中的占位符生成逻辑。
 * 占位符格式：![上传中…](uploading:{uuid})
 */
function makePlaceholder(): string {
  const uploadId = crypto.randomUUID();
  return `![上传中…](uploading:${uploadId})`;
}

/**
 * 模拟上传成功后的替换逻辑。
 * setSource((prev) => prev.replace(placeholder, markdown));
 */
function replacePlaceholder(source: string, placeholder: string, url: string): string {
  const markdown = `![](${url})`;
  return source.replace(placeholder, markdown);
}

/**
 * 模拟上传失败后的替换逻辑。
 * setSource((prev) => prev.replace(placeholder, ""));
 */
function removePlaceholder(source: string, placeholder: string): string {
  return source.replace(placeholder, "");
}

// ─── 单个上传 ────────────────────────────────────────────────────────────

test("单个上传：占位符被正确替换为实际 URL", () => {
  const placeholder = makePlaceholder();
  const source = `一些文字\n${placeholder}\n更多文字`;
  const url = "/api/uploads/ws/notes/n/abc.png";
  const result = replacePlaceholder(source, placeholder, url);
  assert.ok(result.includes(`![](${url})`));
  assert.ok(!result.includes("uploading:"));
  assert.ok(result.includes("一些文字"));
  assert.ok(result.includes("更多文字"));
});

test("单个上传：上传失败时占位符被移除", () => {
  const placeholder = makePlaceholder();
  const source = `文字前\n${placeholder}\n文字后`;
  const result = removePlaceholder(source, placeholder);
  assert.ok(!result.includes("uploading:"));
  assert.ok(!result.includes("上传中"));
  assert.ok(result.includes("文字前"));
  assert.ok(result.includes("文字后"));
});

// ─── 多个并发上传 ────────────────────────────────────────────────────────

test("并发上传：两个占位符互不干扰", () => {
  const ph1 = makePlaceholder();
  const ph2 = makePlaceholder();
  // 确保两个占位符不同
  assert.notEqual(ph1, ph2);

  const source = `文字\n${ph1}\n中间\n${ph2}\n结尾`;
  // 模拟 ph1 先上传完成
  const url1 = "/api/uploads/ws/notes/n/img1.png";
  const step1 = replacePlaceholder(source, ph1, url1);
  // ph2 仍在
  assert.ok(step1.includes(ph2));
  assert.ok(step1.includes(`![](${url1})`));
  assert.ok(!step1.includes("uploading:" + ph1.match(/uploading:([a-f0-9-]+)/)?.[1]));

  // ph2 上传完成
  const url2 = "/api/uploads/ws/notes/n/img2.png";
  const step2 = replacePlaceholder(step1, ph2, url2);
  assert.ok(step2.includes(`![](${url1})`));
  assert.ok(step2.includes(`![](${url2})`));
  assert.ok(!step2.includes("uploading:"));
});

test("并发上传：三个占位符乱序完成也能正确替换", () => {
  const ph1 = makePlaceholder();
  const ph2 = makePlaceholder();
  const ph3 = makePlaceholder();
  const source = `${ph1}\n${ph2}\n${ph3}`;

  // 乱序完成：ph2 → ph3 → ph1
  let current = source;
  current = replacePlaceholder(current, ph2, "/api/uploads/u2.png");
  current = replacePlaceholder(current, ph3, "/api/uploads/u3.png");
  current = replacePlaceholder(current, ph1, "/api/uploads/u1.png");

  assert.ok(current.includes("/api/uploads/u1.png"));
  assert.ok(current.includes("/api/uploads/u2.png"));
  assert.ok(current.includes("/api/uploads/u3.png"));
  assert.ok(!current.includes("uploading:"));
});

test("并发上传：一个失败一个成功，互不影响", () => {
  const ph1 = makePlaceholder();
  const ph2 = makePlaceholder();
  const source = `${ph1}\n${ph2}`;

  // ph1 失败 → 移除
  let current = removePlaceholder(source, ph1);
  // ph2 成功 → 替换
  current = replacePlaceholder(current, ph2, "/api/uploads/ws/n/ok.png");

  assert.ok(current.includes("/api/uploads/ws/n/ok.png"));
  assert.ok(!current.includes("uploading:"));
  assert.ok(!current.includes("上传中"));
});

// ─── 占位符唯一性 ───────────────────────────────────────────────────────

test("占位符唯一性：连续生成 100 个占位符全部不同", () => {
  const placeholders = new Set<string>();
  for (let i = 0; i < 100; i++) {
    placeholders.add(makePlaceholder());
  }
  assert.equal(placeholders.size, 100);
});

test("占位符格式：包含 uploading: 前缀和 UUID", () => {
  const placeholder = makePlaceholder();
  assert.ok(placeholder.startsWith("![上传中…](uploading:"));
  // UUID v4 格式：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuid = placeholder.match(/uploading:([a-f0-9-]+)/)?.[1];
  assert.ok(uuid);
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid));
});

// ─── 边界情况 ───────────────────────────────────────────────────────────

test("占位符替换：占位符不存在于 source 中时不改变 source", () => {
  const source = "一些文字";
  const ph = makePlaceholder();
  const result = replacePlaceholder(source, ph, "/api/uploads/u.png");
  assert.equal(result, source);
});

test("占位符替换：source 中有相同前缀文本时不误替换", () => {
  // 确保只有完整占位符匹配才会被替换
  const ph = makePlaceholder();
  const source = `上传中…${ph}上传中…`;
  const result = replacePlaceholder(source, ph, "/api/uploads/u.png");
  assert.ok(result.startsWith("上传中…"));
  assert.ok(result.endsWith("上传中…"));
  assert.ok(result.includes("![](/api/uploads/u.png)"));
});
