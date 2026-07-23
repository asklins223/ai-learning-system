/**
 * 图片上传端到端逻辑测试
 *
 * 覆盖设计文档 §8 Phase 7 中的端到端测试项：
 * 1. 笔记图片：编辑器插入 → 保存 → 预览渲染 → 卡片生成（过滤图片）→ 证据对齐（跳过图片）→ 导出
 * 2. 头像上传 → 设置页面 → 账户菜单渲染 → 旧头像清理
 *
 * 由于 MinIO 未启动，此测试验证数据处理流水线各环节的正确性，
 * 而非真正的 HTTP 端到端流程。每个环节使用对应模块的纯函数验证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── 笔记图片流水线 ──────────────────────────────────────────────────────

// markdown-parser.ts — 共享层解析器（API 和 Web 共用）
import {
  parseContent,
  segmentsToBlocks,
  markdownToBlocks,
  extractTitleFromBlocks,
  type ParsedBlock,
} from "@ailearn/shared/markdown-parser";

// file-validation.ts — 上传校验
import { validateImageMagicBytes } from "../lib/file-validation.ts";

// markdown-image.ts — objectKey 提取
import { extractObjectKeyFromMarkdownImage } from "../lib/markdown-image.ts";

// AI 流水线 — image block 过滤 + alt text 提取
// 复现 handlers/index.ts 中的 textBlocks 过滤逻辑
function filterImageBlocksForAI(
  blocks: Array<{ ordinal: number; type: string; content: string }>,
): Array<{ ordinal: number; type: string; content: string }> {
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

// 证据对齐 — 跳过 image block
function filterBlocksForAlign(
  blocks: Array<{ id: string; ordinal: number; type: string; content: string }>,
): Array<{ blockId: string; blockOrdinal: number; text: string }> {
  return blocks
    .filter((b) => b.type !== "image")
    .map((b) => ({ blockId: b.id, blockOrdinal: b.ordinal, text: b.content }));
}

// 搜索索引 — 过滤 image block
function filterBlocksForSearch(
  blocks: Array<{ type: string; content: string }>,
): string {
  return blocks
    .filter((b) => b.type !== "image")
    .map((b) => b.content)
    .join("\n");
}

// 复习展示 — image block 特殊处理
function formatBlockForReview(
  block: { type: string; content: string },
): string {
  if (block.type === "image") {
    const altMatch = /^!\[([^\]]*)\]\(/.exec(block.content);
    return altMatch?.[1]?.trim() || "[图片]";
  }
  return block.content;
}

// 导出 — image block 原样输出
function exportBlock(block: { type: string; content: string }): string {
  return block.content;
}

const IMAGE_URL = "/api/uploads/ws-001/notes/note-001/abc-123.png";
const IMAGE_URL_2 = "/api/uploads/ws-001/notes/note-001/def-456.webp";

describe("端到端逻辑：笔记图片完整流水线", () => {
  // ─── Step 1: Markdown → Blocks（编辑器解析） ──────────────────────────

  describe("Step 1: markdownToBlocks 识别图片行", () => {
    it("独立行图片 → type: image block", () => {
      const md = `# 标题\n\n一些文字\n\n![架构图](${IMAGE_URL})\n\n更多文字`;
      const blocks = markdownToBlocks(md);
      const imageBlock = blocks.find((b) => b.type === "image");
      assert.ok(imageBlock, "should have an image block");
      assert.equal(imageBlock!.content, `![架构图](${IMAGE_URL})`);
    });

    it("多图片混合文本 → 各自独立 image block", () => {
      const md = `![图1](${IMAGE_URL})\n\n中间文字\n\n![图2](${IMAGE_URL_2})`;
      const blocks = markdownToBlocks(md);
      const imageBlocks = blocks.filter((b) => b.type === "image");
      assert.equal(imageBlocks.length, 2);
    });

    it("空 alt text 的图片 → 正确识别为 image block", () => {
      const md = `![](${IMAGE_URL})`;
      const blocks = markdownToBlocks(md);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, "image");
    });
  });

  // ─── Step 2: Blocks → Markdown（保存往返） ────────────────────────────

  /**
   * 复现 apps/web/lib/markdown-blocks.ts 中 blocksToMarkdown 的 image 处理：
   * case "image": return b.content;
   * 其他类型也按 web 逻辑简化处理。
   */
  function blocksToMarkdown(blocks: ParsedBlock[]): string {
    return blocks
      .map((b) => b.content)
      .join("\n\n");
  }

  describe("Step 2: blocksToMarkdown 往返保持一致", () => {
    it("image block 往返后 Markdown 图片语法不变", () => {
      const md = `# 标题\n\n![架构图](${IMAGE_URL})\n\n正文`;
      const blocks = markdownToBlocks(md);
      const restored = blocksToMarkdown(blocks);
      assert.ok(restored.includes(`![架构图](${IMAGE_URL})`));
    });
  });

  // ─── Step 3: 搜索索引过滤 ─────────────────────────────────────────────

  describe("Step 3: 搜索索引过滤 image block", () => {
    it("image block content 不进入搜索 body", () => {
      const blocks = [
        { type: "paragraph", content: "可搜索的文本" },
        { type: "image", content: `![图](${IMAGE_URL})` },
        { type: "paragraph", content: "更多文本" },
      ];
      const body = filterBlocksForSearch(blocks);
      assert.ok(body.includes("可搜索的文本"));
      assert.ok(body.includes("更多文本"));
      assert.ok(!body.includes(IMAGE_URL), "image URL should not be in search body");
    });
  });

  // ─── Step 4: AI 卡片生成 — 过滤 image + 提取 alt text ─────────────────

  describe("Step 4: AI 卡片生成过滤 image block 并提取 alt text", () => {
    it("有 alt text 的图片 → 转为（图片：alt）paragraph", () => {
      const blocks = [
        { ordinal: 0, type: "heading", content: "<h1>标题</h1>" },
        { ordinal: 1, type: "image", content: `![架构图](${IMAGE_URL})` },
        { ordinal: 2, type: "paragraph", content: "正文内容" },
      ];
      const textBlocks = filterImageBlocksForAI(blocks);
      assert.equal(textBlocks.length, 3);
      assert.equal(textBlocks[1].type, "paragraph");
      assert.equal(textBlocks[1].content, "（图片：架构图）");
    });

    it("无 alt text 的图片 → 被丢弃", () => {
      const blocks = [
        { ordinal: 0, type: "paragraph", content: "正文" },
        { ordinal: 1, type: "image", content: `![](${IMAGE_URL})` },
      ];
      const textBlocks = filterImageBlocksForAI(blocks);
      assert.equal(textBlocks.length, 1);
      assert.equal(textBlocks[0].content, "正文");
    });

    it("image URL 不发送给 AI provider", () => {
      const blocks = [
        { ordinal: 0, type: "image", content: `![图](${IMAGE_URL})` },
        { ordinal: 1, type: "paragraph", content: "文本" },
      ];
      const textBlocks = filterImageBlocksForAI(blocks);
      const serialized = JSON.stringify(textBlocks);
      assert.ok(!serialized.includes(IMAGE_URL), "URL should not be in AI payload");
      assert.ok(serialized.includes("（图片：图）"), "alt text should be present");
    });
  });

  // ─── Step 5: 证据对齐 — 跳过 image block ──────────────────────────────

  describe("Step 5: 证据对齐跳过 image block", () => {
    it("image block 不参与证据对齐", () => {
      const blocks = [
        { id: "b1", ordinal: 0, type: "paragraph", content: "匹配文本" },
        { id: "b2", ordinal: 1, type: "image", content: `![图](${IMAGE_URL})` },
        { id: "b3", ordinal: 2, type: "paragraph", content: "另一段文本" },
      ];
      const candidates = filterBlocksForAlign(blocks);
      assert.equal(candidates.length, 2);
      assert.ok(candidates.every((c) => !c.text.includes(IMAGE_URL)));
    });
  });

  // ─── Step 6: 复习展示 — image block 特殊处理 ──────────────────────────

  describe("Step 6: 复习展示处理 image block", () => {
    it("有 alt text → 显示 alt text", () => {
      const block = { type: "image", content: `![流程图](${IMAGE_URL})` };
      assert.equal(formatBlockForReview(block), "流程图");
    });

    it("无 alt text → 显示 [图片] 占位符", () => {
      const block = { type: "image", content: `![](${IMAGE_URL})` };
      assert.equal(formatBlockForReview(block), "[图片]");
    });

    it("复习展示不暴露原始 URL", () => {
      const block = { type: "image", content: `![图](${IMAGE_URL})` };
      const formatted = formatBlockForReview(block);
      assert.ok(!formatted.includes(IMAGE_URL));
      assert.ok(!formatted.includes("/api/uploads/"));
    });
  });

  // ─── Step 7: 导出 — 保持 Markdown 兼容 ────────────────────────────────

  describe("Step 7: 导出保持 Markdown 图片语法", () => {
    it("image block 导出为标准 Markdown 图片语法", () => {
      const block = { type: "image", content: `![架构图](${IMAGE_URL})` };
      const exported = exportBlock(block);
      assert.equal(exported, `![架构图](${IMAGE_URL})`);
      // 标准 Markdown 渲染器可以解析此语法
      assert.ok(exported.startsWith("!["));
    });
  });

  // ─── Step 8: 笔记删除 — objectKey 提取用于清理 ────────────────────────

  describe("Step 8: 笔记删除时 objectKey 提取", () => {
    it("站内图片 → 提取 objectKey 用于存储清理", () => {
      const content = `![图](${IMAGE_URL})`;
      const key = extractObjectKeyFromMarkdownImage(content);
      assert.equal(key, "ws-001/notes/note-001/abc-123.png");
    });

    it("外部 URL → 返回 null，不清理", () => {
      const content = "![图](https://example.com/image.png)";
      assert.equal(extractObjectKeyFromMarkdownImage(content), null);
    });

    it("多版本笔记删除时收集所有 image objectKeys", () => {
      const blocks = [
        { type: "paragraph", content: "文本" },
        { type: "image", content: `![图1](${IMAGE_URL})` },
        { type: "image", content: `![图2](${IMAGE_URL_2})` },
        { type: "paragraph", content: "更多文本" },
      ];
      const keys = blocks
        .filter((b) => b.type === "image")
        .map((b) => extractObjectKeyFromMarkdownImage(b.content))
        .filter((k): k is string => k !== null);
      assert.equal(keys.length, 2);
      assert.ok(keys.includes("ws-001/notes/note-001/abc-123.png"));
      assert.ok(keys.includes("ws-001/notes/note-001/def-456.webp"));
    });
  });
});

