/** MarkdownPreview URL 白名单与属性注入回归测试。 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "../../components/MarkdownPreview.tsx";

function render(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownPreview, { source }));
}

describe("MarkdownPreview XSS: URL 与属性注入防护", () => {
  it("渲染 HTTPS 和站内上传图片", () => {
    const html = render([
      "![站内](/api/uploads/ws/notes/n/uuid.png)",
      "段落中 ![外部](https://example.com/image.png) 图片",
    ].join("\n\n"));

    assert.match(html, /<img[^>]+src="\/api\/uploads\/ws\/notes\/n\/uuid\.png"/);
    assert.match(html, /<img[^>]+src="https:\/\/example\.com\/image\.png"/);
    assert.match(html, /class="md-image md-image--inline"/);
  });

  it("拒绝 javascript: / data: / file: / blob: 图片协议", () => {
    for (const destination of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "file:///etc/passwd",
      "blob:https://example.com/id",
    ]) {
      const html = render(`before ![alt](${destination}) after`);
      assert.ok(!html.includes("<img"), `${destination} must not produce an image`);
    }
  });

  it("拒绝 HTTP、协议相对、非上传站内路径和路径穿越图片", () => {
    for (const destination of [
      "http://example.com/image.png",
      "//example.com/image.png",
      "/admin/users",
      "/api/uploads/../admin/users",
      "../image.png",
    ]) {
      const html = render(`![alt](${destination})`);
      assert.ok(!html.includes("<img"), `${destination} must not produce an image`);
    }
  });

  it("拒绝独立图片行的危险 URL，不仅限于行内分支", () => {
    const html = render("![alt](javascript:alert(1))");
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("javascript:alert(1)"));
  });

  it("alt 和 URL 中的属性注入不能逃离引号", () => {
    const altAttack = render('![alt" onerror="alert(1)](https://example.com/x.png)');
    const urlAttack = render('![alt](https://example.com/x" onerror="alert(1))');

    assert.match(altAttack, /<img[^>]+alt="alt&quot; onerror=&quot;alert\(1\)"/);
    assert.ok(!altAttack.includes(' onerror="alert(1)"'));
    assert.ok(!urlAttack.includes(' onerror="alert(1)"'));
    assert.ok(!altAttack.includes("<script>"));
    assert.ok(!urlAttack.includes("<script>"));
  });

  it("链接同样拒绝危险 scheme 和协议相对 URL", () => {
    for (const destination of [
      "javascript:alert(1)",
      "data:text/html,boom",
      "file:///etc/passwd",
      "//evil.example/path",
      "\\\\evil.example\\path",
    ]) {
      const html = render(`[open](${destination})`);
      assert.ok(!html.includes("<a "), `${destination} must not produce an anchor`);
    }
  });

  it("原始 HTML 始终被转义", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror="alert(2)">');
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&lt;img"));
  });
});
