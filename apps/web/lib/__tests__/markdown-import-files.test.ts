import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MARKDOWN_CHARACTERS,
  extractMarkdownTitle,
  isMarkdownFileName,
  markdownSelectionError,
  readMarkdownFile,
  readMarkdownFiles,
  summarizeMarkdownFiles,
  type MarkdownReadableFile,
} from "../markdown-import-files";
import { splitMarkdownImportBatches } from "../api";

function fakeFile(
  name: string,
  content: string | Uint8Array,
  options: { lastModified?: number; delay?: number; fail?: boolean } = {},
): MarkdownReadableFile {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name,
    size: bytes.byteLength,
    lastModified: options.lastModified ?? 1,
    async arrayBuffer() {
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
      if (options.fail) throw new Error("read failed");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

describe("Markdown file import", () => {
  it("accepts only .md and .markdown names, regardless of case", () => {
    assert.equal(isMarkdownFileName("note.md"), true);
    assert.equal(isMarkdownFileName("NOTE.MARKDOWN"), true);
    assert.equal(isMarkdownFileName("note.txt"), false);
    assert.equal(isMarkdownFileName("note.md.txt"), false);
    assert.equal(isMarkdownFileName("README"), false);
  });

  it("maps one file to one item and preserves Markdown horizontal rules", async () => {
    const content = "# 第一篇\n\n正文\n\n---\n\n仍然属于同一个文件";
    const result = await readMarkdownFile(fakeFile("one.md", content));
    assert.equal(result.error, null);
    assert.equal(result.item?.title, "第一篇");
    assert.equal(result.item?.content, content);
  });

  it("uses the filename when no Markdown heading exists", async () => {
    const result = await readMarkdownFile(fakeFile("分布式系统笔记.markdown", "普通正文"));
    assert.equal(result.item?.title, "分布式系统笔记");
  });

  it("ignores headings inside fenced code blocks", () => {
    const content = "```md\n# 代码里的标题\n```\n\n## 真正标题";
    assert.equal(extractMarkdownTitle(content), "真正标题");
  });

  it("does not close a four-backtick fence with a shorter nested run", () => {
    const content = "````md\n```\n# 仍在代码围栏中\n```\n````\n\n# 真正标题";
    assert.equal(extractMarkdownTitle(content), "真正标题");
  });

  it("decodes UTF-8, removes one BOM and supports CRLF", async () => {
    const result = await readMarkdownFile(fakeFile("unicode.md", "\ufeff# 中文标题\r\n\r\n正文🙂"));
    assert.equal(result.item?.title, "中文标题");
    assert.equal(result.item?.content.startsWith("\ufeff"), false);
    assert.match(result.item?.content ?? "", /正文🙂/);
  });

  it("reports invalid UTF-8, binary NUL, empty and unreadable files", async () => {
    const invalid = await readMarkdownFile(fakeFile("invalid.md", new Uint8Array([0xc3, 0x28])));
    const binary = await readMarkdownFile(fakeFile("binary.md", "# 标题\n\u0000"));
    const empty = await readMarkdownFile(fakeFile("empty.md", "   \n"));
    const unreadable = await readMarkdownFile(fakeFile("broken.md", "# x", { fail: true }));
    assert.match(invalid.error ?? "", /UTF-8/);
    assert.match(binary.error ?? "", /二进制/);
    assert.match(empty.error ?? "", /空白/);
    assert.match(unreadable.error ?? "", /读取失败/);
  });

  it("enforces content and title limits", async () => {
    const accepted = await readMarkdownFile(fakeFile("limit.md", "a".repeat(MAX_MARKDOWN_CHARACTERS)));
    const oversized = await readMarkdownFile(fakeFile("too-long.md", "a".repeat(MAX_MARKDOWN_CHARACTERS + 1)));
    const longTitle = await readMarkdownFile(fakeFile("title.md", `# ${"题".repeat(201)}\n正文`));
    assert.equal(accepted.error, null);
    assert.match(oversized.error ?? "", /超过/);
    assert.match(longTitle.error ?? "", /标题/);
  });

  it("preserves selected order even when reads finish out of order", async () => {
    const results = await readMarkdownFiles([
      fakeFile("first.md", "# First", { delay: 20 }),
      fakeFile("second.md", "# Second", { delay: 1 }),
    ]);
    assert.deepEqual(results.map((item) => item.name), ["first.md", "second.md"]);
  });

  it("distinguishes same-metadata files by their content", async () => {
    const [first, second] = await readMarkdownFiles([
      fakeFile("same.md", "# A\n正文一", { lastModified: 7 }),
      fakeFile("same.md", "# B\n正文二", { lastModified: 7 }),
    ]);
    assert.equal(first.size, second.size);
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.notEqual(first.key, second.key);
  });

  it("summarizes errors and enforces the 100-file batch limit", async () => {
    const records = await readMarkdownFiles([
      fakeFile("ok.md", "# OK"),
      fakeFile("bad.txt", "text"),
    ]);
    assert.deepEqual(summarizeMarkdownFiles(records), {
      files: 2,
      ready: 1,
      characters: 4,
      errors: 1,
    });
    assert.match(markdownSelectionError(records) ?? "", /1 个文件/);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      ...records[0],
      key: `file-${index}`,
      name: `file-${index}.md`,
    }));
    assert.match(markdownSelectionError(tooMany) ?? "", /最多导入 100/);
  });

  it("splits large JSON payloads without changing item order", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      title: `note-${index}`,
      content: `# ${index}\n${"正文".repeat(20)}`,
    }));
    const batches = splitMarkdownImportBatches(items, "batch-id", 220);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flat(), items);
  });
});
