import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const source = (path: string) => readFileSync(resolve(WEB_ROOT, path), "utf8");

const contracts = source("features/card-generation-v2/contracts/ui-contracts.ts");
const demoData = source("features/card-generation-v2/demo/demo-data.ts");
const activeCard = source("features/learning-card-v2/ActiveLearningCardV2.tsx");
const reveal = source("features/learning-card-v2/reveal/LearningCardReveal.tsx");
const lifecycle = source("features/learning-card-v2/lifecycle-actions/LifecycleActions.tsx");
const lab = source("features/card-generation-v2/CardGenerationV2Lab.tsx");
const showcase = source("features/card-generation-v2/LearningCardV2Showcase.tsx");
const styles = source("app/styles/card-generation-v2.css");

describe("Active Learning Card V2 UI contract", () => {
  it("keeps answer-bearing fields outside the public card DTO", () => {
    const publicDto = contracts.slice(
      contracts.indexOf("export interface PublicLearningCardPreviewV2"),
      contracts.indexOf("export interface LearningCardRevealContentV2"),
    );
    assert.match(publicDto, /front:/);
    assert.match(publicDto, /objective:/);
    assert.match(publicDto, /personalState:/);
    assert.match(publicDto, /primaryAction:/);
    assert.doesNotMatch(publicDto, /canonicalAnswer|explanation|misconception|evidence|exposureId/);
    assert.match(demoData, /demoPublicCardReveal/);
  });

  it("only inserts reveal content after async Exposure confirmation", () => {
    assert.match(activeCard, /onReveal: \(cardId: string\) => Promise<LearningCardRevealContentV2>/);
    assert.match(activeCard, /const content = await onReveal\(card\.cardId\)/);
    assert.match(activeCard, /!content\.exposureId \|\| !content\.exposedAt \|\| !content\.exposurePolicyVersion/);
    assert.match(activeCard, /revealedContent && <LearningCardReveal/);
    assert.match(reveal, /Exposure-first 交互预览/);
    assert.match(reveal, /content\.practice\.label/);
  });

  it("keeps one primary learning action and fail-closes lifecycle mutations", () => {
    assert.equal(activeCard.match(/learning-card-v2__primary-action/g)?.length, 1);
    assert.match(activeCard, /onStartLearning/);
    assert.match(lifecycle, /capability === "available" && Boolean\(onAction\)/);
    assert.match(lifecycle, /disabled={!enabled}/);
    assert.match(lifecycle, /均未执行/);
  });

  it("integrates a dev-only card tab with responsive and reduced-motion styling", () => {
    assert.match(lab, /value: "card", label: "学习卡"/);
    assert.match(lab, /<LearningCardV2Showcase/);
    assert.match(showcase, /capability="preview"/);
    assert.match(showcase, /待 V2 后端/);
    assert.match(styles, /\.learning-card-v2/);
    assert.match(styles, /@media \(max-width: 760px\)/);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(styles, /var\(--color-paper\)/);
  });

  it("previews seven interaction types across orthogonal card states without answer leakage", () => {
    assert.match(showcase, /demoPublicCards\.map/);
    assert.match(showcase, /SCENARIOS\.map/);
    assert.match(showcase, /"archived"/);
    assert.match(showcase, /"superseded"/);
    assert.match(showcase, /"source_outdated"/);
    assert.match(showcase, /"stale"/);
    assert.match(showcase, /"reveal_error"/);
    assert.match(showcase, /initialReveal=\{receipt\}/);
    assert.doesNotMatch(showcase, /canonicalAnswer:/);
  });
});
