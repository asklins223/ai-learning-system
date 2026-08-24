import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const pageSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(default)/cards/page.tsx"),
  "utf8",
);
// 页面委托给 ObjectiveLibrary（Plan 23 FE-13 切流）；UI 契约断言读实现组件。
const librarySource = readFileSync(
  resolve(WEB_ROOT, "features/learning-objective/ObjectiveLibrary.tsx"),
  "utf8",
);
const cssSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/objective-library.css"),
  "utf8",
);
// 页面壳层样式（PageHeader/工具栏容器）仍由 cards-list.css 提供。
const pageCssSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/cards-list.css"),
  "utf8",
);

describe("learning objective library UI contract", () => {
  it("uses card-first information architecture with one primary action", () => {
    assert.ok(librarySource.includes("objective-library-row"));
    assert.ok(librarySource.includes("objective-library-row-action"));
    assert.ok(librarySource.includes("objective-library-pagination"));
    assert.ok(!librarySource.includes("CardSetDeckPage"));
    assert.ok(!librarySource.includes("CardSetCarousel"));
    assert.ok(!librarySource.includes("api.listCardSets"));
  });

  it("does not expose answer-like legacy summary before learning starts", () => {
    assert.ok(!pageSource.includes("schemaJson.summary"));
    assert.ok(!pageSource.includes("schemaJson?.summary"));
    assert.ok(!pageSource.includes("cardSummary("));
    assert.ok(!librarySource.includes("canonicalAnswer"));
  });

  it("offers search, workflow filters and explicit sorting", () => {
    assert.ok(librarySource.includes('type="search"'));
    assert.ok(librarySource.includes('key: "due"'));
    assert.ok(librarySource.includes('key: "run"'));
    assert.ok(librarySource.includes('key: "newest"'));
    assert.ok(librarySource.includes('key: "oldest"'));
    assert.ok(librarySource.includes("aria-selected={filter === f.key}"));
  });

  it("includes loading, empty, error, pagination and accessible live states", () => {
    assert.ok(librarySource.includes("ObjectiveSkeleton"));
    assert.ok(librarySource.includes("ObjectiveError"));
    assert.ok(librarySource.includes("ObjectiveEmpty"));
    assert.ok(librarySource.includes('role="status"'));
    assert.ok(librarySource.includes("加载更多"));
    assert.ok(librarySource.includes("已加载"));
  });

  it("provides responsive objective rows and reduced-motion treatment", () => {
    assert.ok(cssSource.includes("@media (max-width: 719px)"));
    assert.ok(cssSource.includes("@media (prefers-reduced-motion: reduce)"));
    assert.ok(pageCssSource.includes("@container cards-library-page (max-width: 1050px)"));
    assert.ok(pageCssSource.includes(":focus-visible"));
    assert.ok(cssSource.includes(":focus-visible"));
  });

  it("ships the base visual layer for every card-first surface", () => {
    const requiredBaseSelectors = [
      ".objective-library-row {",
      ".objective-library-row-action {",
      ".objective-library-row-topline {",
      ".objective-library-search input {",
      ".objective-library-menu-trigger {",
      ".objective-library-menu-popover {",
      ".objective-library-count {",
      ".objective-library-pagination {",
    ];
    for (const selector of requiredBaseSelectors) {
      assert.ok(cssSource.includes(selector), `missing base style: ${selector}`);
    }
    assert.match(cssSource, /\.objective-library-list\s*\{[^}]*list-style:\s*none/s);
    assert.match(cssSource, /\.objective-library-row\s*\{[^}]*display:\s*flex/s);
    // 左缘状态色条按 data-state 换色（不只靠 chip 颜色）。
    assert.match(cssSource, /\.objective-library-row\[data-state="due"]\s*::before/);
    assert.ok(pageSource.includes('className="workspace-page-header"'));
  });
});
