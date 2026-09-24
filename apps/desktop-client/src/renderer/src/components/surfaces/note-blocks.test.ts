import { describe, expect, it } from "vitest";
import { parseMarkdownTable } from "./note-blocks";

/**
 * 阅读页的表格识别。
 *
 * 这个文件原来还钉着「编辑器 Markdown ↔ 保存合同的块」那一整套换算；正文事实源换成
 * 共享文档之后那条换算只剩 `packages/shared/note-doc-schema.ts` 一份（用例在
 * `note-doc-schema.test.ts`），这里的旧用例跟着旧实现一起删了。
 */

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

  it("keeps an escaped pipe inside its cell", () => {
    // 投影那侧（`tableToMarkdown`）把单元里的 `|` 写成 `\|`，正是为了让这张表
    // 还是两列；按裸 `|` 切就会凭空多出一列，读起来像串了位。
    expect(parseMarkdownTable("| 列甲 | 列乙 |\n| --- | --- |\n| a\\|b | 乙 |")).toEqual([
      ["列甲", "列乙"],
      ["---", "---"],
      ["a|b", "乙"],
    ]);
  });
});
