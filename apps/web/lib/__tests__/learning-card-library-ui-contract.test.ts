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
    assert.ok(cssSource.includes("@container cards-library-page (max-width: 1050px)"));
    assert.ok(cssSource.includes("@media (max-width: 719px)"));
    assert.ok(cssSource.includes("@media (max-width: 440px)"));
    assert.ok(cssSource.includes("@media (prefers-reduced-motion: reduce)"));
    assert.ok(cssSource.includes(":focus-visible"));
  });

  it("ships the base visual layer for every card-first surface", () => {
    const requiredBaseSelectors = [
      ".cards-library-toolbar {",
      ".cards-search-box {",
      ".cards-filter-chip {",
      ".cards-sort-control {",
      ".cards-objective-list {",
      ".cards-objective-row {",
      ".cards-objective-state {",
      ".cards-objective-body {",
      ".cards-objective-actions {",
      ".cards-objective-primary-action,",
      ".cards-objective-skeletons {",
      ".cards-load-more {",
    ];
    for (const selector of requiredBaseSelectors) {
      assert.ok(cssSource.includes(selector), `missing base style: ${selector}`);
    }
    assert.match(cssSource, /\.cards-objective-list\s*\{[^}]*list-style:\s*none/s);
    assert.match(cssSource, /\.cards-objective-row\s*\{[^}]*display:\s*flex/s);
    assert.match(cssSource, /\.cards-library-toolbar\s*\{[^}]*display:\s*flex/s);
    assert.match(cssSource, /\.cards-filter-chip\.is-active\s*\{/);
    assert.ok(pageSource.includes('className="workspace-page-header"'));
  });
});
