/**
 * 阶段 10（W9）任务 10-1：capability 部署与非法组合校验（§18.1 / 冻结记录 01-7）。
 *
 * 本文件是 **capability 部署核心**（无 DB / 无网络 / 无副作用 / 无随机，纯函数
 * 可测；外部目标——capability API / Provider/tool fence / 前台状态——通过注入的
 * 适配器（adapter）应用，任一节点无法应用则整次配置变更回滚）：
 *
 * - **启动校验（fail startup）**：启动时解析 bundle graph 并校验配置合法；非法
 *   组合必须 fail startup（01-7 §5）——onboarding 开而 global shell 关、Session
 *   Companion 开而 trusted core 关、Scene 开而 Critic/commit 关、map 开而
 *   projection 关、Tutor 开而 Grounded Answer Critic 关等。`fail startup` 只是
 *   防御未知非法配置的最后防线，不是 rollout / 事故回滚机制（01-7 §7）。
 * - **required capability closure 验证**：每次外部 tool/Provider 调用及结果落库
 *   前，重新验证 contract 的 required capability closure 与 runtime epoch；
 *   关闭相关 flag 后在途 Agent 不能继续该能力调用和成本；无关 soft flag 变化不
 *   阻断 core assess/commit drain。
 * - **根关闭闭包（root off）**：运行中关闭 root capability 时先计算反向依赖
 *   闭包（`reverseDependencyClosure`，Must bundle 图，与 01-7 §6 冻结闭包逐字节
 *   一致），再用**同一 config revision** 原子发布（01-7 §7）。
 * - **单 config revision 原子 apply/rollback**：同一 revision 同时更新 capability
 *   API、Provider/tool fence 与前台状态；任一节点无法应用则整次配置变更回滚。
 * - **capability API**：`enabled / degraded / disabled + reason + policyVersion`
 *   （01-7 §5）；运行中从不暴露非法 flag 组合（非法配置拒绝生成视图）。
 *
 * 依赖：capability bundle 契约来自 packages/shared/src/capability-bundle.ts
 * （单一事实来源）。主代理收口 shared/index.ts 后可用 `@ailearn/shared` 别名替换
 * 下列相对导入（semantics 不变）。
 */

import {
  CAPABILITY_ATOMIC_CONTAINMENT,
  CAPABILITY_DEPENDENCY_EDGES,
  CAPABILITY_IDS,
  DEFAULT_CAPABILITY_POLICY_VERSION,
  INTERNAL_ATOMIC_CAPABILITY_IDS,
  MUST_BUNDLE_CAPABILITY_IDS,
  MUST_BUNDLE_DEPENDENCY_EDGES,
  SHOULD_BUNDLE_CAPABILITY_IDS,
  capabilityConfigV1Schema,
  isCapabilityId,
  isMustBundleCapabilityId,
  type CapabilityConfigV1,
  type CapabilityId,
  type CapabilityStateV1,
  type CapabilityStatesV1,
  type MustBundleCapabilityId,
} from "../../../node_modules/@ailearn/shared/src/capability-bundle.ts";
// security_review MEDIUM #1 修复：交叉对账用（启动时验证两图一致）。
import { CAPABILITY_BUNDLE_DEPENDENCIES } from "./rollback-drill.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 一、bundle graph 解析与自检（01-7 §6；启动时调用）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * bundle 图自检（01-7 §6 冻结闭包对账）：返回问题列表，空数组 = 图合法。
 * - 完整依赖图引用合法且无环；
 * - 两个根关闭闭包与冻结记录一致：
 *   `global_companion_shell off → companion_onboarding_v1 → learning_session_companion
 *   → current_target_tutor`；
 *   `trusted_multimodal_core off → learning_session_companion → multimodal_voice →
 *   structured_proof_v1 → journey_routes → understanding_universe_v2 →
 *   current_target_tutor`；
 * - Should flags 独立：不出现在任何 Must 反向闭包中（独立 shadow/canary）。
 */
