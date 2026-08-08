/**
 * 阶段 08（W7）任务 08-4：metrics-schema 单测（§16.4 / §16.6）。
 *
 * 覆盖：指标类型校验（schema 自检 / 未知 id fail closed）、观察 vs 硬 Gate 分离
 * （observe-only 不得授权任何强迫优化；hard-gate 无授权语义）、成本计算
 * （分布归一化、比例、p50/p95 分位、重试放大系数）、hidden/off 后新增成本为 0。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertObservationOnlyMetric,
  checkCoerciveAuthorization,
  checkHiddenOffZeroNewCost,
  checkP95CostCap,
  checkRetryAmplificationUnderCap,
  checkTutorFormalBudgetIsolation,
  COERCIVE_MECHANISMS,
  COST_DIMENSIONS,
  computePercentile,
  computeRatio,
  computeRetryAmplification,
  computeUserCostPercentile,
  getMetricDefinition,
  isCoerciveMechanism,
  isMetricId,
  isZeroCost,
  MetricSchemaError,
  metricDefinitions,
  normalizeDistribution,
  sumCostSamples,
  validateMetricId,
  validateMetricSchema,
  ZERO_COST,
  type CostSample,
} from "./metrics-schema.ts";

// ─── helper ───────────────────────────────────────────────────────────────

function sample(overrides: Partial<CostSample> = {}): CostSample {
  return { ...ZERO_COST, ...overrides };
}

// ─── 1. 指标类型校验 ───────────────────────────────────────────────────────

describe("metrics-schema: 指标类型校验", () => {
  it("整个冻结定义表自检通过（无未知 id / 无分类分组错配 / 无空 buckets）", () => {
    assert.deepEqual(validateMetricSchema(), []);
  });

  it("冻结定义表覆盖 §16.4 §5.1 / §5.2 / §16.6 全部要求指标", () => {
    for (const required of [
      // §16.4 §5.1 observation
      "onboarding_started",
      "onboarding_first_meaningful_action_ratio",
      "companion_summoned",
      "no_keyboard_session_ratio",
      "modality_distribution",
      "presence_distribution",
      "presence_turn_off_rate",
      "route_disposition_distribution",
      "question_flag_disposition_distribution",
      "subsequent_independent_recall",
      "post_repair_same_rubric_miss_rate",
      "transfer_task_success_rate",
      "tutor_feedback_distribution",
      "asr_not_assessable_rate",
      "modality_switch_rate",
      // §16.4 §5.2 observe-only
      "onboarding_completion_rate",
      "companion_open_duration",
      "conversation_turns",
      "retention",
      "dau",
      "learning_duration",
      "completions_count",
      // §16.6 cost
      "llm_calls_per_episode",
      "llm_input_tokens_per_episode",
      "llm_output_tokens_per_episode",
      "asr_seconds_per_session",
      "tts_characters_per_session",
      "object_storage_bytes_per_episode",
      "tutor_budget_per_episode",
      "user_cost_p50",
      "user_cost_p95",
      "retry_amplification_factor",
      // hard-gate
      "hidden_off_zero_new_cost",
      "cancel_confirmed_zero_new_calls",
      "tutor_formal_budget_isolation",
      "retry_amplification_cap",
      "p95_cost_cap",
    ]) {
      assert.equal(isMetricId(required), true, `缺冻结指标 ${required}`);
      assert.ok(getMetricDefinition(required), `缺冻结指标定义 ${required}`);
    }
  });

  it("未知指标 id fail closed", () => {
    assert.equal(isMetricId("nope"), false);
    assert.deepEqual(validateMetricId("nope"), ["unknown metric id: nope"]);
    assert.deepEqual(checkCoerciveAuthorization("nope", ["streak"]), [
      "unknown metric id: nope",
    ]);
    assert.throws(() => assertObservationOnlyMetric("nope"), MetricSchemaError);
  });

  it("observe-only 指标必须放在 observe_only_product 组（结构自检）", () => {
    // 从定义表反推：observe-only 类别只允许出现在 observe_only_product 组。
    for (const def of metricDefinitions) {
      if (def.category === "observe-only") {
        assert.equal(def.group, "observe_only_product");
      }
    }
    // observation 指标不得挂在 observe_only_product 组下。
    for (const def of metricDefinitions) {
      if (def.group === "observe_only_product") {
        assert.equal(def.category, "observe-only");
      }
    }
  });

  it("distribution 指标有非空 buckets 且值合法", () => {
    for (const def of metricDefinitions) {
      if (def.kind === "distribution") {
        assert.ok(def.buckets.length > 0);
        // 桶名冻结、唯一、非空。
        assert.equal(new Set(def.buckets).size, def.buckets.length);
        assert.ok(def.buckets.every((b) => b.length > 0));
      }
    }
  });
});

// ─── 2. 观察 vs 硬 Gate 分离（§16.4 §5.2 / §16.6）──────────────────────────

describe("metrics-schema: 观察 vs 硬 Gate 分离", () => {
  it("§16.4 §5.2 全部 6 种强迫优化手段均被冻结为非法授权", () => {
    assert.deepEqual(
      [...COERCIVE_MECHANISMS].sort(),
      ["auto_advance", "companion_nudge", "extra_modal", "hide_skip", "streak", "task_debt"].sort(),
    );
    assert.ok(COERCIVE_MECHANISMS.every((m) => isCoerciveMechanism(m)));
    assert.equal(isCoerciveMechanism("not-a-mechanism"), false);
  });

  it("observe-only 指标（onboarding 完成率等 7 项）被授权任何强迫优化都判违规", () => {
    const observeOnlyIds = metricDefinitions
      .filter((d) => d.category === "observe-only")
      .map((d) => d.id);
    assert.equal(observeOnlyIds.length, 7);
    for (const id of observeOnlyIds) {
      for (const mechanism of COERCIVE_MECHANISMS) {
        const violations = checkCoerciveAuthorization(id, [mechanism]);
        assert.ok(
          violations.length > 0,
          `${id} 授权 ${mechanism} 必须违规`,
        );
        assert.ok(violations[0].includes("不得授权强迫优化"));
      }
    }
  });

  it("observation 观察指标（如 onboarding 分布）也不得授权强迫优化", () => {
    for (const id of ["onboarding_started", "companion_summoned", "asr_not_assessable_rate"]) {
      assert.deepEqual(checkCoerciveAuthorization(id, ["hide_skip"]).length > 0, true);
    }
  });

  it("观察指标未被授权时通过（空授权列表）", () => {
    for (const id of ["onboarding_started", "onboarding_completion_rate", "dau"]) {
      assert.deepEqual(checkCoerciveAuthorization(id, []), []);
    }
  });

  it("hard-gate 指标不具「授权强迫优化」语义，永不违规", () => {
    for (const def of metricDefinitions) {
      if (def.category === "hard-gate") {
        assert.deepEqual(checkCoerciveAuthorization(def.id, ["streak", "auto_advance"]), []);
      }
    }
  });

  it("未知强迫优化手段被识别为非法参数", () => {
    const violations = checkCoerciveAuthorization("dau", ["not-a-thing"]);
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("未知强迫优化手段"));
  });

  it("assertObservationOnlyMetric 对非 observe-only 指标 fail closed", () => {
    assert.doesNotThrow(() => assertObservationOnlyMetric("dau"));
    assert.throws(() => assertObservationOnlyMetric("onboarding_started"), MetricSchemaError);
    assert.throws(() => assertObservationOnlyMetric("user_cost_p50"), MetricSchemaError);
    assert.throws(() => assertObservationOnlyMetric("hidden_off_zero_new_cost"), MetricSchemaError);
  });
});

// ─── 3. 分布 / 比例计算 ────────────────────────────────────────────────────

describe("metrics-schema: 分布与比例计算", () => {
  it("normalizeDistribution 归一化到总和 1（确定性）", () => {
    const r = normalizeDistribution("onboarding_started", [10, 5, 2, 3, 4]);
    assert.equal(r.ok, true);
    const sum = r.normalized.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.deepEqual(r.normalized[0], 10 / 24);
  });

  it("分布桶数不符 / 负计数 fail closed", () => {
    const wrongCount = normalizeDistribution("onboarding_started", [1, 2, 3]);
    assert.equal(wrongCount.ok, false);
    assert.ok(wrongCount.problems[0].includes("桶数不符"));
    const negative = normalizeDistribution("onboarding_started", [1, -2, 3, 4, 5]);
    assert.equal(negative.ok, false);
    assert.ok(negative.problems[0].includes("负计数"));
  });

  it("分布全零输入确定性返回全零（不产生 NaN）", () => {
    const r = normalizeDistribution("modality_distribution", [0, 0, 0, 0]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized, [0, 0, 0, 0]);
  });

  it("对非 distribution 指标调用归一化 fail closed", () => {
    const r = normalizeDistribution("dau", [1, 2]);
    assert.equal(r.ok, false);
    assert.ok(r.problems[0].includes("不是 distribution 指标"));
  });

  it("computeRatio 分母为 0 确定性返回 0", () => {
    assert.equal(computeRatio(3, 10), 0.3);
    assert.equal(computeRatio(0, 0), 0);
    assert.equal(computeRatio(5, 0), 0);
    assert.equal(computeRatio(5, -1), 0);
    assert.equal(computeRatio(Number.NaN, 10), 0);
  });
});

// ─── 4. 成本计算（§16.6）───────────────────────────────────────────────────

describe("metrics-schema: 成本计算", () => {
  it("sumCostSamples 确定性聚合（每 Session/Episode 汇总）", () => {
    const total = sumCostSamples([
      sample({ llmCalls: 3, inputTokens: 1000, asrSeconds: 30 }),
      sample({ llmCalls: 2, inputTokens: 500, ttsCharacters: 120 }),
    ]);
    assert.equal(total.llmCalls, 5);
    assert.equal(total.inputTokens, 1500);
    assert.equal(total.asrSeconds, 30);
    assert.equal(total.ttsCharacters, 120);
    assert.equal(total.objectStorageBytes, 0);
  });

  it("空样本聚合为零成本", () => {
    assert.deepEqual(sumCostSamples([]), ZERO_COST);
  });

  it("computePercentile 确定性（R7 线性插值）", () => {
    assert.equal(computePercentile([], 0.5), 0);
    assert.equal(computePercentile([7], 0.95), 7);
    const vals = [1, 2, 3, 4];
    // p50 R7: rank=1.5 → (2+3)/2=2.5
    assert.equal(computePercentile(vals, 0.5), 2.5);
    // p0 / p100
    assert.equal(computePercentile(vals, 0), 1);
    assert.equal(computePercentile(vals, 1), 4);
    // 同一输入恒得同一输出（确定性）
    const p50a = computePercentile([9, 1, 5, 3, 7], 0.5);
    const p50b = computePercentile([9, 1, 5, 3, 7], 0.5);
    assert.equal(p50a, p50b);
  });

  it("computeUserCostPercentile 计算用户级 p50/p95（按维度）", () => {
    const users = [
      sample({ llmCalls: 10 }),
      sample({ llmCalls: 20 }),
      sample({ llmCalls: 30 }),
      sample({ llmCalls: 40 }),
    ];
    // p50: rank=1.5 → (20+30)/2=25
    assert.equal(computeUserCostPercentile(users, "llmCalls", 0.5), 25);
    // p95: rank=2.85 → 30 + (40-30)*0.85 = 38.5
    assert.equal(computeUserCostPercentile(users, "llmCalls", 0.95), 38.5);
  });

  it("computeRetryAmplification = billed/unique，合法时 ≤1 不违规", () => {
    assert.equal(computeRetryAmplification(10, 10), 1);
    assert.equal(computeRetryAmplification(10, 12), 1.2);
    assert.equal(computeRetryAmplification(0, 0), 0);
    assert.equal(computeRetryAmplification(0, 5), 0);
    assert.equal(computeRetryAmplification(10, -1), 0);
  });

  it("重试放大系数超冻结上限判违规；未超通过", () => {
    assert.deepEqual(checkRetryAmplificationUnderCap(10, 12), []);
    const violations = checkRetryAmplificationUnderCap(10, 20);
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("超过冻结上限"));
  });
});

// ─── 5. hidden/off 后成本为 0（§16.6 硬 Gate）──────────────────────────────

describe("metrics-schema: hidden/off 后新增成本为 0", () => {
  it("hidden/off 确认后零新增成本通过", () => {
    assert.deepEqual(checkHiddenOffZeroNewCost([], "hidden_off"), []);
    assert.deepEqual(checkHiddenOffZeroNewCost([ZERO_COST], "hidden_off"), []);
  });

  it("hidden/off 确认后任一维度新增成本 >0 判违规", () => {
    const violations = checkHiddenOffZeroNewCost(
      [sample({ llmCalls: 1 })],
      "hidden_off",
    );
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("hidden/off 确认后新增成本必须为 0"));
    assert.ok(violations[0].includes("llmCalls=1"));
  });

  it("用户取消被服务端确认后新增调用必须为 0", () => {
    assert.deepEqual(checkHiddenOffZeroNewCost([ZERO_COST], "cancel_confirmed"), []);
    const violations = checkHiddenOffZeroNewCost(
      [sample({ asrSeconds: 12 })],
      "cancel_confirmed",
    );
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("用户取消确认后"));
  });

  it("isZeroCost 判定", () => {
    assert.equal(isZeroCost(ZERO_COST), true);
    assert.equal(isZeroCost(sample({ ttsCharacters: 1 })), false);
  });

  it("Tutor 独立预算不借用 formal reserve", () => {
    assert.deepEqual(checkTutorFormalBudgetIsolation(sample({ tutorBudgetUnits: 5 }), 0), []);
    const violations = checkTutorFormalBudgetIsolation(sample(), 3);
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("Tutor 借用 formal assessment 预算"));
  });

  it("p95 成本超上限判违规；未超通过；质量缩减绕过一律违规", () => {
    const users = [sample({ llmCalls: 100 })];
    assert.deepEqual(
      checkP95CostCap(users, { llmCalls: 150 }),
      [],
    );
    const violations = checkP95CostCap(users, { llmCalls: 50 });
    assert.ok(violations.length === 1);
    assert.ok(violations[0].includes("p95 llmCalls"));
    const bypass = checkP95CostCap(users, { llmCalls: 150 }, true);
    assert.ok(bypass.length === 1);
    assert.ok(bypass[0].includes("缩减 Critic/证据/A11y 绕过"));
  });
});

// ─── 6. 冻结枚举的完整性与确定性 ───────────────────────────────────────────

describe("metrics-schema: 冻结枚举完整性", () => {
  it("COST_DIMENSIONS 与 CostSample 字段一一对应", () => {
    const fields = Object.keys(ZERO_COST) as (keyof CostSample)[];
    assert.deepEqual([...COST_DIMENSIONS].sort(), [...fields].sort());
  });

  it("定义表 id 唯一（确定性字典）", () => {
    const ids = metricDefinitions.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("每个成本维度都可由 checkP95CostCap 独立设上限", () => {
    const caps: Partial<Record<(typeof COST_DIMENSIONS)[number], number>> = {};
    for (const dim of COST_DIMENSIONS) caps[dim] = Number.MAX_SAFE_INTEGER;
    assert.deepEqual(checkP95CostCap([sample({ llmCalls: 1 })], caps), []);
  });
});
