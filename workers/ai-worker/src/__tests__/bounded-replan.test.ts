import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReplanProposal,
  classifyArtifactReuse,
  inputHashWithReplanVersion,
  type ReplanProposal,
} from "../agent/bounded-replan.ts";

const base: ReplanProposal = {
  version: 2,
  adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "补全 b1 的决策" }],
};

test("valid replan passes", () => {
  assert.deepEqual(validateReplanProposal(base), []);
});

test("empty adjustments rejected", () => {
  const v = validateReplanProposal({ version: 2, adjustments: [] });
  assert.ok(v.some((x) => x.code === "empty_adjustments"));
});

test("forbid reset run", () => {
  const v = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "问题太严重,重置 run 重新开始" }],
  });
  assert.ok(v.some((x) => x.code === "forbid_reset_run"));
});

test("forbid increase budget", () => {
  const v = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "增加预算到 200 次调用" }],
  });
  assert.ok(v.some((x) => x.code === "forbid_increase_budget"));
});

test("forbid clear validated artifact", () => {
  const v = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "清除已验证的 artifact 重来" }],
  });
  assert.ok(v.some((x) => x.code === "forbid_clear_artifact"));
});

test("forbid rerun all specialists unconditionally", () => {
  const v = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "重跑所有 specialist" }],
  });
  assert.ok(v.some((x) => x.code === "forbid_rerun_all"));
});

test("invalid adjustment type rejected", () => {
  const v = validateReplanProposal({
    version: 2,
    adjustments: [{ type: "reset_everything" as never, detail: "x" }],
  });
  assert.ok(v.some((x) => x.code === "invalid_adjustment_type"));
});

test("allowed adjustment types all pass", () => {
  const v = validateReplanProposal({
    version: 2,
    adjustments: [
      { type: "adjust_unfinished_bundle", bundleId: "b1", detail: "补全" },
      { type: "bounded_refetch", bundleId: "b2", detail: "有限补查" },
      { type: "change_specialist", bundleId: "b3", detail: "换 specialist" },
      { type: "add_bundle_context", bundleId: "b4", detail: "加相关 bundle context" },
      { type: "adjust_extraction_focus", bundleId: "b5", detail: "调整 focus" },
    ],
  });
  assert.deepEqual(v, []);
});

test("三分类复用规则(§3.2 表格)", () => {
  // validated_and_unaffected → 直接复用,不重跑
  assert.deepEqual(classifyArtifactReuse(true, false, false), { kind: "validated_and_unaffected", rerunSpecialist: false });
  // validated_but_referenced → 可读,不默认重提取
  assert.deepEqual(classifyArtifactReuse(true, true, false), { kind: "validated_but_referenced", rerunSpecialist: false });
  // invalid_or_affected(未验证或受影响)→ 重跑
  assert.deepEqual(classifyArtifactReuse(false, true, false), { kind: "invalid_or_affected", rerunSpecialist: true });
  assert.deepEqual(classifyArtifactReuse(true, false, true), { kind: "invalid_or_affected", rerunSpecialist: true });
});

test("inputHashWithReplanVersion: v1 不加后缀,>1 追加 rv", () => {
  assert.equal(inputHashWithReplanVersion("abc", 1), "abc");
  assert.equal(inputHashWithReplanVersion("abc", 2), "abc:rv2");
  assert.equal(inputHashWithReplanVersion("abc", 3), "abc:rv3");
});
