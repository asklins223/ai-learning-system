/** MarkdownPreview 的 GFM 表格、链接与图片渲染回归测试。 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "../../components/MarkdownPreview.tsx";

function render(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownPreview, { source }));
}

describe("MarkdownPreview 六级文章结构", () => {
  it("渲染五级与六级标题而不是普通段落", () => {
    const html = render("##### 深层小节\n\n###### 补充说明");
    assert.match(html, /<h5 class="md-h5">深层小节<\/h5>/);
    assert.match(html, /<h6 class="md-h6">补充说明<\/h6>/);
  });
});

describe("MarkdownPreview GFM 表格", () => {
  it("渲染表头、数据行、对齐和可横向滚动容器", () => {
    const html = render([
      "| 名称 | 分数 | 评价 |",
      "| :--- | ---: | :---: |",
      "| Alice | 95 | **很好** |",
      "| Bob | 88 | `stable` |",
    ].join("\n"));

    assert.match(html, /<div class="md-table-wrap" role="region" aria-label="可横向滚动的表格" tabindex="0">/);
    assert.match(html, /<table class="md-table">/);
    assert.match(html, /<th scope="col" style="text-align:left">名称<\/th>/);
    assert.match(html, /<th scope="col" style="text-align:right">分数<\/th>/);
    assert.match(html, /<th scope="col" style="text-align:center">评价<\/th>/);
    assert.match(html, /<td style="text-align:center"><strong class="md-bold">很好<\/strong><\/td>/);
    assert.match(html, /<code class="md-code">stable<\/code>/);
  });

  it("支持无对齐标记、缺失单元格补空与转义 pipe", () => {
    const html = render([
      "A | B",
      "--- | ---",
      "left\\|part | right",
      "only-one |",
    ].join("\n"));

    assert.match(html, /<th scope="col">A<\/th>/);
    assert.match(html, /<td>left\|part<\/td>/);
    assert.match(html, /<td>only-one<\/td><td><\/td>/);
  });

  it("非法分隔行不误渲染为表格", () => {
    const html = render("A | B\n-- | ---\none | two");
    assert.ok(!html.includes("md-table-wrap"));
    assert.match(html, /<p class="md-p">/);
  });

  it("表格单元格中的 HTML 仍被转义", () => {
    const html = render("A | B\n--- | ---\n<script> | ![x](javascript:alert(1))");
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});

describe("MarkdownPreview 安全链接与行内图片", () => {
  it("站内相对链接在当前页打开", () => {
    const html = render([
      "[根路径](/notes/123)",
      "[当前](./guide) [上级](../notes) [锦标](#preview) [查询](?mode=read)",
    ].join("\n\n"));

    for (const href of ["/notes/123", "./guide", "../notes", "#preview", "?mode=read"]) {
      assert.ok(html.includes(`<a href="${href}" class="md-link">`), `${href} should render as an internal link`);
    }
    assert.ok(!html.includes('target="_blank"'));
  });

  it("保留 HTTP(S) 外链支持并添加隔离属性", () => {
    const html = render("[HTTPS](https://example.com/a) [HTTP](http://example.com/b)");
    assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer" class="md-link">HTTPS<\/a>/);
    assert.match(html, /<a href="http:\/\/example\.com\/b" target="_blank" rel="noopener noreferrer" class="md-link">HTTP<\/a>/);
  });

  it("同一段落中的图片不再被链接规则提前消费", () => {
    const html = render("前文 ![架构图](/api/uploads/ws/notes/n/diagram.png) 后文 [阅读笔记](/notes/1)");

    assert.match(html, /<img src="\/api\/uploads\/ws\/notes\/n\/diagram\.png" alt="架构图" class="md-image md-image--inline" loading="lazy" \/>/);
    assert.match(html, /<a href="\/notes\/1" class="md-link">阅读笔记<\/a>/);
    assert.ok(!html.includes("!<a"));
  });

  it("链接文本中仍可使用强调语法", () => {
    const html = render("[**重点**](/notes/1)");
    assert.match(html, /<a href="\/notes\/1" class="md-link"><strong class="md-bold">重点<\/strong><\/a>/);
  });
});
