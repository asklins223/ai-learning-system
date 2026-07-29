import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const reviewSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(default)/review/page.tsx"),
  "utf-8",
);
const focusSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(focus)/review/[scheduleId]/page.tsx"),
  "utf-8",
);
const reviewCss = readFileSync(
  resolve(WEB_ROOT, "app/styles/review-v06.css"),
  "utf-8",
);
const tokenCss = readFileSync(
  resolve(WEB_ROOT, "app/styles/tokens.css"),
  "utf-8",
);

describe("v0.6 review queue UI contract", () => {
  it("shares the workspace header gutter without re-centering wide-screen content", () => {
    assert.ok(reviewSource.includes('className="workspace-page-header"'));
    assert.match(
      reviewCss,
      /\.review-v06-content\s*\{[\s\S]{0,180}max-width: none;[\s\S]{0,180}margin-inline: 0;/,
    );
    assert.ok(!reviewCss.includes("max-width: 1240px"));
  });

  it("keeps the overview concise and avoids repeating the privacy rule in the queue header", () => {
    assert.ok(reviewSource.includes("隐藏学习内容"));
    assert.ok(reviewSource.includes("完成后判断下一步"));
    assert.ok(reviewSource.includes("计入理解记录"));
    assert.ok(!reviewSource.includes("review-v06-privacy-note"));
  });

  it("matches the loading skeleton to the four-column task row", () => {
    assert.ok(reviewSource.includes("review-v06-skeleton-time"));
    assert.ok(reviewSource.includes("review-v06-skeleton-node"));
    assert.ok(reviewSource.includes("review-v06-skeleton-copy"));
    assert.ok(reviewSource.includes("review-v06-skeleton-action"));
  });

  it("uses safe error copy and a single compact metadata hand-off", () => {
    assert.ok(!reviewSource.includes("error instanceof Error"));
    assert.ok(focusSource.includes("validation-focus-route-loading"));
    assert.ok(!focusSource.includes('SessionProgressStage sessionKind="review" stage="loading"'));
    assert.match(
      reviewCss,
      /\.review-focus-route-loading::before\s*\{\s*display: none;/,
    );
  });

  it("keeps backing sheets and raised surfaces darker in the night theme", () => {
    assert.match(
      reviewCss,
      /html\[data-theme="night"\] \.review-v06-page\s*\{[\s\S]{0,160}--review-sheet-back:/,
    );
    assert.match(
      tokenCss,
      /html\[data-theme="night"\][\s\S]*?--shadow-raised:/,
    );
  });
});
