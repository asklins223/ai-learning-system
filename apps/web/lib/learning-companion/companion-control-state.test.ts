/**
 * 任务 05-5：Companion 控制状态纯逻辑单测（§5.5 / §5.4.4）。
 *
 * 覆盖：
 * - 8 个控制状态的类型、作用域、默认值、行为元数据；
 * - resolveControlEffects 各状态行为与组合/互斥规则；
 * - observer/context 零构造判定（quiet 未召唤 / page_context_off /
 *   temporary_hidden / global_off → 0）；
 * - 立即隐藏不等待网络（applyControlAction 纯同步、CAS 失败保持 temporary_hidden）；
 * - PageCompanionContextV1 / CompanionTriggerContextV1 adapter 基础设施
 *   （构造条件、短 TTL、销毁时机、permit+接受后升级）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPANION_CONTROL_STATE_IDS,
  COMPANION_CONTROL_STATE_META,
  DEFAULT_COMPANION_CONTROL_SNAPSHOT,
  applyControlAction,
  isSnapshotHidden,
  resolveControlEffects,
  shouldConstructContext,
  shouldMountObserver,
} from "./companion-control-state.ts";
import {
  PAGE_COMPANION_CONTEXT_VERSION,
  PAGE_CONTEXT_DEFAULT_TTL_MS,
  buildPageContextV1,
  buildTriggerContextV1,
  canUpgradeToFullContext,
  contextExpired,
  destroyContext,
  pageContextConstructionKind,
  shouldDestroyContext,
} from "./page-companion-context.ts";

const base = DEFAULT_COMPANION_CONTROL_SNAPSHOT;
const quietUncalled = {
  presence: "quiet" as const,
  surfaceActive: false,
  validActiveReason: false,
};
const quietSummoned = {
  presence: "quiet" as const,
  surfaceActive: true,
  validActiveReason: false,
};

describe("控制状态类型与元数据（§5.5 完整表）", () => {
  it("恰好 8 个控制状态，名称冻结", () => {
    assert.deepEqual(COMPANION_CONTROL_STATE_IDS, [
      "page_muted",
      "page_context_off",
      "focus_until_task_end",
      "suggestion_paused",
      "temporary_hidden",
      "global_off",
      "animation_off",
      "voice_output_off",
    ]);
  });

  it("每个状态都有作用域与行为描述，默认全部关闭（未选择前默认 quiet）", () => {
    for (const id of COMPANION_CONTROL_STATE_IDS) {
      const meta = COMPANION_CONTROL_STATE_META[id];
      assert.equal(meta.id, id);
      assert.ok(meta.scope.length > 0, `${id} 缺作用域`);
      assert.ok(meta.behavior.length > 0, `${id} 缺行为描述`);
      assert.equal(meta.defaultOn, false);
    }
  });

  it("作用域符合 §5.5：route/task/account/device/account_preference", () => {
    assert.equal(COMPANION_CONTROL_STATE_META.page_muted.scope, "route");
    assert.equal(COMPANION_CONTROL_STATE_META.page_context_off.scope, "route");
    assert.equal(COMPANION_CONTROL_STATE_META.focus_until_task_end.scope, "task");
    assert.equal(COMPANION_CONTROL_STATE_META.suggestion_paused.scope, "account");
    assert.equal(COMPANION_CONTROL_STATE_META.temporary_hidden.scope, "device");
    assert.equal(COMPANION_CONTROL_STATE_META.global_off.scope, "account");
    assert.equal(COMPANION_CONTROL_STATE_META.animation_off.scope, "account_preference");
    assert.equal(COMPANION_CONTROL_STATE_META.voice_output_off.scope, "account_preference");
  });
});

describe("quiet 未召唤：observer/context 构造为 0（§5.4.4）", () => {
  it("安静未召唤：不挂载 observer、不构造 context、无 trigger context，锚点保留", () => {
    const effects = resolveControlEffects(base, quietUncalled);
    assert.equal(effects.observerMounted, false);
    assert.equal(effects.contextConstructible, false);
    assert.equal(effects.triggerContextAllowed, false);
    assert.equal(effects.surfaceHidden, false);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.proactiveSuppressed, false);
  });

  it("零构造判定函数在 quiet 未召唤时为 false", () => {
    assert.equal(shouldMountObserver(base, quietUncalled), false);
    assert.equal(shouldConstructContext(base, quietUncalled), false);
  });
});

describe("quiet 显式召唤后：按 action 所需字段构造短 TTL context（§5.4.4）", () => {
  it("召唤后 observer 挂载、完整 context 可构造；仍无主动 trigger context", () => {
    const effects = resolveControlEffects(base, quietSummoned);
    assert.equal(effects.observerMounted, true);
    assert.equal(effects.contextConstructible, true);
    assert.equal(effects.triggerContextAllowed, false);
    assert.equal(effects.proactiveSuppressed, false);
  });

  it("零构造判定在召唤后为 true", () => {
    assert.equal(shouldMountObserver(base, quietSummoned), true);
    assert.equal(shouldConstructContext(base, quietSummoned), true);
  });
});

describe("page_context_off：即使用户召唤也只静态帮助（§5.4.4）", () => {
  const off = { ...base, pageContextOff: true };

  it("召唤后仍不挂载 observer、不构造 context、无 trigger context", () => {
    const effects = resolveControlEffects(off, quietSummoned);
    assert.equal(effects.observerMounted, false);
    assert.equal(effects.contextConstructible, false);
    assert.equal(effects.triggerContextAllowed, false);
    assert.equal(effects.surfaceHidden, false);
    assert.equal(effects.anchorVisible, true);
  });

  it("moderate + 合法 reason 也不升级上下文", () => {
    const effects = resolveControlEffects(off, {
      presence: "moderate",
      surfaceActive: false,
      validActiveReason: true,
    });
    assert.equal(effects.triggerContextAllowed, false);
    assert.equal(effects.contextConstructible, false);
  });

  it("零构造判定在 page_context_off 下为 false", () => {
    assert.equal(shouldMountObserver(off, quietSummoned), false);
    assert.equal(shouldConstructContext(off, quietSummoned), false);
  });
});

describe("temporary_hidden / global_off：立即停渲染、observer 与 context（§5.5）", () => {
  for (const [name, patch] of [
    ["temporary_hidden", { temporaryHidden: true }],
    ["global_off", { globalOff: true }],
    ["两者同时（global_off 蕴含 temporary_hidden）", { globalOff: true, temporaryHidden: true }],
  ] as const) {
    it(`${name}：表面隐藏、锚点/召唤消失、observer/context/trigger/语音/动画全部为 0`, () => {
      const snapshot = { ...base, ...patch };
      assert.equal(isSnapshotHidden(snapshot), true);
      const effects = resolveControlEffects(snapshot, quietSummoned);
      assert.equal(effects.surfaceHidden, true);
      assert.equal(effects.anchorVisible, false);
      assert.equal(effects.manualSummonAllowed, false);
      assert.equal(effects.observerMounted, false);
      assert.equal(effects.contextConstructible, false);
      assert.equal(effects.triggerContextAllowed, false);
      assert.equal(effects.voiceOutputEnabled, false);
      assert.equal(effects.autoVoiceEnabled, false);
      assert.equal(effects.animationEnabled, false);
    });
  }

  it("temporary_hidden / global_off 下零构造判定恒为 false（即使召唤）", () => {
    assert.equal(shouldMountObserver({ ...base, temporaryHidden: true }, quietSummoned), false);
    assert.equal(shouldConstructContext({ ...base, temporaryHidden: true }, quietSummoned), false);
    assert.equal(shouldMountObserver({ ...base, globalOff: true }, quietSummoned), false);
    assert.equal(shouldConstructContext({ ...base, globalOff: true }, quietSummoned), false);
  });
});

describe("page_muted / focus_until_task_end / suggestion_paused（§5.5）", () => {
  it("page_muted：保留锚点与召唤，主动建议与自动语音为 0，手动语音输出保留", () => {
    const effects = resolveControlEffects({ ...base, pageMuted: true }, quietSummoned);
    assert.equal(effects.proactiveSuppressed, true);
    assert.equal(effects.autoVoiceEnabled, false);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.manualSummonAllowed, true);
    assert.equal(effects.voiceOutputEnabled, true);
    assert.equal(effects.observerMounted, true);
    assert.equal(effects.contextConstructible, true);
  });

  it("focus_until_task_end：所有主动建议为 0，保留手动控件", () => {
    const effects = resolveControlEffects({ ...base, focusUntilTaskEnd: true }, quietSummoned);
    assert.equal(effects.proactiveSuppressed, true);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.observerMounted, true);
  });

  it("suggestion_paused：所有设备主动建议为 0，保留锚点与召唤", () => {
    const effects = resolveControlEffects({ ...base, suggestionPaused: true }, quietSummoned);
    assert.equal(effects.proactiveSuppressed, true);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.manualSummonAllowed, true);
    assert.equal(effects.observerMounted, true);
  });

  it("page_context_off 不抑制主动建议本身（它只关 context）", () => {
    const effects = resolveControlEffects({ ...base, pageContextOff: true }, quietSummoned);
    assert.equal(effects.proactiveSuppressed, false);
    assert.equal(effects.observerMounted, false);
  });

  it("page_muted / focus_until_task_end / suggestion_paused 下即使有合法 reason 也不产生 trigger context", () => {
    const moderate = {
      presence: "moderate" as const,
      surfaceActive: false,
      validActiveReason: true,
    };
    assert.equal(
      resolveControlEffects({ ...base, pageMuted: true }, moderate).triggerContextAllowed,
      false,
    );
    assert.equal(
      resolveControlEffects({ ...base, focusUntilTaskEnd: true }, moderate).triggerContextAllowed,
      false,
    );
    assert.equal(
      resolveControlEffects({ ...base, suggestionPaused: true }, moderate).triggerContextAllowed,
      false,
    );
  });
});

describe("animation_off / voice_output_off 账号级偏好（§5.5）", () => {
  it("animation_off：功能入口保留但静态角色，不改变学习权限", () => {
    const effects = resolveControlEffects({ ...base, animationOff: true }, quietSummoned);
    assert.equal(effects.animationEnabled, false);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.observerMounted, true);
    assert.equal(effects.voiceOutputEnabled, true);
  });

  it("voice_output_off：功能入口保留但静音", () => {
    const effects = resolveControlEffects({ ...base, voiceOutputOff: true }, quietSummoned);
    assert.equal(effects.voiceOutputEnabled, false);
    assert.equal(effects.autoVoiceEnabled, false);
    assert.equal(effects.anchorVisible, true);
    assert.equal(effects.animationEnabled, true);
  });
});

describe("moderate/active 只能用最小 CompanionTriggerContextV1（§5.4.4）", () => {
  it("moderate + 合法 reason：产生 trigger context，但不构造完整 context", () => {
    const effects = resolveControlEffects(base, {
      presence: "moderate",
      surfaceActive: false,
      validActiveReason: true,
    });
    assert.equal(effects.triggerContextAllowed, true);
    assert.equal(effects.contextConstructible, false);
    assert.equal(effects.observerMounted, false);
  });

  it("active + 无合法 reason：不产生 trigger context", () => {
    const effects = resolveControlEffects(base, {
      presence: "active",
      surfaceActive: false,
      validActiveReason: false,
    });
    assert.equal(effects.triggerContextAllowed, false);
  });
});

describe("立即生效不等待网络（§5.5）", () => {
  it("applyControlAction 是纯同步：set global_off=true 立即本地临时隐藏", () => {
    const next = applyControlAction(base, { kind: "set", state: "global_off", value: true });
    assert.equal(next.globalOff, true);
    assert.equal(next.temporaryHidden, true);
    assert.equal(isSnapshotHidden(next), true);
  });

  it("恢复 global_off=false 不静默撤销用户自己的设备级 temporary_hidden", () => {
    const hidden = applyControlAction(base, { kind: "set", state: "temporary_hidden", value: true });
    const restored = applyControlAction(hidden, { kind: "set", state: "global_off", value: false });
    assert.equal(restored.globalOff, false);
    assert.equal(restored.temporaryHidden, true);
    assert.equal(isSnapshotHidden(restored), true);
  });

  it("set temporary_hidden=true 只改设备级开关，不产生网络副作用", () => {
    const next = applyControlAction(base, { kind: "set", state: "temporary_hidden", value: true });
    assert.deepEqual(next, {
      ...base,
      temporaryHidden: true,
    });
  });

  it("set 其余控制状态只翻转对应字段", () => {
    const next = applyControlAction(base, { kind: "set", state: "page_muted", value: true });
    assert.deepEqual(next, { ...base, pageMuted: true });
  });
});

// ─── PageCompanionContextV1 / CompanionTriggerContextV1 adapter 基础设施 ──

describe("pageContextConstructionKind：构造条件（§5.4.4）", () => {
  it("quiet 未召唤 → none；quiet 召唤后 → full", () => {
    assert.equal(pageContextConstructionKind(base, quietUncalled), "none");
    assert.equal(pageContextConstructionKind(base, quietSummoned), "full");
  });

  it("page_context_off（即使召唤）→ none", () => {
    const off = { ...base, pageContextOff: true };
    assert.equal(pageContextConstructionKind(off, quietSummoned), "none");
  });

  it("temporary_hidden / global_off → none", () => {
    assert.equal(
      pageContextConstructionKind({ ...base, temporaryHidden: true }, quietSummoned),
      "none",
    );
    assert.equal(
      pageContextConstructionKind({ ...base, globalOff: true }, quietSummoned),
      "none",
    );
  });

  it("moderate/active + 合法 reason + 未召唤 → trigger_only；召唤后 → full", () => {
    const moderate = {
      presence: "moderate" as const,
      surfaceActive: false,
      validActiveReason: true,
    };
    assert.equal(pageContextConstructionKind(base, moderate), "trigger_only");
    assert.equal(
      pageContextConstructionKind(base, { ...moderate, surfaceActive: true }),
      "full",
    );
  });

  it("moderate/active + 无合法 reason → none", () => {
    assert.equal(
      pageContextConstructionKind(base, {
        presence: "active",
        surfaceActive: false,
        validActiveReason: false,
      }),
      "none",
    );
  });
});

describe("PageCompanionContextV1 构造：只按 action 所需字段、短 TTL、销毁（§5.4.4）", () => {
  it("buildPageContextV1 返回 versioned 净化上下文；entity refs 缺省为空（不发送完整实体列表）", () => {
    const ctx = buildPageContextV1({
      pageKind: "card_detail",
      pageInstanceId: "inst-1",
      originRef: "origin-opaque-1",
      activeMode: "browse",
      allowedActionIds: ["preview_navigation"],
      capabilityFlags: ["static_help"],
      permissionSnapshotHash: "perm-hash",
      hasUnsavedChanges: false,
      sensitivity: "normal",
    });
    assert.equal(ctx.contextVersion, PAGE_COMPANION_CONTEXT_VERSION);
    assert.deepEqual(ctx.visibleEntityRefs, []);
    assert.deepEqual(ctx.selectedEntityRefs, []);
    assert.equal(ctx.originRef, "origin-opaque-1");
    assert.deepEqual(ctx.allowedActionIds, ["preview_navigation"]);
  });

  it("buildPageContextV1 只接收 action 所需 entity refs（显式传入才出现）", () => {
    const ctx = buildPageContextV1({
      pageKind: "card_detail",
      pageInstanceId: "inst-1",
      originRef: "origin-opaque-1",
      activeMode: "browse",
      allowedActionIds: ["spotlight_ui_anchor"],
      capabilityFlags: [],
      permissionSnapshotHash: "perm-hash",
      hasUnsavedChanges: false,
      sensitivity: "normal",
      visibleEntityRefs: ["entity-opaque-1"],
    });
    assert.deepEqual(ctx.visibleEntityRefs, ["entity-opaque-1"]);
    assert.deepEqual(ctx.selectedEntityRefs, []);
  });

  it("短 TTL：TTL 内未过期、超过 TTL 即过期（面板关闭/动作结束即销毁）", () => {
    const createdAt = 1_000;
    assert.equal(contextExpired(createdAt, createdAt, PAGE_CONTEXT_DEFAULT_TTL_MS), false);
    assert.equal(
      contextExpired(createdAt, createdAt + PAGE_CONTEXT_DEFAULT_TTL_MS + 1),
      true,
    );
    assert.equal(
      contextExpired(createdAt, createdAt + PAGE_CONTEXT_DEFAULT_TTL_MS + 1, 5_000),
      true,
    );
  });

  it("面板关闭或动作结束 → 销毁；destroyContext 从 constructed 到 destroyed", () => {
    assert.equal(
      shouldDestroyContext("constructed", { panelClosed: true, actionEnded: false }),
      true,
    );
    assert.equal(
      shouldDestroyContext("active", { panelClosed: false, actionEnded: true }),
      true,
    );
    assert.equal(
      shouldDestroyContext("constructed", { panelClosed: false, actionEnded: false }),
      false,
    );
    assert.equal(destroyContext("constructed"), "destroyed");
    assert.equal(destroyContext("idle"), "idle");
  });
});

describe("CompanionTriggerContextV1 最小快照与升级（§5.4.4）", () => {
  it("trigger context 不含 visible/selected entity refs 或页面内容", () => {
    const trigger = buildTriggerContextV1({
      pageKind: "card_list",
      stablePageContextKey: "stable-key-1",
      sourceEventType: "card_updated",
      activeMode: "browse",
      capabilitySnapshotHash: "cap-hash",
      permissionSnapshotHash: "perm-hash",
    });
    assert.equal(trigger.contextVersion, 1);
    assert.equal("visibleEntityRefs" in trigger, false);
    assert.equal("selectedEntityRefs" in trigger, false);
    assert.equal(trigger.canonicalTargetRef, undefined);
  });

  it("canUpgradeToFullContext：permit + 用户接受才升级；缺一不可", () => {
    const input = { surfaceActive: true, permitGranted: true, userAccepted: true };
    assert.equal(canUpgradeToFullContext(base, input), true);
    assert.equal(
      canUpgradeToFullContext(base, { ...input, permitGranted: false }),
      false,
    );
    assert.equal(
      canUpgradeToFullContext(base, { ...input, userAccepted: false }),
      false,
    );
  });

  it("hidden / page_context_off 下即使 permit+接受也不升级", () => {
    const input = { surfaceActive: true, permitGranted: true, userAccepted: true };
    assert.equal(canUpgradeToFullContext({ ...base, temporaryHidden: true }, input), false);
    assert.equal(canUpgradeToFullContext({ ...base, globalOff: true }, input), false);
    assert.equal(canUpgradeToFullContext({ ...base, pageContextOff: true }, input), false);
  });
});
