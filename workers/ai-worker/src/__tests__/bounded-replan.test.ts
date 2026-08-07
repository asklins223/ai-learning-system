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

test("too many adjustments rejected (security LOW 加固)", () => {
  const v = validateReplanProposal({
    version: 2,
    adjustments: Array.from({ length: 21 }, (_, i) => ({ type: "adjust_unfinished_bundle" as const, bundleId: `b${i}`, detail: "x" })),
  });
  assert.ok(v.some((x) => x.code === "too_many_adjustments"));
});

test("adjustment detail over length limit rejected (security LOW 加固)", () => {
  const v = validateReplanProposal({
    version: 2,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "x".repeat(501) }],
  });
  assert.ok(v.some((x) => x.code === "adjustment_detail_too_long"));
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

test("review should-fix: 黑名单绕过变体全部命中", () => {
  // 变体 1:上限提到 500(原正则 提高.{0,6}(上限|预算) 之外的口径)
  const v1 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "上限提到 500 次调用" }],
  });
  assert.ok(v1.some((x) => x.code === "forbid_increase_budget"), "上限提到 500");

  // 变体 2:extend the cap
  const v2 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "extend the cap to 500" }],
  });
  assert.ok(v2.some((x) => x.code === "forbid_increase_budget"), "extend the cap");

  // 变体 3:全部重跑(顺序不同)
  const v3 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "全部 specialist 重跑一遍" }],
  });
  assert.ok(v3.some((x) => x.code === "forbid_rerun_all"), "全部 specialist 重跑");

  // 变体 4:从头再来
  const v4 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "问题太多,从头再来一次" }],
  });
  assert.ok(v4.some((x) => x.code === "forbid_reset_run"), "从头再来");
});

test("review 复核:合法措辞不误伤(负向)", () => {
  // 含"上限"但无提高动词 → 不命中增预算
  const v1 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_extraction_focus", bundleId: "b1", detail: "调整 focus 到机器学习上限相关概念" }],
  });
  assert.deepEqual(v1, [], "提及'上限'但非增预算不应命中");

  // 无重置语义 → 不命中
  const v2 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "重新评估 b1 的候选决策" }],
  });
  assert.deepEqual(v2, [], "'重新评估'非重置 Run 不应命中");

  // 英语 wipe 无 artifact/everything 上下文 → 不命中
  const v3 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "adjust_unfinished_bundle", bundleId: "b1", detail: "wipe out the confusion in b1" }],
  });
  assert.deepEqual(v3, [], "wipe 无 artifact 上下文不应命中");

  // maxProviderCalls 无增动词(否定式)→ 不命中
  const v4 = validateReplanProposal({
    ...base,
    adjustments: [{ type: "add_bundle_context", bundleId: "b1", detail: "保持 maxProviderCalls 不变,补充上下文" }],
  });
  assert.deepEqual(v4, [], "maxProviderCalls 否定式不应命中");
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
