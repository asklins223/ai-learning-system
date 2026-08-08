/**
 * 阶段 10（W9）任务 10-5：hard-kill rollback drill（§18.2 第 4 步 / §18.3）。
 *
 * 本文件是**三类回滚演练的纯逻辑核心**（无 DB / 无网络 / 无时钟 / 无副作用 /
 * 无随机）：每次 RC 分别演练 soft drain、hard kill 与 legacy reader matrix，
 * 判定结果确定性可复现，接线 harness（09-5 故障注入 / 09-6 真实环境 RC）注入
 * 场景端口后消费。任何判定都**不修改历史**（schedule / attempt / understanding
 * history / active Card Set 只能对比断言不变）。
 *
 * 三类演练（对应 10-w9 任务 10-5 与冻结记录 01-7 §18.1 / 03-6 §5）：
 * - **soft drain**：UI 动画 / overlay / Tutor 展示故障属于 soft rollback——
 *   控制面以**单一 config revision 原子关闭**目标及其反向依赖闭包；required
 *   capability closure 不含被关 flag 的已锁 Episode 可 drain，包含它的可选分支
 *   停止调用并降级/取消，不影响仍健康的 core assess/commit；Global Shell/
 *   onboarding 故障按依赖闭包关闭（未登录页回标准认证 UI、authenticated 页面
 *   保留原生导航与手动入口、onboarding 状态 forward-only 保留、不得用自由
 *   Agent / DOM 抓取补位）；关闭 companion/scene/tutor/map 展示后回既有
 *   question-first 验证和 Review Queue，不把新 Artifact 隐式转旧 submission；
 *   新表/events/artifacts/projections forward-only 保留、已产 canonical
 *   validation/review 结果继续有效、practice 航迹关闭展示后仍保留导出/删除；
 * - **hard kill**：privacy / tenant / 答案泄漏 / trust / Critic / schedule
 *   invariant 属于 hard rollback——固定顺序（03-6 §5）① 提升
 *   learningRuntimeEpoch ② 启用 commitKillSwitch 并 fence 全部未 commit
 *   Episode（status → cancelled；已 commit / stale / cancelled 终态保留）
 *   ③ 取消未完成外部 job ④ 禁止恢复为 trusted（字面量 false）；
 * - **legacy reader matrix**：projection 关闭时旧 reader 仍读 pending
 *   schedule / attempt / 结果；forward-only 保留；再开启时执行 drift replay
 *   与观察窗口；不修改现有 schedule / attempt / understanding history /
 *   active Card Set。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 一、Capability flags 与 bundle 图（冻结，01-7 §2/§4/§6）
// ═══════════════════════════════════════════════════════════════════════════

/** Must capability bundle flag（01-7 §2，W0 冻结；public-beta 默认集合）。 */
export const MUST_BUNDLE_FLAG_IDS = [
  "trusted_multimodal_core",
  "global_companion_shell",
  "companion_onboarding_v1",
  "learning_session_companion",
  "multimodal_voice",
  "structured_proof_v1",
  "journey_routes",
  "understanding_universe_v2",
  "current_target_tutor",
] as const;

/** Should capability bundle flag（01-7 §2；主列车外独立 shadow/canary）。 */
export const SHOULD_FLAG_IDS = [
  "learning_question_markers",
  "semantic_relationships",
  "tutor_workspace_expansion",
] as const;

/** 全部 capability flag（Must + Should）。 */
export const CAPABILITY_FLAG_IDS = [
  ...MUST_BUNDLE_FLAG_IDS,
  ...SHOULD_FLAG_IDS,
] as const;

export type CapabilityFlagId = (typeof CAPABILITY_FLAG_IDS)[number];
export type ShouldFlagId = (typeof SHOULD_FLAG_IDS)[number];
export type MustFlagId = (typeof MUST_BUNDLE_FLAG_IDS)[number];

/** 类型守卫：是否为合法 capability flag id。 */
export function isCapabilityFlagId(value: string): value is CapabilityFlagId {
  return (CAPABILITY_FLAG_IDS as readonly string[]).includes(value);
}

/** 类型守卫：是否为 Should flag。 */
export function isShouldFlagId(value: string): value is ShouldFlagId {
  return (SHOULD_FLAG_IDS as readonly string[]).includes(value);
}

/** 类型守卫：是否为 Must bundle flag。 */
export function isMustFlagId(value: string): value is MustFlagId {
  return (MUST_BUNDLE_FLAG_IDS as readonly string[]).includes(value);
}

/** Must bundle 依赖表（01-7 §4 原子内容与依赖；`requires` 为直接依赖）。 */
export interface CapabilityBundleDependency {
  flag: MustFlagId;
  /** 直接依赖（required capability closure 由传递闭包计算）。 */
  requires: readonly MustFlagId[];
  /** 原子内容（冻结文本摘要，01-7 §4）。 */
  atomicContents: string;
}

