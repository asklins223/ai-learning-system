import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const progressSource = readFileSync(
  resolve(WEB_ROOT, "components/validation/SessionProgressStage.tsx"),
  "utf-8",
);
const validationSource = readFileSync(
  resolve(WEB_ROOT, "components/ValidationFocus.tsx"),
  "utf-8",
);
const reviewSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(focus)/review/[scheduleId]/page.tsx"),
  "utf-8",
);
const cssSource = readFileSync(
  resolve(WEB_ROOT, "app/styles/validation-focus.css"),
  "utf-8",
);

describe("v0.6 session progress stage", () => {
  it("keeps one mounted progress stage while eligibility advances into question preparation", () => {
    assert.match(
      validationSource,
      /state\.phase === "eligibility-check" \|\| state\.phase === "question_preparing"/,
    );
    assert.match(
      validationSource,
      /<SessionProgressStage[\s\S]{0,180}stage=\{state\.phase === "eligibility-check" \? "eligibility" : "question"\}/,
    );
    assert.match(
      validationSource,
      /SessionProgressStage sessionKind=\{sessionKind\} stage="evaluation"/,
    );
    assert.ok(!reviewSource.includes('SessionProgressStage sessionKind="review" stage="loading"'));
    assert.ok(reviewSource.includes("validation-focus-route-loading"));
  });

  it("removes the legacy three-dot loader from both entry paths", () => {
    assert.ok(!validationSource.includes("validation-focus-loader"));
    assert.ok(!reviewSource.includes("validation-focus-loader"));
    assert.ok(!cssSource.includes("validation-focus-loader"));
  });

  it("announces real phases without pretending to be a modal or fake percentage progress", () => {
    assert.ok(progressSource.includes('role="status"'));
    assert.ok(progressSource.includes('aria-live="polite"'));
    assert.ok(progressSource.includes('aria-atomic="true"'));
    assert.ok(progressSource.includes('aria-busy="true"'));
    assert.ok(progressSource.includes('aria-current={state === "active" ? "step" : undefined}'));
    assert.ok(progressSource.includes('aria-hidden="true"'));
    assert.ok(!progressSource.includes('role="dialog"'));
    assert.ok(!progressSource.includes("aria-modal"));
    assert.ok(!progressSource.includes("role=\"progressbar\""));
  });

  it("keeps review and learning-card validation visually and verbally distinct", () => {
    assert.ok(progressSource.includes("间隔复习 · 取回记忆"));
    assert.ok(progressSource.includes("学习卡 · 独立验证"));
    assert.ok(progressSource.includes("ReviewProgressVisual"));
    assert.ok(progressSource.includes("ValidationProgressVisual"));
    assert.ok(cssSource.includes('[data-context="review"]'));
    assert.ok(cssSource.includes('[data-context="validation"]'));
    assert.ok(cssSource.includes(".session-progress-memory-ring"));
    assert.ok(cssSource.includes(".session-progress-card-scan"));
  });

  it("preserves the question-first privacy boundary and an accessible return path", () => {
    assert.ok(progressSource.includes("学习卡内容仍保持隐藏"));
    assert.ok(progressSource.includes("不会提前展示结论与原文"));
    assert.ok(!progressSource.includes(".claim"));
    assert.ok(!progressSource.includes(".quote"));
    assert.ok(!progressSource.includes(".evidence"));
    assert.match(reviewSource, /FocusSessionHeader[\s\S]{0,180}exitHref="\/review"/);
  });

  it("uses system motion tokens and keeps reduced-motion coverage", () => {
    assert.ok(cssSource.includes("session-progress-stage-in"));
    assert.ok(cssSource.includes("session-progress-memory-orbit"));
    assert.ok(cssSource.includes("session-progress-card-scan"));
    assert.ok(cssSource.includes("var(--ease-standard)"));
    assert.match(
      cssSource,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.validation-focus \*[\s\S]*?animation: none !important/,
    );
  });

  it("keeps the answer hierarchy compact and moves low-priority actions out of the sticky dock", () => {
    assert.ok(!validationSource.includes("validation-focus-question-index"));
    assert.ok(!validationSource.includes("validation-focus-question-kicker"));
    assert.match(
      validationSource,
      /validation-focus-secondary-actions[\s\S]*?查看原文[\s\S]*?放弃本轮[\s\S]*?validation-focus-actions/,
    );
    assert.match(
      validationSource,
      /validation-focus-actions[\s\S]*?暂时想不起来[\s\S]*?提交回答/,
    );
    assert.match(
      cssSource,
      /\.validation-focus-secondary-actions\s*\{[\s\S]*?position: relative/,
    );
  });

  it("uses page-level headings for shared terminal states and a desktop result rail", () => {
    assert.ok(!validationSource.includes('<h2 className="validation-focus-state-title"'));
    assert.ok(!validationSource.includes('<h2 className="validation-focus-blocked-title"'));
    assert.match(cssSource, /@media \(min-width: 860px\)[\s\S]*?grid-template-columns:[^;]*240px/);
    assert.match(cssSource, /--validation-paper-back-one:/);
    assert.match(cssSource, /html\[data-theme="night"\] \.validation-focus[\s\S]*?--validation-paper-back-one:/);
  });
});
