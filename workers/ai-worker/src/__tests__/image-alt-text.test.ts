/**
 * AI alt text 提取逻辑单元测试
 *
 * 测试 runGenerateCard 中 image block → text block 的转换逻辑：
 * 1. 有 alt text 的图片 → 转为 paragraph，内容为「（图片：alt）」
 * 2. 无 alt text 的图片 → 被丢弃（返回 null）
 * 3. 混合图片和文本 block → 图片被转换/丢弃，文本 block 保留
 * 4. URL 不泄露到转换后的文本中
 *
 * 此测试复现 handlers/index.ts 中的过滤逻辑，确保正则和转换行为正确。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// ─── 复现 handlers/index.ts 中的 image block 过滤逻辑 ─────────────────────

interface InputBlock {
  ordinal: number;
  type: string;
  content: string;
}

interface OutputBlock {
  ordinal: number;
  type: string;
  content: string;
}

/**
 * 此函数复现 workers/ai-worker/src/handlers/index.ts 中
 * runGenerateCard 的 image block 过滤逻辑（约第 152-161 行）。
 * 如果 handler 中的逻辑被修改，此函数也需同步更新。
 */
function filterImageBlocks(blocks: InputBlock[]): OutputBlock[] {
  return blocks
    .map((b) => {
      if (b.type === "image") {
        const altMatch = /^!\[([^\]]*)\]\([^)]+\)/.exec(b.content);
        const alt = altMatch?.[1]?.trim();
        return alt
          ? { ordinal: b.ordinal, type: "paragraph" as const, content: `（图片：${alt}）` }
          : null;
      }
      return { ordinal: b.ordinal, type: b.type, content: b.content };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
}

// ─── 有 alt text ─────────────────────────────────────────────────────────

test("alt text 提取：有 alt text 的图片 → 转为 paragraph（图片：alt）", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![架构图](/api/uploads/ws/notes/n/abc.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "paragraph");
  assert.equal(result[0].content, "（图片：架构图）");
});

test("alt text 提取：带空格的 alt text → trim 后保留", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![  数据流程图  ](/api/uploads/ws/n/u.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "（图片：数据流程图）");
});

test("alt text 提取：alt text 中含特殊字符 → 保留", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![图-1: 系统架构](https://example.com/img.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "（图片：图-1: 系统架构）");
});

// ─── 无 alt text ─────────────────────────────────────────────────────────

test("alt text 提取：无 alt text 的图片 → 被丢弃", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![](/api/uploads/ws/n/u.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 0);
});

test("alt text 提取：空格 alt text → 被丢弃（trim 后为空）", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![   ](/api/uploads/ws/n/u.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 0);
});

test("alt text 提取：非 Markdown 图片格式的 image block → 被丢弃", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "just a plain text url" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 0);
});

// ─── 混合 block ─────────────────────────────────────────────────────────

test("alt text 提取：混合图片和文本 block → 图片转换/丢弃，文本保留", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "paragraph", content: "这是第一段文字" },
    { ordinal: 1, type: "image", content: "![架构图](/api/uploads/ws/n/a.png)" },
    { ordinal: 2, type: "image", content: "![](/api/uploads/ws/n/b.png)" },
    { ordinal: 3, type: "heading", content: "标题" },
    { ordinal: 4, type: "image", content: "![截图](/api/uploads/ws/n/c.png)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 4); // 2 个图片被丢弃，3 个文本 + 1 个图片转文本 = 4
  assert.equal(result[0].content, "这是第一段文字");
  assert.equal(result[1].content, "（图片：架构图）");
  assert.equal(result[1].type, "paragraph");
  assert.equal(result[2].content, "标题");
  assert.equal(result[2].type, "heading");
  assert.equal(result[3].content, "（图片：截图）");
});

test("alt text 提取：全部是图片 block，部分有 alt → 只保留有 alt 的", () => {
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: "![图A](url-a)" },
    { ordinal: 1, type: "image", content: "![](url-b)" },
    { ordinal: 2, type: "image", content: "![图C](url-c)" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, "（图片：图A）");
  assert.equal(result[1].content, "（图片：图C）");
});

// ─── URL 不泄露 ──────────────────────────────────────────────────────────

test("alt text 提取：URL 不出现在转换后的文本中", () => {
  const secretUrl = "/api/uploads/ws-123/notes/note-456/abc-def.png";
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: `![架构图](${secretUrl})` },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 1);
  assert.ok(!result[0].content.includes(secretUrl));
  assert.ok(!result[0].content.includes("/api/uploads/"));
  assert.ok(!result[0].content.includes("ws-123"));
});

test("alt text 提取：外部 HTTPS URL 也不泄露", () => {
  const externalUrl = "https://internal.example.com/secret/path/image.png";
  const blocks: InputBlock[] = [
    { ordinal: 0, type: "image", content: `![外部图片](${externalUrl})` },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result.length, 1);
  assert.ok(!result[0].content.includes(externalUrl));
  assert.ok(!result[0].content.includes("https://"));
  assert.ok(!result[0].content.includes("internal.example.com"));
});

// ─── ordinal 保持 ────────────────────────────────────────────────────────

test("alt text 提取：保留原始 ordinal 值", () => {
  const blocks: InputBlock[] = [
    { ordinal: 5, type: "image", content: "![图](url)" },
    { ordinal: 10, type: "paragraph", content: "文本" },
  ];
  const result = filterImageBlocks(blocks);
  assert.equal(result[0].ordinal, 5);
  assert.equal(result[1].ordinal, 10);
});
