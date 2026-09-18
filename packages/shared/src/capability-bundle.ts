/**
 * 阶段 10（W9）任务 10-1：capability bundle 契约（§18.1 / 冻结记录 01-7）。
 *
 * 单一事实来源（Frozen）：
 * - **capability 枚举**（01-7 §2 Flag 列表 + 内部原子能力）：9 个 Must bundle
 *   flag、3 个 Should flag，以及 6 个内部原子能力（scene / critic / commit /
 *   map / projection / grounded_answer_critic）。内部原子能力不是 rollout flag，
 *   是 bundle 原子内容与非法组合校验所需的原子（01-7 §4/§5）。
 * - **bundle graph 依赖边**（01-7 §4 原子内容与依赖）：直接 requires 边，传递
 *   闭包由部署层计算；`MUST_BUNDLE_DEPENDENCY_EDGES` 只含 Must 之间的边，
 *   保证 01-7 §6 两个根关闭闭包与冻结记录逐字节一致。
 * - **原子包含**（01-7 §4「原子包含…不可拆分」）：bundle → 其内部原子子能力，
 *   用于「bundle 开而原子子能力关」的非法组合校验。
 * - **CapabilityState**：`enabled / degraded / disabled + reason + policyVersion`
 *   （01-7 §5「capability API 返回 enabled / degraded / disabled + reason +
 *   policyVersion」）；`CapabilityConfigV1` 为单 config revision 原子发布的
 *   契约（01-7 §7），zod strict。
 *
 * 依赖说明：bundle 图是**确定性**的（数组顺序即固定遍历顺序），当前 API/UI
 * 只把它作为能力合同与投影输入；禁止在本文件之外扩展依赖边。
 *
 * zod schema 风格与 packages/shared/src/schemas.ts 保持一致（z.object +
 * .strict + z.infer）。
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// 一、capability 枚举（01-7 §2 Flag 列表 + §4/§5 内部原子能力）
// ═══════════════════════════════════════════════════════════════════════════

/** Must capability bundle flag（01-7 §2，W0 冻结；public-beta 默认集合）。 */
export const MUST_BUNDLE_CAPABILITY_IDS = [
  "trusted_multimodal_core",
  "global_companion_shell",
  "companion_onboarding_v1",
  "learning_run_companion",
  "multimodal_voice",
  "structured_proof_v1",
  "journey_routes",
  "understanding_universe_v2",
  "current_target_tutor",
] as const;
export type MustBundleCapabilityId = (typeof MUST_BUNDLE_CAPABILITY_IDS)[number];

/** Should capability bundle flag（01-7 §2；主列车外独立 shadow/canary）。 */
export const SHOULD_BUNDLE_CAPABILITY_IDS = [
  "learning_question_markers",
  "semantic_relationships",
  "tutor_workspace_expansion",
  /** Plan 23 W0-09：Objective 系统原子切流 bundle（默认 OFF，无行为变化）。 */
  "learning_objective_system_v3",
] as const;
export type ShouldBundleCapabilityId = (typeof SHOULD_BUNDLE_CAPABILITY_IDS)[number];

/**
 * 内部原子能力（01-7 §4 原子内容 / §5 非法组合校验原子）。
 * 不是独立 rollout flag：由所属 bundle 原子包含，但配置状态独立记录，用于
 * 「Scene 开而 Critic/commit 关」「map 开而 projection 关」「Tutor 开而
 * Grounded Answer Critic 关」等组合校验。
 */
export const INTERNAL_ATOMIC_CAPABILITY_IDS = [
  "scene",
  "critic",
  "commit",
  "map",
  "projection",
  "grounded_answer_critic",
] as const;
export type InternalAtomicCapabilityId = (typeof INTERNAL_ATOMIC_CAPABILITY_IDS)[number];

