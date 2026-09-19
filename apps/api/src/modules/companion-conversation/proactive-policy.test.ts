/**
 * P8 Policy Engine 纯函数测试（文档 16 §10.2）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDismissalFeedback,
  evaluateProactivePolicy,
  POLICY_LIMITS,
  type ProactivePolicyInput,
} from "./proactive-policy.ts";

function base(): ProactivePolicyInput {
  return {
    availability: "online",
    interventionLevel: "moderate",
    formalAnswerInProgress: false,
    msSinceLastShown: null,
    recentShownCount: 0,
    dailyShownTotal: 0,
    expired: false,
    now: Date.now(),
  };
}

test("DND / offline / formal_answer / expired 全部抑制（最高优先级）", () => {
  assert.equal(evaluateProactivePolicy({ ...base(), availability: "dnd" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), availability: "offline" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), formalAnswerInProgress: true }).reasonCode, "formal_answer_in_progress");
  assert.equal(evaluateProactivePolicy({ ...base(), expired: true }).reasonCode, "expired");
});

test("quiet/moderate 单日预算独立", () => {
  assert.equal(
    evaluateProactivePolicy({
      ...base(),
      interventionLevel: "quiet",
      dailyShownTotal: POLICY_LIMITS.quietDailyLimit,
    }).reasonCode,
    "quiet_budget_exhausted",
  );
  // moderate 预算更高：quiet 满额在 moderate 下仍允许。
  assert.equal(
    evaluateProactivePolicy({
      ...base(),
      interventionLevel: "moderate",
      dailyShownTotal: POLICY_LIMITS.quietDailyLimit,
    }).allow,
    true,
  );
  assert.equal(
    evaluateProactivePolicy({
      ...base(),
      dailyShownTotal: POLICY_LIMITS.moderateDailyLimit,
    }).reasonCode,
    "quiet_budget_exhausted",
  );
});

test("dedupe 冷却窗口与窗口内次数上限", () => {
  assert.equal(
    evaluateProactivePolicy({ ...base(), msSinceLastShown: 10 * 60 * 1000 }).reasonCode,
    "cooldown",
  );
  assert.equal(
    evaluateProactivePolicy({ ...base(), msSinceLastShown: POLICY_LIMITS.moderateCooldownMs }).allow,
    true,
  );
  // active 间隔更短（15 分钟）：10 分钟前展示在 active 下仍处于冷却。
  assert.equal(
    evaluateProactivePolicy({
      ...base(),
      interventionLevel: "active",
      msSinceLastShown: 10 * 60 * 1000,
    }).reasonCode,
    "cooldown",
  );
  // active 满间隔后允许。
  assert.equal(
    evaluateProactivePolicy({
      ...base(),
      interventionLevel: "active",
      msSinceLastShown: POLICY_LIMITS.activeCooldownMs,
    }).allow,
    true,
  );
  assert.equal(
    evaluateProactivePolicy({ ...base(), recentShownCount: POLICY_LIMITS.dedupeWindowLimit }).reasonCode,
    "dedupe_recent",
  );
});

test("全通过 → allowed", () => {
  assert.deepEqual(evaluateProactivePolicy(base()), { allow: true, reasonCode: "allowed" });
});

// ── 展示反馈进生成（念头管线切片①，2026-09-18） ──────────────────────────

test("反馈判定：最近 3 条送达里 dismiss ≥2 → 沉默", () => {
  assert.equal(evaluateDismissalFeedback(["dismissed", "dismissed", "acted"]).suppress, true);
  assert.equal(evaluateDismissalFeedback(["dismissed", "acted", "dismissed"]).suppress, true);
});

test("反馈判定：dismiss 不足阈值或窗口为空 → 不沉默", () => {
  assert.equal(evaluateDismissalFeedback(["dismissed", "acted", "acted"]).suppress, false);
  assert.equal(evaluateDismissalFeedback(["dismissed"]).suppress, false);
  assert.equal(evaluateDismissalFeedback([]).suppress, false);
  // 超出窗口的旧 dismiss 不参与
  assert.equal(evaluateDismissalFeedback(["acted", "acted", "acted", "dismissed", "dismissed"]).suppress, false);
});

test("反馈判定：只看传入的已送达状态，未读状态由调用方过滤", () => {
  // 传入 queued/delivered 不是本函数的合同——调用方 SQL 只取 displayed/acted/dismissed。
  assert.equal(evaluateDismissalFeedback(["queued", "delivered", "dismissed"]).suppress, false);
});
