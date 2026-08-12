/**
 * 任务 14：resolveAnswerMode 编排纯函数单测（14-...-multimodal-reconstruction §3.1 / §4 阶段 A）。
 *
 * 阶段 A 退出验收要求锁定（§4 阶段 A + §3.1 注 1.0）：
 * - 显式 text/voice 偏好分支（决策 4「偏好=优先」语义）；
 * - 默认偏好下「练习页 silent 优先、text 兜底 / 复习页 text 默认」的不对称语义
 *   （决策 1/2 的刻意结果）；
 * - cooldown 窗口内一律 practice（规则 1）；
 * - 任何模态不可用时 fail-open 到 text，不允许「无路可走」（规则 4）；
 * - silent 正式航程需 eligibility 五证 + 跨模态 Gold（§7 决策 2，fail closed）；
 * - transfer gate（rubricComplete + evidenceComplete，06-6，fail closed）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SceneType } from "@ailearn/shared";
import { resolveAnswerMode } from "./resolve-answer-mode.ts";
import type { ResolveAnswerModeInput } from "./resolve-answer-mode.ts";

const base: ResolveAnswerModeInput = {
  page: "practice",
  keyPointId: "kp-1",
  rubricComplete: true,
  evidenceComplete: true,
  structuredProofEligibility: "eligible",
  crossModalGoldPassed: true,
  userPreference: "any",
  inCooldown: false,
  voiceAvailable: true,
};

describe("resolveAnswerMode · 复习页默认 text（决策 1）", () => {
  it("未设偏好 → text，即使 silent 可用、voice 可用", () => {
    const out = resolveAnswerMode({ ...base, page: "review" });
    assert.equal(out.mode, "text");
    assert.equal(out.trustCeiling, "mastery_eligible");
    assert.equal(out.reason, "review-default-text");
  });

  it("偏好 text → text", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "review",
      userPreference: "text",
    });
    assert.equal(out.mode, "text");
  });

  it("偏好 silent → 复习页不提供 silent 正式模态，落回 text（fail-open）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "review",
      userPreference: "silent",
    });
    assert.equal(out.mode, "text");
  });

  it("显式偏好 voice 且 voice 可用 → voice（决策 4 语义）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "review",
      userPreference: "voice",
      voiceAvailable: true,
    });
    assert.equal(out.mode, "voice");
    assert.deepEqual(out.scenePlan, [SceneType.VOICE_TEACHBACK]);
    assert.equal(out.trustCeiling, "mastery_eligible");
  });

  it("偏好 voice 但 provider 不可用 → 自动落回 text（fail-open，不卡死）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "review",
      userPreference: "voice",
      voiceAvailable: false,
    });
    assert.equal(out.mode, "text");
  });

  it("偏好 voice 但 silent 也 eligible → 复习页仍走 voice（review 不因 silent 抢跑）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "review",
      userPreference: "voice",
      voiceAvailable: true,
    });
    assert.equal(out.mode, "voice");
  });
});

describe("resolveAnswerMode · 练习页默认 silent 优先、text 兜底（决策 2）", () => {
  it("未设偏好 + eligible 且过 Gold → silent（不以打字为默认前提）", () => {
    const out = resolveAnswerMode({ ...base, page: "practice" });
    assert.equal(out.mode, "silent");
    assert.deepEqual(out.scenePlan, [SceneType.ORDERING, SceneType.REPAIR]);
    assert.equal(out.trustCeiling, "mastery_eligible");
    assert.equal(out.reason, "practice-default-silent");
  });

  it("未设偏好 + silent 不 eligible（五证缺）→ 不展示 silent 路线（fail closed）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      structuredProofEligibility: "not_eligible",
    });
    assert.notEqual(out.mode, "silent");
    assert.equal(out.mode, "transfer"); // gate 通过时 → transfer
  });

  it("未设偏好 + eligible 但未过跨模态 Gold → 不展示 silent 正式航程（决策 2 硬门槛）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      crossModalGoldPassed: false,
    });
    assert.notEqual(out.mode, "silent");
    assert.equal(out.mode, "transfer");
  });

  it("未设偏好 + silent 不可用 + transfer gate 未过 → text 兜底", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      structuredProofEligibility: "not_eligible",
      rubricComplete: false,
      evidenceComplete: false,
    });
    assert.equal(out.mode, "text");
    assert.equal(out.trustCeiling, "mastery_eligible");
    assert.equal(out.reason, "practice-default-text");
  });

  it("练习页与复习页默认不对称：同输入下 practice=silent / review=text", () => {
    const practiceOut = resolveAnswerMode({ ...base, page: "practice" });
    const reviewOut = resolveAnswerMode({ ...base, page: "review" });
    assert.equal(practiceOut.mode, "silent");
    assert.equal(reviewOut.mode, "text");
  });
});

describe("resolveAnswerMode · 显式偏好优先（决策 4「偏好=优先」）", () => {
  it("练习页显式 text 偏好 → text，不被 silent 抢跑", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "text",
    });
    assert.equal(out.mode, "text");
    assert.equal(out.reason, "practice-preference-text");
  });

  it("练习页显式 voice 偏好 + voice 可用 → voice", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "voice",
      voiceAvailable: true,
    });
    assert.equal(out.mode, "voice");
  });

  it("练习页显式 voice 偏好但 voice 不可用 → fail-open 到 text（规则 4）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "voice",
      voiceAvailable: false,
    });
    assert.equal(out.mode, "text");
    assert.equal(out.reason, "practice-voice-unavailable");
  });

  it("练习页显式 silent 偏好 + eligible/过 Gold → silent", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "silent",
    });
    assert.equal(out.mode, "silent");
    assert.equal(out.reason, "practice-preference-silent");
  });

  it("练习页显式 silent 偏好但不可用 → fail-open 到 text（规则 4）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "silent",
      structuredProofEligibility: "not_eligible",
      crossModalGoldPassed: false,
    });
    assert.equal(out.mode, "text");
  });
});

describe("resolveAnswerMode · cooldown 一律 practice（规则 1）", () => {
  it("cooldown 内任何偏好/页面 → practice，trustCeiling=practice", () => {
    const variants: ResolveAnswerModeInput[] = [
      { ...base, page: "practice", userPreference: "voice" },
      { ...base, page: "practice", userPreference: "text" },
      { ...base, page: "review", userPreference: "voice" },
      { ...base, page: "review", userPreference: "any" },
    ];
    for (const input of variants) {
      const out = resolveAnswerMode({ ...input, inCooldown: true });
      assert.equal(out.mode, "practice");
      assert.equal(out.trustCeiling, "practice");
      assert.equal(out.reason, "cooldown-active");
    }
  });

  it("内容工具暴露后的 cooldown 不因显式偏好重置为正式模态", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "text",
      inCooldown: true,
    });
    assert.equal(out.mode, "practice");
  });
});

describe("resolveAnswerMode · transfer gate（06-6，fail closed）", () => {
  it("gate 通过 → transfer，trustCeiling=record_only（0 schedule 副作用）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      structuredProofEligibility: "not_eligible",
      rubricComplete: true,
      evidenceComplete: true,
    });
    assert.equal(out.mode, "transfer");
    assert.equal(out.trustCeiling, "record_only");
    assert.equal(out.reason, "practice-default-transfer");
  });

  it("rubric 不全 → transfer 不可用（unavailable 语义）", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      structuredProofEligibility: "not_eligible",
      rubricComplete: false,
      evidenceComplete: true,
    });
    assert.equal(out.mode, "text");
  });

  it("evidence 不全 → transfer 不可用", () => {
    const out = resolveAnswerMode({
      ...base,
      page: "practice",
      structuredProofEligibility: "not_eligible",
      rubricComplete: true,
      evidenceComplete: false,
    });
    assert.equal(out.mode, "text");
  });
});

describe("resolveAnswerMode · scenePlan 透传与兜底", () => {
  it("voice 模态：未给 hint 时默认 voice_teachback，给了则透传", () => {
    const defaultOut = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "voice",
    });
    assert.deepEqual(defaultOut.scenePlan, [SceneType.VOICE_TEACHBACK]);

    const hinted = resolveAnswerMode({
      ...base,
      page: "practice",
      userPreference: "voice",
      scenePlanHint: [SceneType.VOICE_TEACHBACK, SceneType.OPTIONAL_TEXT],
    });
    assert.deepEqual(hinted.scenePlan, [SceneType.VOICE_TEACHBACK, SceneType.OPTIONAL_TEXT]);
  });

  it("silent 模态：未给 hint 时默认 ordering+repair（procedure family 互补对）", () => {
    const out = resolveAnswerMode({ ...base, page: "practice" });
    assert.deepEqual(out.scenePlan, [SceneType.ORDERING, SceneType.REPAIR]);
  });

  it("text/practice 模态 scenePlan 为空", () => {
    const textOut = resolveAnswerMode({ ...base, page: "practice", userPreference: "text" });
    const cooldownOut = resolveAnswerMode({ ...base, inCooldown: true });
    assert.deepEqual(textOut.scenePlan, []);
    assert.deepEqual(cooldownOut.scenePlan, []);
  });
});

describe("resolveAnswerMode · 不变量：绝无「无路可走」", () => {
  it("所有输入组合下 mode 必在五种模态内，且 text/practice 永远可达", () => {
    const combinations: ResolveAnswerModeInput[] = [];
    for (const page of ["practice", "review"] as const) {
      for (const userPreference of ["voice", "silent", "text", "any"] as const) {
        for (const voiceAvailable of [true, false]) {
          for (const eligible of ["eligible", "not_eligible"] as const) {
            combinations.push({
              ...base,
              page,
              userPreference,
              voiceAvailable,
              structuredProofEligibility: eligible,
              crossModalGoldPassed: eligible === "eligible",
              rubricComplete: false,
              evidenceComplete: false,
              inCooldown: false,
            });
          }
        }
      }
    }
    assert.ok(combinations.length >= 32);
    for (const input of combinations) {
      const out = resolveAnswerMode(input);
      assert.ok(
        ["voice", "silent", "text", "transfer", "practice"].includes(out.mode),
        `unexpected mode for ${JSON.stringify(input)}`,
      );
      assert.ok(out.trustCeiling.length > 0);
      assert.ok(out.reason.length > 0);
    }
  });
});
