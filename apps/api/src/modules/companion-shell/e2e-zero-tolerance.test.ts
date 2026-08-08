/**
 * 阶段 08（W7）任务 08-5：全链路 E2E 0 容忍校验单测（§16.4 硬 Gate + §17.1 子集）。
 *
 * 每个 0 容忍项提供「干净样本断言 0 违规 + 违规样本断言必检」双断言，
 * 保证校验逻辑的确定性覆盖（对应冻结记录 01-5 §5.3 与 08-w7 任务 08-5）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertZeroTolerance,
  checkAutonomyZero,
  checkCredentialPageZeroIngress,
  checkEpochPropagationSla,
  checkHiddenOffZeroActivity,
  checkMutationRequiresFourGates,
  checkNewDevicePreResolutionZeroMount,
  checkOnboardingZero,
  checkQuietZeroAndPrePermitTransfer,
  computeStopSuccessRate,
  CREDENTIAL_INGRESS_CHANNELS,
  GLOBAL_OFF_PROPAGATION_SLA_MS,
  isCredentialIngressChannel,
  isZeroToleranceActivityKind,
  runZeroToleranceSuite,
  ZERO_TOLERANCE_ACTIVITY_KINDS,
  ZERO_TOLERANCE_DIMENSION_IDS,
  ZeroToleranceFailure,
  type CompanionActivity,
  type MutationAttempt,
  type ZeroToleranceScenario,
} from "./e2e-zero-tolerance.ts";

// ─── helper ───────────────────────────────────────────────────────────────

function act(
  kind: CompanionActivity["kind"],
  overrides: Partial<CompanionActivity> = {},
): CompanionActivity {
  return { kind, ...overrides };
}

/** 干净的全链路场景：所有维度 0 容忍应通过。 */
function cleanScenario(): ZeroToleranceScenario {
  return {
    hiddenOff: {
      deviceSessionId: "device-a",
      temporaryHiddenConfirmed: false,
      globalOffCasApplied: false,
      activities: [],
    },
    epochPropagation: {
      globalOffAppliedAtMs: 1_000,
      accountEpochAfterGlobalOff: 7,
      devices: [],
      leaseExpiredAtMs: 0,
      activities: [],
      globalOffCasFailed: false,
      displayedGlobalSuccess: false,
    },
    newDevice: [],
    credentialPage: { activities: [] },
    quietTransfer: { presence: "quiet", surfaceActive: false, activities: [] },
    mutationGates: { mutations: [] },
    autonomy: { activities: [], laterDismissStopEffects: [], stopAttempts: [] },
    onboarding: {
      offerStatus: "not_offered",
      autoShowsAfterOffer: 0,
      autoInviteOrReplayAfterConsumed: 0,
      skipActionCount: 1,
      terminalRollbackCount: 0,
    },
  };
}

function hiddenOffInput(overrides: Partial<Parameters<typeof checkHiddenOffZeroActivity>[0]> = {}) {
  return {
    deviceSessionId: "device-a",
    temporaryHiddenConfirmed: false,
    globalOffCasApplied: false,
    activities: [],
    ...overrides,
  };
}

function epochInput(overrides: Partial<Parameters<typeof checkEpochPropagationSla>[0]> = {}) {
  return {
    globalOffAppliedAtMs: 1_000,
    accountEpochAfterGlobalOff: 7,
    devices: [],
    leaseExpiredAtMs: 0,
    activities: [],
    globalOffCasFailed: false,
    displayedGlobalSuccess: false,
    ...overrides,
  };
}

// ─── D1：hidden/off 零活动矩阵（01-5 §5.3-1）─────────────────────────────