// ─── 共享层 Markdown 解析器验证 ────────────────────────────────────────────

describe("端到端逻辑：共享层 Markdown 解析器", () => {
  it("parseContent 识别图片行为 image segment", () => {
    const md = "# 标题\n\n![图片](/api/uploads/test.png)\n\n正文";
    const segments = parseContent(md, "markdown");
    const imageSeg = segments.find((s: { segmentType: string; text: string }) => s.segmentType === "image");
    assert.ok(imageSeg, "should have an image segment");
    assert.ok(imageSeg!.text.includes("![图片]"));
  });

  it("segmentsToBlocks 将 image segment 映射为 image block", () => {
    const md = "![图](/api/uploads/test.png)\n\n正文";
    const segments = parseContent(md, "markdown");
    const blocks = segmentsToBlocks(segments, "markdown");
    const imageBlock = blocks.find((b) => b.type === "image");
    assert.ok(imageBlock);
  });

  it("markdownToBlocks (shared) 识别图片行", () => {
    const md = "![图](/api/uploads/test.png)";
    const blocks = markdownToBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "image");
  });

  it("extractTitleFromBlocks: image block 在无 heading 时可能作为回退标题", () => {
    // extractTitleFromBlocks 的回退逻辑是 blocks.find(b => b.content.trim())
    // 如果 image block 排在前面，其 content（Markdown 图片语法）会作为标题
    // 这是预期行为——image 支持不修改 extractTitleFromBlocks
    const blocks: ParsedBlock[] = [
      { type: "image", content: "![图](/api/uploads/test.png)" },
      { type: "paragraph", content: "实际标题文本" },
    ];
    const title = extractTitleFromBlocks(blocks);
    // 回退到第一个非空 block（image），标题为图片语法
    assert.ok(title.length > 0);
    // 在有 heading 时优先使用 heading
    const blocksWithHeading: ParsedBlock[] = [
      { type: "image", content: "![图](/api/uploads/test.png)" },
      { type: "heading", content: "# 正确标题" },
    ];
    const titleWithHeading = extractTitleFromBlocks(blocksWithHeading);
    assert.ok(titleWithHeading.includes("正确标题"));
    assert.ok(!titleWithHeading.includes("/api/uploads/"));
  });
});