export function assertBundleGraphValid(): readonly string[] {
  const problems: string[] = [];
  const all = new Set<string>(CAPABILITY_IDS);
  const must = new Set<string>(MUST_BUNDLE_CAPABILITY_IDS);
  const should = new Set<string>(SHOULD_BUNDLE_CAPABILITY_IDS);

  if (CAPABILITY_IDS.length !== 18) {
    problems.push(`capability 枚举总数应为 18，实际 ${CAPABILITY_IDS.length}`);
  }
  if (MUST_BUNDLE_CAPABILITY_IDS.length !== 9) {
    problems.push(`Must bundle flag 应为 9 个，实际 ${MUST_BUNDLE_CAPABILITY_IDS.length}`);
  }
  if (SHOULD_BUNDLE_CAPABILITY_IDS.length !== 3) {
    problems.push(`Should flag 应为 3 个，实际 ${SHOULD_BUNDLE_CAPABILITY_IDS.length}`);
  }
  if (INTERNAL_ATOMIC_CAPABILITY_IDS.length !== 6) {
    problems.push(`内部原子能力应为 6 个，实际 ${INTERNAL_ATOMIC_CAPABILITY_IDS.length}`);
  }

  // 完整图引用合法性。
  for (const edge of CAPABILITY_DEPENDENCY_EDGES) {
    if (!all.has(edge.capability)) {
      problems.push(`依赖图节点 ${edge.capability} 不是合法 capability`);
    }
    for (const req of edge.requires) {
      if (!all.has(req)) {
        problems.push(`bundle ${edge.capability} 依赖未知 capability ${req}`);
      }
    }
  }
  // Must 图只引用 Must 节点。
  for (const edge of MUST_BUNDLE_DEPENDENCY_EDGES) {
    if (!must.has(edge.capability)) {
      problems.push(`Must 依赖图节点 ${edge.capability} 不是 Must flag`);
    }
    for (const req of edge.requires) {
      if (!must.has(req)) {
        problems.push(`Must 依赖图 ${edge.capability} 依赖非 Must ${req}`);
      }
    }
  }
  // 原子包含表引用合法性。
  for (const containment of CAPABILITY_ATOMIC_CONTAINMENT) {
    if (!all.has(containment.bundle)) {
      problems.push(`原子包含 bundle ${containment.bundle} 不是合法 capability`);
    }
    for (const sub of containment.contains) {
      if (!all.has(sub)) {
        problems.push(`原子包含 ${containment.bundle} 引用未知原子 ${sub}`);
      }
      if (!(INTERNAL_ATOMIC_CAPABILITY_IDS as readonly string[]).includes(sub)) {
        problems.push(`原子包含 ${containment.bundle} 的子能力 ${sub} 不是内部原子能力`);
      }
    }
  }

  // security_review MEDIUM #1 修复：与 rollback-drill 的本地图交叉对账——
  // 两处独立维护的同一 capability 依赖集必须一致，否则 root off 闭包会漂移
  // 导致回滚漏关能力。启动时发现不一致 → fail startup。
  // 注：shared 图含内部原子能力（scene/critic/commit/map/projection 等），
  // rollback-drill 图只含 Must/Should flag——比较前过滤内部原子。
  const atomics = new Set<string>(INTERNAL_ATOMIC_CAPABILITY_IDS);
  for (const local of CAPABILITY_BUNDLE_DEPENDENCIES) {
    const sharedEdge = CAPABILITY_DEPENDENCY_EDGES.find((e) => e.capability === local.flag);
    if (sharedEdge === undefined) {
      problems.push(`交叉对账：rollback-drill 图节点 ${local.flag} 不在 shared bundle graph`);
      continue;
    }
    const sharedReqs = sharedEdge.requires.filter((r) => !atomics.has(r)).sort();
    const localReqs = [...local.requires].sort();
    if (JSON.stringify(sharedReqs) !== JSON.stringify(localReqs)) {
      problems.push(
        `交叉对账：capability ${local.flag} 依赖不一致（shared=${sharedReqs.join("/")} vs rollback-drill=${localReqs.join("/")}）`,
      );
    }
  }

  // 完整图无环（Kahn 拓扑检测：边 req → capability 表示 capability 依赖 req；
  // 环会破坏闭包计算的确定性，必须拒绝）。
  const inDegree = new Map<string, number>();
  for (const id of CAPABILITY_IDS) inDegree.set(id, 0);
  for (const edge of CAPABILITY_DEPENDENCY_EDGES) {
    inDegree.set(edge.capability, (inDegree.get(edge.capability) ?? 0) + edge.requires.length);
  }
  const queue = CAPABILITY_IDS.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const processed = new Set<string>(queue);
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const edge of CAPABILITY_DEPENDENCY_EDGES) {
      if (!(edge.requires as readonly string[]).includes(current)) continue;
      const next = (inDegree.get(edge.capability) ?? 0) - 1;
      inDegree.set(edge.capability, next);
      if (next === 0 && !processed.has(edge.capability)) {
        processed.add(edge.capability);
        queue.push(edge.capability);
      }
    }
  }
  if (processed.size !== CAPABILITY_IDS.length) {
    const cycleNodes = CAPABILITY_IDS.filter((id) => !processed.has(id));
    problems.push(`bundle 依赖图存在环（未拓扑完成）：${cycleNodes.join(",")}`);
  }

  // 冻结闭包对账（01-7 §6）。
  const expectedShell = [
    "companion_onboarding_v1",
    "learning_session_companion",
    "current_target_tutor",
  ];
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
  for (const mustFlag of MUST_BUNDLE_CAPABILITY_IDS) {
    for (const flag of reverseDependencyClosure(mustFlag)) {
      if (should.has(flag)) {
        problems.push(`Should flag ${flag} 出现在 Must flag ${mustFlag} 的关闭闭包中（应保持独立）`);
      }
    }
  }
  return problems;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、闭包计算（完整图 / Must bundle 图 / 根关闭原子闭包）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * required capability closure（完整图传递闭包，含自身，确定性 BFS）：该 capability
 * 集合可用所需的全部前置能力（含内部原子）。用于每次外部 tool/Provider 调用及
 * 结果落库前的 access 验证。
 */
