/**
 * content hash 迁移单元测试
 *
 * 验证 markdownToBlocks 开始识别图片行后，已有 paragraph 中的 ![](url)
 * 在保存后正确变为 image block，导致 content hash 变化（一次性迁移）。
 *
 * 使用 @ailearn/shared 的 markdownToBlocks 和 packages/shared 的 ParsedBlock 类型。
 * content hash 使用 apps/api/src/modules/note/service.ts 的 computeContentHash。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { markdownToBlocks, type ParsedBlock } from "../lib/markdown-parser.ts";
import { computeContentHash } from "../modules/note/service.ts";

// 辅助：ParsedBlock[] → Markdown 文本（简化版，仅用于往返验证）
function blocksToMarkdown(blocks: ParsedBlock[]): string {
  return blocks.map((b) => b.content).join("\n\n");
}

// ─── 图片行识别 ──────────────────────────────────────────────────────────

test("content hash 迁移：独立图片行被识别为 image block（非 paragraph）", () => {
  const md = "![架构图](/api/uploads/ws/notes/n/abc.png)";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[0].content, "![架构图](/api/uploads/ws/notes/n/abc.png)");
});

test("content hash 迁移：无 alt text 的图片也被识别为 image block", () => {
  const md = "![](/api/uploads/ws/notes/n/abc.png)";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "image");
});

// ─── content hash 变化 ──────────────────────────────────────────────────

test("content hash 迁移：图片作为 image block 和 paragraph 的 hash 不同", () => {
  // 模拟旧版解析器行为：![](url) 被归为 paragraph
  const oldBlocks: ParsedBlock[] = [
    { type: "paragraph", content: "![](/api/uploads/ws/n/u.png)" },
  ];
  // 新版解析器行为：![](url) 被归为 image
  const newBlocks = markdownToBlocks("![](/api/uploads/ws/n/u.png)");

  const oldHash = computeContentHash({ blocks: oldBlocks });
  const newHash = computeContentHash({ blocks: newBlocks });

  assert.notEqual(oldHash, newHash);
});

test("content hash 迁移：相同图片行产生的 hash 稳定一致", () => {
  const md = "![图](/api/uploads/ws/n/u.png)";
  const blocks1 = markdownToBlocks(md);
  const blocks2 = markdownToBlocks(md);
  const hash1 = computeContentHash({ blocks: blocks1 });
  const hash2 = computeContentHash({ blocks: blocks2 });
  assert.equal(hash1, hash2);
});

// ─── 往返一致性 ─────────────────────────────────────────────────────────

test("content hash 迁移：图片 Markdown → blocks → Markdown 往返一致", () => {
  const originalMd = "![架构图](/api/uploads/ws/notes/n/abc.png)";
  const blocks = markdownToBlocks(originalMd);
  const restoredMd = blocksToMarkdown(blocks);
  assert.equal(restoredMd.trim(), originalMd.trim());
});

test("content hash 迁移：混合内容（文字+图片+文字）正确分段", () => {
  const md = [
    "这是第一段文字描述。",
    "",
    "![架构图](/api/uploads/ws/notes/n/abc.png)",
    "",
    "这是图片后的文字。",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "paragraph");
  assert.ok(blocks[0].content.includes("第一段"));
  assert.equal(blocks[1].type, "image");
  assert.ok(blocks[1].content.includes("架构图"));
  assert.equal(blocks[2].type, "paragraph");
  assert.ok(blocks[2].content.includes("图片后"));
});

// ─── 迁移场景模拟 ───────────────────────────────────────────────────────

test("content hash 迁移：旧笔记保存后图片行从 paragraph 变为 image", () => {
  // 模拟旧版保存的数据：![](url) 被存为 paragraph
  const oldData: ParsedBlock[] = [
    { type: "paragraph", content: "一些文字" },
    { type: "paragraph", content: "![图](/api/uploads/ws/n/u.png)" },
    { type: "paragraph", content: "更多文字" },
  ];

  // 用户编辑后重新保存，前端用新版 markdownToBlocks 解析
  const restoredMd = blocksToMarkdown(oldData);
  const newBlocks = markdownToBlocks(restoredMd);

  // 新版解析后，图片行变为 image block
  const imageBlock = newBlocks.find((b) => b.type === "image");
  assert.ok(imageBlock, "应该存在一个 image block");
  assert.ok(imageBlock.content.includes("![图]"));

  // content hash 应该不同（因为 type 变了）
  const oldHash = computeContentHash({ blocks: oldData });
  const newHash = computeContentHash({ blocks: newBlocks });
  assert.notEqual(oldHash, newHash);
});

test("content hash 迁移：无图片的笔记 hash 不受影响", () => {
  const md = "# 标题\n\n这是一段普通文字。";
  const blocks = markdownToBlocks(md);
  const hash1 = computeContentHash({ blocks });
  const hash2 = computeContentHash({ blocks });
  assert.equal(hash1, hash2);
});

// ─── 多图片场景 ─────────────────────────────────────────────────────────

test("content hash 迁移：多个连续图片行各自独立成 block", () => {
  const md = [
    "![图1](url1.png)",
    "![图2](url2.png)",
    "![图3](url3.png)",
  ].join("\n\n");
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[2].type, "image");
  assert.ok(blocks[0].content.includes("图1"));
  assert.ok(blocks[1].content.includes("图2"));
  assert.ok(blocks[2].content.includes("图3"));
});

test("content hash 迁移：图片行在代码块内不被识别为 image", () => {
  const md = "```\n![图](url.png)\n```";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.ok(blocks[0].content.includes("![图](url.png)"));
});

// ─── content hash 稳定性（key 顺序无关） ───────────────────────────────

test("content hash 稳定性：block 内 key 顺序不影响哈希", () => {
  // 同一内容的两种 key 排列方式
  const blocksA = [{ type: "paragraph", content: "hello" }];
  const blocksB = [{ content: "hello", type: "paragraph" }];

  const hashA = computeContentHash({ blocks: blocksA });
  const hashB = computeContentHash({ blocks: blocksB });

  assert.equal(hashA, hashB, "key 顺序不同但内容相同时应产生相同哈希");
});

test("content hash 稳定性：嵌套对象 key 顺序不影响哈希", () => {
  const contentA = { blocks: [{ type: "heading", content: "标题" }], meta: { b: 2, a: 1 } };
  const contentB = { meta: { a: 1, b: 2 }, blocks: [{ content: "标题", type: "heading" }] };

  assert.equal(
    computeContentHash(contentA),
    computeContentHash(contentB),
    "嵌套对象 key 顺序不影响哈希",
  );
});

test("content hash 稳定性：blocks 数组顺序敏感", () => {
  const blocksA = [
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段" },
  ];
  const blocksB = [
    { type: "paragraph", content: "第二段" },
    { type: "paragraph", content: "第一段" },
  ];

  assert.notEqual(
    computeContentHash({ blocks: blocksA }),
    computeContentHash({ blocks: blocksB }),
    "blocks 顺序不同应产生不同哈希",
  );
});

test("content hash 稳定性：空 blocks 与无 blocks 的哈希差异", () => {
  const hashEmpty = computeContentHash({ blocks: [] });
  const hashMissing = computeContentHash({});

  // 两者内容不同（一个有空数组，一个没有 blocks key），哈希应不同
  assert.notEqual(hashEmpty, hashMissing, "空 blocks 和无 blocks 应产生不同哈希");
});

test("content hash 稳定性：canonical JSON 匹配 PostgreSQL jsonb::text 格式", () => {
  // 验证 computeContentHash 内部产生的 canonical JSON 与 PostgreSQL jsonb::text 一致
  // 格式：key 按长度排序、使用 ": " 和 ", " 分隔符（含空格）
  const contentJson = { blocks: [{ type: "paragraph", content: "test" }] };
  const hash = computeContentHash(contentJson);

  // 手动构建预期 canonical JSON（匹配 PostgreSQL jsonb::text 格式）
  // key 排序：先按长度，再按字母序
  // "type" (4) < "content" (7)，所以 type 在前
  const expectedCanonical = '{"blocks": [{"type": "paragraph", "content": "test"}]}';
  const expectedHash = createHash("md5").update(expectedCanonical).digest("hex");

  assert.equal(hash, expectedHash, "哈希应与 PostgreSQL jsonb::text 格式 + MD5 一致");
});
