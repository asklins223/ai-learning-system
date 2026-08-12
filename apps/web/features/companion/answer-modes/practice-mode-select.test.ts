/**
 * 任务 14 接线：练习页 modeSelect 编排纯函数单测（14 方案 §3.1/§3.2/§3.6）。
 *
 * 锁定（服务端 journeyPlan 权威编排，前端不再自行 fail-closed）：
 * - journeyPlan.mode=silent → silent 默认 + voice/text 可切换；
 * - journeyPlan.mode=voice → voice 默认；
 * - journeyPlan.mode=transfer → transfer 默认（record_only 语义由服务端签发）；
 * - cooldown 内一律 text（规则 1）；
 * - 决策 4「偏好=优先」：显式偏好决定默认（受服务端编排集合约束）；
 * - journeyPlan 缺失 → text 兜底（不猜模态）；
 * - text 恒可达（规则 4 fail-open）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePracticeModeSelect } from "./practice-mode-select.ts";
import type { PracticeJourneyPlan } from "./practice-mode-select.ts";

const silentPlan: PracticeJourneyPlan = {
  version: "journey-plan-v1",
  mode: "silent",
  scenePlan: ["ordering", "repair"],
  trustCeiling: "mastery_eligible",
  journeyHint: "本轮由伴星安排排序与修复练习，不强制打字。",
  reason: "silent-formal-plan",
};
const voicePlan: PracticeJourneyPlan = {
  version: "journey-plan-v1",
  mode: "voice",
  scenePlan: ["voice_teachback"],
  trustCeiling: "mastery_eligible",
  journeyHint: "本轮以语音复述为主。",
  reason: "voice-formal-plan",
};
const transferPlan: PracticeJourneyPlan = {
  version: "journey-plan-v1",
  mode: "transfer",
  scenePlan: ["multi_step_scenario"],
  trustCeiling: "record_only",
  journeyHint: "本轮为情境应用练习，默认不影响复习时间。",
  reason: "transfer-gate-passed",
};

describe("resolvePracticeModeSelect：服务端 journeyPlan 权威编排", () => {
  it("mode=silent → silent 默认，voice/text 可切换（不强制打字）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: silentPlan,
      voiceAvailable: true,
      inCooldown: false,
    });
    assert.deepEqual(out.options, ["silent", "voice", "text"]);
    assert.equal(out.defaultOption, "silent");
    assert.equal(out.reason, "journey-silent");
  });

  it("mode=voice → voice 默认", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: voicePlan,
      voiceAvailable: true,
      inCooldown: false,
    });
    assert.deepEqual(out.options, ["voice", "text"]);
    assert.equal(out.defaultOption, "voice");
  });

  it("mode=transfer → transfer 默认（record_only 不消费 schedule）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: transferPlan,
      voiceAvailable: true,
      inCooldown: false,
    });
    assert.ok(out.options.includes("transfer"));
    assert.equal(out.defaultOption, "transfer");
  });

  it("journeyPlan 缺失 → text 兜底（不猜模态，不伪装）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: null,
      voiceAvailable: true,
      inCooldown: false,
    });
    assert.deepEqual(out.options, ["text"]);
    assert.equal(out.reason, "no-journey-plan");
  });
});

describe("resolvePracticeModeSelect：cooldown 一律练习级（规则 1）", () => {
  it("cooldown 内任何计划 → 只给 text", () => {
    for (const journeyPlan of [silentPlan, voicePlan, transferPlan]) {
      const out = resolvePracticeModeSelect({
        journeyPlan,
        voiceAvailable: true,
        inCooldown: true,
      });
      assert.deepEqual(out.options, ["text"]);
      assert.equal(out.reason, "cooldown-practice");
    }
  });
});

describe("resolvePracticeModeSelect：决策 4「偏好=优先」", () => {
  it("显式 voice 偏好 → voice 默认（服务端编排集合内）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: silentPlan,
      voiceAvailable: true,
      inCooldown: false,
      userPreference: "voice",
    });
    assert.equal(out.defaultOption, "voice");
  });

  it("显式 text 偏好 → 不被 silent 抢跑", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: silentPlan,
      voiceAvailable: true,
      inCooldown: false,
      userPreference: "text",
    });
    assert.deepEqual(out.options, ["text"]);
    assert.equal(out.reason, "preference-text");
  });

  it("显式 silent 偏好 + 服务端编排 silent → silent 默认", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: silentPlan,
      voiceAvailable: true,
      inCooldown: false,
      userPreference: "silent",
    });
    assert.equal(out.defaultOption, "silent");
    assert.equal(out.reason, "preference-silent");
  });

  it("显式 silent 偏好但服务端编排非 silent → 不展示 silent（资格约束仍生效）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: voicePlan,
      voiceAvailable: true,
      inCooldown: false,
      userPreference: "silent",
    });
    assert.ok(!out.options.includes("silent"));
    assert.equal(out.reason, "preference-silent-unavailable");
  });
});

describe("resolvePracticeModeSelect：voice 不可用回退", () => {
  it("journeyPlan=silent 但 voice 不可用 → 只有 silent/text", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: silentPlan,
      voiceAvailable: false,
      inCooldown: false,
    });
    assert.deepEqual(out.options, ["silent", "text"]);
    assert.equal(out.defaultOption, "silent");
  });

  it("journeyPlan=voice 但 voice 不可用 → text 兜底（fail-open）", () => {
    const out = resolvePracticeModeSelect({
      journeyPlan: voicePlan,
      voiceAvailable: false,
      inCooldown: false,
    });
    assert.deepEqual(out.options, ["text"]);
    assert.equal(out.defaultOption, "text");
  });
});