/** 全部 capability（Must + Should + 内部原子）。 */
export const CAPABILITY_IDS = [
  ...MUST_BUNDLE_CAPABILITY_IDS,
  ...SHOULD_BUNDLE_CAPABILITY_IDS,
  ...INTERNAL_ATOMIC_CAPABILITY_IDS,
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** zod strict enum schema：capability id。 */
export const capabilityIdSchema = z.enum(CAPABILITY_IDS);
/** zod strict enum schema：Must bundle flag。 */
export const mustBundleCapabilityIdSchema = z.enum(MUST_BUNDLE_CAPABILITY_IDS);
/** zod strict enum schema：Should bundle flag。 */
export const shouldBundleCapabilityIdSchema = z.enum(SHOULD_BUNDLE_CAPABILITY_IDS);
/** zod strict enum schema：内部原子能力。 */
export const internalAtomicCapabilityIdSchema = z.enum(INTERNAL_ATOMIC_CAPABILITY_IDS);

/** 类型守卫：是否合法 capability id。 */
export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

/** 类型守卫：是否 Must bundle flag。 */
export function isMustBundleCapabilityId(value: string): value is MustBundleCapabilityId {
  return (MUST_BUNDLE_CAPABILITY_IDS as readonly string[]).includes(value);
}

/** 类型守卫：是否 Should bundle flag。 */
export function isShouldBundleCapabilityId(value: string): value is ShouldBundleCapabilityId {
  return (SHOULD_BUNDLE_CAPABILITY_IDS as readonly string[]).includes(value);
}

/** 类型守卫：是否内部原子能力。 */
export function isInternalAtomicCapabilityId(value: string): value is InternalAtomicCapabilityId {
  return (INTERNAL_ATOMIC_CAPABILITY_IDS as readonly string[]).includes(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、bundle graph 依赖边（01-7 §4 原子内容与依赖；冻结）
// ═══════════════════════════════════════════════════════════════════════════

/** 直接依赖边（required capability closure 由传递闭包计算）。 */
export interface CapabilityDependencyEdge {
  capability: CapabilityId;
  /** 直接依赖（完整图含内部原子；`requires` 全部为合法 capability id）。 */
  requires: readonly CapabilityId[];
}

/**
 * 完整依赖图（Must + Should + 内部原子）：
 * - 非法组合（§18.1 / 01-7 §5）由该图推导：
 *   - onboarding 开而 global shell 关（companion_onboarding_v1 requires shell）；
 *   - LearningRun Companion 开而 trusted core 关（learning_run_companion requires core）；
 *   - Scene 开而 Critic/commit 关（scene requires critic, commit）；
 *   - map 开而 projection 关（map requires projection）；
 *   - Tutor 开而 Grounded Answer Critic 关（current_target_tutor requires GAC）。
 * - 无环（自检在部署层断言）。
 */
export const CAPABILITY_DEPENDENCY_EDGES: readonly CapabilityDependencyEdge[] = [
  { capability: "trusted_multimodal_core", requires: [] },
  { capability: "global_companion_shell", requires: [] },
  { capability: "companion_onboarding_v1", requires: ["global_companion_shell"] },
  {
    capability: "learning_run_companion",
    requires: ["global_companion_shell", "trusted_multimodal_core"],
  },
  { capability: "multimodal_voice", requires: ["trusted_multimodal_core"] },
  { capability: "structured_proof_v1", requires: ["trusted_multimodal_core", "scene"] },
  { capability: "journey_routes", requires: ["trusted_multimodal_core"] },
  { capability: "understanding_universe_v2", requires: ["trusted_multimodal_core", "projection"] },
  {
    capability: "current_target_tutor",
    requires: ["learning_run_companion", "trusted_multimodal_core", "grounded_answer_critic"],
  },
  { capability: "learning_question_markers", requires: [] },
  { capability: "semantic_relationships", requires: [] },
  { capability: "tutor_workspace_expansion", requires: ["trusted_multimodal_core", "grounded_answer_critic"] },
  {
    // Plan 23 W0-09：Objective 系统（Surface/Dashboard/Topology V3）原子切流 bundle。
    capability: "learning_objective_system_v3",
    requires: ["trusted_multimodal_core"],
  },
  { capability: "scene", requires: ["critic", "commit"] },
  { capability: "critic", requires: ["trusted_multimodal_core"] },
  { capability: "commit", requires: ["trusted_multimodal_core"] },
  { capability: "map", requires: ["projection"] },
  { capability: "projection", requires: ["trusted_multimodal_core"] },
  { capability: "grounded_answer_critic", requires: ["trusted_multimodal_core"] },
];

/**
 * Must bundle 依赖图（只含 Must 之间的边，用于 01-7 §6 根关闭闭包）：
 * 反向依赖闭包在该图上计算，保证与冻结记录逐字节一致——
 * `global_companion_shell off → companion_onboarding_v1 → learning_run_companion
 * → current_target_tutor`；
 * `trusted_multimodal_core off → learning_run_companion → multimodal_voice →
 * structured_proof_v1 → journey_routes → understanding_universe_v2 →
 * current_target_tutor`。
 * Should flags 独立（01-7 §4），不出现在任何 Must 关闭闭包内。
 */
export const MUST_BUNDLE_DEPENDENCY_EDGES: readonly CapabilityDependencyEdge[] = [
  { capability: "trusted_multimodal_core", requires: [] },
  { capability: "global_companion_shell", requires: [] },
  { capability: "companion_onboarding_v1", requires: ["global_companion_shell"] },
  {
    capability: "learning_run_companion",
    requires: ["global_companion_shell", "trusted_multimodal_core"],
  },
  { capability: "multimodal_voice", requires: ["trusted_multimodal_core"] },
  { capability: "structured_proof_v1", requires: ["trusted_multimodal_core"] },
  { capability: "journey_routes", requires: ["trusted_multimodal_core"] },
  { capability: "understanding_universe_v2", requires: ["trusted_multimodal_core"] },
  {
    capability: "current_target_tutor",
    requires: ["learning_run_companion", "trusted_multimodal_core"],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 三、原子包含（01-7 §4「原子包含…不可拆分」；bundle → 内部原子子能力）
// ═══════════════════════════════════════════════════════════════════════════

/** 原子包含关系：bundle 开则其原子子能力必须开（不可拆分）。 */
export interface CapabilityAtomicContainment {
  bundle: CapabilityId;
  contains: readonly CapabilityId[];
}

export const CAPABILITY_ATOMIC_CONTAINMENT: readonly CapabilityAtomicContainment[] = [
  { bundle: "trusted_multimodal_core", contains: ["critic", "commit"] },
  { bundle: "structured_proof_v1", contains: ["scene"] },
  { bundle: "understanding_universe_v2", contains: ["projection", "map"] },
  { bundle: "current_target_tutor", contains: ["grounded_answer_critic"] },
];

// ═══════════════════════════════════════════════════════════════════════════
// 四、CapabilityState 与单 config revision 配置契约（01-7 §5/§7；zod strict）
// ═══════════════════════════════════════════════════════════════════════════

/** capability 状态：enabled / degraded / disabled（01-7 §5）。 */
export const capabilityStatusSchema = z.enum(["enabled", "degraded", "disabled"]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

/** 单个 capability 状态：status + reason + policyVersion。 */
export const capabilityStateV1Schema = z
  .object({
    status: capabilityStatusSchema,
    /** degraded/disabled 必须携带原因；enabled 可为空。 */
    reason: z.string().min(1).max(500).optional(),
    /** 该状态归属的冻结 policy 版本（= config.policyVersion）。 */
    policyVersion: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.status !== "enabled" && (state.reason === undefined || state.reason.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "degraded/disabled capability 必须携带 reason",
        path: ["reason"],
      });
    }
  });
export type CapabilityStateV1 = z.infer<typeof capabilityStateV1Schema>;

/** capability 状态表（全部 capability 一一对应；zod record 推断）。 */
export const capabilityStatesV1Schema = z.record(capabilityIdSchema, capabilityStateV1Schema);
export type CapabilityStatesV1 = z.infer<typeof capabilityStatesV1Schema>;

/**
 * 控制面配置（01-7 §7 单 config revision 原子发布契约）。
 * 同一 revision 同时更新 capability API、Provider/tool fence 与前台状态；
 * 任一节点无法应用则整次配置变更回滚。
 */
export const capabilityConfigV1Schema = z
  .object({
    /** 单一 config revision（每次原子变更 +1）。 */
    revision: z.number().int().min(0),
    /** 冻结 policy 版本。 */
    policyVersion: z.string().min(1).max(200),
    /** learningRuntimeEpoch：hard rollback 提升；每次外部调用/落库前与 contract 快照对账。 */
    epoch: z.number().int().min(0),
    states: capabilityStatesV1Schema,
  })
  .strict();
export type CapabilityConfigV1 = z.infer<typeof capabilityConfigV1Schema>;

/** 冻结 policy 版本（01-7，W0 冻结 capability bundle）。 */
export const DEFAULT_CAPABILITY_POLICY_VERSION = "capability-bundles-v1" as const;

/**
 * 构造基准配置（helper；可注入覆盖）。默认全部 capability enabled。
 * `overrides` 提供 `{ status, reason? }` 或直接完整状态对象。
 */
export function createCapabilityConfig(
  opts: {
    revision?: number;
    epoch?: number;
    policyVersion?: string;
    overrides?: Readonly<
      Partial<Record<CapabilityId, Pick<CapabilityStateV1, "status"> & Partial<Pick<CapabilityStateV1, "reason">>>>
    >;
  } = {},
): CapabilityConfigV1 {
  const policyVersion = opts.policyVersion ?? DEFAULT_CAPABILITY_POLICY_VERSION;
  const states = {} as CapabilityStatesV1;
  for (const id of CAPABILITY_IDS) {
    const override = opts.overrides?.[id];
    states[id] = {
      status: override?.status ?? "enabled",
      reason: override?.reason,
      policyVersion,
    };
  }
  return {
    revision: opts.revision ?? 1,
    policyVersion,
    epoch: opts.epoch ?? 0,
    states,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、contract snapshot 与 capability API 视图（01-7 §5/§7；zod strict）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * contract 能力快照（Episode/调用方签发时冻结）：外部 tool/Provider 调用及结果
 * 落库前，用当前配置重新验证其 required capability closure 与 runtime epoch。
 */
export const capabilityContractSnapshotV1Schema = z
  .object({
    /** 签发时的 config revision。 */
    revision: z.number().int().min(0),
    /** 签发时的 runtime epoch（learningRuntimeEpoch）。 */
    epoch: z.number().int().min(0),
    /** 该 contract 的 required capabilities（部署层展开为传递闭包后校验）。 */
    requiredCapabilities: z.array(capabilityIdSchema).min(1).max(64),
  })
  .strict();
export type CapabilityContractSnapshotV1 = z.infer<typeof capabilityContractSnapshotV1Schema>;

/** capability API 视图（authenticated Web 读取；未登录读服务端签名 manifest）。 */
export const capabilityApiViewV1Schema = z
  .object({
    revision: z.number().int().min(0),
    policyVersion: z.string().min(1).max(200),
    epoch: z.number().int().min(0),
    capabilities: capabilityStatesV1Schema,
  })
  .strict();
export type CapabilityApiViewV1 = z.infer<typeof capabilityApiViewV1Schema>;