describe("D1 checkHiddenOffZeroActivity：temporary_hidden / global_off 零活动矩阵", () => {
  it("干净样本：temporary_hidden 未确认、无活动 → 0 违规", () => {
    assert.deepEqual(checkHiddenOffZeroActivity(hiddenOffInput()), []);
  });

  it("temporary_hidden 确认后当前设备 8 类活动各自=0 被违反（listener/DTO/角色/声音/邀请/预取/调用）", () => {
    const kinds: CompanionActivity["kind"][] = [
      "page_context_listener",
      "page_context_dto",
      "character",
      "voice",
      "in_app_invite",
      "prefetch",
      "companion_call",
    ];
    for (const kind of kinds) {
      const violations = checkHiddenOffZeroActivity(
        hiddenOffInput({ temporaryHiddenConfirmed: true, activities: [act(kind)] }),
      );
      assert.equal(
        violations.length,
        1,
        `${kind} 必须被检出一项违规`,
      );
      assert.match(violations[0], /temporary_hidden 确认后当前设备/);
    }
  });

  it("temporary_hidden 确认后 observer_mount / idle_animation 也=0（observer/context 零构造）", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({
        temporaryHiddenConfirmed: true,
        activities: [act("observer_mount"), act("idle_animation")],
      }),
    );
    assert.equal(violations.length, 2);
  });

  it("temporary_hidden 只约束当前设备：其他设备活动不违规", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({
        temporaryHiddenConfirmed: true,
        activities: [act("voice", { deviceSessionId: "device-b" })],
      }),
    );
    assert.deepEqual(violations, []);
  });

  it("temporary_hidden 确认前的活动不算违规（时间窗判定）", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({
        temporaryHiddenConfirmed: true,
        hiddenConfirmedAtMs: 5_000,
        activities: [act("prefetch", { atMs: 3_000 })],
      }),
    );
    assert.deepEqual(violations, []);
  });

  it("global_off CAS 后所有设备的活动=0 被违反（不区分 device）", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({
        globalOffCasApplied: true,
        activities: [
          act("page_context_listener", { deviceSessionId: "device-a" }),
          act("companion_call", { deviceSessionId: "device-b" }),
        ],
      }),
    );
    assert.equal(violations.length, 2);
    assert.match(violations[0], /global_off CAS 后/);
  });

  it("global_off CAS 后 Companion 系统通知=0 被违反", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({
        globalOffCasApplied: true,
        activities: [act("system_notification")],
      }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /system_notification/);
  });

  it("可取消调用已请求取消但未取消 → 违规；已取消 → 不违规", () => {
    const cancelled = checkHiddenOffZeroActivity(
      hiddenOffInput({
        activities: [
          act("companion_call", { cancelRequested: true, cancelled: true }),
        ],
      }),
    );
    assert.deepEqual(cancelled, []);

    const notCancelled = checkHiddenOffZeroActivity(
      hiddenOffInput({
        activities: [act("companion_call", { cancelRequested: true, cancelled: false })],
      }),
    );
    assert.equal(notCancelled.length, 1);
    assert.match(notCancelled[0], /未取消/);
  });

  it("迟到结果被采用 → 违规（须丢弃不渲染不写状态）", () => {
    const violations = checkHiddenOffZeroActivity(
      hiddenOffInput({ activities: [act("late_result_adopted")] }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /迟到/);
  });
});

// ─── D2：epoch 传播 SLA 与 lease/CAS（01-5 §5.3-2）───────────────────────

