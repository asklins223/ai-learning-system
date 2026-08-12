/**
 * 任务 07-9：个性化偏好 单测（§11，冻结记录 01-9）。
 *
 * 覆盖：
 * - 本轮上下文（§11.1）：默认只要求选目的地、其余可选；本轮精力不长期保存、
 *   不形成画像；只影响 route composition/表达/数量/互动选择；不进 mastery /
 *   official scheduler；
 * - 长期可编辑偏好（§11.2 清单）：23 个键白名单 schema、值校验、
 *   设备本地键标记；
 * - 偏好 CRUD：查看 / 修改 / 重置 / 导出 / 删除，导入回读；
 * - Agent 只能提出 suggested preference、不能静默改变 explicit；
 * - onboarding 完成/跳过是产品状态不是学习偏好；重置偏好不触发已跳过引导；
 * - 设置与帮助：重新播放首次引导、伴星当前可使用哪些页面上下文。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_PREFERENCES_STATE,
  PREFERENCE_KEYS,
  REPLAY_FIRST_GUIDE_ENTRY,
  ROUND_CHALLENGE_OPTIONS,
  ROUND_DURATION_OPTIONS,
  ROUND_ENERGY_OPTIONS,
  ROUND_INPUT_MODE_OPTIONS,
  ROUND_SCOPE_OPTIONS,
  acceptSuggestedPreference,
  agentSilentChangeAttempt,
  applyAgentSuggestedPreference,
  buildCompanionPageContextAvailability,
  buildRoundContext,
  deleteAllPreferences,
  exportPreferences,
  getPreferenceLabel,
  importPreferences,
  isDeviceLocalPreferenceKey,
  isLearningPreferenceKey,
  rejectSuggestedPreference,
  resetAllPreferences,
  resetPreference,
  resolveRoundContextBoundaries,
  setExplicitPreference,
  validatePreferenceValue,
  type PreferencesState,
  type RoundContext,
} from "./session-preferences.ts";

// ─── 1. 本轮上下文（§11.1）────────────────────────────────────────────

describe("本轮上下文（§11.1）", () => {
  it("默认只要求选择目的地，其余全部可选（缺省 null）", () => {
    const result = buildRoundContext({ destinationKeyPointId: "kp-1" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.context.destinationKeyPointId, "kp-1");
      assert.equal(result.context.duration, null);
      assert.equal(result.context.energy, null);
      assert.equal(result.context.challenge, null);
      assert.equal(result.context.inputMode, null);
      assert.equal(result.context.scope, null);
    }
  });

  it("完整表达本轮约束 → 全部生效", () => {
    const result = buildRoundContext({
      destinationKeyPointId: "kp-1",
      duration: "10",
      energy: "low",
      challenge: "gentle",
      inputMode: "touch_keyboard",
      scope: "single_cluster",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.context.duration, "10");
      assert.equal(result.context.energy, "low");
      assert.equal(result.context.challenge, "gentle");
      assert.equal(result.context.inputMode, "touch_keyboard");
      assert.equal(result.context.scope, "single_cluster");
    }
  });

  it("缺少目的地 → 拒绝", () => {
    const result = buildRoundContext({ destinationKeyPointId: "" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "destination_missing");
  });

  it("自定义时长必须提供自定义分钟数", () => {
    const missing = buildRoundContext({ destinationKeyPointId: "kp-1", duration: "custom" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "custom_minutes_required");
  });

  it("自定义分钟数必须为正整数", () => {
    const bad = buildRoundContext({ destinationKeyPointId: "kp-1", duration: "custom", customMinutes: 0 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, "custom_minutes_invalid");
    const ok = buildRoundContext({ destinationKeyPointId: "kp-1", duration: "custom", customMinutes: 25 });
    assert.equal(ok.ok, true);
  });

  it("非自定义时长时自定义分钟数被忽略", () => {
    const result = buildRoundContext({
      destinationKeyPointId: "kp-1",
      duration: "3",
      customMinutes: 99,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.context.customMinutes, null);
  });

  it("枚举选项齐全（3/10/20/自定义、低负荷/正常、温和/标准/挑战、静音/语音/触控键盘、聚焦/混合）", () => {
    assert.deepEqual([...ROUND_DURATION_OPTIONS], ["3", "10", "20", "custom"]);
    assert.deepEqual([...ROUND_ENERGY_OPTIONS], ["low", "normal"]);
    assert.deepEqual([...ROUND_CHALLENGE_OPTIONS], ["gentle", "standard", "challenge"]);
    assert.deepEqual([...ROUND_INPUT_MODE_OPTIONS], ["silent", "voice", "touch_keyboard"]);
    assert.deepEqual([...ROUND_SCOPE_OPTIONS], ["single_cluster", "mixed_review"]);
  });

  it("本轮精力不长期保存、不形成画像；只影响 route/表达/数量/互动，不进 mastery 或 scheduler", () => {
    const result = buildRoundContext({
      destinationKeyPointId: "kp-1",
      duration: "20",
      energy: "low",
      challenge: "challenge",
    });
    assert.equal(result.ok, true);
    const boundaries = resolveRoundContextBoundaries(result.ok ? result.context : ({} as RoundContext));
    assert.equal(boundaries.neverPersisted, true, "本轮上下文不长期保存");
    assert.equal(boundaries.masteryInfluence, 0, "不进 mastery（0 字面量）");
    assert.equal(boundaries.schedulerInfluence, false, "不进 official scheduler");
    assert.equal(boundaries.affectsRouteComposition, true);
    assert.equal(boundaries.affectsExpression, true);
    assert.equal(boundaries.affectsQuantity, true);
    assert.equal(boundaries.affectsInteractionChoice, true);
  });

  it("本轮上下文不写入任何长期偏好（explicit/suggested 均不含本轮字段）", () => {
    const result = buildRoundContext({
      destinationKeyPointId: "kp-1",
      energy: "low",
      duration: "10",
    });
    assert.equal(result.ok, true);
    const exported = exportPreferences(EMPTY_PREFERENCES_STATE);
    assert.ok(!exported.includes("energy"));
    // buildRoundContext 是纯上下文构造，不触碰偏好状态
    assert.deepEqual(deleteAllPreferences(), EMPTY_PREFERENCES_STATE);
  });
});

// ─── 2. 长期偏好白名单（§11.2 清单）───────────────────────────────────

describe("长期可编辑偏好白名单（§11.2 清单）", () => {
  it("白名单恰好包含 §11.2 全部 23 个偏好键", () => {
    assert.equal(PREFERENCE_KEYS.length, 23);
    assert.deepEqual([...PREFERENCE_KEYS], [
      "default_input_priority",
      "disabled_encounters",
      "feedback_style",
      "presence",
      "page_muted_default",
      "focus_default",
      "animation_enabled",
      "voice_output_enabled",
      "global_off",
      "temporary_hidden_device_local",
      "suppressed_suggestion_classes",
      "challenge_tendency",
      "single_topic_interleave",
      "default_duration_minutes",
      "weekly_load_minutes",
      "available_time_window",
      "notification_boundary",
      "tts_rate",
      "subtitles_enabled",
      "sound_effects_enabled",
      "reduced_motion",
      "a11y_preference",
      "raw_audio_retention",
    ]);
  });

  it("onboarding 完成/跳过是产品状态，不是学习偏好", () => {
    assert.equal(isLearningPreferenceKey("onboarding_completed"), false);
    assert.equal(isLearningPreferenceKey("onboarding_skipped"), false);
  });

  it("临时隐藏是设备本地偏好键（不跨设备同步）", () => {
    assert.equal(isDeviceLocalPreferenceKey("temporary_hidden_device_local"), true);
    assert.equal(isDeviceLocalPreferenceKey("presence"), false);
    assert.equal(isDeviceLocalPreferenceKey("global_off"), false);
  });

  it("每个偏好键都有标签与值校验", () => {
    for (const key of PREFERENCE_KEYS) {
      assert.ok(getPreferenceLabel(key).length > 0, `${key} 应有展示标签`);
      assert.ok(validatePreferenceValue(key, undefined) === false, `${key} 拒绝 undefined`);
    }
  });

  it("值校验：合法与非法样例", () => {
    assert.equal(validatePreferenceValue("presence", "quiet"), true);
    assert.equal(validatePreferenceValue("presence", "loud"), false);
    assert.equal(validatePreferenceValue("feedback_style", "concise"), true);
    assert.equal(validatePreferenceValue("feedback_style", "chatty"), false);
    assert.equal(validatePreferenceValue("default_duration_minutes", 10), true);
    assert.equal(validatePreferenceValue("default_duration_minutes", 0), false);
    assert.equal(validatePreferenceValue("default_duration_minutes", -5), false);
    assert.equal(validatePreferenceValue("tts_rate", 1.0), true);
    assert.equal(validatePreferenceValue("tts_rate", 3.0), false);
    assert.equal(validatePreferenceValue("available_time_window", { start: "09:00", end: "17:00" }), true);
    assert.equal(validatePreferenceValue("available_time_window", { start: "17:00", end: "09:00" }), false);
    assert.equal(validatePreferenceValue("disabled_encounters", ["enc-a", "enc-b"]), true);
    assert.equal(validatePreferenceValue("disabled_encounters", [1, 2]), false);
    assert.equal(validatePreferenceValue("raw_audio_retention", "never_keep"), true);
    assert.equal(validatePreferenceValue("raw_audio_retention", "keep_forever"), false);
  });
});

// ─── 3. 偏好 CRUD（查看 / 修改 / 重置 / 导出 / 删除）───────────────────

describe("偏好 CRUD（§11.2 全量可查看/修改/重置/导出/删除）", () => {
  it("修改：合法键 + 合法值 → 写入 explicit", () => {
    const result = setExplicitPreference(EMPTY_PREFERENCES_STATE, "presence", "moderate");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state.explicit.presence, "moderate");
  });

  it("修改：非法键 → 拒绝", () => {
    const result = setExplicitPreference(
      EMPTY_PREFERENCES_STATE,
      "onboarding_completed" as never,
      true,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_key");
  });

  it("修改：非法值 → 拒绝", () => {
    const result = setExplicitPreference(EMPTY_PREFERENCES_STATE, "presence", "loud");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_value");
  });

  it("重置单个偏好：explicit 与 suggested 一并移除", () => {
    let state = EMPTY_PREFERENCES_STATE;
    const set = setExplicitPreference(state, "presence", "active");
    assert.equal(set.ok, true);
    state = set.ok ? set.state : state;
    const suggested = applyAgentSuggestedPreference(state, "presence", "quiet");
    state = suggested.state;
    assert.equal(state.explicit.presence, "active");
    assert.equal(state.suggested.presence, "quiet");
    const after = resetPreference(state, "presence");
    assert.equal("presence" in after.explicit, false);
    assert.equal("presence" in after.suggested, false);
  });

  it("重置全部偏好 → 空快照（不影响 onboarding 产品状态）", () => {
    const result = resetAllPreferences();
    assert.deepEqual(result, { explicit: {}, suggested: {} });
    // 重置偏好绝不重新触发已跳过引导：重置结果不含任何 onboarding 键
    assert.equal("onboarding_completed" in result.explicit, false);
    assert.equal("onboarding_skipped" in result.explicit, false);
  });

  it("导出：JSON 文本可解析且包含 explicit/suggested", () => {
    const set = setExplicitPreference(EMPTY_PREFERENCES_STATE, "feedback_style", "guided");
    assert.equal(set.ok, true);
    const json = exportPreferences(set.ok ? set.state : EMPTY_PREFERENCES_STATE);
    const parsed = JSON.parse(json);
    assert.equal(parsed.explicit.feedback_style, "guided");
    assert.deepEqual(parsed.suggested, {});
  });

  it("导出 → 导入往返一致", () => {
    let state = EMPTY_PREFERENCES_STATE;
    const set = setExplicitPreference(state, "presence", "active");
    assert.equal(set.ok, true);
    state = set.ok ? set.state : state;
    const suggested = applyAgentSuggestedPreference(state, "tts_rate", 1.25);
    state = suggested.state;
    const json = exportPreferences(state);
    const imported = importPreferences(json);
    assert.equal(imported.ok, true);
    if (imported.ok) {
      assert.deepEqual(imported.state, state);
    }
  });

  it("导入非法值 → 整体拒绝", () => {
    const imported = importPreferences(JSON.stringify({ explicit: { presence: "loud" } }));
    assert.equal(imported.ok, false);
    if (!imported.ok) assert.equal(imported.reason, "invalid_value");
  });

  it("导入非 JSON → 拒绝", () => {
    assert.equal(importPreferences("not-json").ok, false);
  });

  it("删除全部偏好 → 空快照", () => {
    const set = setExplicitPreference(EMPTY_PREFERENCES_STATE, "presence", "active");
    assert.equal(set.ok, true);
    const after = deleteAllPreferences();
    assert.deepEqual(after, { explicit: {}, suggested: {} });
  });
});

// ─── 4. Agent 只能提出 suggested preference（§11.2 / 01-9 §3）──────────

describe("Agent 建议边界（suggested preference）", () => {
  it("Agent 建议只写 suggested，explicit 不被静默改变", () => {
    const result = applyAgentSuggestedPreference(EMPTY_PREFERENCES_STATE, "presence", "active");
    assert.equal(result.explicitChanged, false);
    assert.equal("presence" in result.state.explicit, false, "explicit 不得被 Agent 改变");
    assert.equal(result.state.suggested.presence, "active");
  });

  it("Agent 建议非法值 → 连 suggested 也不写（fail closed）", () => {
    const result = applyAgentSuggestedPreference(EMPTY_PREFERENCES_STATE, "presence", "loud");
    assert.equal("presence" in result.state.suggested, false);
    assert.equal("presence" in result.state.explicit, false);
    assert.ok(result.note.length > 0);
  });

  it("用户显式接受 → suggested 提升到 explicit", () => {
    const proposed = applyAgentSuggestedPreference(EMPTY_PREFERENCES_STATE, "tts_rate", 1.5);
    const accepted = acceptSuggestedPreference(proposed.state, "tts_rate");
    assert.equal(accepted.explicit.tts_rate, 1.5);
    assert.equal("tts_rate" in accepted.suggested, false);
  });

  it("用户显式拒绝 → 从 suggested 移除，不进 explicit", () => {
    const proposed = applyAgentSuggestedPreference(EMPTY_PREFERENCES_STATE, "tts_rate", 1.5);
    const rejected = rejectSuggestedPreference(proposed.state, "tts_rate");
    assert.equal("tts_rate" in rejected.suggested, false);
    assert.equal("tts_rate" in rejected.explicit, false);
  });

  it("原型链键不当作已建议（hasOwn 防御，不抛 TypeError）", () => {
    // 模拟调用方传入非法键（运行时 string，绕过 TS 联合类型）
    const state = applyAgentSuggestedPreference(EMPTY_PREFERENCES_STATE, "tts_rate", 1.5).state;
    const protoKey = "toString" as never;
    const accepted = acceptSuggestedPreference(state, protoKey);
    assert.deepEqual(accepted, state, "accept 对原型链键应原样返回");
    const rejected = rejectSuggestedPreference(state, protoKey);
    assert.deepEqual(rejected, state, "reject 对原型链键应原样返回");
    assert.equal(state.explicit.tts_rate, undefined, "tts_rate 仍在 suggested，未误提升");
    // `in` 检查含原型链（对任何对象恒 true），必须用 hasOwn 验证未写入自有键
    assert.equal(Object.hasOwn(state.suggested, "toString"), false);
  });

  it("Agent 静默改变 explicit → 一律阻止，explicit 原样保留", () => {
    const set = setExplicitPreference(EMPTY_PREFERENCES_STATE, "presence", "quiet");
    assert.equal(set.ok, true);
    const state: PreferencesState = set.ok ? set.state : EMPTY_PREFERENCES_STATE;
    const attempt = agentSilentChangeAttempt(state, "presence", "active");
    assert.equal(attempt.blocked, true);
    assert.equal(attempt.state.explicit.presence, "quiet", "explicit 保持原样");
    assert.deepEqual(attempt.state.suggested, {});
  });
});

// ─── 5. 设置与帮助（§11.2）────────────────────────────────────────────

describe("设置与帮助", () => {
  it("提供「重新播放首次引导」入口", () => {
    assert.equal(REPLAY_FIRST_GUIDE_ENTRY, "重新播放首次引导");
  });

  it("伴星当前可使用哪些页面上下文：去重排序", () => {
    const pages = buildCompanionPageContextAvailability([
      "card-detail",
      "star-map",
      "card-detail",
      "review",
    ]);
    assert.deepEqual([...pages], ["card-detail", "review", "star-map"]);
  });

  it("空页面上下文 → 空列表（不编造可用页面）", () => {
    assert.deepEqual(buildCompanionPageContextAvailability([]), []);
  });
});
