/**
 * 阶段 07（W6）任务 07-4：存在感设置与控制状态单测（§5.5/§5.6）。
 *
 * 验收覆盖（对应任务 07-4）：
 * - 三档存在感：quiet 未召唤时只有静态中性锚点、主动提示为 0；moderate 只在
 *   恢复/可恢复错误/stale/committed change 给一次邀请；active 增加有原因说明的
 *   下一步但不自动开始；未选择前默认 quiet；任一档不自动开麦/不自动进下一题/
 *   不因忽略失望/无红色倒计时/可一键隐藏保留完整手动能力；
 * - 控制状态全站接线：8 个 id 的 scope、temporary_hidden 仅设备本地、
 *   global_off 账号级同步、device fence 构造与迟到结果丢弃；
 * - global_off CAS：revision 匹配成功、stale 失败 → 设置页显示未同步文案；
 * - 三种学习前台状态：信任域（together/free_explore → practice_only、
 *   let_me_try → trusted assessment）、动作矩阵、知识帮助门（let_me_try 只能
 *   呈现「切换到一起学习」确认）；
 * - enter_practice_mode 原子切换：先记录 assistance/exposure 再开放 Tutor
 *   权限（顺序 + 同事务），已 together 幂等，free_explore 拒绝，迟到 fence
 *   丢弃，失败整体回滚且 Tutor 权限不开放。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCOUNT_SYNCED_STATES,
  buildDeviceFence,
  canEnterTrustedAssessment,
  COMPANION_CONTROL_STATE_IDS,
  COMPANION_CONTROL_STATE_SCOPE,
  COMPANION_PRESENCE_BEHAVIORS,
  DEFAULT_LEARNING_FOREGROUND_STATE,
  DEFAULT_PRESENCE_LEVEL,
  describeGlobalOffSync,
  DEVICE_LOCAL_ONLY_STATES,
  enterPracticeMode,
  evaluateGlobalOffCas,
  foregroundTrustDomain,
  GLOBAL_OFF_DEVICE_ONLY_MESSAGE,
  isCompanionControlStateId,
  LEARNING_FOREGROUND_ACTIONS,
  nextEpochAfterGlobalOff,
  presenceAllowsReasonClass,
  PRESENCE_INVARIANTS,
  PRESENCE_TO_ALLOWED_REASON_CLASSES,
  PresenceControlError,
  PresenceControlErrorCode,
  resolveKnowledgeHelpGate,
  resolvePresenceLevel,
  validateSurfaceEpoch,
  type EnterPracticeModeDeps,
  type EnterPracticeModeInput,
  type LearningForegroundState,
  type LearningFrontRepo,
  type LearningScope,
} from "./presence-control.ts";

// ─── 内存 LearningFrontRepo + 模拟事务（快照/回滚）────────────────────────

class InMemoryFrontRepo implements LearningFrontRepo {
  state: LearningForegroundState | null = null;
  assistanceRecorded = false;
  tutorOpened = false;
  operations: string[] = [];
  /** 模拟「开放 Tutor 权限」步骤失败（触发整体回滚）。 */
  failOpenTutor = false;

  async readForegroundState(_scope: LearningScope): Promise<LearningForegroundState | null> {
    return this.state;
  }

  async recordAssistanceAndExposure(_scope: LearningScope, input: { userActionNonce: string }): Promise<void> {
    this.operations.push(`record:${input.userActionNonce}`);
    this.assistanceRecorded = true;
  }

  async openTutorPermission(_scope: LearningScope): Promise<void> {
    if (this.failOpenTutor) throw new Error("tutor permission open failed");
    this.operations.push("open-tutor");
    this.tutorOpened = true;
  }

  async writeForegroundState(_scope: LearningScope, state: LearningForegroundState): Promise<void> {
    this.operations.push(`write:${state}`);
    this.state = state;
  }

  snapshot(): InMemoryFrontRepo {
    const s = new InMemoryFrontRepo();
    s.state = this.state;
    s.assistanceRecorded = this.assistanceRecorded;
    s.tutorOpened = this.tutorOpened;
    s.operations = [...this.operations];
    return s;
  }

  restore(s: InMemoryFrontRepo): void {
    this.state = s.state;
    this.assistanceRecorded = s.assistanceRecorded;
    this.tutorOpened = s.tutorOpened;
    this.operations = s.operations;
  }
}