describe("D2 checkEpochPropagationSla：epoch 传播 SLA、旧 lease、CAS 失败", () => {
  it("干净样本：SLA 内传播 + 最新 epoch + 无旧 lease 活动 + CAS 成功 → 0 违规", () => {
    assert.deepEqual(
      checkEpochPropagationSla(
        epochInput({
          devices: [
            { deviceSessionId: "d1", epochReceivedAtMs: 1_500, epochReceived: 7 },
            { deviceSessionId: "d2", epochReceivedAtMs: 2_000, epochReceived: 7 },
          ],
        }),
      ),
      [],
    );
  });

  it("epoch 传播超过 W0 SLA → 违规", () => {
    const violations = checkEpochPropagationSla(
      epochInput({
        devices: [
          { deviceSessionId: "d1", epochReceivedAtMs: 1_000 + GLOBAL_OFF_PROPAGATION_SLA_MS + 1, epochReceived: 7 },
        ],
      }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /超过 W0 SLA/);
  });

  it("设备收到旧 epoch（不等于当前 account epoch）→ 违规", () => {
    const violations = checkEpochPropagationSla(
      epochInput({
        devices: [{ deviceSessionId: "d1", epochReceivedAtMs: 1_500, epochReceived: 6 }],
      }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /旧 epoch/);
  });

  it("旧 lease 到期后仍挂载/调用 → 违规；到期前不违规", () => {
    const violations = checkEpochPropagationSla(
      epochInput({
        leaseExpiredAtMs: 10_000,
        activities: [
          act("observer_mount", { atMs: 12_000 }),
          act("companion_call", { atMs: 15_000 }),
          act("page_context_dto", { atMs: 8_000 }), // 到期前
        ],
      }),
    );
    assert.equal(violations.length, 2);
  });

  it("CAS 失败却显示全局成功 → 违规", () => {
    const violations = checkEpochPropagationSla(
      epochInput({ globalOffCasFailed: true, displayedGlobalSuccess: true }),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /CAS 失败/);
  });

  it("CAS 失败但显示「仅本设备已隐藏，尚未同步」→ 不违规", () => {
    assert.deepEqual(
      checkEpochPropagationSla(epochInput({ globalOffCasFailed: true, displayedGlobalSuccess: false })),
      [],
    );
  });
});

// ─── D3：新设备认证后、解析前零挂载（01-5 §5.3-3）────────────────────────

describe("D3 checkNewDevicePreResolutionZeroMount：认证后解析前零挂载", () => {
  it("干净样本：认证 → 解析 → 之后才挂载 → 0 违规", () => {
    const events = [
      { kind: "auth_completed" as const, atMs: 100 },
      { kind: "account_state_resolved" as const, atMs: 400 },
      { kind: "mount_activity" as const, atMs: 500, activity: act("observer_mount") },
    ];
    assert.deepEqual(checkNewDevicePreResolutionZeroMount(events), []);
  });

  it("认证后、开关状态解析前挂载 observer → 违规", () => {
    const events = [
      { kind: "auth_completed" as const, atMs: 100 },
      { kind: "mount_activity" as const, atMs: 200, activity: act("observer_mount") },
      { kind: "account_state_resolved" as const, atMs: 400 },
    ];
    const violations = checkNewDevicePreResolutionZeroMount(events);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /解析前/);
  });

  it("认证后、解析前发 Companion 调用 / 挂角色 → 违规", () => {
    const events = [
      { kind: "auth_completed" as const, atMs: 100 },
      { kind: "mount_activity" as const, atMs: 200, activity: act("companion_call") },
      { kind: "mount_activity" as const, atMs: 250, activity: act("character") },
    ];
    assert.equal(checkNewDevicePreResolutionZeroMount(events).length, 2);
  });

  it("认证前挂载不算（认证层静态帮助除外）→ 不违规", () => {
    const events = [
      { kind: "mount_activity" as const, atMs: 50, activity: act("character") },
      { kind: "auth_completed" as const, atMs: 100 },
    ];
    assert.deepEqual(checkNewDevicePreResolutionZeroMount(events), []);
  });
});

// ─── D4：credential 页六面零进入（01-5 §5.3-4）───────────────────────────

describe("D4 checkCredentialPageZeroIngress：credential 页六面零进入", () => {
  it("干净样本：无任何进入/模型/预取/observer → 0 违规", () => {
    assert.deepEqual(checkCredentialPageZeroIngress({ activities: [] }), []);
  });

  it("输入值进入六面任一渠道 → 违规（companion_dto/logs/analytics/screenshot/model_request/persistent_context）", () => {
    for (const channel of CREDENTIAL_INGRESS_CHANNELS) {
      const violations = checkCredentialPageZeroIngress({
        activities: [act("credential_value_ingress", { channel })],
      });
      assert.equal(violations.length, 1, `${channel} 必须检出一项`);
      assert.match(violations[0], /输入值进入/);
    }
  });

  it("字段交互元数据（焦点/长度/粘贴/自动填充/时序）进入渠道 → 违规", () => {
    const violations = checkCredentialPageZeroIngress({
      activities: [act("credential_metadata_ingress", { channel: "analytics" })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /字段交互元数据/);
  });

  it("credential 页 LLM/ASR/TTS、个性化预取与 DOM/selection observer → 各自违规", () => {
    const kinds: CompanionActivity["kind"][] = ["llm_call", "asr_call", "tts_call", "prefetch", "observer_mount"];
    for (const kind of kinds) {
      const violations = checkCredentialPageZeroIngress({
        activities: [act(kind, { pageSensitivity: "credential" })],
      });
      assert.equal(violations.length, 1, `${kind} 必须被检出`);
    }
  });

  it("非 credential 页的预取/observer 不违规（敏感级判定）", () => {
    assert.deepEqual(
      checkCredentialPageZeroIngress({
        activities: [act("prefetch", { pageSensitivity: "normal" })],
      }),
      [],
    );
  });
});

// ─── D5：quiet 零 observer/context/idle；permit+accept 前零传输（01-5 §5.3-8）─

describe("D5 checkQuietZeroAndPrePermitTransfer：quiet 与 permit 前零传输", () => {
  it("干净样本：quiet 未召唤且无活动 → 0 违规", () => {
    assert.deepEqual(checkQuietZeroAndPrePermitTransfer({ presence: "quiet", surfaceActive: false, activities: [] }), []);
  });

  it("quiet 未召唤时挂载 entity/selection observer → 违规", () => {
    const violations = checkQuietZeroAndPrePermitTransfer({
      presence: "quiet",
      surfaceActive: false,
      activities: [act("observer_mount")],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /observer/);
  });

  it("quiet 未召唤时 idle 动画 → 违规", () => {
    const violations = checkQuietZeroAndPrePermitTransfer({
      presence: "quiet",
      surfaceActive: false,
      activities: [act("idle_animation")],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /idle/);
  });

  it("quiet 未召唤时完整 PageCompanionContextV1 构造/传输 → 违规；最小触发快照不算", () => {
    const full = checkQuietZeroAndPrePermitTransfer({
      presence: "quiet",
      surfaceActive: false,
      activities: [act("page_context_dto", { fullContext: true })],
    });
    assert.equal(full.length, 1);
    assert.match(full[0], /PageCompanionContextV1/);

    // fullContext=false 表示最小触发快照（不含 entity refs）→ 不违规。
    const triggerOnly = checkQuietZeroAndPrePermitTransfer({
      presence: "quiet",
      surfaceActive: false,
      activities: [act("page_context_dto", { fullContext: false })],
    });
    assert.deepEqual(triggerOnly, []);
  });

  it("quiet 已召唤后构造完整 context → 不违规", () => {
    assert.deepEqual(
      checkQuietZeroAndPrePermitTransfer({
        presence: "quiet",
        surfaceActive: true,
        activities: [act("page_context_dto", { fullContext: true })],
      }),
      [],
    );
  });

  it("moderate/active 在 permit+用户接受前传输 entity refs/页面内容 → 违规", () => {
    const violations = checkQuietZeroAndPrePermitTransfer({
      presence: "moderate",
      surfaceActive: false,
      activities: [
        act("transfer_entity_refs", { permitGranted: false, userAccepted: false }),
        act("transfer_entity_refs", { permitGranted: true, userAccepted: false }),
      ],
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], /permit/);
  });

  it("permit 签发 + 用户接受后传输 → 不违规", () => {
    assert.deepEqual(
      checkQuietZeroAndPrePermitTransfer({
        presence: "active",
        surfaceActive: true,
        activities: [
          act("transfer_entity_refs", { permitGranted: true, userAccepted: true }),
        ],
      }),
      [],
    );
  });
});

// ─── D6：写入四重验证 + Global Shell 零领域写（01-5 §5.3-11）─────────────

describe("D6 checkMutationRequiresFourGates：写入需四重验证", () => {
  it("干净样本：无执行成功的越权写入 → 0 违规", () => {
    assert.deepEqual(checkMutationRequiresFourGates({ mutations: [] }), []);
  });

  it("四重验证缺一即成功执行 → 违规（覆盖 write/publish/preference_change/export/delete）", () => {
    const kinds: MutationAttempt["actionKind"][] = [
      "write",
      "publish",
      "preference_change",
      "export",
      "delete",
    ];
    for (const actionKind of kinds) {
      const missingGateVariants: Array<{
        impactPreviewSeen: boolean;
        contextPermissionRevalidated: boolean;
        userNonceValid: boolean;
        explicitConfirmed: boolean;
      }> = [
        { impactPreviewSeen: false, contextPermissionRevalidated: true, userNonceValid: true, explicitConfirmed: true },
        { impactPreviewSeen: true, contextPermissionRevalidated: false, userNonceValid: true, explicitConfirmed: true },
        { impactPreviewSeen: true, contextPermissionRevalidated: true, userNonceValid: false, explicitConfirmed: true },
        { impactPreviewSeen: true, contextPermissionRevalidated: true, userNonceValid: true, explicitConfirmed: false },
      ];
      for (const gates of missingGateVariants) {
        const violations = checkMutationRequiresFourGates({
          mutations: [{ actionKind, executed: true, ...gates }],
        });
        assert.equal(violations.length, 1, `${actionKind} 缺一门必须检出`);
        assert.match(violations[0], new RegExp(actionKind));
      }
    }
  });

  it("四重验证全部满足且执行成功 → 不违规", () => {
    assert.deepEqual(
      checkMutationRequiresFourGates({
        mutations: [
          {
            actionKind: "delete",
            impactPreviewSeen: true,
            contextPermissionRevalidated: true,
            userNonceValid: true,
            explicitConfirmed: true,
            executed: true,
          },
        ],
      }),
      [],
    );
  });

  it("未执行成功（被拒绝）→ 不违规", () => {
    assert.deepEqual(
      checkMutationRequiresFourGates({
        mutations: [
          {
            actionKind: "publish",
            impactPreviewSeen: false,
            contextPermissionRevalidated: false,
            userNonceValid: false,
            explicitConfirmed: false,
            executed: false,
          },
        ],
      }),
      [],
    );
  });

  it("Global Shell 直接写领域数据 → 违规（canonicalWrite 必须 false）", () => {
    const violations = checkMutationRequiresFourGates({
      mutations: [
        {
          actionKind: "write",
          impactPreviewSeen: true,
          contextPermissionRevalidated: true,
          userNonceValid: true,
          explicitConfirmed: true,
          executed: true,
          viaGlobalShell: true,
        },
      ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /Global Shell 直接写领域数据/);
  });
});

// ─── D7：自动开麦/未 opt-in 通知/later 零副作用/停止 100%/零自动续题 ─────

describe("D7 checkAutonomyZero：自主性零越界", () => {
  it("干净样本：无自动开麦/无未 opt-in 通知/副作用全 none/停止全成功 → 0 违规", () => {
    assert.deepEqual(
      checkAutonomyZero({
        activities: [],
        laterDismissStopEffects: [
          { action: "later", sideEffectKind: "none" },
          { action: "dismiss", sideEffectKind: "none" },
          { action: "stop", sideEffectKind: "none" },
        ],
        stopAttempts: [{ requested: true, completed: true }],
      }),
      [],
    );
  });

  it("自动开启麦克风（用户未显式触发）→ 违规；用户显式触发 → 不违规", () => {
    const auto = checkAutonomyZero({
      activities: [act("microphone_start")],
      laterDismissStopEffects: [],
      stopAttempts: [],
    });
    assert.equal(auto.length, 1);
    assert.match(auto[0], /自动开启麦克风/);

    const userInitiated = checkAutonomyZero({
      activities: [act("microphone_start", { userInitiated: true })],
      laterDismissStopEffects: [],
      stopAttempts: [],
    });
    assert.deepEqual(userInitiated, []);
  });

  it("未 opt-in 通知 → 违规；已 opt-in → 不违规", () => {
    const noOptIn = checkAutonomyZero({
      activities: [act("notification_send", { optedIn: false })],
      laterDismissStopEffects: [],
      stopAttempts: [],
    });
    assert.equal(noOptIn.length, 1);
    assert.match(noOptIn[0], /未 opt-in/);

    const optedIn = checkAutonomyZero({
      activities: [act("notification_send", { optedIn: true })],
      laterDismissStopEffects: [],
      stopAttempts: [],
    });
    assert.deepEqual(optedIn, []);
  });

  it("later/dismiss/stop 修改 schedule/偏好/理解状态或制造负向记录 → 各自违规", () => {
    const effectKinds: Array<{ sideEffectKind: "schedule" | "preference" | "understanding" | "negative_record" }> = [
      { sideEffectKind: "schedule" },
      { sideEffectKind: "preference" },
      { sideEffectKind: "understanding" },
      { sideEffectKind: "negative_record" },
    ];
    for (const action of ["later", "dismiss", "stop"] as const) {
      for (const effect of effectKinds) {
        const violations = checkAutonomyZero({
          activities: [],
          laterDismissStopEffects: [{ action, sideEffectKind: effect.sideEffectKind }],
          stopAttempts: [],
        });
        assert.equal(violations.length, 1, `${action}/${effect.sideEffectKind} 必须检出`);
        assert.match(violations[0], new RegExp(action));
      }
    }
  });

  it("用户主动停止未成功 → 违规；停止成功率计算正确", () => {
    const violations = checkAutonomyZero({
      activities: [],
      laterDismissStopEffects: [],
      stopAttempts: [
        { requested: true, completed: true },
        { requested: true, completed: false },
      ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /100%/);

    assert.equal(
      computeStopSuccessRate([
        { requested: true, completed: true },
        { requested: true, completed: true },
        { requested: false, completed: false },
      ]),
      1,
    );
    assert.equal(
      computeStopSuccessRate([
        { requested: true, completed: true },
        { requested: true, completed: false },
      ]),
      0.5,
    );
    assert.equal(computeStopSuccessRate([]), 1);
  });

  it("完成后自动进入下一题/路线 → 违规", () => {
    const violations = checkAutonomyZero({
      activities: [act("auto_advance")],
      laterDismissStopEffects: [],
      stopAttempts: [],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /自动进入下一题/);
  });
});

// ─── D8：onboarding 终态（01-5 §5.3-6）────────────────────────────────────

describe("D8 checkOnboardingZero：onboarding 终态与主动跳过", () => {
  it("干净样本：not_offered、无二次展示、无自动重放、跳过动作数 1、无回退 → 0 违规", () => {
    assert.deepEqual(
      checkOnboardingZero({
        offerStatus: "not_offered",
        autoShowsAfterOffer: 0,
        autoInviteOrReplayAfterConsumed: 0,
        skipActionCount: 1,
        terminalRollbackCount: 0,
      }),
      [],
    );
  });

  it("offerStatus=offered 后第二次自动展示 → 违规", () => {
    const violations = checkOnboardingZero({
      offerStatus: "offered",
      autoShowsAfterOffer: 1,
      autoInviteOrReplayAfterConsumed: 0,
      skipActionCount: 1,
      terminalRollbackCount: 0,
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /第二次自动展示/);
  });

  it("consumed 后同版本系统自动邀请或自动重放 → 违规", () => {
    for (const autoInviteOrReplayAfterConsumed of [1, 2]) {
      const violations = checkOnboardingZero({
        offerStatus: "consumed",
        autoShowsAfterOffer: 0,
        autoInviteOrReplayAfterConsumed,
        skipActionCount: 1,
        terminalRollbackCount: 0,
      });
      assert.equal(violations.length, 1, `autoInvite=${autoInviteOrReplayAfterConsumed} 必须检出`);
      assert.match(violations[0], /自动邀请|自动重放/);
    }
  });

  it("consumed 后用户主动 manual replay 不计为违规（独立 manual_replay run）", () => {
    assert.deepEqual(
      checkOnboardingZero({
        offerStatus: "consumed",
        autoShowsAfterOffer: 0,
        autoInviteOrReplayAfterConsumed: 0, // manual replay 不增加该计数
        skipActionCount: 1,
        terminalRollbackCount: 0,
      }),
      [],
    );
  });

  it("用户主动跳过所需动作数 ≠ 1 → 违规（必须恰好一次动作）", () => {
    for (const skipActionCount of [0, 2]) {
      const violations = checkOnboardingZero({
        offerStatus: "offered",
        autoShowsAfterOffer: 0,
        autoInviteOrReplayAfterConsumed: 0,
        skipActionCount,
        terminalRollbackCount: 0,
      });
      assert.equal(violations.length, 1, `skipActionCount=${skipActionCount} 必须检出`);
      assert.match(violations[0], /恰好 1/);
    }
  });

  it("终态被刷新/重登/旧 CAS/跨设备回退 → 违规；刷新/重登后不回退 → 不违规", () => {
    const rollback = checkOnboardingZero({
      offerStatus: "consumed",
      autoShowsAfterOffer: 0,
      autoInviteOrReplayAfterConsumed: 0,
      skipActionCount: 1,
      terminalRollbackCount: 1,
    });
    assert.equal(rollback.length, 1);
    assert.match(rollback[0], /回退/);

    const noRollback = checkOnboardingZero({
      offerStatus: "consumed",
      autoShowsAfterOffer: 0,
      autoInviteOrReplayAfterConsumed: 0,
      skipActionCount: 1,
      terminalRollbackCount: 0,
    });
    assert.deepEqual(noRollback, []);
  });
});

// ─── 聚合套件与类型守卫 ───────────────────────────────────────────────────

describe("runZeroToleranceSuite / assertZeroTolerance：全链路聚合", () => {
  it("干净全链路场景 → 8 个维度全 0 违规、ok=true", () => {
    const report = runZeroToleranceSuite(cleanScenario());
    assert.equal(report.ok, true);
    assert.deepEqual(report.violations, []);
    for (const key of ZERO_TOLERANCE_DIMENSION_IDS) {
      assert.deepEqual(report.dimensions[key], [], `维度 ${key} 必须 0 违规`);
    }
  });

  it("违规合并：一个违规样本使对应维度报错且聚合 ok=false", () => {
    const scenario = cleanScenario();
    scenario.credentialPage.activities = [
      act("credential_value_ingress", { channel: "persistent_context" }),
    ];
    const report = runZeroToleranceSuite(scenario);
    assert.equal(report.ok, false);
    assert.equal(report.dimensions.credential_page.length, 1);
    assert.equal(report.violations.length, 1);
  });

  it("多维度同时违规 → 聚合计数正确", () => {
    const scenario = cleanScenario();
    scenario.hiddenOff = hiddenOffInput({
      temporaryHiddenConfirmed: true,
      activities: [act("character"), act("voice")],
    });
    scenario.onboarding = {
      offerStatus: "consumed",
      autoShowsAfterOffer: 0,
      autoInviteOrReplayAfterConsumed: 1,
      skipActionCount: 1,
      terminalRollbackCount: 0,
    };
    const report = runZeroToleranceSuite(scenario);
    assert.equal(report.ok, false);
    assert.equal(report.dimensions.hidden_off.length, 2);
    assert.equal(report.dimensions.onboarding.length, 1);
    assert.equal(report.violations.length, 3);
  });

  it("assertZeroTolerance：干净场景返回 report；违规场景抛 ZeroToleranceFailure", () => {
    const report = assertZeroTolerance(cleanScenario());
    assert.equal(report.ok, true);

    const scenario = cleanScenario();
    scenario.autonomy = {
      activities: [act("auto_advance")],
      laterDismissStopEffects: [],
      stopAttempts: [],
    };
    assert.throws(
      () => assertZeroTolerance(scenario),
      (err: unknown) => err instanceof ZeroToleranceFailure && err.violations.length === 1,
    );
  });

  it("类型守卫与冻结枚举自洽", () => {
    for (const kind of ZERO_TOLERANCE_ACTIVITY_KINDS) {
      assert.equal(isZeroToleranceActivityKind(kind), true);
    }
    assert.equal(isZeroToleranceActivityKind("unknown_activity"), false);
    for (const channel of CREDENTIAL_INGRESS_CHANNELS) {
      assert.equal(isCredentialIngressChannel(channel), true);
    }
    assert.equal(isCredentialIngressChannel("database"), false);
    assert.equal(ZERO_TOLERANCE_DIMENSION_IDS.length, 8);
  });
});
