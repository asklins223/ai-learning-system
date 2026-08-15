import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const pageSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(default)/cards/page.tsx"),
  "utf8",
);
const cssSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/cards-list.css"),
  "utf8",
);

describe("learning objective library UI contract", () => {
  it("uses card-first information architecture with one primary action", () => {
    assert.ok(pageSource.includes('data-ui="learning-objective-row"'));
    assert.ok(pageSource.includes('data-ui="learning-objective-primary-action"'));
    assert.ok(pageSource.includes("learningObjectivePresentation(card"));
    assert.ok(!pageSource.includes("CardSetDeckPage"));
    assert.ok(!pageSource.includes("CardSetCarousel"));
    assert.ok(!pageSource.includes("api.listCardSets"));
  });

  it("does not expose answer-like legacy summary before learning starts", () => {
    assert.ok(!pageSource.includes("schemaJson.summary"));
    assert.ok(!pageSource.includes("schemaJson?.summary"));
    assert.ok(!pageSource.includes("cardSummary("));
    assert.ok(pageSource.includes("不会提前展示答案或关键结论"));
  });

  it("offers search, workflow filters and explicit sorting", () => {
    assert.ok(pageSource.includes('type="search"'));
    assert.ok(pageSource.includes('key: "action"'));
    assert.ok(pageSource.includes('key: "review"'));
    assert.ok(pageSource.includes('key: "practiced"'));
    assert.ok(pageSource.includes('aria-label="学习目标排序方式"'));
  });

  it("includes loading, empty, error, pagination and accessible live states", () => {
    assert.ok(pageSource.includes('className="cards-objective-skeletons"'));
    assert.ok(pageSource.includes('role="alert"'));
    assert.ok(pageSource.includes("还没有学习目标"));
    assert.ok(pageSource.includes("loadMoreError"));
    assert.ok(pageSource.includes('aria-live="polite"'));
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
