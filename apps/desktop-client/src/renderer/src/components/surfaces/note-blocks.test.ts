import { describe, expect, it } from "vitest";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import {
  blockBody,
  blocksMatchMarkdown,
  blocksToMarkdown,
  isHorizontalRule,
  markdownToBlocks,
  parseImageBlock,
  parseInlineMarkdown,
  parseMarkdownTable,
} from "./note-blocks";

/**
 * 正文在「编辑器 Markdown」和「保存合同的块」之间的唯一换算。
 *
 * 编辑器是真 Markdown（Milkdown），所以往返不再靠转义：`#`、`> `、`- `、```
 * 本来就是文档语法。这些测试钉住的是换算的合同——每种块类型的读写一致、
 * 老客户端写下的形状塌缩成同一份正文、以及「只丢了空白」不算改动（否则
 * 自动保存会永远不收敛）。
 */

function projection(blocks: ReadonlyArray<[NoteBlockProjectionV1["type"], string]>): NoteBlockProjectionV1[] {
  return blocks.map(([type, content], ordinal) => ({ ordinal, type, content }));
}

function roundTrip(blocks: ReadonlyArray<[NoteBlockProjectionV1["type"], string]>) {
  return markdownToBlocks(blocksToMarkdown(projection(blocks)));
}

describe("note block markdown", () => {
  it("round-trips every block type the editor can produce", () => {
    expect(roundTrip([
      ["heading", "牛顿第二定律"],
      ["paragraph", "合外力与加速度成正比。"],
      ["quote", "引用的一句"],
      ["list", "第一点\n第二点"],
      ["code", "const a = 1;\nconst b = 2;"],
      ["paragraph", "收尾段"],
    ])).toEqual([
      { type: "heading", content: "牛顿第二定律" },
      { type: "paragraph", content: "合外力与加速度成正比。" },
      { type: "quote", content: "引用的一句" },
      { type: "list", content: "第一点\n第二点" },
      { type: "code", content: "const a = 1;\nconst b = 2;" },
      { type: "paragraph", content: "收尾段" },
    ]);
  });

  it("keeps a code block whole when its body has blank lines", () => {
    expect(roundTrip([["code", "line one\n\nline three"]])).toEqual([
      { type: "code", content: "line one\n\nline three" },
    ]);
  });

  it("keeps the angle brackets that belong to a code block", () => {
    expect(roundTrip([["code", "const tag = <div>hi</div>"]])).toEqual([
      { type: "code", content: "const tag = <div>hi</div>" },
    ]);
  });

  it("keeps a multi-line quote and an ordered list as their own blocks", () => {
    expect(markdownToBlocks("> 一句\n> 又一句\n\n1. 甲\n2. 乙")).toEqual([
      { type: "quote", content: "一句\n又一句" },
      { type: "list", content: "甲\n乙" },
    ]);
  });

  it("reads the markers a writer types by hand", () => {
    expect(markdownToBlocks("# 标题\n\n正文\n\n> 引用\n\n- 甲\n- 乙\n\n```\ncode\n```")).toEqual([
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "正文" },
      { type: "quote", content: "引用" },
      { type: "list", content: "甲\n乙" },
      { type: "code", content: "code" },
    ]);
  });

  it("drops empty sections instead of writing empty blocks", () => {
    expect(markdownToBlocks("正文\n\n\n\n   \n\n尾段")).toEqual([
      { type: "paragraph", content: "正文" },
      { type: "paragraph", content: "尾段" },
    ]);
  });

  it("reads a horizontal rule as its own paragraph and keeps it stable", () => {
    expect(isHorizontalRule("---")).toBe(true);
    expect(isHorizontalRule("***")).toBe(true);
    expect(isHorizontalRule("- - -")).toBe(false);
    expect(roundTrip([["paragraph", "---"]])).toEqual([{ type: "paragraph", content: "---" }]);
  });

  it("shows a legacy version's stored markup as the prose the reader sees", () => {
    // blockBody 是老形状（Web 端写的 <h1>、带标记的引用/列表/围栏）的唯一塌缩点。
    expect(blockBody("heading", "<h1>欧姆定律</h1>")).toBe("欧姆定律");
    expect(blockBody("quote", "> 电阻不变")).toBe("电阻不变");
    expect(blockBody("list", "- 第一点\n- 第二点")).toBe("第一点\n第二点");
    expect(blockBody("code", "```\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(roundTrip([
      ["heading", "<h1>欧姆定律</h1>"],
      ["paragraph", "<p>电阻不变时，电流与电压成正比。</p>"],
    ])).toEqual([
      { type: "heading", content: "欧姆定律" },
      { type: "paragraph", content: "电阻不变时，电流与电压成正比。" },
    ]);
  });

  it("round-trips an image block through its markdown line form", () => {
    expect(roundTrip([
      ["paragraph", "配图如下"],
      ["image", "![实验装置](https://example.com/setup.png)"],
    ])).toEqual([
      { type: "paragraph", content: "配图如下" },
      { type: "image", content: "![实验装置](https://example.com/setup.png)" },
    ]);
  });

  it("keeps a multi-line section that only opens with an image line a paragraph", () => {
    // 只有「整节就一行且整行是图片」才识别成 image；图片行后跟说明文字是散文。
    expect(markdownToBlocks("![截图](https://example.com/shot.png)\n下一行说明")).toEqual([
      { type: "paragraph", content: "![截图](https://example.com/shot.png)\n下一行说明" },
    ]);
  });

  it("leaves empty text blocks out of the markdown entirely", () => {
    // 空标题没有 `#` 可写，写出去下一轮会变成另一种块；只有空代码块有围栏形态。
    expect(blocksToMarkdown(projection([["heading", ""], ["paragraph", "  "]]))).toBe("");
    expect(blocksToMarkdown(projection([["code", ""]]))).toBe("```\n\n```");
  });
});

