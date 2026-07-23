/**
 * F-008/F-018: Markdown ↔ Block[] 往返测试。
 *
 * 覆盖：标题、有序列表、无序列表、引用、代码围栏、多段落。
 * 验证：blocksToMarkdown(markdownToBlocks(input)) 保留原始语义。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blocksToMarkdown,
  markdownHeadingSelections,
  markdownToBlocks,
} from "../markdown-blocks";

function roundTrip(md: string): string {
  return blocksToMarkdown(markdownToBlocks(md));
}

describe("markdown-blocks round-trip", () => {
  it("preserves headings", () => {
    const input = "# Title\n\n## Subtitle\n\n### Section";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[1].type, "heading");
    assert.equal(blocks[2].type, "heading");
  });

  it("preserves level-five and level-six headings for the article outline", () => {
    const input = "##### Detail\n\n###### Footnote";
    const blocks = markdownToBlocks(input);
    assert.deepEqual(blocks.map((block) => block.content), ["<h5>Detail</h5>", "<h6>Footnote</h6>"]);
    assert.equal(blocksToMarkdown(blocks), input);
  });

  it("locates duplicate headings without counting code-fence examples", () => {
    const input = "# 重复标题\n\n```md\n# 围栏中的示例\n```\n\n## 重复标题";
    const selections = markdownHeadingSelections(input);
    assert.deepEqual(
      selections.map(({ start, length }) => input.slice(start, start + length)),
      ["重复标题", "重复标题"],
    );
  });

  it("preserves ordered list markers (1. 2. 3.)", () => {
    const input = "1. first\n2. second\n3. third";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "list");
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("1. first"), "should preserve '1.' marker");
    assert.ok(output.includes("2. second"), "should preserve '2.' marker");
    assert.ok(output.includes("3. third"), "should preserve '3.' marker");
  });

  it("preserves unordered list markers (- )", () => {
    const input = "- apple\n- banana\n- cherry";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "list");
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("- apple"), "should preserve '- ' marker");
    assert.ok(output.includes("- banana"), "should preserve '- ' marker");
  });

  it("preserves blockquote lines", () => {
    const input = "> line one\n> line two\n> line three";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "quote");
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("> line one"), "should preserve '> ' prefix");
    assert.ok(output.includes("> line two"), "should preserve '> ' prefix");
    assert.ok(output.includes("> line three"), "should preserve '> ' prefix");
  });

  it("preserves code fence with language", () => {
    const input = "```typescript\nconst x = 1;\nconst y = 2;\n```";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "code");
    assert.ok(blocks[0].content.includes("```typescript"));
    assert.ok(blocks[0].content.includes("const x = 1;"));
  });

  it("preserves mixed content", () => {
    const input = `# Title

Some paragraph text.

- item 1
- item 2

> A quote

\`\`\`python
print("hello")
\`\`\`

Final paragraph.`;
    const blocks = markdownToBlocks(input);
    // heading, paragraph, list, quote, code, paragraph = 6 blocks
    assert.equal(blocks.length, 6);
    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[1].type, "paragraph");
    assert.equal(blocks[2].type, "list");
    assert.equal(blocks[3].type, "quote");
    assert.equal(blocks[4].type, "code");
    assert.equal(blocks[5].type, "paragraph");
  });

  it("preserves nested list indentation", () => {
    const input = "- top level\n  - nested\n  - nested 2\n- back to top";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "list");
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("- top level"), "should preserve top level");
    assert.ok(output.includes("  - nested"), "should preserve nested");
  });

  it("handles empty input", () => {
    assert.equal(markdownToBlocks("").length, 0);
    assert.equal(blocksToMarkdown([]), "");
  });

  it("handles CRLF line endings", () => {
    const input = "# Title\r\n\r\nParagraph one.\r\n\r\n- list item";
    const blocks = markdownToBlocks(input);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[1].type, "paragraph");
    assert.equal(blocks[2].type, "list");
  });

  it("preserves horizontal rule", () => {
    const input = "Above\n\n---\n\nBelow";
    const blocks = markdownToBlocks(input);
    // paragraph, paragraph (---), paragraph
    assert.ok(blocks.length >= 3);
  });

  it("preserves Markdown hard-break spaces", () => {
    const input = "first line  \nsecond line";
    assert.equal(roundTrip(input), input);
  });

  it("preserves trailing spaces inside fenced code", () => {
    const input = "```text\nvalue  \n```";
    assert.equal(roundTrip(input), input);
  });
});

/**
 * G-008: Cross-layer Markdown contract tests.
 *
 * API parser stores heading content as raw Markdown (`# 标题`), while Web
 * parser stores it as HTML tags (`<h1>标题</h1>`). blocksToMarkdown must
 * correctly serialize both formats without doubling heading markers.
 *
 * Simulates blocks that arrive from the API (via /import/markdown or
 * parse_source job) and verifies Web's blocksToMarkdown handles them.
 */
describe("cross-layer heading contract (G-008)", () => {
  function makeBlock(type: "heading" | "paragraph" | "code" | "list" | "quote", content: string) {
    return { ordinal: 0, type, content };
  }

  it("serializes API-format heading (# prefix) without doubling", () => {
    const blocks = [makeBlock("heading", "# 标题")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "# 标题", "should not produce '## # 标题'");
  });

  it("serializes API-format level-2 heading (## prefix) without doubling", () => {
    const blocks = [makeBlock("heading", "## 副标题")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "## 副标题");
  });

  it("serializes API-format level-3 heading (### prefix) without doubling", () => {
    const blocks = [makeBlock("heading", "### 小节")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "### 小节");
  });

  it("serializes Web-format heading (<hN> tags) correctly", () => {
    const blocks = [makeBlock("heading", "<h1>标题</h1>")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "# 标题");
  });

  it("serializes Web-format level-2 heading correctly", () => {
    const blocks = [makeBlock("heading", "<h2>副标题</h2>")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "## 副标题");
  });

  it("serializes plain text heading with default ## prefix", () => {
    const blocks = [makeBlock("heading", "无格式标题")];
    const output = blocksToMarkdown(blocks);
    assert.equal(output, "## 无格式标题");
  });

  it("handles mixed API-format and Web-format headings in same document", () => {
    const blocks = [
      { ordinal: 0, type: "heading" as const, content: "# API标题" },
      { ordinal: 1, type: "paragraph" as const, content: "正文" },
      { ordinal: 2, type: "heading" as const, content: "<h2>Web标题</h2>" },
    ];
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("# API标题"), "should preserve API heading");
    assert.ok(output.includes("## Web标题"), "should convert Web heading");
    assert.ok(!output.includes("## # API标题"), "should not double API heading");
  });

  it("does not double-prefix quotes that already have > (API format)", () => {
    const blocks = [makeBlock("quote", "> line one\n> line two")];
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("> line one"), "should preserve existing > prefix");
    assert.ok(!output.includes("> > line"), "should not double > prefix");
  });

  it("preserves API-format list with original markers", () => {
    const blocks = [makeBlock("list", "1. first\n2. second")];
    const output = blocksToMarkdown(blocks);
    assert.ok(output.includes("1. first"), "should preserve ordered marker");
    assert.ok(output.includes("2. second"), "should preserve ordered marker");
  });
});
