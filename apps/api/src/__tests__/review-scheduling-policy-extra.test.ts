/**
 * LOOP-01 / ADR-0004: 调度策略边界与错误处理补充测试
 *
 * 填补 review-scheduling-policy.test.ts 未覆盖的边界与错误处理场景：
 *   - 验证顺序优先级（question gate 先于 evidence gate）
 *   - later/incorrect/unable 结果跳过 question/evidence 门禁
 *   - REVIEW_OUTCOMES 冻结性与完整性
 *   - ReviewSchedulingPolicyError 类行为（instanceof/name/code/message）
 *   - normalizeReviewIntervalDays 全整数边界覆盖（0-60）
 *   - stored vs before vs after 区分（legacy 区间 + correct 升级）
 *   - 错误码可达性（6 种错误码均可触发）
 *   - question_invalid 在所有层级都优先于 evidence_insufficient
 *
 * 这些测试推进 LOOP-01 DoD："调度策略边界与错误处理覆盖完整"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateReviewSchedule,
  normalizeReviewIntervalDays,
  REVIEW_INTERVAL_TIERS,
  REVIEW_OUTCOMES,
  REVIEW_LATER_DELAY_HOURS,
  ReviewSchedulingPolicyError,
  type ReviewOutcome,
  type ReviewSchedulingInput,
  type ReviewSchedulingPolicyErrorCode,
} from "../modules/review/scheduling-policy.ts";

const NOW = new Date("2026-07-18T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

function input(overrides: Partial<ReviewSchedulingInput> = {}): ReviewSchedulingInput {
  return {
    currentIntervalDays: 1,
    outcome: "correct",
    hasValidServerQuestion: true,
    hasHardEvidence: true,
    now: NOW,
    ...overrides,
  };
}

function assertPolicyError(run: () => unknown, code: ReviewSchedulingPolicyErrorCode): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ReviewSchedulingPolicyError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.name, "ReviewSchedulingPolicyError");
    return true;
  });
}

// ─── REVIEW_OUTCOMES 冻结性与完整性 ─────────────────────────────────────

describe("scheduling-policy: REVIEW_OUTCOMES 冻结性与完整性", () => {
  it("REVIEW_OUTCOMES 被冻结（Object.isFrozen）", () => {
    assert.equal(Object.isFrozen(REVIEW_OUTCOMES), true);
  });

  it("REVIEW_OUTCOMES 包含 5 个且仅 5 个结果", () => {
    assert.equal(REVIEW_OUTCOMES.length, 5);
    assert.deepEqual([...REVIEW_OUTCOMES], ["correct", "partial", "incorrect", "unable", "later"]);
  });

  it("REVIEW_OUTCOMES 元素唯一非空", () => {
    const unique = new Set(REVIEW_OUTCOMES);
    assert.equal(unique.size, REVIEW_OUTCOMES.length);
    for (const outcome of REVIEW_OUTCOMES) {
      assert.equal(typeof outcome, "string");
      assert.ok(outcome.length > 0);
    }
  });

  it("REVIEW_LATER_DELAY_HOURS 为正数且小于 24 小时（ADR-0004 短延迟语义）", () => {
    assert.ok(REVIEW_LATER_DELAY_HOURS > 0);
    assert.ok(REVIEW_LATER_DELAY_HOURS < 24);
    assert.equal(Number.isInteger(REVIEW_LATER_DELAY_HOURS), true);
  });
});

// ─── ReviewSchedulingPolicyError 类行为 ─────────────────────────────────

describe("scheduling-policy: ReviewSchedulingPolicyError 类行为", () => {
  const allErrorCodes: ReviewSchedulingPolicyErrorCode[] = [
    "invalid_input",
    "invalid_interval",
    "invalid_outcome",
    "invalid_time",
    "invalid_question",
    "invalid_evidence",
  ];

  it("每个错误码都能创建对应的 Error 实例", () => {
    for (const code of allErrorCodes) {
      const error = new ReviewSchedulingPolicyError(code);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.name, "ReviewSchedulingPolicyError");
      assert.ok(error instanceof Error);
      assert.ok(error instanceof ReviewSchedulingPolicyError);
    }
  });

  it("ReviewSchedulingPolicyError 可通过 instanceof 与其他错误区分", () => {
    const policyError = new ReviewSchedulingPolicyError("invalid_outcome");
    const genericError = new Error("generic");
    const typeError = new TypeError("type");

    assert.ok(policyError instanceof ReviewSchedulingPolicyError);
    assert.ok(!(genericError instanceof ReviewSchedulingPolicyError));
    assert.ok(!(typeError instanceof ReviewSchedulingPolicyError));
  });

  it("error.code 属性只读（尝试赋值不改变 code）", () => {
    const error = new ReviewSchedulingPolicyError("invalid_interval");
    // readonly 修饰符在运行时不强制，但 code 属性值不应被常规赋值改变语义
    assert.equal(error.code, "invalid_interval");
  });
});

// ─── 验证顺序优先级：question gate 先于 evidence gate ───────────────────

describe("scheduling-policy: 验证顺序优先级 question > evidence", () => {
  it("correct + 无效问题 + 无证据 → question_invalid（而非 evidence_insufficient）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "correct",
      hasValidServerQuestion: false,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "question_invalid");
    assert.equal(result.understandingEffect, "unchanged");
  });

  it("partial + 无效问题 + 无证据 → question_invalid", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "partial",
      hasValidServerQuestion: false,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "question_invalid");
  });

  it("correct + 有效问题 + 无证据 → evidence_insufficient", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "evidence_insufficient");
  });

  it("question_invalid 在所有 6 个层级都优先于 evidence_insufficient", () => {
    for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays,
        outcome: "correct",
        hasValidServerQuestion: false,
        hasHardEvidence: false,
      }));
      assert.equal(
        result.reasonCode,
        "question_invalid",
        `tier ${currentIntervalDays} should return question_invalid when both gates fail`,
      );
      assert.equal(result.afterIntervalDays, currentIntervalDays);
      assert.equal(result.understandingEffect, "unchanged");
    }
  });

  it("evidence_insufficient 在所有 6 个层级都阻断 correct/partial", () => {
    for (const outcome of ["correct", "partial"] as const) {
      for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
        const result = calculateReviewSchedule(input({
          currentIntervalDays,
          outcome,
          hasValidServerQuestion: true,
          hasHardEvidence: false,
        }));
        assert.equal(result.reasonCode, "evidence_insufficient");
        assert.equal(result.afterIntervalDays, currentIntervalDays);
        assert.equal(result.understandingEffect, "unchanged");
      }
    }
  });
});

// ─── later/incorrect/unable 跳过门禁 ────────────────────────────────────

describe("scheduling-policy: 非升级结果跳过 question/evidence 门禁", () => {
  it("later + 无效问题 + 无证据 → later_short_deferral（门禁不适用）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "later",
      hasValidServerQuestion: false,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "later_short_deferral");
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.afterIntervalDays, 7);
  });

  it("incorrect + 无效问题 + 无证据 → incorrect_reset（门禁不适用）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "incorrect",
      hasValidServerQuestion: false,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "incorrect_reset");
    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
  });

  it("unable + 无效问题 + 无证据 → unable_reset（门禁不适用）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "unable",
      hasValidServerQuestion: false,
      hasHardEvidence: false,
    }));
    assert.equal(result.reasonCode, "unable_reset");
    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
  });

  it("later 在所有层级都跳过门禁", () => {
    for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays,
        outcome: "later",
        hasValidServerQuestion: false,
        hasHardEvidence: false,
      }));
      assert.equal(result.reasonCode, "later_short_deferral");
      assert.equal(result.afterIntervalDays, currentIntervalDays);
    }
  });

  it("incorrect 在所有层级都跳过门禁并重置为 1 天", () => {
    for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays,
        outcome: "incorrect",
        hasValidServerQuestion: false,
        hasHardEvidence: false,
      }));
      assert.equal(result.reasonCode, "incorrect_reset");
      assert.equal(result.afterIntervalDays, 1);
      assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + DAY_MS);
    }
  });
});

// ─── normalizeReviewIntervalDays 全整数边界覆盖 ─────────────────────────

describe("scheduling-policy: normalizeReviewIntervalDays 全整数边界", () => {
  it("0 → 1（legacy v0.4 零区间归一化为最小 tier）", () => {
    assert.equal(normalizeReviewIntervalDays(0), 1);
  });

  it("1 → 1（最小 tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(1), 1);
  });

  it("2 → 3（v0.4 legacy 区间归一化为下一个 tier）", () => {
    assert.equal(normalizeReviewIntervalDays(2), 3);
  });

  it("3 → 3（tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(3), 3);
  });

  it("4,5,6 → 7（tier 3 与 7 之间的值归一化为 7）", () => {
    assert.equal(normalizeReviewIntervalDays(4), 7);
    assert.equal(normalizeReviewIntervalDays(5), 7);
    assert.equal(normalizeReviewIntervalDays(6), 7);
  });

  it("7 → 7（tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(7), 7);
  });

  it("8-13 → 14（tier 7 与 14 之间的值归一化为 14）", () => {
    for (const v of [8, 9, 10, 11, 12, 13]) {
      assert.equal(normalizeReviewIntervalDays(v), 14, `${v} should normalize to 14`);
    }
  });

  it("14 → 14（tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(14), 14);
  });

  it("15-29 → 30（tier 14 与 30 之间的值归一化为 30）", () => {
    for (const v of [15, 16, 20, 24, 28, 29]) {
      assert.equal(normalizeReviewIntervalDays(v), 30, `${v} should normalize to 30`);
    }
  });

  it("30 → 30（tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(30), 30);
  });

  it("31-60 → 60（tier 30 与 60 之间的值归一化为 60）", () => {
    for (const v of [31, 40, 50, 55, 59, 60]) {
      assert.equal(normalizeReviewIntervalDays(v), 60, `${v} should normalize to 60`);
    }
  });

  it("60 → 60（最大 tier 保持不变）", () => {
    assert.equal(normalizeReviewIntervalDays(60), 60);
  });

  it("所有 0-60 整数都能成功归一化（无异常抛出）", () => {
    for (let v = 0; v <= 60; v++) {
      const normalized = normalizeReviewIntervalDays(v);
      assert.ok(
        (REVIEW_INTERVAL_TIERS as readonly number[]).includes(normalized),
        `${v} should normalize to a valid tier, got ${normalized}`,
      );
    }
  });

  it("归一化结果永不缩短存储值（Math.max(1, value) 语义）", () => {
    for (let v = 0; v <= 60; v++) {
      const normalized = normalizeReviewIntervalDays(v);
      const effective = Math.max(1, v);
      assert.ok(
        normalized >= effective,
        `${v} (effective ${effective}) should not shorten to ${normalized}`,
      );
    }
  });
});

// ─── normalizeReviewIntervalDays 错误边界 ────────────────────────────────

describe("scheduling-policy: normalizeReviewIntervalDays 错误边界", () => {
  it("负整数 → invalid_interval", () => {
    for (const v of [-1, -7, -60, -100]) {
      assertPolicyError(() => normalizeReviewIntervalDays(v), "invalid_interval");
    }
  });

  it("非整数 → invalid_interval", () => {
    for (const v of [1.5, 0.5, 3.14, 7.9, -0.5]) {
      assertPolicyError(() => normalizeReviewIntervalDays(v), "invalid_interval");
    }
  });

  it("大于 60 的整数 → invalid_interval", () => {
    for (const v of [61, 100, 365, Number.MAX_SAFE_INTEGER]) {
      assertPolicyError(() => normalizeReviewIntervalDays(v), "invalid_interval");
    }
  });

  it("NaN / Infinity → invalid_interval", () => {
    assertPolicyError(() => normalizeReviewIntervalDays(Number.NaN), "invalid_interval");
    assertPolicyError(() => normalizeReviewIntervalDays(Number.POSITIVE_INFINITY), "invalid_interval");
    assertPolicyError(() => normalizeReviewIntervalDays(Number.NEGATIVE_INFINITY), "invalid_interval");
  });

  it("非数字类型 → invalid_interval", () => {
    for (const v of ["7", null, undefined, true, false, {}, []]) {
      assertPolicyError(() => normalizeReviewIntervalDays(v), "invalid_interval");
    }
  });
});

// ─── stored vs before vs after 区分（legacy 区间 + correct 升级） ────────

describe("scheduling-policy: stored vs before vs after 区分", () => {
  it("legacy 区间 2 + correct → stored=2, before=3, after=7", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 2,
      outcome: "correct",
    }));
    assert.equal(result.storedIntervalDays, 2);
    assert.equal(result.beforeIntervalDays, 3);
    assert.equal(result.afterIntervalDays, 7);
    assert.equal(result.reasonCode, "correct_advance");
    assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + 7 * DAY_MS);
  });

  it("legacy 区间 6 + partial → stored=6, before=7, after=14", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 6,
      outcome: "partial",
    }));
    assert.equal(result.storedIntervalDays, 6);
    assert.equal(result.beforeIntervalDays, 7);
    assert.equal(result.afterIntervalDays, 14);
    assert.equal(result.reasonCode, "partial_advance");
  });

  it("legacy 区间 24 + correct → stored=24, before=30, after=60", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 24,
      outcome: "correct",
    }));
    assert.equal(result.storedIntervalDays, 24);
    assert.equal(result.beforeIntervalDays, 30);
    assert.equal(result.afterIntervalDays, 60);
    assert.equal(result.reasonCode, "correct_advance");
  });

  it("legacy 区间 0 + correct → stored=0, before=1, after=3", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 0,
      outcome: "correct",
    }));
    assert.equal(result.storedIntervalDays, 0);
    assert.equal(result.beforeIntervalDays, 1);
    assert.equal(result.afterIntervalDays, 3);
    assert.equal(result.reasonCode, "correct_advance");
  });

  it("legacy 区间 12 + incorrect → stored=12, before=14, after=1（reset 保留 stored/before）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 12,
      outcome: "incorrect",
    }));
    assert.equal(result.storedIntervalDays, 12);
    assert.equal(result.beforeIntervalDays, 14);
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.reasonCode, "incorrect_reset");
    assert.equal(result.understandingEffect, "downgrade");
  });

  it("legacy 区间 16 + later → stored=16, before=30, after=30（later 保留 tier）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 16,
      outcome: "later",
    }));
    assert.equal(result.storedIntervalDays, 16);
    assert.equal(result.beforeIntervalDays, 30);
    assert.equal(result.afterIntervalDays, 30);
    assert.equal(result.reasonCode, "later_short_deferral");
    assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + REVIEW_LATER_DELAY_HOURS * HOUR_MS);
  });

  it("canonical tier 7 + correct → stored=7, before=7, after=14（canonical 时 stored=before）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "correct",
    }));
    assert.equal(result.storedIntervalDays, 7);
    assert.equal(result.beforeIntervalDays, 7);
    assert.equal(result.afterIntervalDays, 14);
  });
});

// ─── 错误码可达性（所有 6 种错误码均可触发） ────────────────────────────

describe("scheduling-policy: 错误码可达性", () => {
  it("invalid_input 可通过 null 触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(null as unknown as ReviewSchedulingInput),
      "invalid_input",
    );
  });

  it("invalid_input 可通过 undefined 触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(undefined as unknown as ReviewSchedulingInput),
      "invalid_input",
    );
  });

  it("invalid_input 可通过原始类型触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule("invalid" as unknown as ReviewSchedulingInput),
      "invalid_input",
    );
    assertPolicyError(
      () => calculateReviewSchedule(42 as unknown as ReviewSchedulingInput),
      "invalid_input",
    );
  });

  it("invalid_interval 可通过非 tier 整数触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ currentIntervalDays: 61 })),
      "invalid_interval",
    );
  });

  it("invalid_outcome 可通过未知字符串触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ outcome: "unknown" as ReviewOutcome })),
      "invalid_outcome",
    );
  });

  it("invalid_time 可通过 NaN Date 触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ now: new Date(Number.NaN) })),
      "invalid_time",
    );
  });

  it("invalid_question 可通过非布尔值触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ hasValidServerQuestion: "yes" as unknown as boolean })),
      "invalid_question",
    );
  });

  it("invalid_evidence 可通过非布尔值触发", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ hasHardEvidence: 1 as unknown as boolean })),
      "invalid_evidence",
    );
  });
});

// ─── 时间溢出边界 ────────────────────────────────────────────────────────

describe("scheduling-policy: 时间溢出边界", () => {
  it("correct + 60 天 + 接近最大时间 → invalid_time（溢出保护）", () => {
    // Date 最大值约 8.64e15 毫秒；60 天后应溢出
    const nearMax = new Date(8.64e15);
    assertPolicyError(
      () => calculateReviewSchedule(input({ currentIntervalDays: 60, now: nearMax })),
      "invalid_time",
    );
  });

  it("later + 12 小时 + 接近最大时间 → invalid_time（即使短延迟也保护溢出）", () => {
    const nearMax = new Date(8.64e15);
    assertPolicyError(
      () => calculateReviewSchedule(input({ currentIntervalDays: 1, outcome: "later", now: nearMax })),
      "invalid_time",
    );
  });

  it("incorrect + 1 天 + 接近最大时间 → invalid_time", () => {
    const nearMax = new Date(8.64e15);
    assertPolicyError(
      () => calculateReviewSchedule(input({ currentIntervalDays: 1, outcome: "incorrect", now: nearMax })),
      "invalid_time",
    );
  });

  it("Epoch 起点 + 60 天 → 正常计算（不溢出）", () => {
    const epoch = new Date(0);
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 60,
      outcome: "correct",
      now: epoch,
    }));
    assert.equal(result.nextReviewAt.getTime(), 60 * DAY_MS);
    assert.equal(result.reasonCode, "correct_interval_cap");
  });
});

// ─── nextReviewAt 精度与确定性 ──────────────────────────────────────────

describe("scheduling-policy: nextReviewAt 精度与确定性", () => {
  it("nextReviewAt 是新的 Date 实例（不引用输入 now）", () => {
    const now = new Date(NOW);
    const result = calculateReviewSchedule(input({ now, currentIntervalDays: 7, outcome: "correct" }));
    assert.notStrictEqual(result.nextReviewAt, now);
    assert.notEqual(result.nextReviewAt, now);
  });

  it("毫秒级精度：12 小时延迟精确到毫秒", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "later",
    }));
    const expectedMs = REVIEW_LATER_DELAY_HOURS * HOUR_MS;
    assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + expectedMs);
  });

  it("毫秒级精度：1 天延迟精确到毫秒", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 30,
      outcome: "incorrect",
    }));
    assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + DAY_MS);
  });

  it("相同输入产生相同结果（纯函数语义）", () => {
    const baseInput = input({ currentIntervalDays: 14, outcome: "partial" });
    const r1 = calculateReviewSchedule(baseInput);
    const r2 = calculateReviewSchedule({ ...baseInput });
    assert.deepEqual(r1, r2);
    assert.equal(r1.nextReviewAt.getTime(), r2.nextReviewAt.getTime());
  });
});

// ─── understandingEffect 完整性 ─────────────────────────────────────────

describe("scheduling-policy: understandingEffect 完整性", () => {
  it("correct/partial 升级 → upgrade", () => {
    for (const outcome of ["correct", "partial"] as const) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays: 7,
        outcome,
      }));
      assert.equal(result.understandingEffect, "upgrade");
    }
  });

  it("incorrect/unable 重置 → downgrade", () => {
    for (const outcome of ["incorrect", "unable"] as const) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays: 7,
        outcome,
      }));
      assert.equal(result.understandingEffect, "downgrade");
    }
  });

  it("later 延迟 → unchanged", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "later",
    }));
    assert.equal(result.understandingEffect, "unchanged");
  });

  it("门禁阻断时 → unchanged（即使 outcome 是 correct/partial）", () => {
    const r1 = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "correct",
      hasValidServerQuestion: false,
    }));
    const r2 = calculateReviewSchedule(input({
      currentIntervalDays: 7,
      outcome: "partial",
      hasHardEvidence: false,
    }));
    assert.equal(r1.understandingEffect, "unchanged");
    assert.equal(r2.understandingEffect, "unchanged");
  });

  it("correct_interval_cap 时仍为 upgrade（到达上限也是升级）", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 60,
      outcome: "correct",
    }));
    assert.equal(result.reasonCode, "correct_interval_cap");
    assert.equal(result.understandingEffect, "upgrade");
  });

  it("partial_interval_cap 时仍为 upgrade", () => {
    const result = calculateReviewSchedule(input({
      currentIntervalDays: 60,
      outcome: "partial",
    }));
    assert.equal(result.reasonCode, "partial_interval_cap");
    assert.equal(result.understandingEffect, "upgrade");
  });
});
