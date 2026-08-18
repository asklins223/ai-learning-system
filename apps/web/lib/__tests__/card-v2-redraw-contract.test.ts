import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");

function source(path: string) {
  return readFileSync(resolve(WEB_ROOT, path), "utf8");
}

const controls = source("features/card-generation-v2/GenerationControls.tsx");
const scopePicker = source("features/card-generation-v2/components/CustomScopePicker.tsx");
const limitStepper = source("features/card-generation-v2/components/CardLimitStepper.tsx");
const review = source("features/card-generation-v2/CandidateReview.tsx");
const pageSource = source("features/card-generation-v2/CandidateReviewPage.tsx");
const zero = source("features/card-generation-v2/ZeroCardResult.tsx");
const contracts = source("features/card-generation-v2/contracts/ui-contracts.ts");
const demoData = source("features/card-generation-v2/demo/demo-data.ts");
const noteEditor = source("components/NoteEditor.tsx");
const cardsPage = source("app/(workspace)/(default)/cards/page.tsx");
const styles = source("app/styles/card-generation-v2.css");

describe("Card V2 UI redraw contract", () => {
  it("keeps generation controls value-first and fail-closed until the V2 API exists", () => {
    assert.ok(controls.includes("系统会合并碎片、过滤低价值内容，也可能建议 0 张卡"));
    assert.ok(controls.includes("只改变纳入门槛，不要求凑卡数"));
    assert.ok(controls.includes('capability: "preview" | "available"'));
    assert.ok(controls.includes('disabled={disabled || capability === "preview"}'));
    assert.ok(!controls.includes("density"));
    assert.ok(!controls.includes("overview"));
    assert.ok(!controls.includes("standard"));
    assert.ok(!controls.includes("complete"));
  });

  it("uses custom accessible scope and card-limit controls instead of browser widgets", () => {
    assert.ok(controls.includes("<CustomScopePicker"));
    assert.ok(controls.includes("<CardLimitStepper"));
    assert.ok(!controls.includes("<select"));
    assert.ok(!controls.includes('type="number"'));

    assert.ok(scopePicker.includes('aria-haspopup="listbox"'));
    assert.ok(scopePicker.includes('role="listbox"'));
    assert.ok(scopePicker.includes('role="option"'));
    assert.ok(scopePicker.includes('document.addEventListener("pointerdown"'));
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) {
      assert.ok(scopePicker.includes(key), `scope picker handles ${key}`);
    }

    assert.ok(limitStepper.includes('role="spinbutton"'));
    assert.ok(limitStepper.includes('aria-live="polite"'));
    assert.ok(limitStepper.includes("aria-valuenow={value ?? 0}"));
    assert.ok(limitStepper.includes('value === null ? "智能数量，无手动上限"'));
    assert.ok(controls.includes("max={12}"));
    assert.ok(styles.includes(".card-v2-scope-picker__listbox"));
    assert.ok(styles.includes(".card-v2-limit-stepper__value"));
  });

  it("does not preload Candidate answers before an explicit reveal", () => {
    const publicCandidate = contracts.slice(
      contracts.indexOf("export interface CandidateReviewItemV2"),
      contracts.indexOf("export interface CandidateRevealContentV2"),
    );
    assert.ok(!publicCandidate.includes("answer:"));
    assert.ok(!publicCandidate.includes("evidencePreview:"));
    assert.ok(review.includes("onReveal"));
    assert.ok(review.includes("查看后会标记为已预习"));
    assert.ok(review.includes("已预习答案"));
    assert.ok(demoData.includes("demoCandidateReveals"));
  });

  it("wires candidate review to the real V2 API (R7：不再断言未集成)", () => {
    // §19.3：审核操作必须走真实 API（CandidateReviewPage + adapters + api-client）。
    assert.ok(review.includes('role="dialog"'));
    assert.ok(review.includes('aria-modal="true"'));
    assert.ok(review.includes("学习目标不同，不能直接合并"));
    assert.ok(review.includes('reviewState: "rechecking"'));
    assert.ok(review.includes("撤销不保留"));
    assert.ok(review.includes("selected.length === 0 || hasRechecking"));
    // R7：CandidateReviewPage 是真实 API 审核页；CandidateReview 组件经页面注入
    // 真实 client（demo 回调仅保留给 Lab 预览）。
    assert.ok(pageSource.includes("CandidateReviewPage"));
    assert.ok(pageSource.includes("createV2Client"));
    assert.ok(pageSource.includes("candidateAction"));
    assert.ok(pageSource.includes("activateCandidates"));
    assert.ok(pageSource.includes("revealCandidate"));
    assert.ok(!pageSource.includes("demoCandidateReveals"));
  });

  it("treats zero-card as a successful recommendation rather than an error", () => {
    assert.ok(zero.includes("分析已完成 · 0 张学习卡"));
    assert.ok(zero.includes("没有生成卡不是失败"));
    assert.ok(!zero.includes("强制生成"));
    assert.ok(!zero.includes("手动创建"));
  });

  it("routes legacy generation results to V2 learning cards or the card library", () => {
    const targetStart = noteEditor.indexOf("const generatedCardHref");
    const targetEnd = noteEditor.indexOf("const hasWritableContent", targetStart);
    const target = noteEditor.slice(targetStart, targetEnd);
    assert.ok(target.includes("result?.cardId"));
    // V1 卡详情页已退役：生成结果导航改指 V2 /learning-cards/:cardId。
    assert.ok(target.includes("/learning-cards/${generationRun.result.cardId}"));
    assert.ok(!target.includes("/card-sets/"));
    assert.ok(!target.includes("`/cards/${generationRun.result.cardId}`"));
  });

  it("retires the CardSet deck flag from the /cards information architecture", () => {
    assert.doesNotMatch(cardsPage, /isCardSetDeckUIEnabled/);
    assert.doesNotMatch(cardsPage, /CardSetDeckPage/);
  });

  it("supports small screens, reduced motion and keyboard focus", () => {
    assert.ok(styles.includes("@media (max-width: 760px)"));
    assert.ok(styles.includes("@media (prefers-reduced-motion: reduce)"));
    assert.ok(styles.includes("var(--mobile-nav-inset)"));
  });
});
