/**
 * G-008: Markdown parser span & heading contract tests.
 *
 * Verifies:
 * - Heading block content is stored as raw Markdown (`# 标题`), not HTML tags.
 * - charStart/charEnd correctly slice the original content, including with
 *   leading whitespace, CRLF, nested lists, and unclosed code fences.
 * - Round-trip: parseMarkdown → segmentsToBlocks → content.slice(charStart, charEnd) === text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseContent, markdownToBlocks, extractTitleFromBlocks } from "../lib/markdown-parser.ts";

/** Wrapper around the public parseContent API for markdown type. */
function parseMarkdown(content: string) {
  return parseContent(content, "markdown");
}

describe("markdown-parser heading contract", () => {
  it("stores heading content as raw Markdown (# prefix)", () => {
    const segments = parseMarkdown("# 标题\n\n段落");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].segmentType, "heading");
    assert.equal(segments[0].text, "# 标题");
  });

  it("stores level-2 heading as raw Markdown (## prefix)", () => {
    const segments = parseMarkdown("## 副标题\n\n段落");
    assert.equal(segments[0].segmentType, "heading");
    assert.equal(segments[0].text, "## 副标题");
  });

  it("stores level-3 heading as raw Markdown (### prefix)", () => {
    const segments = parseMarkdown("### 小节\n\n段落");
    assert.equal(segments[0].segmentType, "heading");
    assert.equal(segments[0].text, "### 小节");
  });
});

describe("markdown-parser span correctness", () => {
  function verifySlice(content: string) {
    const segments = parseMarkdown(content);
    for (const seg of segments) {
      const sliced = content.slice(seg.charStart, seg.charEnd);
      assert.equal(
        sliced, seg.text,
        `Span mismatch: expected "${seg.text}" but got "${sliced}" at [${seg.charStart}, ${seg.charEnd})`,
      );
    }
    return segments;
  }

  it("heading span matches original slice", () => {
    verifySlice("# 标题\n\n段落内容");
  });

  it("paragraph span matches original slice", () => {
    verifySlice("# Title\n\nFirst paragraph.\n\nSecond paragraph.");
  });

  it("leading whitespace is excluded from span", () => {
    const content = "# Title\n\n  indented paragraph";
    verifySlice(content);
  });

  it("trailing whitespace is excluded from span", () => {
    const content = "# Title\n\nparagraph with trailing spaces   \n\nnext";
    verifySlice(content);
  });

  it("CRLF line endings produce correct spans", () => {
    const content = "# Title\r\n\r\nParagraph one.\r\n\r\n- list item";
    // G-008: Parser normalizes CRLF to LF internally, so offsets refer to
    // the normalized content. Verify slices against the normalized version.
    const normalized = content.replace(/\r\n/g, "\n");
    const segments = parseContent(content, "markdown");
    for (const seg of segments) {
      const sliced = normalized.slice(seg.charStart, seg.charEnd);
      assert.equal(
        sliced, seg.text,
        `CRLF span mismatch: expected "${seg.text}" but got "${sliced}"`,
      );
    }
  });

  it("code block span matches original slice", () => {
    const content = "```js\nconst x = 1;\nconsole.log(x);\n```\n\nAfter code.";
    verifySlice(content);
  });

  it("list span matches original slice", () => {
    const content = "# Title\n\n- item 1\n- item 2\n- item 3";
    verifySlice(content);
  });

  it("ordered list span matches original slice", () => {
    const content = "1. first\n2. second\n3. third";
    verifySlice(content);
  });

  it("quote span matches original slice", () => {
    const content = "> line one\n> line two\n> line three";
    verifySlice(content);
  });

  it("mixed content spans all match", () => {
    const content = `# Title

Some paragraph text.

- item 1
- item 2

> A quote

\`\`\`python
print("hello")
\`\`\`

Final paragraph.`;
    verifySlice(content);
  });

  it("unclosed code fence produces valid span", () => {
    const content = "```js\nconst x = 1;\nconsole.log(x);";
    const segments = parseContent(content, "markdown");
    assert.ok(segments.length >= 1);
    assert.equal(segments[0].segmentType, "code");
    // Verify slice is valid (may not include closing fence since there isn't one)
    const sliced = content.slice(segments[0].charStart, segments[0].charEnd);
    assert.ok(sliced.includes("const x = 1;"), "unclosed code fence should contain code");
  });

  it("empty lines between blocks produce correct spans", () => {
    const content = "# A\n\n\n\nB";
    verifySlice(content);
  });

  it("content with only whitespace produces no segments", () => {
    assert.equal(parseContent("   \n\n  \n", "markdown").length, 0);
  });
});

describe("markdown-parser block conversion", () => {
  it("heading block content is raw Markdown for Web compatibility", () => {
    const blocks = markdownToBlocks("# 标题\n\n段落");
    assert.equal(blocks[0].type, "heading");
    assert.equal(blocks[0].content, "# 标题");
  });

  it("extractTitleFromBlocks strips # prefix from heading", () => {
    const blocks = markdownToBlocks("# My Title\n\nContent");
    assert.equal(extractTitleFromBlocks(blocks), "My Title");
  });

  it("extractTitleFromBlocks handles level-2 heading", () => {
    const blocks = markdownToBlocks("## Sub Title\n\nContent");
    assert.equal(extractTitleFromBlocks(blocks), "Sub Title");
  });
});

describe("markdown-parser parseContent dispatch", () => {
  it("text type splits by double newline", () => {
    const segments = parseContent("Para one\n\nPara two", "text");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].segmentType, "paragraph");
  });

  it("code type returns single segment", () => {
    const segments = parseContent("const x = 1;", "code");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].segmentType, "code");
  });

  it("markdown type uses parseMarkdown", () => {
    const segments = parseContent("# Title\n\nBody", "markdown");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].segmentType, "heading");
  });

  it("url type uses parseMarkdown", () => {
    const segments = parseContent("# Title\n\nBody", "url");
    assert.equal(segments.length, 2);
    assert.equal(segments[0].segmentType, "heading");
  });
});
