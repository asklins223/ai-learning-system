import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerationPlan } from "@ailearn/shared";
import { computePlanContentHash } from "../agent/plan-repository.ts";

function plan(): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent: "机器学习学习卡",
    learningFocus: ["监督学习", "过拟合"],
    bundleTasks: [
      { bundleId: "b1", specialist: "text_extractor", extractionFocus: "监督学习", relatedBundleIds: [], expectedDecisionKinds: ["candidate", "no_candidate"] },
      { bundleId: "b2", specialist: "text_extractor", extractionFocus: "过拟合", relatedBundleIds: ["b1"], expectedDecisionKinds: ["candidate"] },
    ],
    compositionStrategy: { density: "standard", cardBudget: 5 },
  };
}

test("computePlanContentHash 稳定且内容寻址", () => {
  const p = plan();
  const h1 = computePlanContentHash(p);
  const h2 = computePlanContentHash(structuredClone(p));
  assert.equal(h1, h2, "相同内容 hash 一致");
  assert.equal(h1.length, 64, "sha256 hex 长度");

  const changed = computePlanContentHash({ ...p, documentIntent: "改为其他意图" });
  assert.notEqual(h1, changed, "内容变化 hash 不同");
});