export function requiredCapabilityClosure(ids: readonly CapabilityId[]): readonly CapabilityId[] {
  const visited = new Set<CapabilityId>();
  const queue: CapabilityId[] = [];
  for (const id of ids) {
    if (isCapabilityId(id) && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const edge = CAPABILITY_DEPENDENCY_EDGES.find((e) => e.capability === current);
    if (edge === undefined) continue;
    for (const req of edge.requires) {
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return queue;
}

/**
 * 根关闭闭包（01-7 §6）：关闭 root capability 时需同时关闭的**反向依赖传递闭包**
 * （不含 target 自身）。只在 Must bundle 图上计算（Should flags 独立，01-7 §4）。
 */
export function reverseDependencyClosure(
  flag: MustBundleCapabilityId,
): readonly MustBundleCapabilityId[] {
  const visited = new Set<MustBundleCapabilityId>();
  const queue: MustBundleCapabilityId[] = [flag];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const edge of MUST_BUNDLE_DEPENDENCY_EDGES) {
      if (!isMustBundleCapabilityId(edge.capability)) continue;
      if ((edge.requires as readonly string[]).includes(current) && !visited.has(edge.capability)) {
        visited.add(edge.capability);
        queue.push(edge.capability);
      }
    }
  }
  return [...visited];
}

/**
 * 关闭 target 后需要一并关闭的完整原子闭包（含 target 自身）：
 * - Must 反向依赖闭包（01-7 §6 冻结闭包）；
 * - 上述 bundle 原子包含的内部原子子能力（01-7 §4 原子不可拆分）；
 * - 依赖上述能力的 Should flags（01-7 §4 依赖关闭时 Should 跟随，避免产生非法
 *   组合；不进入冻结闭包断言）。
 */
export function atomicOffClosure(flag: MustBundleCapabilityId): readonly CapabilityId[] {
  const closure = [flag, ...reverseDependencyClosure(flag)];
  const result: CapabilityId[] = [...closure];
  const closedSet = new Set<CapabilityId>(result);
  // bundle → 内部原子子能力（原子不可拆分，一起关闭）。
  for (const c of closure) {
    for (const containment of CAPABILITY_ATOMIC_CONTAINMENT) {
      if (containment.bundle !== c) continue;
      for (const sub of containment.contains) {
        if (!closedSet.has(sub)) {
          closedSet.add(sub);
          result.push(sub);
        }
      }
    }
  }
  // 依赖已关闭能力的 Should flags 跟随关闭（保持配置合法；Should 独立仅指不进
  // 冻结闭包断言 / 不被 Must 默认发布强制，依赖关闭时仍须收敛）。
  for (const shouldFlag of SHOULD_BUNDLE_CAPABILITY_IDS) {
    const shouldClosure = requiredCapabilityClosure([shouldFlag]);
    if (shouldClosure.some((c) => closedSet.has(c)) && !closedSet.has(shouldFlag)) {
      closedSet.add(shouldFlag);
      result.push(shouldFlag);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、启动校验与非法组合 fail startup（01-7 §5 / §18.1）
// ═══════════════════════════════════════════════════════════════════════════

/** 从未知输入解析配置（zod strict；非法输入抛 ZodError）。 */
export function parseCapabilityConfig(input: unknown): CapabilityConfigV1 {
  return capabilityConfigV1Schema.parse(input);
}

/** 当前状态是否为非 disabled（enabled/degraded 均视为「开着」）。 */
export function isCapabilityOn(state: CapabilityStateV1): boolean {
  return state.status !== "disabled";
}

/**
 * 配置合法性校验（01-7 §5 / §18.1）：任一 capability 开着而其 required closure
 * 中有 disabled、任一 bundle 开着而其原子包含的子能力 disabled，均属非法组合。
 * 覆盖：onboarding 开而 global shell 关、Session Companion 开而 trusted core 关、
 * Scene 开而 Critic/commit 关、map 开而 projection 关、Tutor 开而 Grounded
 * Answer Critic 关等。返回问题列表，空数组 = 合法。
 */
export function validateConfigLegal(config: CapabilityConfigV1): readonly string[] {
  const problems: string[] = [];
  const state = (id: CapabilityId): CapabilityStateV1 | undefined => config.states[id];
  // states 完整性：缺失 key 视为 fail-closed（缺失即关，但显式报告便于排障）。
  for (const id of CAPABILITY_IDS) {
    if (state(id) === undefined) {
      problems.push(`配置缺少 capability ${id} 的状态记录`);
    }
  }
  // R1：每个非 disabled capability 的直接 requires 全部非 disabled。
  for (const edge of CAPABILITY_DEPENDENCY_EDGES) {
    const self = state(edge.capability);
    if (self === undefined || self.status === "disabled") continue;
    for (const req of edge.requires) {
      const reqState = state(req);
      if (reqState === undefined || reqState.status === "disabled") {
        problems.push(`非法组合：${edge.capability} 开而 required capability ${req} 关（fail startup）`);
      }
    }
  }
  // R2：bundle 开着而其原子包含的子能力 disabled（原子不可拆分）。
  for (const containment of CAPABILITY_ATOMIC_CONTAINMENT) {
    const bundleState = state(containment.bundle);
    if (bundleState === undefined || bundleState.status === "disabled") continue;
    for (const sub of containment.contains) {
      const subState = state(sub);
      if (subState === undefined || subState.status === "disabled") {
        problems.push(`非法组合：${containment.bundle} 开而原子包含 ${sub} 关（fail startup）`);
      }
    }
  }
  return problems;
}

/** 启动校验结果。 */
export interface CapabilityStartupValidation {
  ok: boolean;
  problems: readonly string[];
}

/**
 * 启动校验（fail startup）：解析 bundle graph + 校验配置合法。非法组合必须
 * fail startup（01-7 §5）；`fail startup` 只是防御未知非法配置的最后防线。
 * 调用方在 ok=false 时必须拒绝启动。
 */
export function validateStartup(config: CapabilityConfigV1): CapabilityStartupValidation {
  const graphProblems = assertBundleGraphValid();
  const configProblems = validateConfigLegal(config);
  const problems = [...graphProblems, ...configProblems];
  return { ok: problems.length === 0, problems };
}

/**
 * 启动校验的抛出版本：非法配置抛 Error（fail startup 硬失败）。
 * 用于服务启动入口直接接线。
 */
export function failStartupIfIllegal(config: CapabilityConfigV1): void {
  const { ok, problems } = validateStartup(config);
  if (!ok) {
    throw new Error(`capability 配置非法，拒绝启动：\n- ${problems.join("\n- ")}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、capability API 视图（01-7 §5：enabled / degraded / disabled + reason +
//    policyVersion）与 access 验证（外部调用 / 结果落库前）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * capability API 视图：每个 capability 返回 `enabled / degraded / disabled +
 * reason + policyVersion`。
 * - disabled：显式关闭（reason 透传）；
 * - degraded：显式降级，或 enabled 但其 required closure 中有 degraded（传递
 *   降级，reason 注明前置降级来源）；
 * - enabled：自身 enabled 且 required closure 全部 enabled。
 * 运行中从不暴露非法 flag 组合：配置非法（validateConfigLegal 非空）时抛
 * 内部错误而不是返回含非法组合的视图（01-7 §7「fail startup 只是最后防线」，
 * 正常运行时的配置必须始终合法）。
 */
export function computeCapabilityApiView(config: CapabilityConfigV1) {
  const illegal = validateConfigLegal(config);
  if (illegal.length > 0) {
    throw new Error(`capability 配置非法，拒绝生成 API 视图：${illegal.join("；")}`);
  }
  const capabilities = {} as CapabilityStatesV1;
  for (const id of CAPABILITY_IDS) {
    const state = config.states[id];
    // validateConfigLegal 已保证 states 覆盖全部 capability（缺 key 会抛内部错误）。
    capabilities[id] = resolveEffectiveState(config, id, state!);
  }
  return {
    revision: config.revision,
    policyVersion: config.policyVersion,
    epoch: config.epoch,
    capabilities,
  };
}

/** 计算单个 capability 的有效状态（含传递降级）。 */
function resolveEffectiveState(
  config: CapabilityConfigV1,
  id: CapabilityId,
  state: CapabilityStateV1,
): CapabilityStateV1 {
  if (state.status === "disabled" || state.status === "degraded") {
    return state;
  }
  const closure = requiredCapabilityClosure([id]);
  const degradedSource = closure.find((c) => config.states[c]?.status === "degraded");
  if (degradedSource !== undefined) {
    return {
      status: "degraded",
      reason: `required capability ${degradedSource} 已降级`,
      policyVersion: config.policyVersion,
    };
  }
  return state;
}

/** access 验证结论。 */
export interface CapabilityAccessVerdict {
  allowed: boolean;
  /** 展开后的 required capability closure（含传递依赖）。 */
  closure: readonly CapabilityId[];
  /** 闭包中被关闭（disabled）的 capability（导致拒绝的原因）。 */
  blockedCapabilities: readonly CapabilityId[];
  /** 拒绝原因（allowed=false 时有值）。 */
  reason?: string;
}

/** access 验证选项。 */
export interface CapabilityAccessOptions {
  /** 期望的 runtime epoch（来自调用上下文）；与 config.epoch 不符 → 拒绝。 */
  expectedEpoch?: number;
  /** 已锁 contract 快照（在途 Agent）时可替代 expectedEpoch 做 epoch 对账。 */
  snapshot?: {
    revision: number;
    epoch: number;
  };
}

/**
 * 每次外部 tool/Provider 调用及结果落库前的重新验证（01-7 §5 / §18.1）：
 * - 展开 required capability closure 并校验全部非 disabled；
 * - 校验 runtime epoch：config.epoch 与期望/快照 epoch 一致（epoch 提升意味着
 *   hard rollback，在途 Agent 立即失去该能力调用与成本）。
 * 返回 allowed=false 时调用方必须 fail closed（不发起外部调用 / 不落库）。
 */
export function verifyCapabilityAccess(
  config: CapabilityConfigV1,
  requiredIds: readonly CapabilityId[],
  options: CapabilityAccessOptions = {},
): CapabilityAccessVerdict {
  const closure = requiredCapabilityClosure(requiredIds);
  if (options.snapshot !== undefined && options.snapshot.epoch !== config.epoch) {
    return {
      allowed: false,
      closure,
      blockedCapabilities: [],
      reason: `runtime epoch 已提升：contract epoch ${options.snapshot.epoch} ≠ 当前 ${config.epoch}`,
    };
  }
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== config.epoch) {
    return {
      allowed: false,
      closure,
      blockedCapabilities: [],
      reason: `runtime epoch 不匹配：期望 ${options.expectedEpoch} ≠ 当前 ${config.epoch}`,
    };
  }
  const blocked = closure.filter((id) => {
    const state = config.states[id];
    return state === undefined || state.status === "disabled";
  });
  if (blocked.length > 0) {
    return {
      allowed: false,
      closure,
      blockedCapabilities: blocked,
      reason: `required capability closure 含已关闭能力：[${blocked.join(",")}]`,
    };
  }
  return { allowed: true, closure, blockedCapabilities: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、单 config revision 原子 apply/rollback（01-7 §7 / §18.1）
// ═══════════════════════════════════════════════════════════════════════════

/** 原子发布的三个目标：capability API、Provider/tool fence、前台状态。 */
export const CAPABILITY_PUBLISH_TARGETS = [
  "capability_api",
  "provider_tool_fence",
  "frontend_state",
] as const;
export type CapabilityPublishTarget = (typeof CAPABILITY_PUBLISH_TARGETS)[number];

/** 发布目标适配器（真实接线由调用方注入；核心无副作用）。 */
export interface CapabilityPublishAdapter {
  readonly target: CapabilityPublishTarget;
  /** 应用 next 配置；返回 !ok 表示该节点无法应用（→ 整次回滚）。 */
  apply(next: CapabilityConfigV1): { ok: boolean; error?: string };
  /** 整次回滚时对该节点撤销到 previous 配置。 */
  rollback(previous: CapabilityConfigV1): void;
}

export interface AtomicCapabilityChangeResult {
  ok: boolean;
  /** 成功 = 新配置；失败 = 原配置（整次回滚，01-7 §7）。 */
  config: CapabilityConfigV1;
  /** 成功 = 新 revision；失败 = 原 revision。 */
  revision: number;
  /** 本次实际变更状态的 capability（空 = 无状态变化）。 */
  changedCapabilities: readonly CapabilityId[];
  /** 已成功应用的发布目标（失败时用于诊断回滚范围）。 */
  appliedTargets: readonly CapabilityPublishTarget[];
  failureReason?: string;
}

/** 构造 disabled 状态（闭包关闭用）。 */
export function makeDisabledState(
  policyVersion: string,
  reason: string,
): CapabilityStateV1 {
  return { status: "disabled", reason, policyVersion };
}

/** 构造 enabled 状态。 */
export function makeEnabledState(policyVersion: string): CapabilityStateV1 {
  return { status: "enabled", policyVersion };
}

/**
 * 单 config revision 原子发布（01-7 §7）：同一 revision 同时更新 capability
 * API（states）、Provider/tool fence 与前台状态；任一节点无法应用则整次配置
 * 变更回滚（对已应用节点逐个 rollback，返回原配置、原 revision、ok=false）。
 * 发布前先校验 next 配置合法——非法配置拒绝发布（运行中从不暴露非法 flag
 * 组合）。
 */
export function applyAtomicCapabilityChange(
  config: CapabilityConfigV1,
  nextStates: CapabilityStatesV1,
  adapters: readonly CapabilityPublishAdapter[],
): AtomicCapabilityChangeResult {
  const illegal = validateConfigLegal({ ...config, states: nextStates });
  if (illegal.length > 0) {
    return {
      ok: false,
      config,
      revision: config.revision,
      changedCapabilities: [],
      appliedTargets: [],
      failureReason: `非法配置拒绝发布：${illegal.join("；")}`,
    };
  }
  const changed = CAPABILITY_IDS.filter((id) => nextStates[id] !== config.states[id]);
  const nextConfig: CapabilityConfigV1 = {
    ...config,
    revision: config.revision + 1,
    states: nextStates,
  };
  const applied: CapabilityPublishTarget[] = [];
  for (const adapter of adapters) {
    // security_review MEDIUM #2 修复：adapter.apply 抛异常同样视为节点失败，
    // 必须对已成功节点回滚，保证"任一节点失败整次回滚"的原子性承诺。
    let result: { ok: boolean; error?: string };
    try {
      result = adapter.apply(nextConfig);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      // 任一节点无法应用 → 整次回滚：对已成功节点撤销到原配置。
      for (const appliedAdapter of adapters.slice(0, applied.length)) {
        try {
          appliedAdapter.rollback(config);
        } catch {
          // 回滚自身失败不掩盖原始失败（原始 failureReason 已记录）
        }
      }
      return {
        ok: false,
        config,
        revision: config.revision,
        changedCapabilities: [],
        appliedTargets: applied,
        failureReason: `节点 ${adapter.target} 无法应用：${result.error ?? "未知错误"}（整次回滚）`,
      };
    }
    applied.push(adapter.target);
  }
  return {
    ok: true,
    config: nextConfig,
    revision: nextConfig.revision,
    changedCapabilities: changed,
    appliedTargets: applied,
  };
}

/**
 * 运行中关闭 root capability（01-7 §6/§7）：先计算反向依赖闭包
 * （`atomicOffClosure`：target + Must 反向闭包 + 原子子能力 + 依赖 Should），
 * 再以同一 config revision 原子发布到 capability API、Provider/tool fence 与
 * 前台状态。任一节点无法应用 → 整次回滚（返回原配置）。
 */
export function closeRootCapability(
  config: CapabilityConfigV1,
  target: MustBundleCapabilityId,
  adapters: readonly CapabilityPublishAdapter[],
): AtomicCapabilityChangeResult {
  const closure = atomicOffClosure(target);
  const nextStates = { ...config.states } as CapabilityStatesV1;
  for (const id of closure) {
    nextStates[id] = makeDisabledState(
      config.policyVersion,
      `root capability ${target} 关闭（原子闭包）`,
    );
  }
  return applyAtomicCapabilityChange(config, nextStates, adapters);
}

/**
 * 便利 helper：构造三个标准发布目标适配器（capability API / Provider/tool
 * fence / 前台状态）。默认行为是**只记录**（纯逻辑核心），真实接线由调用方在
 * apply/rollback 中对接 DB 事务、Provider fence 与前台状态推送。返回的适配器
 * 可被替换为任意自定义实现。
 */
export function createDefaultPublishAdapters(): readonly CapabilityPublishAdapter[] {
  return CAPABILITY_PUBLISH_TARGETS.map((target) => ({
    target,
    apply: () => ({ ok: true }),
    rollback: () => {},
  }));
}

// 导出常量便于测试与文档对账。
export { DEFAULT_CAPABILITY_POLICY_VERSION };
