/**
 * P8 Policy Engine 纯函数测试（文档 16 §10.2）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDismissalFeedback,
  evaluateProactivePolicy,
  evaluateTriggeredPush,
  isWithinQuietHours,
  POLICY_LIMITS,
  PROACTIVE_CADENCE_MS,
  proactiveCadenceMs,
  proactiveAvailabilityBlocked,
  routineCadenceBlocked,
  type ProactivePolicyInput,
} from "./companion-proactive-policy.ts";

function base(): ProactivePolicyInput {
  return {
    availability: "online",
    interventionLevel: "moderate",
    formalAnswerInProgress: false,
    msSinceLastShown: null,
    recentShownCount: 0,
    expired: false,
    // 三位新必填：给默认值而不是省略，是为了让"新加一道门却没传信号"在编译期就现形。
    spaceMuted: false,
    quietHours: null,
    recentDeliveryStates: [],
    now: Date.now(),
  };
}

test("房间静音排在所有账号级判断之前（doc 34 L10 的那条顺序是刻意的）", () => {
  assert.equal(evaluateProactivePolicy({
    ...base(), spaceMuted: true, availability: "dnd", formalAnswerInProgress: true,
  }).reasonCode, "space_muted");
  assert.equal(evaluateProactivePolicy({ ...base(), spaceMuted: true }).reasonCode, "space_muted");
  assert.equal(evaluateProactivePolicy({ ...base(), quietHours: {
    startLocal: "00:00", endLocal: "23:59", timezone: "UTC",
  } }).reasonCode, "quiet_hours");
  assert.equal(evaluateProactivePolicy({
    ...base(), recentShownCount: POLICY_LIMITS.dedupeWindowLimit,
  }).reasonCode, "dedupe_recent");
  assert.equal(evaluateProactivePolicy(base()).reasonCode, "allowed");
});

test("DND / offline / formal_answer / expired 全部抑制（最高优先级）", () => {
  assert.equal(evaluateProactivePolicy({ ...base(), availability: "dnd" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), availability: "offline" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), formalAnswerInProgress: true }).reasonCode, "formal_answer_in_progress");
  assert.equal(evaluateProactivePolicy({ ...base(), expired: true }).reasonCode, "expired");
});

/**
 * 用户 2026-09-21 的口径：**"不要给我限制，按用户偏好设置推送频率即可"**。
 *
 * 原来是一天几条（quiet 1 / moderate 3 / active 6）。那个控件答错了问题：
 * 它不决定"什么时候说"，只决定"说到几条就闭嘴"，而且实测会整天静音——
 * 三条从没展示过的僵尸念头就能把 moderate 的一天占满（§9.58）。
 */
test("例行主动只有间隔，没有日额度", () => {
  assert.deepEqual(
    (["quiet", "moderate", "active"] as const).map(proactiveCadenceMs),
    [3 * 60 * 60 * 1000, 90 * 60 * 1000, 30 * 60 * 1000],
  );
  assert.deepEqual(PROACTIVE_CADENCE_MS, {
    quiet: 3 * 60 * 60 * 1000,
    moderate: 90 * 60 * 1000,
    active: 30 * 60 * 1000,
  });
  // 间隔之内：三档都拦（"刚说过"不是"今天说够了"）。
  for (const level of ["quiet", "moderate", "active"] as const) {
    assert.equal(
      evaluateProactivePolicy({
        ...base(), interventionLevel: level, msSinceLastShown: proactiveCadenceMs(level) - 60_000,
      }).reasonCode,
      "cooldown",
      `${level} 在间隔内不该开口`,
    );
    // 间隔一到就允许，而且**没有条数上限**：同一档连着满足间隔就一直能开口。
    assert.equal(
      evaluateProactivePolicy({
        ...base(), interventionLevel: level, msSinceLastShown: proactiveCadenceMs(level),
      }).allow,
      true,
      `${level} 满间隔后该放行`,
    );
  }
  // 安静档是"少而轻"，不是"永不"：从没开过口时第一次一定允许。
  assert.deepEqual(
    [evaluateProactivePolicy({ ...base(), interventionLevel: "quiet" }).allow,
     evaluateProactivePolicy({ ...base(), interventionLevel: "quiet" }).reasonCode],
    [true, "allowed"],
  );
});

/**
 * 触发式 = 用户先要过的（0238 到点提醒）或正在等的（学习完成）。
 * 它不是"频率"的对象：一条 09:00 的提醒被"她今天话说多了"压掉，
 * 用户拿到的是"提醒不准"，不是"她有分寸"。
 */
test("触发式推送不进任何频率限制", () => {
  const justSpoke = { ...base(), kind: "triggered" as const, msSinceLastShown: 1000 };
  assert.deepEqual(evaluateProactivePolicy(justSpoke), { allow: true, reasonCode: "allowed" });
  // 作答中也不拦：闹钟在该响的时候响。
  assert.equal(evaluateProactivePolicy({
    ...base(), kind: "triggered" as const, formalAnswerInProgress: true,
  }).allow, true);
  // 同一 key 已经展示过两次也不拦（去重窗口是例行那一类的规则）。
  assert.equal(evaluateProactivePolicy({
    ...base(), kind: "triggered" as const, recentShownCount: POLICY_LIMITS.dedupeWindowLimit,
  }).allow, true);
  // 但"设备明确不在"仍然挡：气泡进收件箱，人回来照样看得见。
  assert.equal(evaluateProactivePolicy({ ...base(), kind: "triggered" as const, availability: "dnd" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), kind: "triggered" as const, availability: "offline" }).allow, false);
  assert.equal(evaluateProactivePolicy({ ...base(), kind: "triggered" as const, expired: true }).reasonCode, "expired");
  // 缺省必须是 routine：漏传 kind 不能把频率闸整个绕过去。
  assert.equal(evaluateProactivePolicy({ ...base(), msSinceLastShown: 1000 }).reasonCode, "cooldown");
  // 触发式的独立入口与上面完全同源（不是第二份判定）。
  assert.deepEqual(evaluateTriggeredPush({ availability: "online", expired: false }), { allow: true, reasonCode: "allowed" });
  assert.equal(evaluateTriggeredPush({ availability: "dnd", expired: false }).reasonCode, "dnd");
  assert.equal(evaluateTriggeredPush({ availability: "online", expired: true }).reasonCode, "expired");
});

test("勿扰/离线：两条链路共用同一条判定", () => {
  // 以前这条只有 api 的 proactive-hook 在用，worker 的念头管线连 `presence` 都没读，
  // 于是 HUD 上的「勿扰」对"她主动开口"完全无效——设置存在、界面能改、一条链路不听。
  assert.equal(proactiveAvailabilityBlocked("online"), false);
  assert.equal(proactiveAvailabilityBlocked("dnd"), true);
  assert.equal(proactiveAvailabilityBlocked("offline"), true);
});

test("间隔判定与策略同源（念头管线只调这一条）", () => {
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: null }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 29 * 60 * 1000 }), true);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 31 * 60 * 1000 }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "quiet", msSinceLastCue: 2 * 60 * 60 * 1000 }), true);
});

test("dedupe 冷却窗口与窗口内次数上限", () => {
  assert.equal(
    evaluateProactivePolicy({ ...base(), msSinceLastShown: 10 * 60 * 1000 }).reasonCode,
    "cooldown",
  );
  assert.equal(
    evaluateProactivePolicy({ ...base(), msSinceLastShown: PROACTIVE_CADENCE_MS.moderate }).allow,
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
