/**
 * P8 Policy Engine 纯函数测试（文档 16 §10.2）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDismissalFeedback,
  evaluateProactivePolicy,
  isWithinQuietHours,
  POLICY_LIMITS,
  proactiveDailyLimit,
  type ProactivePolicyInput,
} from "./companion-proactive-policy.ts";

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
    "daily_budget_exhausted",
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
    "daily_budget_exhausted",
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

test("安静档是「少而轻」，不是结构上永不为零（抱怨 #8）", () => {
  // quietDailyLimit 曾是 0：设成安静之后，主动提醒在结构上永远不会发生，
  // 而界面上并没有"关闭主动提醒"这个开关，只有一档写着"安静"。
  assert.equal(POLICY_LIMITS.quietDailyLimit, 1);
  const first = evaluateProactivePolicy({ ...base(), interventionLevel: "quiet" });
  assert.deepEqual([first.allow, first.reasonCode], [true, "allowed"]);
  const second = evaluateProactivePolicy({ ...base(), interventionLevel: "quiet", dailyShownTotal: 1 });
  assert.deepEqual([second.allow, second.reasonCode], [false, "daily_budget_exhausted"]);
  // 三档额度都从同一个映射取（worker 的念头管线也走它）。
  assert.deepEqual(
    (["quiet", "moderate", "active"] as const).map(proactiveDailyLimit),
    [1, 3, 6],
  );
});

test("静默时段：跨午夜环绕、24:00 归一、坏配置一律不打扰", () => {
  const now = new Date("2026-09-18T18:30:00Z"); // UTC 18:30
  assert.equal(isWithinQuietHours({ startLocal: "23:00", endLocal: "07:00", timezone: "UTC" }, now), false);
  assert.equal(isWithinQuietHours({ startLocal: "17:00", endLocal: "20:00", timezone: "UTC" }, now), true);
  // start === end 是全时段静默，不是"零时长窗口"
  assert.equal(isWithinQuietHours({ startLocal: "00:00", endLocal: "00:00", timezone: "UTC" }, now), true);
  // 时区非法 → fail closed（这条是统一的意义所在：api 那份曾经返回"不在静默时段"，
  // 于是配置一坏就半夜照发）
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Not/AZone" }, now), true);
  // 钟面值越界同样按静默处理，而不是"当成没配"
  assert.equal(isWithinQuietHours({ startLocal: "25:00", endLocal: "07:00", timezone: "UTC" }, now), true);
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:60", timezone: "UTC" }, now), true);
  // 24:00 与 00:00 同义
  assert.equal(isWithinQuietHours({ startLocal: "24:00", endLocal: "07:00", timezone: "UTC" }, new Date("2026-09-18T02:00:00Z")), true);
});

test("本地钟面按账号时区判定，不是按 UTC", () => {
  // 北京 22:30 = UTC 14:30：静默窗 22:00–07:00 必须命中（按 UTC 判会漏掉整晚）。
  const utcAfternoon = new Date("2026-09-18T14:30:00Z");
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" }, utcAfternoon), true);
  // 北京 09:30 = UTC 01:30：静默窗不该命中（按 UTC 判反而会说"在静默时段"）。
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" }, new Date("2026-09-18T01:30:00Z")), false);
});

test("反馈降权：最近 3 条里 dismiss ≥2 → 沉默（两条链路同一个规则）", () => {
  assert.equal(evaluateDismissalFeedback(["dismissed", "dismissed", "acted"]).suppress, true);
  assert.equal(evaluateDismissalFeedback(["dismissed", "acted", "acted"]).suppress, false);
  assert.equal(evaluateDismissalFeedback([]).suppress, false);
  // 窗口只看最近 3 条：更早的两次 dismiss 不该永久沉默
  assert.equal(evaluateDismissalFeedback(["acted", "acted", "acted", "dismissed", "dismissed"]).suppress, false);
});