export const CAPABILITY_BUNDLE_DEPENDENCIES: readonly CapabilityBundleDependency[] = [
  {
    flag: "trusted_multimodal_core",
    requires: [],
    atomicContents:
      "Session/Episode + universal text_or_mixed fallback + artifact + 双 Critic + reducer + existing-domain commit + outbox",
  },
  {
    flag: "global_companion_shell",
    requires: [],
    atomicContents:
      "credential-safe auth manifest + 全路由 coverage registry + 全局角色/锚点/侧板 + Trigger Context + trigger rule/双预算/lease + 控制状态 + origin/focus 恢复 + context-off/hidden/off 零监听/调用",
  },
  {
    flag: "companion_onboarding_v1",
    requires: ["global_companion_shell"],
    atomicContents:
      "隔离 onboarding_sample:* assets、deterministic demo Card/Scene renderer、静态 demo map 与 CAS 状态机；对 exposure 与全部 learning facts 为 0 副作用",
  },
  {
    flag: "learning_session_companion",
    requires: ["global_companion_shell", "trusted_multimodal_core"],
    atomicContents:
      "public typed action gateway；只有该 bundle 可把伴星升级到 Session 动作，不提供 core-off 半可写模式",
  },
  {
    flag: "multimodal_voice",
    requires: ["trusted_multimodal_core"],
    atomicContents: "ASR/TTS policy 和对象存储（text fallback 已由 trusted core 原子包含）",
  },
  {
    flag: "structured_proof_v1",
    requires: ["trusted_multimodal_core"],
    atomicContents: "Scene safety、deterministic scorer、SilentProofProfile eligibility 和完整 mastery bundle",
  },
  {
    flag: "journey_routes",
    requires: ["trusted_multimodal_core"],
    atomicContents: "official scheduler adapter（FSRS shadow 不是依赖）",
  },
  {
    flag: "understanding_universe_v2",
    requires: ["trusted_multimodal_core"],
    atomicContents: "canonical outbox projection（projection 关闭不影响 canonical facts）",
  },
  {
    flag: "current_target_tutor",
    requires: ["learning_session_companion", "trusted_multimodal_core"],
    atomicContents: "原子 practice transition + Grounded Answer Critic + supported-segment filter",
  },
];

/** Should bundle 依赖（01-7 §4；Should 独立 shadow/canary，不进入 Must 关闭闭包）。 */
export interface ShouldBundleDependency {
  flag: ShouldFlagId;
  requires: readonly MustFlagId[];
}

export const SHOULD_BUNDLE_DEPENDENCIES: readonly ShouldBundleDependency[] = [
  { flag: "learning_question_markers", requires: [] },
  { flag: "semantic_relationships", requires: [] },
  { flag: "tutor_workspace_expansion", requires: ["trusted_multimodal_core"] },
];

/**
 * flag 的 required capability closure（传递闭包，含自身）：该 flag 可用的全部
 * 前置能力。用于判定「required capability closure 不含被关 flag → 可 drain」。
 */
export function requiredCapabilityClosure(flag: CapabilityFlagId): readonly CapabilityFlagId[] {
  const visited = new Set<CapabilityFlagId>([flag]);
  const queue: CapabilityFlagId[] = [flag];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = CAPABILITY_BUNDLE_DEPENDENCIES.find((d) => d.flag === current);
    if (deps === undefined) continue;
    for (const req of deps.requires) {
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return [...visited];
}

/**
 * 根关闭闭包（01-7 §6）：关闭 target 时需同时关闭的**反向依赖传递闭包**
 * （不含 target 自身）。Should flags 独立（01-7 §4），不在任何 Must 关闭闭包内。
 */
export function reverseDependencyClosure(flag: CapabilityFlagId): readonly CapabilityFlagId[] {
  const visited = new Set<CapabilityFlagId>();
  const queue: CapabilityFlagId[] = [flag];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of CAPABILITY_BUNDLE_DEPENDENCIES) {
      if (dep.requires.includes(current as MustFlagId) && !visited.has(dep.flag)) {
        visited.add(dep.flag);
        queue.push(dep.flag);
      }
    }
  }
  return [...visited];
}

/** 关闭目标后需要一并关闭的完整闭包（含 target 自身，去重）。 */
export function atomicOffClosure(flag: CapabilityFlagId): readonly CapabilityFlagId[] {
  return [flag, ...reverseDependencyClosure(flag)];
}

/**
 * bundle 图自检（01-7 §6 冻结闭包对账）：返回问题列表，空数组 = 图合法。
 * - 根关闭闭包必须与冻结记录一致：
 *   `global_companion_shell off → companion_onboarding_v1 → learning_session_companion
 *   → current_target_tutor`；
 *   `trusted_multimodal_core off → learning_session_companion → multimodal_voice →
 *   structured_proof_v1 → journey_routes → understanding_universe_v2 → current_target_tutor`；
 * - Should flags 不得出现在任何 Must 反向闭包中（独立 shadow/canary）。
 */
