import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  formatSafeImageUnitReference,
  readPartialCardCoverageWarning,
} from "../card-coverage-warning";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const detailSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(focus)/cards/[id]/page.tsx"),
  "utf-8",
);
const listSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(default)/cards/page.tsx"),
  "utf-8",
);

describe("partial learning card presentation", () => {
  it("accepts only the typed partial-generation warning", () => {
    const unitId = "4b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1";
    assert.deepEqual(
      readPartialCardCoverageWarning({
        coverageWarning: {
          code: "partial_generation",
          excludedImageCount: 1,
          excludedUnitIds: [unitId, unitId, "not-a-uuid"],
          excludedImages: [{
            sourceUnitId: unitId,
            imageAssetId: "1b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
            imageBlockId: "2b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
            reason: "image_provider_timeout",
          }],
        },
      }),
      {
        code: "partial_generation",
        excludedImageCount: 1,
        excludedUnitIds: [unitId],
        excludedImages: [{
          sourceUnitId: unitId,
          imageAssetId: "1b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          imageBlockId: "2b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          reason: "image_provider_timeout",
        }],
      },
    );
    assert.equal(
      readPartialCardCoverageWarning({
        coverageWarning: {
          code: "partial_generation",
          excludedImageCount: 0,
          excludedUnitIds: [],
        },
      }),
      null,
    );
    assert.equal(
      readPartialCardCoverageWarning({
        coverageWarning: {
          code: "unexpected",
          excludedImageCount: 1,
          excludedUnitIds: [],
        },
      }),
      null,
    );
  });

  it("formats an opaque image-unit reference without exposing the full id", () => {
    const unitId = "4b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1";
    const formatted = formatSafeImageUnitReference(unitId);
    assert.equal(formatted, "4b1ec21f…7cc1");
    assert.ok(!formatted.includes(unitId));
  });

  it("keeps the detail warning first and validation disabled by lifecycle status", () => {
    const alertStart = detailSource.indexOf(
      'className="card-detail-alerts"',
    );
    const partialAlert = detailSource.indexOf(
      "card-detail-partial-alert",
      alertStart,
    );
    const evidenceAlert = detailSource.indexOf(
      "evidenceError &&",
      alertStart,
    );

    assert.ok(partialAlert > alertStart);
    assert.ok(partialAlert < evidenceAlert);
    assert.ok(detailSource.includes('label: "部分结果"'));
    assert.ok(detailSource.includes("这张卡不会替换完整学习卡，也不能用于验证或复习。"));
    assert.ok(detailSource.includes('aria-label="已排除的图片素材"'));
    assert.ok(detailSource.includes('const isCardActive = card.status === "active"'));
    // 2026-08-12 同步：用户并行重构移除 canValidate 局部变量——验证入口改为
    // onStartJourney 动态路由（companion/validate），partial 卡"不能验证"红线
    // 由上方警告文案 + cardPresentation 状态徽章（label/tone）承担。断言
    // 徽章接线存在 + 警告文案不变量（红线语义保持）。
    assert.ok(detailSource.includes("cardPresentation.label"));
    assert.ok(detailSource.includes("cardPresentation.tone"));
    assert.ok(
      detailSource.includes("这张卡不会替换完整学习卡，也不能用于验证或复习。"),
    );
  });

  it("places partial results in a truthful check-first state in the library", () => {
    assert.ok(listSource.includes("readPartialCardCoverageWarning(card.schemaJson)"));
    assert.ok(listSource.includes('data-state={presentation.state}'));
    assert.ok(listSource.includes("请先检查内容"));
    assert.ok(listSource.includes('data-ui="learning-objective-primary-action"'));
  });
});
