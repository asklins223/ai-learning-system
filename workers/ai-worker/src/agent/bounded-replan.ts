/**
 * P3-3: Bounded Replan + Artifact 三分类复用(实施计划 §3.2)。
 *
 * **Replan 边界**(违反任一即拒绝该 Replan 提案):
 * - 只允许调整:未完成 Bundle、有限补查、修改 Specialist、增加相关 Bundle Context、
 *   调整 Extraction Focus;
 * - **不得**:重置 Run、自动增预算、清除已验证 Artifact、无条件重跑全部 Specialist。
 *
 * **防死循环**:Replan 次数不设硬上限,由 run 级预算(maxProviderCalls/runDeadline/token 上限)
 * 与自旋检测兜底(见 §9-1;budget.ts 角色级 maxTurns/maxToolCalls 不作执行检查)。
 */

export type ArtifactReuseKind = "validated_and_unaffected" | "validated_but_referenced" | "invalid_or_affected";

export interface ReplanViolation {
  code: string;
  message: string;
}

/** §3.2 Replan 允许调整的维度 */
export type ReplanAdjustmentType =
  | "adjust_unfinished_bundle"
  | "bounded_refetch"
  | "change_specialist"
  | "add_bundle_context"
  | "adjust_extraction_focus";

/** Replan 提案:仅含调整项,不含重置/增预算/清 Artifact 类动作 */
export interface ReplanProposal {
  adjustments: Array<{
    type: ReplanAdjustmentType;
    bundleId?: string;
    detail: string;
  }>;
  /** Replan Version(单调递增,入 inputHash 保证重跑不命中旧缓存) */
  version: number;
}

/** 单次 Replan 提案的调整条数上限(security_review LOW:防未来 LLM 输入放大) */
export const MAX_REPLAN_ADJUSTMENTS = 20;
/** 单条 detail 长度上限 */
export const MAX_REPLAN_ADJUSTMENT_DETAIL_LENGTH = 500;

// ─── Replan 边界校验 ─────────────────────────────────────────────────────

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; code: string; message: string }> = [
  { pattern: /重置\s*run|reset\s*run|重新开始整个|restart|从头再来|重新开始一次|整体重来/i, code: "forbid_reset_run", message: "Replan 不得重置 Run" },
  { pattern: /增加预算|提高.{0,6}(上限|预算)|加大.{0,6}(上限|预算)|extend.{0,6}(cap|budget)|raise.{0,6}(cap|budget)|bump.{0,6}(cap|budget)|(上限|预算).{0,4}(提到|调到|调高|调大|提高到|增加|加大)|maxProviderCalls.{0,8}(增加|提高|加大|raise|extend|bump|increase)/i, code: "forbid_increase_budget", message: "Replan 不得自动增预算" },
  { pattern: /清除.{0,6}(artifact|已验证)|清空.{0,6}(artifact|已验证)|删除.{0,8}(artifact|已验证)|wipe.{0,6}(artifact|everything|validated|cache)|delete.{0,6}validated/i, code: "forbid_clear_artifact", message: "Replan 不得清除已验证 Artifact" },
  { pattern: /(全部|所有|所有.{0,6}都|每个).{0,12}重跑|重跑(所有|全部)|rerun all|re-run all|重跑所有 specialist/i, code: "forbid_rerun_all", message: "Replan 不得无条件重跑全部 Specialist" },
];

/**
 * 校验 Replan 提案是否在 §3.2 边界内。
 * 返回 violations(空数组 = 通过)。纯函数。
 */
export function validateReplanProposal(proposal: ReplanProposal): ReplanViolation[] {
  const violations: ReplanViolation[] = [];
  const joined = proposal.adjustments.map((a) => `${a.type}:${a.detail}`).join(" ");

  for (const f of FORBIDDEN_PATTERNS) {
    if (f.pattern.test(joined)) {
      violations.push({ code: f.code, message: f.message });
    }
  }

  // 调整项必须非空且均在允许维度内
  if (proposal.adjustments.length === 0) {
    violations.push({ code: "empty_adjustments", message: "Replan 提案为空(无事可做却要求 Replan)" });
  }
  if (proposal.adjustments.length > MAX_REPLAN_ADJUSTMENTS) {
    violations.push({ code: "too_many_adjustments", message: `Replan 调整项超过上限 ${MAX_REPLAN_ADJUSTMENTS}` });
  }
  const allowed: ReplanAdjustmentType[] = [
    "adjust_unfinished_bundle",
    "bounded_refetch",
    "change_specialist",
    "add_bundle_context",
    "adjust_extraction_focus",
  ];
  for (const a of proposal.adjustments) {
    if (!allowed.includes(a.type)) {
      violations.push({ code: "invalid_adjustment_type", message: `不允许的调整类型 ${a.type}` });
    }
    if (a.detail.length > MAX_REPLAN_ADJUSTMENT_DETAIL_LENGTH) {
      violations.push({ code: "adjustment_detail_too_long", message: `调整 detail 超过上限 ${MAX_REPLAN_ADJUSTMENT_DETAIL_LENGTH}` });
    }
  }
  return violations;
}

// ─── Artifact 三分类复用(§3.2 表格) ─────────────────────────────────────

export interface ReuseDecision {
  kind: ArtifactReuseKind;
  /** invalid_or_affected 时:重新执行 Specialist(不重跑 Provider 的复用方不需要) */
  rerunSpecialist: boolean;
}

/**
 * 三分类复用规则(§3.2):
 * - validated_and_unaffected  → 直接复用,不重新调用 Provider;
 * - validated_but_referenced  → 允许 Compose/Replan 读取,不默认重提取;
 * - invalid_or_affected       → 创建新 Specialist Unit(inputHash 含 Replan Version)。
 *
 * @param validated 该 bundle 的 Artifact 是否已验证(VERIFY/质量门禁通过)
 * @param referenced 是否被 Compose/Replan 读取(被读取 ≠ 重提取)
 * @param affected 是否受本次 Gap/调整影响(affectedBundleIds)
 */
export function classifyArtifactReuse(
  validated: boolean,
  referenced: boolean,
  affected: boolean,
): ReuseDecision {
  if (!validated || affected) {
    // 未验证或受影响:重跑 Specialist(新 unit,inputHash 含 Replan Version)
    return { kind: "invalid_or_affected", rerunSpecialist: true };
  }
  if (referenced) {
    // 已验证但被引用:可读,不默认重提取
    return { kind: "validated_but_referenced", rerunSpecialist: false };
  }
  return { kind: "validated_and_unaffected", rerunSpecialist: false };
}

/** inputHash 追加 Replan Version(保证重跑不命中旧 unit 缓存) */
export function inputHashWithReplanVersion(inputHash: string, replanVersion: number): string {
  if (replanVersion <= 1) return inputHash;
  return `${inputHash}:rv${replanVersion}`;
}