export function assertCapabilityGraphValid(): readonly string[] {
  const problems: string[] = [];
  const mustSet = new Set<string>(MUST_BUNDLE_FLAG_IDS);
  const shouldSet = new Set<string>(SHOULD_FLAG_IDS);
  // 依赖引用合法性。
  for (const dep of CAPABILITY_BUNDLE_DEPENDENCIES) {
    for (const req of dep.requires) {
      if (!mustSet.has(req)) {
        problems.push(`bundle ${dep.flag} 依赖未知 Must flag ${req}`);
      }
    }
  }
  for (const dep of SHOULD_BUNDLE_DEPENDENCIES) {
    for (const req of dep.requires) {
      if (!mustSet.has(req)) {
        problems.push(`should bundle ${dep.flag} 依赖未知 Must flag ${req}`);
      }
    }
  }
  // 冻结闭包对账（01-7 §6）。
  const expectedShell = ["companion_onboarding_v1", "learning_session_companion", "current_target_tutor"];
  const actualShell = reverseDependencyClosure("global_companion_shell");
  if (JSON.stringify(actualShell) !== JSON.stringify(expectedShell)) {
    problems.push(
      `global_companion_shell 关闭闭包不符：期望 [${expectedShell.join(",")}] 实际 [${actualShell.join(",")}]`,
    );
  }
  const expectedCore = [
    "learning_session_companion",
    "multimodal_voice",
    "structured_proof_v1",
    "journey_routes",
    "understanding_universe_v2",
    "current_target_tutor",
  ];
  const actualCore = reverseDependencyClosure("trusted_multimodal_core");
  if (JSON.stringify(actualCore) !== JSON.stringify(expectedCore)) {
    problems.push(
      `trusted_multimodal_core 关闭闭包不符：期望 [${expectedCore.join(",")}] 实际 [${actualCore.join(",")}]`,
    );
  }
  // Should flags 独立：不得出现在任何 Must 反向闭包中。
  for (const must of MUST_BUNDLE_FLAG_IDS) {
    for (const flag of reverseDependencyClosure(must)) {
      if (shouldSet.has(flag)) {
        problems.push(`Should flag ${flag} 出现在 Must flag ${must} 的关闭闭包中（应保持独立）`);
      }
    }
  }
  return problems;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、soft drain（soft rollback：UI 动画 / overlay / Tutor 展示故障）
// ═══════════════════════════════════════════════════════════════════════════

export type CapabilityState = "enabled" | "degraded" | "disabled";

/** 控制面配置（单 config revision 原子发布，01-7 §7）。 */
export interface CapabilityConfigV1 {
  /** 单一 config revision（每次原子变更 +1）。 */
  revision: number;
  /** 冻结 policy 版本。 */
  policyVersion: string;
  /** learningRuntimeEpoch（hard kill 提升；soft rollback 不变）。 */
  epoch: number;
  /** commit kill switch（hard rollback 启用；启用后 COMMIT 全部 fail closed）。 */
  commitKillSwitch: boolean;
  /** 是否允许 trusted 恢复（hard rollback 后恒 false）。 */
  trustedRecoveryAllowed: boolean;
  states: Readonly<Record<CapabilityFlagId, CapabilityState>>;
}

export const DEFAULT_POLICY_VERSION = "capability-bundles-v1" as const;

/** 构造全 enabled 的基准配置（helper；可注入覆盖）。 */
export function createCapabilityConfig(
  overrides: Readonly<Partial<Record<CapabilityFlagId, CapabilityState>>> = {},
  opts: {
    revision?: number;
    epoch?: number;
    commitKillSwitch?: boolean;
    trustedRecoveryAllowed?: boolean;
  } = {},
): CapabilityConfigV1 {
  const states = {} as Record<CapabilityFlagId, CapabilityState>;
  for (const flag of CAPABILITY_FLAG_IDS) {
    states[flag] = overrides[flag] ?? "enabled";
  }
  return {
    revision: opts.revision ?? 1,
    policyVersion: DEFAULT_POLICY_VERSION,
    epoch: opts.epoch ?? 0,
    commitKillSwitch: opts.commitKillSwitch ?? false,
    trustedRecoveryAllowed: opts.trustedRecoveryAllowed ?? true,
    states,
  };
}

/** 当前配置中处于 disabled 的 flag 列表。 */
export function disabledFlagsOf(config: CapabilityConfigV1): readonly CapabilityFlagId[] {
  return CAPABILITY_FLAG_IDS.filter((flag) => config.states[flag] === "disabled");
}

/** 原子关闭时的节点可应用校验（非空 blocked 表示该节点无法应用 → 整次回滚）。 */
export interface AtomicOffGuard {
  flag: CapabilityFlagId;
  /** 无法应用的原因（如 DB 写入失败 / 节点被保护）；空表示可应用。 */
  blocked?: string;
}

export interface AtomicOffResult {
  ok: boolean;
  /** 应用成功后的 revision（或失败回滚后保持原 revision）。 */
  revision: number;
  /** 本次实际关闭的 flag（含闭包；幂等空关闭为 []）。 */
  disabledFlags: readonly CapabilityFlagId[];
  /** 应用后的配置（失败时原样返回，保证「任一节点无法应用 → 整次回滚」）。 */
  config: CapabilityConfigV1;
  failureReason?: string;
}

/**
 * 对任意合法闭包集合做单 config revision 原子关闭（01-7 §7）：同一 revision 同时
 * 更新 capability states；任一节点无法应用 → 整次回滚（返回原配置、原 revision、
 * ok=false）。`closure` 由调用方保证为合法闭包（可经 `atomicOffClosure` /
 * `reverseDependencyClosure` 计算）。
 */
export function applyAtomicOffClosure(
  config: CapabilityConfigV1,
  closure: readonly CapabilityFlagId[],
  guards: readonly AtomicOffGuard[] = [],
): AtomicOffResult {
  // 任一节点无法应用 → 整次回滚（不部分应用）。
  for (const guard of guards) {
    if (guard.blocked !== undefined && guard.blocked.length > 0 && closure.includes(guard.flag)) {
      return {
        ok: false,
        revision: config.revision,
        disabledFlags: [],
        config,
        failureReason: `节点 ${guard.flag} 无法应用：${guard.blocked}`,
      };
    }
  }
  const newStates = { ...config.states } as Record<CapabilityFlagId, CapabilityState>;
  let changed = false;
  for (const flag of closure) {
    if (newStates[flag] !== "disabled") {
      newStates[flag] = "disabled";
      changed = true;
    }
  }
  if (!changed) {
    // 幂等：闭包均已关，无状态变化，revision 不变。
    return { ok: true, revision: config.revision, disabledFlags: [], config };
  }
  return {
    ok: true,
    revision: config.revision + 1,
    disabledFlags: [...closure],
    config: { ...config, revision: config.revision + 1, states: newStates },
  };
}

/**
 * 单 config revision 原子关闭（01-7 §7）：目标 + 反向依赖闭包一次发布，
 * 同一 revision 同时更新 capability states；任一节点无法应用 → 整次回滚
 * （返回原配置、原 revision、ok=false）。Should flag 关闭只影响自身（独立）。
 */
export function applyAtomicOff(
  config: CapabilityConfigV1,
  target: CapabilityFlagId,
  guards: readonly AtomicOffGuard[] = [],
): AtomicOffResult {
  return applyAtomicOffClosure(config, atomicOffClosure(target), guards);
}

/** Episode 状态（与学习域终态语义一致：已 commit / cancelled / stale 不回滚）。 */
export type EpisodeStatus = "active" | "committed" | "cancelled" | "stale";

/** Episode contract（PREPARE 冻结快照的纯逻辑视图）。 */
export interface EpisodeContractV1 {
  id: string;
  status: EpisodeStatus;
  /** 已锁输入（PREPARE 后锁定的 Episode；终局前不可变更）。 */
  locked: boolean;
  runtimeEpochSnapshot: number;
  /** required capability closure（该 Episode 继续完成所必需的 flag 闭包）。 */
  requiredCapabilities: readonly CapabilityFlagId[];
  /** 可选分支包含的 flag（被关时停止调用并降级/取消，不阻断 drain）。 */
  optionalCapabilities: readonly CapabilityFlagId[];
}

export type DrainDecision =
  | { kind: "drain"; reason: string }
  | { kind: "degrade_or_cancel"; reason: string }
  | { kind: "settled"; reason: string };

/**
 * 可 drain 判定（§18.3 soft rollback）：
 * - 终态（committed / cancelled / stale）→ settled（已 commit 不回滚）；
 * - epoch 失配 → degrade_or_cancel（hard kill 后的失配由 fence 收尾）；
 * - required capability closure 与被关 flag 无交集且已锁 → **drain**（继续正常
 *   core assess/commit 完成），不影响健康 core；
 * - 有交集：若交集全部落在可选分支 → degrade_or_cancel（可选分支停止调用并
 *   降级/取消）；若 required 被命中 → degrade_or_cancel（该 Episode 不能继续，
 *   取消/标记 stale，0 学习副作用）。
 */
export function decideEpisodeDrain(
  episode: EpisodeContractV1,
  disabledFlags: readonly CapabilityFlagId[],
  currentEpoch: number,
): DrainDecision {
  if (episode.status !== "active") {
    return { kind: "settled", reason: `episode ${episode.id} 已终局（${episode.status}），不回滚` };
  }
  if (episode.runtimeEpochSnapshot !== currentEpoch) {
    return {
      kind: "degrade_or_cancel",
      reason: `episode ${episode.id} runtimeEpoch 失配（snapshot=${episode.runtimeEpochSnapshot}, current=${currentEpoch}），不 drain`,
    };
  }
  const blocked = episode.requiredCapabilities.filter((f) => disabledFlags.includes(f));
  if (blocked.length === 0) {
    return {
      kind: "drain",
      reason: `episode ${episode.id} required capability closure 不含被关 flag，可 drain`,
    };
  }
  const blockedOnlyOptional = blocked.every((f) => episode.optionalCapabilities.includes(f));
  if (blockedOnlyOptional) {
    return {
      kind: "degrade_or_cancel",
      reason: `episode ${episode.id} 被关 flag [${blocked.join(",")}] 均为可选分支，停止调用并降级/取消`,
    };
  }
  return {
    kind: "degrade_or_cancel",
    reason: `episode ${episode.id} required capability [${blocked.join(",")}] 被关，取消/标记 stale，0 学习副作用`,
  };
}

/**
 * 健康 core assess/commit 是否不受 soft rollback 影响：
 * trusted_multimodal_core 未被关 && commitKillSwitch 未启用 && runtimeEpoch 未提升。
 */
export function coreAssessCommitUnaffected(
  config: CapabilityConfigV1,
  currentEpoch: number,
): boolean {
  return (
    config.states["trusted_multimodal_core"] !== "disabled" &&
    !config.commitKillSwitch &&
    config.epoch === currentEpoch
  );
}

// ─── Global Shell / onboarding 故障降级（§18.3 soft rollback）──────────────

/** 未登录页回落（global shell 关 → 标准认证 UI；禁止自由 Agent / DOM 抓取补位）。 */
export interface UnauthenticatedSurfaceResolution {
  /** 回到标准认证 UI（非伴星页面）。 */
  standardAuthUi: boolean;
  /** 不得用自由 Agent 生成帮助补位。 */
  freeAgentFallbackUsed: boolean;
  /** 不得用 DOM 抓取补位。 */
  domScrapeFallbackUsed: boolean;
}

export function resolveUnauthenticatedSurface(
  disabledFlags: readonly CapabilityFlagId[],
  freeAgentFallbackUsed = false,
  domScrapeFallbackUsed = false,
): UnauthenticatedSurfaceResolution {
  const shellOff = disabledFlags.includes("global_companion_shell");
  if (!shellOff) {
    return { standardAuthUi: false, freeAgentFallbackUsed, domScrapeFallbackUsed };
  }
  return {
    standardAuthUi: true,
    freeAgentFallbackUsed: freeAgentFallbackUsed && shellOff,
    domScrapeFallbackUsed: domScrapeFallbackUsed && shellOff,
  };
}

/** authenticated 页面降级（保留原生导航与手动入口，不依赖伴星）。 */
export interface AuthenticatedNavigationResolution {
  nativeNavigation: boolean;
  manualEntry: boolean;
}

export function resolveAuthenticatedNavigation(
  disabledFlags: readonly CapabilityFlagId[],
): AuthenticatedNavigationResolution {
  const shellOff = disabledFlags.includes("global_companion_shell");
  if (!shellOff) {
    return { nativeNavigation: false, manualEntry: false };
  }
  return { nativeNavigation: true, manualEntry: true };
}

/** onboarding 状态 forward-only 保留（关闭不影响 onboarding；consumed 不回退、不重放）。 */
export interface OnboardingPreservation {
  preserved: boolean;
  forwardOnly: boolean;
  consumedRetained: boolean;
  notReplayed: boolean;
  unchanged: boolean;
}

export function preserveOnboardingForwardOnly(
  disabledFlags: readonly CapabilityFlagId[],
  onboardingStateBefore: string,
  onboardingStateAfter: string,
): OnboardingPreservation {
  const shellOff = disabledFlags.includes("global_companion_shell");
  const stateUnchanged = onboardingStateBefore === onboardingStateAfter;
  const consumedRetained = onboardingStateBefore === "consumed" ? true : stateUnchanged;
  return {
    preserved: shellOff && stateUnchanged,
    forwardOnly: stateUnchanged,
    consumedRetained,
    notReplayed: consumedRetained,
    unchanged: stateUnchanged,
  };
}

/** 关闭 companion/scene/tutor/map 展示后回既有 question-first 验证与 Review Queue。 */
export interface FallbackVerificationResolution {
  questionFirst: boolean;
  reviewQueue: boolean;
}

export function resolveFallbackVerification(
  disabledFlags: readonly CapabilityFlagId[],
): FallbackVerificationResolution {
  const displayOff = [
    "learning_session_companion",
    "structured_proof_v1",
    "current_target_tutor",
    "journey_routes",
    "understanding_universe_v2",
  ].some((f) => disabledFlags.includes(f as CapabilityFlagId));
  if (!displayOff) {
    return { questionFirst: false, reviewQueue: false };
  }
  return { questionFirst: true, reviewQueue: true };
}

/** 新 Artifact 不得隐式转换为旧 submission（提示手动重录，避免双写竞态）。 */
export interface LegacySubmissionRejection {
  artifactKind: string;
  blocked: boolean;
  reason: string;
}

export function rejectImplicitLegacySubmission(artifactKind: string): LegacySubmissionRejection {
  if (artifactKind.startsWith("episode_artifact_v2")) {
    return {
      artifactKind,
      blocked: true,
      reason: "新 Artifact 不能隐式转换为旧 submission，请手动重录（legacy-adapter 唯一消费矩阵）",
    };
  }
  return { artifactKind, blocked: false, reason: "旧 submission 路径保持原语义" };
}

/** forward-only 保留：新表 / events / artifacts / projections 不因回滚删除；已产 canonical 结果继续有效。 */
export interface ForwardOnlyPreservation {
  newTablesKept: boolean;
  eventsKept: boolean;
  artifactsKept: boolean;
  projectionsKept: boolean;
  canonicalResultsStillValid: boolean;
}

export function preserveForwardOnlyArtifacts(): ForwardOnlyPreservation {
  return {
    newTablesKept: true,
    eventsKept: true,
    artifactsKept: true,
    projectionsKept: true,
    canonicalResultsStillValid: true,
  };
}

/** practice 航迹关闭展示后仍保留用户导出 / 删除能力。 */
export interface PracticeTrailControls {
  exportAvailable: boolean;
  deleteAvailable: boolean;
}

export function preservePracticeTrailControls(
  disabledFlags: readonly CapabilityFlagId[],
): PracticeTrailControls {
  const practiceOff = ["learning_session_companion", "current_target_tutor"].some((f) =>
    disabledFlags.includes(f as CapabilityFlagId),
  );
  if (!practiceOff) {
    return { exportAvailable: false, deleteAvailable: false };
  }
  return { exportAvailable: true, deleteAvailable: true };
}

/** 历史快照（回滚不得修改现有 schedule / attempt / understanding history / active Card Set）。 */
export interface HistorySnapshot {
  schedules: readonly string[];
  attempts: readonly string[];
  understanding: readonly string[];
  activeCardSet: readonly string[];
}

/** 历史是否完全未被触碰（顺序敏感深比较）。 */
export function historyUntouched(before: HistorySnapshot, after: HistorySnapshot): boolean {
  return (
    JSON.stringify(before.schedules) === JSON.stringify(after.schedules) &&
    JSON.stringify(before.attempts) === JSON.stringify(after.attempts) &&
    JSON.stringify(before.understanding) === JSON.stringify(after.understanding) &&
    JSON.stringify(before.activeCardSet) === JSON.stringify(after.activeCardSet)
  );
}

// ─── soft drain 演练编排 ───────────────────────────────────────────────────

export interface SoftDrainDrillInput {
  config: CapabilityConfigV1;
  /** 要关闭的目标 flag（UI 动画 / overlay / Tutor 展示故障）。 */
  target: CapabilityFlagId;
  guards?: readonly AtomicOffGuard[];
  episodes: readonly EpisodeContractV1[];
  currentEpoch: number;
  /** 演练注入的实际生效关闭集合（如 Global Shell/onboarding 故障）；缺省用原子关闭结果。 */
  closedFlagsOverride?: readonly CapabilityFlagId[];
  /** 演练注入的违规补位标志（自由 Agent / DOM 抓取）。 */
  freeAgentFallbackUsed?: boolean;
  domScrapeFallbackUsed?: boolean;
  /** onboarding 关闭前后的状态（forward-only 校验）。 */
  onboardingStateBefore?: string;
  onboardingStateAfter?: string;
  /** 演练注入的新 Artifact 种类（隐式转旧 submission 拒绝）。 */
  artifactKinds?: readonly string[];
  historyBefore?: HistorySnapshot;
  historyAfter?: HistorySnapshot;
}

export interface DrainDecisionRecord {
  episodeId: string;
  decision: "drain" | "degrade_or_cancel" | "settled";
  reason: string;
}

export interface SoftDrainDrillReport {
  target: CapabilityFlagId;
  atomicOff: AtomicOffResult;
  /** 可 drain（required closure 不含被关 flag）的已锁 Episode。 */
  drainableEpisodes: readonly string[];
  /** 停止调用并降级/取消的可选分支 Episode。 */
  degradedOrCancelledEpisodes: readonly string[];
  /** 健康 core assess/commit 不受影响。 */
  coreAssessCommitUnaffected: boolean;
  /** 实际生效的关闭集合（演练视图）。 */
  closedFlags: readonly CapabilityFlagId[];
  unauthenticatedStandardAuthUi: boolean;
  freeAgentFallbackUsed: boolean;
  domScrapeFallbackUsed: boolean;
  nativeNavigationRetained: boolean;
  manualEntryRetained: boolean;
  onboardingPreserved: boolean;
  onboardingForwardOnly: boolean;
  questionFirstAvailable: boolean;
  reviewQueueAvailable: boolean;
  implicitLegacySubmissionBlocked: readonly string[];
  forwardOnlyPreserved: ForwardOnlyPreservation;
  practiceExportAvailable: boolean;
  practiceDeleteAvailable: boolean;
  historyUntouched: boolean;
  /** 原子关闭成功 + 全部 soft 降级语义成立。 */
  passed: boolean;
}

/**
 * soft drain 演练编排（纯函数）：原子关闭 → 逐 Episode drain 判定 → 降级语义 →
 * forward-only / practice / 历史不变量。返回可逐字段断言的报告。
 */
export function planSoftRollback(input: SoftDrainDrillInput): SoftDrainDrillReport {
  const atomicOff = applyAtomicOff(input.config, input.target, input.guards ?? []);
  const closedFlags =
    input.closedFlagsOverride !== undefined
      ? input.closedFlagsOverride
      : atomicOff.ok
        ? atomicOff.disabledFlags
        : disabledFlagsOf(input.config);

  const decisions = input.episodes.map((ep) => ({
    episode: ep,
    decision: decideEpisodeDrain(ep, closedFlags, input.currentEpoch),
  }));
  const drainableEpisodes = decisions
    .filter((d) => d.decision.kind === "drain")
    .map((d) => d.episode.id);
  const degradedOrCancelledEpisodes = decisions
    .filter((d) => d.decision.kind === "degrade_or_cancel")
    .map((d) => d.episode.id);

  const unauth = resolveUnauthenticatedSurface(
    closedFlags,
    input.freeAgentFallbackUsed ?? false,
    input.domScrapeFallbackUsed ?? false,
  );
  const nav = resolveAuthenticatedNavigation(closedFlags);
  const onboarding = preserveOnboardingForwardOnly(
    closedFlags,
    input.onboardingStateBefore ?? "consumed",
    input.onboardingStateAfter ?? "consumed",
  );
  const fallback = resolveFallbackVerification(closedFlags);
  const rejections = (input.artifactKinds ?? []).map((kind) => rejectImplicitLegacySubmission(kind));
  const forwardOnly = preserveForwardOnlyArtifacts();
  const practice = preservePracticeTrailControls(closedFlags);
  const historyUntouchedFlag = historyUntouched(
    input.historyBefore ?? { schedules: [], attempts: [], understanding: [], activeCardSet: [] },
    input.historyAfter ?? { schedules: [], attempts: [], understanding: [], activeCardSet: [] },
  );

  const implicitLegacySubmissionBlocked = rejections
    .filter((r) => r.blocked)
    .map((r) => r.artifactKind);

  const passed =
    atomicOff.ok &&
    coreAssessCommitUnaffected(atomicOff.config, input.currentEpoch) &&
    (!closedFlags.includes("global_companion_shell") ||
      (unauth.standardAuthUi && !unauth.freeAgentFallbackUsed && !unauth.domScrapeFallbackUsed &&
        nav.nativeNavigation && nav.manualEntry && onboarding.preserved)) &&
    fallback.questionFirst &&
    fallback.reviewQueue &&
    forwardOnly.canonicalResultsStillValid &&
    practice.exportAvailable &&
    practice.deleteAvailable &&
    historyUntouchedFlag;

  return {
    target: input.target,
    atomicOff,
    drainableEpisodes,
    degradedOrCancelledEpisodes,
    coreAssessCommitUnaffected: coreAssessCommitUnaffected(atomicOff.config, input.currentEpoch),
    closedFlags,
    unauthenticatedStandardAuthUi: unauth.standardAuthUi,
    freeAgentFallbackUsed: unauth.freeAgentFallbackUsed,
    domScrapeFallbackUsed: unauth.domScrapeFallbackUsed,
    nativeNavigationRetained: nav.nativeNavigation,
    manualEntryRetained: nav.manualEntry,
    onboardingPreserved: onboarding.preserved,
    onboardingForwardOnly: onboarding.forwardOnly,
    questionFirstAvailable: fallback.questionFirst,
    reviewQueueAvailable: fallback.reviewQueue,
    implicitLegacySubmissionBlocked,
    forwardOnlyPreserved: forwardOnly,
    practiceExportAvailable: practice.exportAvailable,
    practiceDeleteAvailable: practice.deleteAvailable,
    historyUntouched: historyUntouchedFlag,
    passed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、hard kill（privacy / tenant / 答案泄漏 / trust / Critic / schedule invariant）
// ═══════════════════════════════════════════════════════════════════════════

/** hard rollback 触发类别（§18.3）。 */
export type HardIncidentKind =
  | "privacy"
  | "tenant"
  | "answer_leak"
  | "trust"
  | "critic"
  | "schedule_invariant";

export const HARD_INCIDENT_KINDS: readonly HardIncidentKind[] = [
  "privacy",
  "tenant",
  "answer_leak",
  "trust",
  "critic",
  "schedule_invariant",
];

/** 类型守卫：是否合法 hard incident 类别。 */
export function isHardIncidentKind(value: string): value is HardIncidentKind {
  return (HARD_INCIDENT_KINDS as readonly string[]).includes(value);
}

/** hard incident 固定处理顺序（03-6 §5，先隔离再收尾，不可交换）。 */
export const HARD_KILL_ORDER = [
  "bump_runtime_epoch",
  "fence_uncommitted_episodes",
  "cancel_external_jobs",
  "forbid_trusted_recovery",
] as const;

export interface ExternalJobLike {
  id: string;
  status: "running" | "pending" | "finished";
}

export interface HardKillInput {
  incident: HardIncidentKind;
  currentRuntimeEpoch: number;
  /** 全部未 commit Episode（含已终局；fence 只处理 active）。 */
  uncommittedEpisodes: readonly EpisodeContractV1[];
  externalJobs: readonly ExternalJobLike[];
}

export interface HardKillResult {
  incident: HardIncidentKind;
  /** 固定顺序（03-6 §5）。 */
  order: readonly string[];
  /** 提升后的 learningRuntimeEpoch（旧 snapshot 全部失配 → fail closed）。 */
  newRuntimeEpoch: number;
  /** commit kill switch 已启用。 */
  killSwitchEnabled: boolean;
  /** 被 fence（status → cancelled）的未 commit Episode id。 */
  fencedEpisodes: readonly string[];
  /** 已取消的外部 job id。 */
  cancelledJobs: readonly string[];
  /** 禁止恢复为 trusted（字面量 false，类型层保证）。 */
  trustedRecoveryAllowed: false;
  /** hard kill 后不写可恢复 staging。 */
  stagingWritten: false;
}

/**
 * hard kill 编排（纯函数，固定顺序不可交换）：
 * ① 提升 runtime epoch（先隔离：旧 snapshot 全部失配）→ ② 启用 commitKillSwitch
 * 并 fence 全部未 commit Episode（active → cancelled；已 committed / stale /
 * cancelled 终态保留，防御性过滤不重复 fence）→ ③ 取消全部未完成外部 job →
 * ④ 禁止 trusted 恢复（恒 false）。只产出结果对象，不写任何领域真值。
 */
export function executeHardKill(input: HardKillInput): HardKillResult {
  const newRuntimeEpoch = input.currentRuntimeEpoch + 1;
  const fencedEpisodes = input.uncommittedEpisodes
    .filter((ep) => ep.status === "active")
    .map((ep) => ep.id);
  const cancelledJobs = input.externalJobs
    .filter((job) => job.status === "running" || job.status === "pending")
    .map((job) => job.id);
  return {
    incident: input.incident,
    order: [...HARD_KILL_ORDER],
    newRuntimeEpoch,
    killSwitchEnabled: true,
    fencedEpisodes,
    cancelledJobs,
    trustedRecoveryAllowed: false,
    stagingWritten: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、legacy reader matrix（projection 关闭时旧 reader 兼容矩阵）
// ═══════════════════════════════════════════════════════════════════════════

export interface PendingScheduleLike {
  id: string;
  status: "pending" | "consumed";
}

export interface AttemptLike {
  id: string;
}

export interface ResultLike {
  id: string;
}

export interface LegacyReaderMatrixInput {
  pendingSchedules: readonly PendingScheduleLike[];
  attempts: readonly AttemptLike[];
  results: readonly ResultLike[];
  /** 投影（understanding_universe_v2 / map）是否启用。 */
  projectionsEnabled: boolean;
  /** 演练中是否观察到删除新表 / events / artifacts / projections 的操作（必须 false）。 */
  forwardOnlyMutationObserved: boolean;
  historyBefore: HistorySnapshot;
  historyAfter: HistorySnapshot;
}

export interface LegacyReaderMatrixReport {
  /** 旧 reader 仍读 pending schedule。 */
  pendingSchedulesReadable: boolean;
  /** 旧 reader 仍读 attempt。 */
  attemptsReadable: boolean;
  /** 旧 reader 仍读结果（canonical validation / review）。 */
  resultsReadable: boolean;
  /** forward-only：新表 / events / artifacts / projections 保留，不因回滚删除。 */
  forwardOnlyPreserved: boolean;
  /** 已产 canonical validation/review 结果继续有效。 */
  canonicalResultsStillValid: boolean;
  /** 回滚不修改现有 schedule / attempt / understanding history / active Card Set。 */
  historyUntouched: boolean;
  /** projection 再开启时需执行 drift replay。 */
  driftReplayRequired: boolean;
  /** projection 再开启时需执行观察窗口。 */
  observationWindowRequired: boolean;
  pendingSchedulesCount: number;
  attemptsCount: number;
  resultsCount: number;
}

/**
 * legacy reader matrix 判定（纯函数）：projection 关闭时旧 reader 仍读 pending
 * schedule / attempt / 结果（数据 forward-only 保留即读得到）；回滚不得修改历史；
 * 再开启投影时执行 drift replay 与观察窗口。
 */
export function evaluateLegacyReaderMatrix(
  input: LegacyReaderMatrixInput,
): LegacyReaderMatrixReport {
  const forwardOnlyPreserved = !input.forwardOnlyMutationObserved;
  const historyUntouchedFlag = historyUntouched(input.historyBefore, input.historyAfter);
  return {
    pendingSchedulesReadable: forwardOnlyPreserved,
    attemptsReadable: forwardOnlyPreserved,
    resultsReadable: forwardOnlyPreserved,
    forwardOnlyPreserved,
    canonicalResultsStillValid: forwardOnlyPreserved && historyUntouchedFlag,
    historyUntouched: historyUntouchedFlag,
    driftReplayRequired: !input.projectionsEnabled,
    observationWindowRequired: !input.projectionsEnabled,
    pendingSchedulesCount: input.pendingSchedules.length,
    attemptsCount: input.attempts.length,
    resultsCount: input.results.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、三类演练统一编排（每次 RC 分别演练 soft drain / hard kill / legacy matrix）
// ═══════════════════════════════════════════════════════════════════════════

export interface RollbackDrillSuiteInput {
  softDrain: SoftDrainDrillInput;
  hardKill: HardKillInput;
  legacy: LegacyReaderMatrixInput;
}

export interface RollbackDrillSuiteReport {
  softDrain: SoftDrainDrillReport;
  hardKill: HardKillResult;
  legacy: LegacyReaderMatrixReport;
  /** 三类演练全部通过。 */
  allPassed: boolean;
  /** 图自检（冻结闭包对账，必须为空）。 */
  graphProblems: readonly string[];
}

/** 三类回滚演练统一编排：soft drain + hard kill + legacy reader matrix。 */
export function runRollbackDrillSuite(input: RollbackDrillSuiteInput): RollbackDrillSuiteReport {
  const softDrain = planSoftRollback(input.softDrain);
  const hardKill = executeHardKill(input.hardKill);
  const legacy = evaluateLegacyReaderMatrix(input.legacy);
  const graphProblems = assertCapabilityGraphValid();
  const hardKillPassed =
    JSON.stringify(hardKill.order) === JSON.stringify([...HARD_KILL_ORDER]) &&
    hardKill.killSwitchEnabled &&
    hardKill.trustedRecoveryAllowed === false &&
    hardKill.stagingWritten === false &&
    hardKill.fencedEpisodes.length > 0 &&
    hardKill.cancelledJobs.length > 0;
  const allPassed =
    softDrain.passed &&
    hardKillPassed &&
    legacy.pendingSchedulesReadable &&
    legacy.attemptsReadable &&
    legacy.resultsReadable &&
    legacy.forwardOnlyPreserved &&
    legacy.historyUntouched &&
    graphProblems.length === 0;
  return { softDrain, hardKill, legacy, allPassed, graphProblems };
}