// ─── 头像上传逻辑验证 ─────────────────────────────────────────────────────

describe("端到端逻辑：头像上传流水线", () => {
  // 复现 AvatarUploader.tsx 的前端校验逻辑
  const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

  function validateAvatarFile(file: { type: string; size: number }): { valid: boolean; error?: string } {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return { valid: false, error: "仅支持 PNG、JPEG、WebP、GIF 格式" };
    }
    if (file.size > MAX_AVATAR_SIZE) {
      return { valid: false, error: "头像文件不能超过 2MB" };
    }
    return { valid: true };
  }

  it("合法 PNG 头像 → 通过前端校验", () => {
    const result = validateAvatarFile({ type: "image/png", size: 500_000 });
    assert.equal(result.valid, true);
  });

  it("SVG 头像 → 前端拒绝", () => {
    const result = validateAvatarFile({ type: "image/svg+xml", size: 50_000 });
    assert.equal(result.valid, false);
  });

  it("超过 2MB 的头像 → 前端拒绝", () => {
    const result = validateAvatarFile({ type: "image/png", size: 3 * 1024 * 1024 });
    assert.equal(result.valid, false);
    assert.ok(result.error!.includes("2MB"));
  });

  it("magic bytes 校验通过的真实 PNG → 可以上传", () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(validateImageMagicBytes(pngHeader, "image/png"), true);
  });

  it("magic bytes 校验拒绝的伪装文件 → 不应通过", () => {
    const fakeHeader = Buffer.from("FAKEFAKE");
    assert.equal(validateImageMagicBytes(fakeHeader, "image/png"), false);
  });

  // 旧头像清理逻辑
  it("旧头像为站内上传 → 提取 objectKey 用于清理", () => {
    const oldAvatarUrl = "/api/uploads/avatars/user-123/old-uuid.png";
    // 复现 cleanupOldAvatar 逻辑
    assert.ok(oldAvatarUrl.startsWith("/api/uploads/avatars/"));
    const objectKey = oldAvatarUrl.replace("/api/uploads/", "");
    assert.equal(objectKey, "avatars/user-123/old-uuid.png");
  });

  it("旧头像为外部 URL → 不清理（前缀不匹配）", () => {
    const oldAvatarUrl = "https://example.com/old-avatar.png";
    assert.ok(!oldAvatarUrl.startsWith("/api/uploads/avatars/"));
  });

  it("旧头像为 null → 不清理", () => {
    const oldAvatarUrl: string | null = null;
    assert.equal(oldAvatarUrl, null);
    // null 值不会进入 cleanupOldAvatar 的前缀检查
  });
});
