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
  summarizePracticeQuotaV2,
  type DeliveredPracticeV2,
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
  // §49：1 张的批次不再点名（库里 41% 的批次是 1–2 张）。旧口径是 ⌈1/2⌉=1，
  // 等于"整批只有一张卡，还必须交一道选择题"——作者凑不出第二个有出处的干扰项时
  // 正确行为是写 null（D4），但 100% 的配额会把那句 null 变成长期缺额。
  const one = allocatePracticeForms(["definition"]);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.form, null, "单张批次被点名了：小批豁免失效");
  const two = allocatePracticeForms(["definition", "boundary"]);
  assert.ok(two.every((entry) => entry.form === null), "2 张的批次也不该点名");
  const three = allocatePracticeForms(["definition", "fact", "boundary"]);
  assert.equal(three.filter((entry) => entry.form !== null).length, 2,
    "n≥3 才回到 ⌈n/2⌉：3 张点 2 张");

  // 4 张 → 至少 2 张被点名；同形态允许的两种形状要铺开，不能两张都出选择题。
  const batch = allocatePracticeForms(["definition", "definition", "fact", "boundary"]);
  const required = batch.filter((entry) => entry.form !== null);
  assert.equal(required.length, 2, "4 张卡至少 2 张必须带练习件");
  assert.notEqual(required[0]?.form, required[1]?.form, "同形态内也要把形状铺开");
  // 没被点名的卡是 null（不强制），而不是被硬塞一个形状。
  assert.equal(batch.filter((entry) => entry.form === null).length, 2);

  // 形态边界优先于铺开：这四张的允许形状里根本没有选择题，被点名的只会落在
  // ordering / matching 上。（原先用 N=2 举这个例子，那条现在归到"小批豁免"里了。）
  const sequences = allocatePracticeForms(["sequence", "procedure", "sequence", "procedure"]);
  const seqRequired = sequences.filter((entry) => entry.form !== null);
  assert.equal(seqRequired.length, 2);
  assert.ok(seqRequired.every((entry) => entry.form === "ordering" || entry.form === "matching"),
    "点名的形状越出了该知识形态允许的范围");

  // 空批次不炸。
  assert.deepEqual(allocatePracticeForms([]), []);
});

/**
 * D6 的另一半：配额点名之后**有没有真的兑现**（`summarizePracticeQuotaV2`）。
 *
 * 缺了这一步，"这批一道练习件都没有"和"配额被无声跳过"在数据上完全同形——
 * 就是本文件开头那条"preferredStrategies 是死配置"的同一种失效形状。
 */
const quotaObjectives = [
  { objectiveLocalId: "obj-a", practiceForm: "single_choice" as const },
  { objectiveLocalId: "obj-b", practiceForm: "true_false" as const },
  { objectiveLocalId: "obj-c", practiceForm: null },
];

test("练习件配额：形状对上才算兑现，交 null 与交错形状都要记账", () => {
  // 全兑现。
  const met = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: "single_choice", optionCount: 4 }], ["obj-b", { form: "true_false" }],
  ]));
  assert.deepEqual(met, { requiredCount: 2, metCount: 2, misses: [] });

  // 交错形状：要求 true_false 却交了 matching——整批的模态铺开没有发生，不算兑现。
  const wrongShape = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: "single_choice", optionCount: 4 }], ["obj-b", { form: "matching", optionCount: 3 }],
  ]));
  assert.equal(wrongShape.metCount, 1);
  assert.deepEqual(wrongShape.misses, [{
    objectiveLocalId: "obj-b", requiredForm: "true_false", deliveredForm: "matching",
    missReason: "wrong_form",
  }]);

  // 什么都没交（作者按合同老实写 null）与"候选被门禁淘汰"（映射里根本没有这个 id）
  // 都落进缺额、`deliveredForm` 都是 null：两者在事件里同形是有意的，但
  // requiredCount/metCount 让"配额被无声跳过"再也读不出错。
  const nothing = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: null }],
  ]));
  assert.deepEqual(nothing.misses, [
    { objectiveLocalId: "obj-a", requiredForm: "single_choice", deliveredForm: null, missReason: "nothing_delivered" },
    { objectiveLocalId: "obj-b", requiredForm: "true_false", deliveredForm: null, missReason: "nothing_delivered" },
  ]);
  assert.equal(nothing.requiredCount, 2);
  assert.equal(nothing.metCount, 0);
});

test("练习件配额：没被点名的卡自愿多交，不占别人的名额", () => {
  const report = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: null }], ["obj-b", { form: null }], ["obj-c", { form: "ordering", optionCount: 4 }],
  ]));
  assert.equal(report.requiredCount, 2, "只有被点名的两张算配额");
  assert.equal(report.metCount, 0, "未被点名那张交的形状不能替别人抵账");
});

/**
 * 形状对上还不够宽：这是 §44 那次实测直接带来的规则——两批里 2 道 `single_choice`
 * 有 1 道只有 2 个选项，而两个选项没有干扰项可言，等于把点名判断题换成点名选择题
 * 之后又原地换回去。合同侧不能抬下限（会打断已落库的卡，见 §46），所以下限只作用在
 * "算不算兑现配额"这一处。
 */
test("练习件配额：选择题少于 3 个选项不算兑现，且记账要说清是宽度不够", () => {
  const narrow = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: "single_choice", optionCount: 2 }],
    ["obj-b", { form: "true_false" }],
  ]));
  assert.equal(narrow.metCount, 1, "2 选项的选择题被当成兑现了 single_choice 的点名");
  assert.deepEqual(narrow.misses, [{
    objectiveLocalId: "obj-a", requiredForm: "single_choice", deliveredForm: "single_choice",
    missReason: "too_few_options",
  }]);

  // 刚好 3 个选项就兑现——下限必须是闭区间，不能顺手写成 > 3。
  const justEnough = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: "single_choice", optionCount: 3 }],
    ["obj-b", { form: "true_false" }],
  ]));
  assert.equal(justEnough.metCount, 2);

  // 没给宽度（自愿交的、或映射里只有形状）不能蒙混过关：缺省按 0 处理。
  const noWidth = summarizePracticeQuotaV2(quotaObjectives, new Map<string, DeliveredPracticeV2>([
    ["obj-a", { form: "single_choice" }],
    ["obj-b", { form: "true_false" }],
  ]));
  assert.equal(noWidth.metCount, 1);

  // 判断题没有选项集合可数，不许被这条下限误伤。
  const tfOnly = summarizePracticeQuotaV2(
    [{ objectiveLocalId: "obj-b", practiceForm: "true_false" as const }],
    new Map<string, DeliveredPracticeV2>([["obj-b", { form: "true_false" }]]),
  );
  assert.deepEqual(tfOnly.misses, []);
});
