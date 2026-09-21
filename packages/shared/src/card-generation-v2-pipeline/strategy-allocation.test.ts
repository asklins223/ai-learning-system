/**
 * 题型（strategy）分配回归（2026-09-20 实走复盘）。
 *
 * 缺陷形态：一篇笔记生成的 5 张卡全部是"主动回忆"题，用户在生成设置里勾的题型
 * 对产出毫无影响。三层原因叠加：
 *   1. `preferredStrategies` 写入 semantic spec 后从未被任何环节读取（死配置）；
 *   2. author 提示的输出模板与唯一示例都写死 `recall`，模型照抄示例；
 *   3. 确定性兜底的 `fact/definition → recall` 映射让 `cloze` 整条链路不可达。
 *
 * 修法是把决策收回 planner：按整批上下文分配，author 只能执行。本测试钉住
 * 分配的三条规则——形态边界、偏好优先、多样性上限。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocatePracticeForms,
  allocateStrategies,
  strategyForKnowledgeForm,
} from "./index.ts";
import type { CardStrategyV2, KnowledgeFormV2 } from "../card-generation-v2-contracts.ts";

const strategiesOf = (
  forms: KnowledgeFormV2[],
  preferred?: CardStrategyV2[],
): CardStrategyV2[] => allocateStrategies(forms, preferred).map((a) => a.strategy);

test("cloze 在兜底映射上可达：单一事实类知识优先出补全题", () => {
  assert.equal(strategyForKnowledgeForm("fact"), "cloze");
  assert.deepEqual(strategiesOf(["fact"]), ["cloze"]);
});

test("未勾选题型时，按知识形态的最自然题型出题", () => {
  assert.deepEqual(strategiesOf(["comparison", "causal_model", "sequence", "boundary"]),
    ["compare", "why", "sequence", "boundary"]);
});

test("同批不出现单一题型垄断：5 张事实类笔记至少 2 种题型", () => {
  const allocated = strategiesOf(["fact", "fact", "fact", "fact", "fact"]);
  assert.equal(new Set(allocated).size, 2, `实际分布：${allocated.join(",")}`);
  for (const strategy of new Set(allocated)) {
    assert.ok(
      allocated.filter((s) => s === strategy).length <= Math.ceil(5 / 2),
      `${strategy} 占比超过 ⌈N/2⌉`,
    );
  }
});

test("用户只勾一种题型时按所愿：不拿多样性去纠正明确的单一偏好", () => {
  const forms: KnowledgeFormV2[] = ["definition", "definition", "definition"];
  assert.deepEqual(strategiesOf(forms, ["cloze"]), ["cloze", "cloze", "cloze"]);
});

test("题型勾选是集合不是优先级：点选顺序不改变分配结果", () => {
  const forms: KnowledgeFormV2[] = ["definition", "definition", "definition"];
  assert.deepEqual(
    strategiesOf(forms, ["cloze", "recall"]),
    strategiesOf(forms, ["recall", "cloze"]),
    "chip Multi-select 的点选顺序不是优先级声明",
  );
  // definition 的教学首选是 recall；两种都被勾选时按适配度排，
  // 而不是按用户先点了哪个（默认值曾是 ["recall","why"]，按点选排会把
  // recall 顶到一切形态前面，正好复刻被复盘的缺陷）。
  assert.deepEqual(strategiesOf(forms, ["cloze", "recall"]), ["recall", "recall", "cloze"]);
});

test("默认全选题型时，分配完全由知识形态决定", () => {
  const all: CardStrategyV2[] = [
    "recall", "cloze", "compare", "sequence", "why", "boundary", "application",
  ];
  assert.deepEqual(
    strategiesOf(["fact", "causal_model", "comparison"], all),
    strategiesOf(["fact", "causal_model", "comparison"]),
  );
});

test("偏好与形态边界冲突时不越界：因果模型不会被塞进填空题", () => {
  // definition 可接受 [recall, cloze]，causal_model 只接受 [why, recall]；
  // 用户只要 cloze 时，因果那张必须退回形态内的合法题型而不是产出错误题型。
  const allocated = strategiesOf(["definition", "causal_model"], ["cloze"]);
  assert.equal(allocated[0], "cloze");
  assert.ok(["why", "recall"].includes(allocated[1]!), `实际：${allocated[1]}`);
});

test("偏离最自然题型时留下可审计理由码", () => {
  const [first, second] = allocateStrategies(["fact", "fact"]);
  assert.equal(first?.reasonCode, undefined);
  assert.equal(first?.strategy, "cloze");
  // 第二张被多样性上限推到同形态的另一个合法题型
  assert.equal(second?.strategy, "recall");
  assert.equal(second?.reasonCode, "strategy_diversity_capped");

  const preferred = allocateStrategies(["definition"], ["cloze"])[0];
  assert.equal(preferred?.reasonCode, "strategy_preference_applied");
});

/**
 * D6：整批的客观练习件配额。
 *
 * 缺陷形态（2026-09-21 真跑）：practiceItem 既可省略又没有形状约束时，一整批模型
 * 要么全不交、要么一律挑最省事的 ordering。配额与题型分配同源——它必须在整批层面
 * 决定，逐张出题的作者看不到同批其他卡。
 */
test("练习件配额：至少一半的卡被点名，形状在本批铺开，且不越形态边界", () => {
  const one = allocatePracticeForms(["definition"]);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.form, "single_choice");
  assert.equal(one[0]?.reasonCode, "practice_quota_required");

  // 4 张 → 至少 2 张被点名；同形态允许的两种形状要铺开，不能两张都出选择题。
  const batch = allocatePracticeForms(["definition", "definition", "fact", "boundary"]);
  const required = batch.filter((entry) => entry.form !== null);
  assert.equal(required.length, 2, "4 张卡至少 2 张必须带练习件");
  assert.notEqual(required[0]?.form, required[1]?.form, "同形态内也要把形状铺开");
  // 没被点名的卡是 null（不强制），而不是被硬塞一个形状。
  assert.equal(batch.filter((entry) => entry.form === null).length, 2);

  // 形态边界优先于铺开：这两张的允许形状里根本没有选择题，被点名的也只会落在
  // ordering / matching 上（N=2 的配额是 1，所以第二张是 null 而不是硬塞）。
  const sequences = allocatePracticeForms(["sequence", "procedure"]);
  assert.equal(sequences[0]?.form, "ordering");
  assert.ok(sequences.every((entry) =>
    entry.form === null || entry.form === "ordering" || entry.form === "matching"));

  // 空批次不炸。
  assert.deepEqual(allocatePracticeForms([]), []);
});