describe("blocksMatchMarkdown", () => {
  const stored = projection([["paragraph", "hello"]]);

  it("accepts text that only loses unrepresentable whitespace on the round trip", () => {
    expect(blocksMatchMarkdown("hello\n", stored)).toBe(true);
    expect(blocksMatchMarkdown("hello\n\n\n", stored)).toBe(true);
  });

  it("rejects real content changes", () => {
    expect(blocksMatchMarkdown("hello world", stored)).toBe(false);
    expect(blocksMatchMarkdown("# hello", stored)).toBe(false);
    expect(blocksMatchMarkdown("", stored)).toBe(false);
  });

  it("accepts the exact markdown of a multi-block version", () => {
    const multi = projection([
      ["heading", "结论"],
      ["paragraph", "合外力与加速度成正比。"],
    ]);
    const markdown = blocksToMarkdown(multi);
    expect(blocksMatchMarkdown(markdown, multi)).toBe(true);
    expect(blocksMatchMarkdown(markdown, projection([["paragraph", "结论"]]))).toBe(false);
  });

  it("compares a legacy Web-era version through the same body it renders", () => {
    // 老版本打开的一瞬不能显示「未提交」，否则自动保存会重写一个内容相同的版本。
    const legacy = projection([
      ["heading", "<h1>结论</h1>"],
      ["list", "- 甲\n- 乙"],
    ]);
    expect(blocksMatchMarkdown(blocksToMarkdown(legacy), legacy)).toBe(true);
  });
});

describe("parseImageBlock", () => {
  it("splits a markdown image into alt and url", () => {
    expect(parseImageBlock("![实验装置](https://example.com/setup.png)")).toEqual({
      alt: "实验装置",
      url: "https://example.com/setup.png",
    });
  });

  it("rejects content that is not a single markdown image", () => {
    expect(parseImageBlock("asset-id")).toBeNull();
    expect(parseImageBlock("![alt](https://a.test/x.png)\n更多文字")).toBeNull();
    expect(parseImageBlock("![alt](https://a.test/x.png) 后缀")).toBeNull();
  });
});

describe("parseMarkdownTable", () => {
  it("parses a github-flavored table into cell rows", () => {
    expect(parseMarkdownTable("| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |")).toEqual([
      ["列一", "列二"],
      ["---", "---"],
      ["甲", "乙"],
    ]);
  });

  it("rejects text that is not a table", () => {
    expect(parseMarkdownTable("普通段落")).toBeNull();
    expect(parseMarkdownTable("| 只有一行 |")).toBeNull();
    expect(parseMarkdownTable("| 甲 | 乙 |\n| 不是分隔行 |")).toBeNull();
  });
});

describe("parseInlineMarkdown", () => {
  it("splits the four inline syntaxes the reading page renders", () => {
    expect(parseInlineMarkdown("**加粗** 和 *斜体* 与 `代码` 及 [链接](https://a.test)")).toEqual([
      { kind: "strong", text: "加粗" },
      { kind: "text", text: " 和 " },
      { kind: "em", text: "斜体" },
      { kind: "text", text: " 与 " },
      { kind: "code", text: "代码" },
      { kind: "text", text: " 及 " },
      { kind: "link", text: "链接", href: "https://a.test" },
    ]);
  });

  it("keeps syntax it cannot read as plain text instead of dropping it", () => {
    expect(parseInlineMarkdown("普通的一句")).toEqual([{ kind: "text", text: "普通的一句" }]);
    expect(parseInlineMarkdown("**未闭合的加粗")).toEqual([{ kind: "text", text: "**未闭合的加粗" }]);
  });
});