/** 模拟 DB 事务：fn 成功即提交；抛错即回滚到快照（原子性）。 */
function makeTxSimulator(repo: InMemoryFrontRepo) {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const snapshot = repo.snapshot();
    try {
      return await fn();
    } catch (err) {
      repo.restore(snapshot);
      throw err;
    }
  };
}

const SCOPE: LearningScope = { workspaceId: "ws-1", userId: "user-1" };
const FIXED_NOW = () => new Date(1_800_000_000_000);

function makeDeps(repo: InMemoryFrontRepo, options: { validNonces?: Set<string> } = {}): EnterPracticeModeDeps {
  const consumed = new Set<string>();
  const valid = options.validNonces ?? new Set(["user-confirmed-123"]);
  return {
    repo,
    transaction: makeTxSimulator(repo),
    now: FIXED_NOW,
    validateAndConsumeUserActionNonce: async (_scope, _keyPointId, nonce) => {
      if (!valid.has(nonce) || consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
  };
}

function baseInput(overrides: Partial<EnterPracticeModeInput> = {}): EnterPracticeModeInput {
  return {
    scope: SCOPE,
    deviceSessionId: "device-a",
    deviceSurfaceEpoch: 0,
    accountEpoch: 0,
    keyPointId: "kp:card-1",
    contentExposureKey: "cex:abc123",
    userActionNonce: "user-confirmed-123",
    ...overrides,
  };
}

async function expectPresenceError(
  fn: Promise<unknown>,
  code: PresenceControlErrorCode,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof PresenceControlError, `expected PresenceControlError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ─── 1. 三档存在感 ────────────────────────────────────────────────────────

describe("presence levels", () => {
  it("未选择前默认 quiet（首次启用中立选择）", () => {
    assert.equal(DEFAULT_PRESENCE_LEVEL, "quiet");
    assert.equal(resolvePresenceLevel(undefined), "quiet");
    assert.equal(resolvePresenceLevel(""), "quiet");
    assert.equal(resolvePresenceLevel("bogus"), "quiet");
    assert.equal(resolvePresenceLevel("moderate"), "moderate");
    assert.equal(resolvePresenceLevel("active"), "active");
  });

  it("presence → reason class 映射（§5.5）：quiet 主动提示为 0；moderate 无普通建议；active 全量", () => {
    assert.deepEqual(PRESENCE_TO_ALLOWED_REASON_CLASSES.quiet, []);
    assert.deepEqual(PRESENCE_TO_ALLOWED_REASON_CLASSES.moderate, [
      "resume",
      "recoverable_error",
      "canonical_change",
    ]);
    assert.deepEqual(PRESENCE_TO_ALLOWED_REASON_CLASSES.active, [
      "resume",
      "recoverable_error",
      "canonical_change",
      "ordinary_suggestion",
    ]);
    assert.equal(presenceAllowsReasonClass("quiet", "recoverable_error"), false);
    assert.equal(presenceAllowsReasonClass("moderate", "resume"), true);
    assert.equal(presenceAllowsReasonClass("moderate", "ordinary_suggestion"), false);
    assert.equal(presenceAllowsReasonClass("active", "ordinary_suggestion"), true);
  });

  it("每档行为元数据：quiet 静态锚点；moderate/active 描述一致", () => {
    assert.equal(COMPANION_PRESENCE_BEHAVIORS.quiet.staticAnchorOnly, true);
    assert.equal(COMPANION_PRESENCE_BEHAVIORS.moderate.staticAnchorOnly, false);
    assert.equal(COMPANION_PRESENCE_BEHAVIORS.active.staticAnchorOnly, false);
    assert.ok(COMPANION_PRESENCE_BEHAVIORS.moderate.description.includes("一次邀请"));
    assert.ok(COMPANION_PRESENCE_BEHAVIORS.active.description.includes("下一步"));
    // 三档都必须存在且合法。
    for (const level of ["quiet", "moderate", "active"] as const) {
      assert.equal(COMPANION_PRESENCE_BEHAVIORS[level].level, level);
    }
  });

  it("任一档不变量：不自动开麦/不自动进下一题/不因忽略失望/无红色倒计时/可一键隐藏保留手动能力", () => {
    assert.equal(PRESENCE_INVARIANTS.autoMicrophoneEnabled, false);
    assert.equal(PRESENCE_INVARIANTS.autoAdvanceToNextQuestion, false);
    assert.equal(PRESENCE_INVARIANTS.expressDisappointmentOnIgnore, false);
    assert.equal(PRESENCE_INVARIANTS.redCountdownOrTaskDebt, false);
    assert.equal(PRESENCE_INVARIANTS.oneTapHideAvailable, true);
    assert.equal(PRESENCE_INVARIANTS.manualCapabilitiesPreserved, true);
  });
});

// ─── 2. 控制状态全站接线 ──────────────────────────────────────────────────

describe("control state wiring", () => {
  it("8 个 versioned 控制状态 id 全部合法", () => {
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
    for (const id of COMPANION_CONTROL_STATE_IDS) {
      assert.ok(isCompanionControlStateId(id));
    }
    assert.equal(isCompanionControlStateId("model_invented"), false);
  });

  it("scope 正确：temporary_hidden 设备级、global_off 账号级、page_muted 路由级等", () => {
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.temporary_hidden, "device");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.global_off, "account");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.page_muted, "route");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.page_context_off, "route");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.focus_until_task_end, "task");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.suggestion_paused, "account");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.animation_off, "account_preference");
    assert.equal(COMPANION_CONTROL_STATE_SCOPE.voice_output_off, "account_preference");
  });

  it("temporary_hidden 持久布尔只留设备本地；global_off/suggestion_paused 账号同步", () => {
    assert.deepEqual(DEVICE_LOCAL_ONLY_STATES, ["temporary_hidden"]);
    assert.ok(ACCOUNT_SYNCED_STATES.includes("global_off"));
    assert.ok(ACCOUNT_SYNCED_STATES.includes("suggestion_paused"));
    assert.ok(ACCOUNT_SYNCED_STATES.includes("animation_off"));
    assert.ok(ACCOUNT_SYNCED_STATES.includes("voice_output_off"));
    assert.ok(!DEVICE_LOCAL_ONLY_STATES.includes("global_off"));
  });
});

// ─── 3. 设备 fence 与迟到结果丢弃 ─────────────────────────────────────────

describe("device fence and surface epoch", () => {
  it("buildDeviceFence 构造合法 fence；非法 deviceSessionId/surfaceEpoch 拒绝", () => {
    assert.deepEqual(buildDeviceFence({ deviceSessionId: "dev-1", surfaceEpoch: 3 }), {
      deviceSessionId: "dev-1",
      surfaceEpoch: 3,
    });
    assert.throws(() => buildDeviceFence({ deviceSessionId: "  ", surfaceEpoch: 0 }), RangeError);
    assert.throws(() => buildDeviceFence({ deviceSessionId: "x".repeat(201), surfaceEpoch: 0 }), RangeError);
    assert.throws(() => buildDeviceFence({ deviceSessionId: "dev-1", surfaceEpoch: -1 }), RangeError);
    assert.throws(() => buildDeviceFence({ deviceSessionId: "dev-1", surfaceEpoch: 1.5 }), RangeError);
  });

  it("迟到 surface epoch（落后于 account epoch）一律丢弃", () => {
    assert.equal(validateSurfaceEpoch(0, 5), false);
    assert.equal(validateSurfaceEpoch(5, 5), true);
    assert.equal(validateSurfaceEpoch(6, 5), true);
  });
});

// ─── 4. global_off CAS ────────────────────────────────────────────────────

describe("global_off CAS", () => {
  it("revision 匹配 → APPLIED；不匹配 → STALE_REVISION", () => {
    assert.deepEqual(evaluateGlobalOffCas({ baseRevision: 3, currentRevision: 3 }), {
      ok: true,
      code: "APPLIED",
    });
    assert.deepEqual(evaluateGlobalOffCas({ baseRevision: 2, currentRevision: 3 }), {
      ok: false,
      code: "STALE_REVISION",
    });
  });

  it("global off 时 epoch 单调递增（广播 fence 撤销信号）", () => {
    assert.equal(nextEpochAfterGlobalOff(0), 1);
    assert.equal(nextEpochAfterGlobalOff(7), 8);
  });

  it("CAS 失败时设置页显示「仅本设备已隐藏，全局关闭尚未同步」", () => {
    assert.equal(describeGlobalOffSync(true), "synced");
    assert.equal(describeGlobalOffSync(false), "device_only_pending");
    assert.equal(
      GLOBAL_OFF_DEVICE_ONLY_MESSAGE,
      "仅本设备已隐藏，全局关闭尚未同步",
    );
  });
});

// ─── 5. 三种学习前台状态（§5.6）───────────────────────────────────────────

describe("learning foreground states", () => {
  it("信任域：一起学习/自由探索 → practice_only；让我试试 → trusted assessment", () => {
    assert.equal(foregroundTrustDomain("together"), "practice_only");
    assert.equal(foregroundTrustDomain("free_explore"), "practice_only");
    assert.equal(foregroundTrustDomain("let_me_try"), "trusted_assessment");
    // 安全默认前台状态 = 一起学习（practice_only 域）。
    assert.equal(DEFAULT_LEARNING_FOREGROUND_STATE, "together");
  });

  it("动作矩阵：let_me_try 无内容辅助、可 trusted assessment、索要知识帮助需切换确认", () => {
    assert.deepEqual(LEARNING_FOREGROUND_ACTIONS.together, {
      allowContentAssistance: true,
      allowTrustedAssessment: false,
      allowFreeExploration: false,
      requireSwitchToTogetherConfirmation: false,
    });
    assert.deepEqual(LEARNING_FOREGROUND_ACTIONS.let_me_try, {
      allowContentAssistance: false,
      allowTrustedAssessment: true,
      allowFreeExploration: false,
      requireSwitchToTogetherConfirmation: true,
    });
    assert.deepEqual(LEARNING_FOREGROUND_ACTIONS.free_explore, {
      allowContentAssistance: true,
      allowTrustedAssessment: false,
      allowFreeExploration: true,
      requireSwitchToTogetherConfirmation: false,
    });
    assert.equal(canEnterTrustedAssessment("let_me_try"), true);
    assert.equal(canEnterTrustedAssessment("together"), false);
    assert.equal(canEnterTrustedAssessment("free_explore"), false);
  });

  it("知识帮助门：let_me_try 只能呈现「切换到一起学习」确认（Agent 不能代点）", () => {
    assert.deepEqual(resolveKnowledgeHelpGate("let_me_try"), {
      kind: "require_switch_to_together",
    });
    assert.deepEqual(resolveKnowledgeHelpGate("together"), { kind: "allowed" });
    assert.deepEqual(resolveKnowledgeHelpGate("free_explore"), { kind: "allowed" });
  });
});

// ─── 6. enter_practice_mode 原子切换 ──────────────────────────────────────

describe("enter_practice_mode atomic switch", () => {
  it("从 let_me_try 切换：先记录 assistance/exposure，再开放 Tutor 权限，最后写前台状态", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "let_me_try";
    const result = await enterPracticeMode(makeDeps(repo), baseInput());

    assert.equal(result.state, "together");
    assert.equal(result.assistanceRecorded, true);
    assert.equal(result.tutorPermissionOpened, true);
    // 顺序：record → open-tutor → write:together（先记录再开放，不能先提示再补记）。
    assert.deepEqual(repo.operations, [
      "record:user-confirmed-123",
      "open-tutor",
      "write:together",
    ]);
    assert.equal(repo.assistanceRecorded, true);
    assert.equal(repo.tutorOpened, true);
    assert.equal(repo.state, "together");
  });

  it("已在 together（含未选择默认）→ 幂等返回，不重复记录 assistance；Tutor 权限真实就绪", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "together";
    const result = await enterPracticeMode(makeDeps(repo), baseInput());
    assert.equal(result.assistanceRecorded, false);
    assert.equal(result.tutorPermissionOpened, true);
    assert.equal(repo.tutorOpened, true); // security_review MEDIUM #2：权限真实开放
    assert.deepEqual(repo.operations, ["open-tutor"]);

    // 未选择（null）→ 按默认「一起学习」幂等（同样真实开放 Tutor 权限）。
    const repo2 = new InMemoryFrontRepo();
    const result2 = await enterPracticeMode(makeDeps(repo2), baseInput());
    assert.equal(result2.assistanceRecorded, false);
    assert.equal(repo2.tutorOpened, true);
    assert.deepEqual(repo2.operations, ["open-tutor"]);
  });

  it("free_explore 无需切换 → INVALID_FOREGROUND_TRANSITION（无副作用）", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "free_explore";
    await expectPresenceError(
      enterPracticeMode(makeDeps(repo), baseInput()),
      PresenceControlErrorCode.INVALID_FOREGROUND_TRANSITION,
    );
    assert.deepEqual(repo.operations, []);
    assert.equal(repo.tutorOpened, false);
  });

  it("迟到 surface epoch（global off 撤销后）→ STALE_SURFACE_EPOCH，不记录不开放", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "let_me_try";
    await expectPresenceError(
      enterPracticeMode(makeDeps(repo), baseInput({ deviceSurfaceEpoch: 0, accountEpoch: 4 })),
      PresenceControlErrorCode.STALE_SURFACE_EPOCH,
    );
    assert.deepEqual(repo.operations, []);
    assert.equal(repo.tutorOpened, false);
    assert.equal(repo.state, "let_me_try");
  });

  it("Tutor 权限开放失败 → 整体回滚：assistance/exposure 不残留、权限不开放、状态不变", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "let_me_try";
    repo.failOpenTutor = true;
    await assert.rejects(
      enterPracticeMode(makeDeps(repo), baseInput()),
      /tutor permission open failed/,
    );
    // 模拟事务回滚：record 的写入被撤销，open-tutor 从未成功，状态仍 let_me_try。
    assert.equal(repo.assistanceRecorded, false);
    assert.equal(repo.tutorOpened, false);
    assert.equal(repo.state, "let_me_try");
    // 操作日志为空（回滚到快照）。
    assert.deepEqual(repo.operations, []);
  });

  it("Agent 不能代点：无用户确认 nonce 无法触发切换（USER_CONFIRMATION_REQUIRED）", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "let_me_try";
    // 缺少 userActionNonce（Agent 代点路径没有确认 nonce）→ 拒绝且无副作用。
    const { userActionNonce: _ignored, ...withoutNonce } = baseInput();
    await expectPresenceError(
      enterPracticeMode(makeDeps(repo), withoutNonce as EnterPracticeModeInput),
      PresenceControlErrorCode.USER_CONFIRMATION_REQUIRED,
    );
    assert.deepEqual(repo.operations, []);
    assert.equal(repo.tutorOpened, false);
    void _ignored;
  });

  it("非法 nonce（未签发）与重复 nonce（已消费）均拒绝且无副作用", async () => {
    const repo = new InMemoryFrontRepo();
    repo.state = "let_me_try";
    // 未签发/伪造 nonce → 拒绝。
    await expectPresenceError(
      enterPracticeMode(makeDeps(repo), baseInput({ userActionNonce: "forged-nonce" })),
      PresenceControlErrorCode.USER_CONFIRMATION_REQUIRED,
    );
    assert.deepEqual(repo.operations, []);
    assert.equal(repo.tutorOpened, false);

    // 合法 nonce 一次性：消费后再次使用 → 拒绝（服务端原子消费，不会再次验证通过）。
    const repo2 = new InMemoryFrontRepo();
    repo2.state = "let_me_try";
    const first = await enterPracticeMode(makeDeps(repo2), baseInput());
    assert.equal(first.state, "together");
    assert.equal(first.tutorPermissionOpened, true);
    // 已消费的 nonce 不再在服务端有效集合中（模拟原子消费）→ 重复使用被拒绝。
    await expectPresenceError(
      enterPracticeMode(makeDeps(repo2, { validNonces: new Set() }), baseInput()),
      PresenceControlErrorCode.USER_CONFIRMATION_REQUIRED,
    );
  });
});
