import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const pageSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(focus)/cards/[id]/page.tsx"),
  "utf-8",
);
const paperSource = readFileSync(
  resolve(WEB_ROOT, "components/study/StudyPaper.tsx"),
  "utf-8",
);
const factsSource = readFileSync(
  resolve(WEB_ROOT, "components/study/UnderstandingFacts.tsx"),
  "utf-8",
);
const evidenceSource = readFileSync(
  resolve(WEB_ROOT, "components/study/EvidenceRail.tsx"),
  "utf-8",
);
const reviewPlanSource = readFileSync(
  resolve(WEB_ROOT, "components/study/ReviewPlanCard.tsx"),
  "utf-8",
);
const cssSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/card-detail.css"),
  "utf-8",
);
const darkModeSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/dark-mode.css"),
  "utf-8",
);

describe("learning card detail UI contract", () => {
  it("uses one overview and a stable reading-paper plus support-rail hierarchy", () => {
    assert.ok(pageSource.includes('className="card-detail-overview"'));
    assert.ok(pageSource.includes('className="card-detail-content-grid"'));
    assert.ok(pageSource.includes('className="card-detail-side-rail"'));
    assert.ok(pageSource.includes("<StudyPaper"));
    assert.ok(pageSource.includes("<EvidenceRail"));
    assert.ok(pageSource.includes("<ReviewPlanCard"));
    assert.ok(pageSource.includes("<UnderstandingFacts"));
    assert.ok(!pageSource.includes('className="study-desk-grid"'));
    assert.ok(!pageSource.includes('className={`validation-side'));
  });

  it("keeps one semantic page title and restores the notebook identity on the reading paper", () => {
    assert.ok(pageSource.includes('<h1 id="card-detail-title">'));
    assert.ok(paperSource.includes('<h2 id="study-paper-title">理解要点</h2>'));
    assert.ok(!paperSource.includes("<h1"));
    assert.ok(paperSource.includes("study-card-tab"));
    assert.ok(paperSource.includes('className="binder-ring" aria-hidden="true"'));
    assert.ok(cssSource.includes(".card-detail-content-grid .study-card-stack::after"));
    assert.match(
      cssSource,
      /\.card-detail-content-grid \.binder-ring \{[\s\S]{0,140}display: block/,
    );
  });

  it("reuses the system card status presentation instead of local status copy", () => {
    assert.ok(pageSource.includes("statusMap.cardStatus(card.status)"));
    assert.ok(pageSource.includes("<StatusChip"));
    assert.ok(pageSource.includes("cardPresentation.label"));
    assert.ok(!pageSource.includes('card.status === "superseded"'));
  });

  it("always renders a useful next-step state while validation remains isolated", () => {
    assert.ok(pageSource.includes("function CardNextStep"));
    assert.match(
      pageSource,
      /\{layoutMode !== "compact" && \(\s*<CardNextStep/,
    );
    assert.ok(pageSource.includes("独立验证暂未开启"));
    assert.ok(pageSource.includes("你仍可阅读理解要点、核对证据并查看复习安排。"));
    assert.match(pageSource, /href=\{`\/cards\/\$\{cardId\}\/validate`\}/);
    assert.ok(!pageSource.includes("<ValidationPanel"));
    assert.ok(!pageSource.includes("<ValidationFocus"));
    assert.ok(!pageSource.includes("refQuote"));
  });

  it("derives validation eligibility only from active status and hard evidence", () => {
    assert.ok(pageSource.includes('const isCardActive = card.status === "active"'));
    assert.ok(pageSource.includes("const eligibleKeyPointCount = evidenceGroups.filter"));
    assert.ok(pageSource.includes("isHardEvidence("));
    assert.match(
      pageSource,
      /const canValidate =\s*isCardActive && !evidenceLoading && eligibleKeyPointCount > 0/,
    );
    assert.ok(!pageSource.includes("buildValidationPrompt"));
  });

  it("preserves accessible loading, failure, navigation and compact actions", () => {
    assert.match(pageSource, /className="card-detail-loading"[\s\S]{0,100}role="status"/);
    assert.match(pageSource, /className="card-detail-state"[\s\S]{0,100}role="alert"/);
    assert.ok(pageSource.includes('aria-label="学习卡导航"'));
    assert.ok(pageSource.includes('aria-label="学习卡详情操作"'));
    assert.ok(pageSource.includes('useState<DetailLayoutMode>("compact")'));
    assert.ok(pageSource.includes('width >= 1080 ? "medium" : "compact"'));
    assert.ok(pageSource.includes('canStartValidation ? "" : "is-single"'));
    assert.ok(pageSource.includes('canStartValidation ? "证据线索" : "证据与复习"'));
    assert.ok(!pageSource.includes("查看验证条件"));
    assert.ok(cssSource.includes(".card-detail-action-dock.is-single"));
    assert.ok(cssSource.includes("safe-area-inset-bottom"));
    assert.ok(cssSource.includes(":focus-visible"));
  });

  it("does not expose backend error details in the redesigned surface", () => {
    assert.ok(!pageSource.includes("caught.message"));
    assert.ok(!pageSource.includes("job.lastError"));
    assert.ok(pageSource.includes("暂时无法读取这张学习卡，请稍后重试。"));
    assert.ok(pageSource.includes("证据状态暂时没有更新成功，请稍后重试。"));
  });

  it("keeps facts factual and labels evidence records conservatively", () => {
    assert.ok(!factsSource.includes(">理解度<"));
    assert.ok(!factsSource.includes("}%"));
    assert.ok(evidenceSource.includes("条证据记录"));
    assert.ok(evidenceSource.includes("const firstEvidence = availableEvidence[0]"));
    assert.ok(!evidenceSource.includes("?? group.evidences[0]"));
    assert.ok(evidenceSource.includes("disabled={!hasEvidenceRecords}"));
    assert.ok(paperSource.includes("原文依据"));
    assert.ok(paperSource.includes("查看关键要点"));
    assert.ok(!paperSource.includes("KEY POINT"));
    assert.ok(!pageSource.includes('学习卡 {String(pager.index).padStart(2, "0")}'));
    assert.ok(!pageSource.includes("{keyPoints.length} 个理解要点"));
    assert.ok(!reviewPlanSource.includes("尚未生成复习时间"));
    assert.ok(!reviewPlanSource.includes("基于当前验证状态自动安排"));
  });

  it("uses the shared 1142px detail rhythm and one responsive hierarchy", () => {
    assert.ok(cssSource.includes("width: min(100%, 1142px)"));
    assert.ok(cssSource.includes(".card-detail-overview-grid"));
    assert.ok(cssSource.includes(".card-detail-content-grid"));
    assert.ok(cssSource.includes('data-layout="compact"'));
    assert.ok(
      cssSource.includes(
        "@container card-detail (min-width: 640px) and (max-width: 1079px)",
      ),
    );
    assert.ok(cssSource.includes("grid-template-rows: minmax(0, 1fr) auto"));
    const sideRailMarkup = pageSource.slice(
      pageSource.indexOf('className="card-detail-side-rail"'),
      pageSource.indexOf("</aside>", pageSource.indexOf('className="card-detail-side-rail"')),
    );
    assert.ok(sideRailMarkup.indexOf("<EvidenceRail") < sideRailMarkup.indexOf("<ReviewPlanCard"));
    assert.ok(cssSource.includes("prefers-reduced-motion"));
  });

  it("keeps the notebook layers legible in the night theme", () => {
    assert.ok(cssSource.includes("--binder-page"));
    assert.ok(cssSource.includes("--binder-sheet-middle"));
    assert.ok(cssSource.includes("--binder-sheet-back"));
    assert.match(
      cssSource,
      /\[data-theme="night"\][\s\S]{0,180}\.study-card-stack::before/,
    );
    assert.match(
      cssSource,
      /\[data-theme="night"\][\s\S]{0,180}\.study-card-page \{/,
    );
    assert.match(
      cssSource,
      /\[data-theme="night"\][\s\S]{0,180}\.binder-ring i \{/,
    );
    assert.match(
      cssSource,
      /\[data-theme="night"\][\s\S]{0,180}\.card-detail-overview[\s\S]{0,80}\.understanding-path \{[\s\S]{0,100}background: transparent;/,
    );
    assert.match(
      darkModeSource,
      /\[data-theme="night"\] \.card-detail-desk \{\s*color-scheme: dark;/,
    );
  });
});
