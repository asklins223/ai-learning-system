/**
 * 任务 07-8：跨页、跨设备与失败恢复 单测（§5.4.7）。
 *
 * 覆盖：
 * - 跨页只携带四样东西（有界摘要/originRef/合法 entity refs/已确认 checkpoint），
 *   不携带无限消息流；返回恢复来源/滚动位置/星图 viewport/选择态；
 * - 跨设备同步白名单：同步 onboarding 终态/global off/存在感/suppression/目标/
 *   checkpoint；不同步 temporary hidden/page mute/未提交输入/原始音频/临时敏感；
 * - 新设备续接：presence/trigger 允许时至多问一次；quiet 只被动续接、绝不展开 Scene；
 * - 展示 target 前重查（workspace/权限/revision/policy/assistance/capability/时效），
 *   恢复/接管前不暴露未重验 target 名称；
 * - 多设备显式接管：未接管设备提交为 0，重复请求幂等；
 * - 登录过期恢复：回原页面与合法 checkpoint，不重放旧权限 action；
 * - 失败恢复：不阻塞页面、始终提供 retry/manual/exit、重试幂等。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKPOINT_STALE_THRESHOLD_MS,
  CROSS_DEVICE_SYNC_WHITELIST,
  MAX_CARRY_ENTITY_REFS,
  MAX_CARRY_SUMMARY_LENGTH,
  NEVER_CROSS_DEVICE_FIELDS,
  assertNoDeviceLocalLeak,
  buildFailureRecoveryOffer,
  chooseResumeResponse,
  deriveNewDeviceResumeOffer,
  extractCrossDeviceSyncState,
  isCommitAllowedForDevice,
  isCrossDeviceSyncField,
  isNeverCrossDeviceField,
  isUnboundedMessageFlowPresent,
  reauthResumeAfterExpiry,
  resolveCrossPageRestore,
  revalidateTargetBeforeReveal,
  tryExplicitTakeover,
  validateCrossPageCarry,
  type AccountSyncableState,
  type ConfirmedCheckpoint,
  type CrossPageCarryPayload,
  type DeviceLocalState,
  type MultiDeviceSessionState,
  type NewDeviceResumeInput,
  type ReauthResumeInput,
  type TargetRevalidationInput,
} from "./cross-device-recovery.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-08T12:00:00Z");

function checkpoint(overrides: Partial<ConfirmedCheckpoint> = {}): ConfirmedCheckpoint {
  return {
    checkpointId: "cp-1",
    sessionId: "session-1",
    episodeId: "episode-1",
    targetKeyPointId: "kp-1",
    confirmedAt: new Date("2026-08-06T10:00:00Z"),
    commitKey: "commit-1",
    workspaceId: "ws-1",
    targetWorkspaceId: "ws-1",
    contentRevision: 3,
    ...overrides,
  };
}

function carryPayload(overrides: Partial<CrossPageCarryPayload> = {}): CrossPageCarryPayload {
  return {
    taskSummary: {
      sessionId: "session-1",
      episodeId: "episode-1",
      targetKeyPointId: "kp-1",
      goalText: "巩固关键点 kp-1 的边界条件。",
    },
    originRef: { type: "key_point", id: "kp-1" },
    entityRefs: [
      { kind: "key_point", id: "kp-1", workspaceId: "ws-1" },
      { kind: "card", id: "card-1", workspaceId: "ws-1" },
    ],
    confirmedCheckpoint: checkpoint(),
    ...overrides,
  };
}

function syncableState(overrides: Partial<AccountSyncableState> = {}): AccountSyncableState {
  return {
    onboarding_offer_terminal: true,
    global_off: false,
    presence: "moderate",
    suggestion_suppression: ["class-a"],
    learning_goals: ["kp-1"],
    session_checkpoint: checkpoint(),
    ...overrides,
  };
}

function deviceLocal(overrides: Partial<DeviceLocalState> = {}): DeviceLocalState {
  return {
    temporaryHidden: true,
    pageMuted: true,
    unsubmittedInput: { draft: "未提交草稿" },
    rawAudioPending: true,
    transientSensitive: true,
    ...overrides,
  };
}

function revalidationInput(overrides: Partial<TargetRevalidationInput> = {}): TargetRevalidationInput {
  return {
    currentWorkspaceId: "ws-1",
    targetWorkspaceId: "ws-1",
    targetName: "某个目标名称",
    permissionGranted: true,
    contentRevisionFresh: true,
    policyMatches: true,
    assistanceAllowed: true,
    capabilityGranted: true,
    revalidationAt: NOW,
    checkpointAt: new Date("2026-08-06T10:00:00Z"),
    ...overrides,
  };
}

function deviceState(overrides: Partial<MultiDeviceSessionState> = {}): MultiDeviceSessionState {
  return {
    sessionId: "session-1",
    currentDeviceId: "device-a",
    ownerDeviceId: null,
    takeoverEpoch: 1,
    ...overrides,
  };
}

// ─── 1. 跨页有界携带与返回恢复 ───────────────────────────────────────────

describe("跨页有界携带（§5.4.7 bullet 1）", () => {
  it("合法 payload（四样东西）→ 校验通过", () => {
    const result = validateCrossPageCarry(carryPayload());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.entityRefs.length, 2);
      assert.ok(result.payload.confirmedCheckpoint !== null);
    }
  });

  it("携带 messages 数组 → 拒绝（不携带无限消息流）", () => {
    const bad = carryPayload({ taskSummary: { ...carryPayload().taskSummary } });
    const leaked = { ...bad, messages: [{ role: "user", content: "..." }] };
    const result = validateCrossPageCarry(leaked);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unbounded_message_flow");
  });

  it("嵌套 messageHistory / transcript → 拒绝", () => {
    const bad = carryPayload();
    const leaked = {
      ...bad,
      taskSummary: {
        ...bad.taskSummary,
        transcript: ["一句话一句话……"],
      },
    };
    const result = validateCrossPageCarry(leaked);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unbounded_message_flow");
  });

  it("isUnboundedMessageFlowPresent 检测 messages 数组", () => {
    assert.equal(isUnboundedMessageFlowPresent({ messages: [] }), true);
    assert.equal(isUnboundedMessageFlowPresent({ nested: { messageHistory: [] } }), true);
    assert.equal(isUnboundedMessageFlowPresent({ taskSummary: { goalText: "x" } }), false);
  });

  it("goalText 超过有界长度 → 拒绝", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      taskSummary: { ...bad.taskSummary, goalText: "x".repeat(MAX_CARRY_SUMMARY_LENGTH + 1) },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "summary_too_long");
  });

  it("entity refs 超过数量上限 → 拒绝", () => {
    const bad = carryPayload();
    const many = Array.from({ length: MAX_CARRY_ENTITY_REFS + 1 }, (_, i) => ({
      kind: "card" as const,
      id: `card-${i}`,
      workspaceId: "ws-1",
    }));
    const result = validateCrossPageCarry({ ...bad, entityRefs: many });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "too_many_entity_refs");
  });

  it("非法 entity ref kind → 拒绝", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      entityRefs: [{ kind: "evidence", id: "e-1", workspaceId: "ws-1" }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_entity_ref");
  });

  it("跨 workspace entity ref → 拒绝（跨 workspace 泄漏为 0）", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      entityRefs: [
        { kind: "key_point", id: "kp-1", workspaceId: "ws-1" },
        { kind: "note", id: "note-1", workspaceId: "ws-2" },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "cross_workspace_entity_ref");
  });

  it("checkpoint 与 entity refs 不属于同一 workspace → 拒绝", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      entityRefs: [{ kind: "key_point", id: "kp-1", workspaceId: "ws-1" }],
      confirmedCheckpoint: checkpoint({ workspaceId: "ws-2", targetWorkspaceId: "ws-2" }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "cross_workspace_entity_ref");
  });

  it("非法 originRef → 拒绝", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      originRef: { type: "file", id: "f-1" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_origin_ref");
  });

  it("非法 checkpoint → 拒绝", () => {
    const bad = carryPayload();
    const result = validateCrossPageCarry({
      ...bad,
      confirmedCheckpoint: { ...checkpoint(), contentRevision: Number.NaN },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_checkpoint");
  });

  it("无 checkpoint / 无 originRef 的浏览态 carry 也合法（可空字段）", () => {
    const result = validateCrossPageCarry(
      carryPayload({ originRef: null, confirmedCheckpoint: null }),
    );
    assert.equal(result.ok, true);
  });

  it("返回时恢复来源/滚动位置/星图 viewport/选择态", () => {
    const carry = carryPayload();
    const info = resolveCrossPageRestore(carry, {
      origin: "star-map",
      scrollPosition: { x: 12, y: 34 },
      frozenStarMap: {
        viewport: { offsetX: 100, offsetY: 200, zoom: 1.5 },
        selection: { selectedId: "kp-1" },
      },
    });
    assert.equal(info.origin, "star-map");
    assert.deepEqual(info.scrollPosition, { x: 12, y: 34 });
    assert.deepEqual(info.starMapViewport, { offsetX: 100, offsetY: 200, zoom: 1.5 });
    assert.deepEqual(info.starMapSelection, { selectedId: "kp-1" });
  });

  it("非星图来源 → 不恢复 viewport/选择态（即使提供了冻结现场）", () => {
    const carry = carryPayload();
    const info = resolveCrossPageRestore(carry, {
      origin: "card-detail",
      scrollPosition: null,
      frozenStarMap: {
        viewport: { offsetX: 100, offsetY: 200, zoom: 1.5 },
        selection: { selectedId: "kp-1" },
      },
    });
    assert.equal(info.starMapViewport, null);
    assert.equal(info.starMapSelection, null);
    assert.equal(info.origin, "card-detail");
  });
});

// ─── 2. 跨设备同步白名单 ─────────────────────────────────────────────────

describe("跨设备同步白名单（§5.4.7 bullet 2）", () => {
  it("白名单恰好包含六类同步字段", () => {
    assert.deepEqual([...CROSS_DEVICE_SYNC_WHITELIST], [
      "onboarding_offer_terminal",
      "global_off",
      "presence",
      "suggestion_suppression",
      "learning_goals",
      "session_checkpoint",
    ]);
  });

  it("临时隐藏/页面静音/未提交输入/原始音频/临时敏感绝不同步", () => {
    assert.deepEqual([...NEVER_CROSS_DEVICE_FIELDS], [
      "temporary_hidden",
      "page_mute",
      "unsubmitted_input",
      "raw_audio",
      "transient_sensitive",
    ]);
    for (const field of NEVER_CROSS_DEVICE_FIELDS) {
      assert.equal(isCrossDeviceSyncField(field), false, `${field} 不在同步白名单`);
      assert.equal(isNeverCrossDeviceField(field), true, `${field} 标记为绝不跨设备同步`);
    }
  });

  it("提取同步快照：只含白名单字段，device-local 全部排除", () => {
    const sync = extractCrossDeviceSyncState({
      syncable: syncableState(),
      deviceLocal: deviceLocal(),
    });
    const keys = Object.keys(sync).sort();
    assert.deepEqual(keys, [...CROSS_DEVICE_SYNC_WHITELIST].sort(), "同步快照键集合 = 白名单");
    // device-local 内容不得出现在同步快照中
    assert.equal("temporary_hidden" in sync, false);
    assert.equal("page_mute" in sync, false);
    assert.equal("unsubmitted_input" in sync, false);
    assert.equal("raw_audio" in sync, false);
    assert.equal("transient_sensitive" in sync, false);
    // 同步内容与源一致
    assert.equal(sync.onboarding_offer_terminal, true);
    assert.equal(sync.presence, "moderate");
    assert.deepEqual(sync.suggestion_suppression, ["class-a"]);
  });

  it("同步 payload 含 device-local 键 → 防泄漏校验失败", () => {
    const sync = extractCrossDeviceSyncState({
      syncable: syncableState(),
      deviceLocal: deviceLocal(),
    });
    assert.equal(assertNoDeviceLocalLeak(sync), true);
    assert.equal(assertNoDeviceLocalLeak({ ...sync, temporary_hidden: true }), false);
    assert.equal(assertNoDeviceLocalLeak({ ...sync, unsubmitted_input: {} }), false);
    assert.equal(assertNoDeviceLocalLeak({ ...sync, raw_audio: true }), false);
  });

  it("未提交输入与原始音频绝不进入同步 payload（直接验证字段值）", () => {
    const sync = extractCrossDeviceSyncState({
      syncable: syncableState(),
      deviceLocal: deviceLocal({ unsubmittedInput: { secretDraft: "…" }, rawAudioPending: true }),
    });
    const serialized = JSON.stringify(sync);
    assert.ok(!serialized.includes("secretDraft"), "未提交输入不得被序列化进同步快照");
  });
});

// ─── 3. 新设备续接询问 ───────────────────────────────────────────────────

describe("新设备续接询问（§5.4.7 bullet 3）", () => {
  const input = (overrides: Partial<NewDeviceResumeInput> = {}): NewDeviceResumeInput => ({
    presence: "moderate",
    triggerAllowed: true,
    alreadyAskedOnDevice: false,
    hasResumableCheckpoint: true,
    ...overrides,
  });

  it("无 checkpoint → 不询问", () => {
    const offer = deriveNewDeviceResumeOffer(input({ hasResumableCheckpoint: false }));
    assert.equal(offer.kind, "none");
  });

  it("moderate + trigger 允许 + 未问过 → 至多问一次", () => {
    const offer = deriveNewDeviceResumeOffer(input());
    assert.equal(offer.kind, "ask_once");
    if (offer.kind === "ask_once") assert.ok(offer.text.includes("继续"));
  });

  it("已问过一次 → 不重复问，只给被动入口", () => {
    const offer = deriveNewDeviceResumeOffer(input({ alreadyAskedOnDevice: true }));
    assert.equal(offer.kind, "passive_entry");
  });

  it("quiet 下只给被动续接入口，绝不自动展开 Scene", () => {
    const offer = deriveNewDeviceResumeOffer(input({ presence: "quiet", triggerAllowed: true }));
    assert.equal(offer.kind, "passive_entry");
  });

  it("trigger 不允许 → 被动入口", () => {
    const offer = deriveNewDeviceResumeOffer(input({ triggerAllowed: false }));
    assert.equal(offer.kind, "passive_entry");
  });

  it("active + trigger 允许 + 未问过 → 同样至多一次", () => {
    const offer = deriveNewDeviceResumeOffer(input({ presence: "active" }));
    assert.equal(offer.kind, "ask_once");
  });

  it("选择「继续」也不自动展开完整 Scene：必须重查 + 显式接管", () => {
    const choice = chooseResumeResponse("continue_task");
    assert.equal(choice.choice, "continue_task");
    assert.equal(choice.needsRevalidation, true);
    assert.equal(choice.needsExplicitTakeover, true);
  });

  it("选择「暂不恢复」 → not_now", () => {
    assert.equal(chooseResumeResponse("not_now").choice, "not_now");
  });
});

// ─── 4. target 展示前重查 ────────────────────────────────────────────────

describe("target 展示前重查（§5.4.7 bullet 3）", () => {
  it("全部通过 → 才暴露 target 名称", () => {
    const result = revalidateTargetBeforeReveal(revalidationInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.targetNameRevealed, true);
      assert.equal(result.targetName, "某个目标名称");
    }
  });

  const failureCases: Array<[keyof TargetRevalidationInput, unknown, string]> = [
    ["currentWorkspaceId", "ws-9", "workspace_mismatch"],
    ["permissionGranted", false, "permission_revoked"],
    ["contentRevisionFresh", false, "content_revision_stale"],
    ["policyMatches", false, "policy_outdated"],
    ["assistanceAllowed", false, "assistance_not_allowed"],
    ["capabilityGranted", false, "capability_missing"],
  ];

  for (const [key, value, expectedReason] of failureCases) {
    it(`任一重查失败（${key}）→ 说明原因并安全重建，不暴露 target 名称`, () => {
      const result = revalidateTargetBeforeReveal(
        revalidationInput({ [key]: value } as Partial<TargetRevalidationInput>),
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.targetNameRevealed, false);
        assert.equal(result.reason, expectedReason);
        assert.ok(result.rebuild.reasonText.length > 0);
        // 恢复/接管前不暴露未重验 target 名称：失败文本不得包含目标名称
        assert.ok(
          !JSON.stringify(result.rebuild).includes("某个目标名称"),
          "失败原因不得暴露未重验的 target 名称",
        );
      }
    });
  }

  it("checkpoint 太旧 → checkpoint_too_old（安全重建）", () => {
    const result = revalidateTargetBeforeReveal(
      revalidationInput({
        checkpointAt: new Date(NOW.getTime() - CHECKPOINT_STALE_THRESHOLD_MS - 1),
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "checkpoint_too_old");
  });

  it("无 checkpoint → 视为太旧", () => {
    const result = revalidateTargetBeforeReveal(revalidationInput({ checkpointAt: null }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "checkpoint_too_old");
  });

  it("checkpoint 在阈值内 → 不因时效拒绝", () => {
    const result = revalidateTargetBeforeReveal(
      revalidationInput({
        checkpointAt: new Date(NOW.getTime() - CHECKPOINT_STALE_THRESHOLD_MS),
      }),
    );
    assert.equal(result.ok, true);
  });
});

// ─── 5. 多设备显式接管 ───────────────────────────────────────────────────

describe("多设备显式接管（§5.4.7 bullet 4）", () => {
  it("无接管者 → 首个显式请求接管成功", () => {
    const result = tryExplicitTakeover(deviceState(), "device-a", 2);
    assert.equal(result.granted, true);
    assert.equal(result.role, "owner");
    assert.equal(result.commitAllowed, true);
    assert.equal(result.readonlyNotice, null);
  });

  it("已接管者重复请求 → 幂等：结果不变（granted 仍 true）", () => {
    const first = tryExplicitTakeover(deviceState(), "device-a", 2);
    const state = deviceState({ ownerDeviceId: "device-a", takeoverEpoch: first.takeoverEpoch });
    const again = tryExplicitTakeover(state, "device-a", 3);
    assert.equal(again.granted, true);
    assert.equal(again.commitAllowed, true);
    assert.equal(again.takeoverEpoch, first.takeoverEpoch, "重复接管不改变 epoch（幂等）");
  });

  it("其它设备请求 → 只读提示，提交为 0", () => {
    const state = deviceState({ ownerDeviceId: "device-a" });
    const result = tryExplicitTakeover(state, "device-b", 2);
    assert.equal(result.granted, false);
    assert.equal(result.role, "readonly");
    assert.equal(result.commitAllowed, false, "未接管设备提交为 0");
    assert.ok(result.readonlyNotice !== null);
  });

  it("未接管设备提交恒为 0（isCommitAllowedForDevice）", () => {
    const state = deviceState({ ownerDeviceId: "device-a" });
    assert.equal(isCommitAllowedForDevice(state, "device-a"), true);
    assert.equal(isCommitAllowedForDevice(state, "device-b"), false);
    assert.equal(isCommitAllowedForDevice(state, "device-c"), false);
  });

  it("只读提示不含 target 名称（不泄露未重验信息）", () => {
    const state = deviceState({ ownerDeviceId: "device-a" });
    const result = tryExplicitTakeover(state, "device-b", 2);
    assert.ok(result.readonlyNotice !== null);
    assert.ok(!result.readonlyNotice.includes("某个目标名称"));
  });
});

// ─── 6. 登录过期恢复 ─────────────────────────────────────────────────────

describe("登录过期恢复（§5.4.7 bullet 5）", () => {
  const reauthInput = (overrides: Partial<ReauthResumeInput> = {}): ReauthResumeInput => ({
    checkpoint: checkpoint(),
    originalPage: "card-detail",
    authFresh: true,
    grantedScopes: ["read"],
    pendingAction: "commit_episode",
    ...overrides,
  });

  it("重新认证成功 → 回到原页面与合法 checkpoint", () => {
    const result = reauthResumeAfterExpiry(reauthInput());
    assert.equal(result.restorePage, "card-detail");
    assert.ok(result.restoreCheckpoint !== null);
    assert.equal(result.restoreCheckpoint!.checkpointId, "cp-1");
    assert.deepEqual(result.availableScopes, ["read"]);
  });

  it("不重放旧权限 action：replayedOldPermissionActions 恒为空数组", () => {
    const result = reauthResumeAfterExpiry(reauthInput());
    assert.deepEqual(result.replayedOldPermissionActions, []);
    assert.equal(result.pendingExplicitConfirmation, "commit_episode",
      "过期前的权限 action 转为需用户重新显式确认，不自动重放");
  });

  it("认证未恢复 → 不恢复 checkpoint，不授予 scope", () => {
    const result = reauthResumeAfterExpiry(reauthInput({ authFresh: false }));
    assert.equal(result.restoreCheckpoint, null);
    assert.deepEqual(result.availableScopes, []);
    assert.equal(result.pendingExplicitConfirmation, null);
    assert.deepEqual(result.replayedOldPermissionActions, []);
  });
});

// ─── 7. 失败恢复与重试幂等 ──────────────────────────────────────────────

describe("失败恢复与重试幂等（§5.4.7 bullet 6）", () => {
  it("始终提供「重试 / 使用手动方式 / 退出伴星」", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "model",
      steps: ["s1", "s2", "s3"],
      confirmedSteps: ["s1"],
      appliedSteps: ["s1"],
      retryCount: 0,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    assert.deepEqual([...offer.options], ["retry", "manual", "exit"]);
    assert.equal(offer.neverBlockPage, true, "失败不阻塞页面");
  });

  it("重试幂等：只重放未应用步骤，已确认/已应用步骤不重复", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "voice",
      steps: ["s1", "s2", "s3"],
      confirmedSteps: ["s1"],
      appliedSteps: ["s1"],
      retryCount: 0,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    assert.deepEqual([...offer.retryPlan.stepsToRetry], ["s2", "s3"]);
    assert.deepEqual([...offer.retryPlan.alreadyApplied], ["s1"]);
    assert.equal(offer.retryPlan.retryIdempotent, true);
    assert.deepEqual(offer.retryPlan.lostConfirmedSteps, [], "不丢失已确认步骤");
    assert.equal(offer.retryPlan.canRetry, true);
  });

  it("已达重试上限 → 不再建议重试（但仍提供手动/退出）", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "model",
      steps: ["s1"],
      confirmedSteps: [],
      appliedSteps: [],
      retryCount: 3,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    assert.equal(offer.retryPlan.canRetry, false);
    assert.deepEqual([...offer.options], ["retry", "manual", "exit"]);
  });

  it("存在丢失的已确认步骤 → 不安全，禁止重试", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "shell",
      steps: ["s2"],
      confirmedSteps: ["s1"],
      appliedSteps: [],
      retryCount: 0,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    assert.deepEqual([...offer.retryPlan.lostConfirmedSteps], ["s1"]);
    assert.equal(offer.retryPlan.retryIdempotent, false);
    assert.equal(offer.retryPlan.canRetry, false, "丢失已确认步骤时不能安全重试");
  });

  it("已应用副作用不重复：全部步骤已应用 → 无步骤可重试", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "animation",
      steps: ["s1"],
      confirmedSteps: ["s1"],
      appliedSteps: ["s1"],
      retryCount: 0,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    assert.deepEqual(offer.retryPlan.stepsToRetry, []);
    assert.equal(offer.retryPlan.canRetry, false);
  });

  it("guidance 有内容且非身份化（不含责备/催促）", () => {
    const offer = buildFailureRecoveryOffer({
      failureKind: "role",
      steps: ["s1", "s2"],
      confirmedSteps: ["s1"],
      appliedSteps: ["s1"],
      retryCount: 0,
      maxRetries: 3,
      manualFallbackAvailable: true,
    });
    for (const word of ["你落后", "欠", "保住"]) {
      assert.ok(!offer.guidance.includes(word), `guidance 不应包含「${word}」`);
    }
    assert.ok(offer.guidance.length > 0);
  });
});
