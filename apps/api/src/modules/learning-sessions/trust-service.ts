/**
 * trust-service.ts（阶段 04 / W3，任务 04-3）
 *
 * 服务端 Artifact Trust、EpisodeTrustDecision 与 reducer（01-2 §7.3/§7.4，
 * 04-w3 任务 04-3）。全部为纯函数：不读时钟、不改状态、不调外部服务。
 *
 * 核心不变量（验收）：
 * - Agent 只能请求 requestedTrustClass；Scene policy 冻结 templateTrustCeiling；
 *   客户端/Agent 不能提交或覆盖 effective 值 → computeEffectiveTrustClass 只从
 *   服务端事实推导，永不读取任何客户端提供的 effective 字段；
 * - EpisodeTrustDecision 由服务端签发（issueEpisodeTrustDecision），decisionHash
 *   对冻结字段确定性哈希（sourceArtifactIds/reasonCodes 排序幂等）→ 同 artifact
 *   重放 hash 一致（verifyEpisodeTrustDecision 可重建校验）；
 * - rubric-session-reducer-v2 输出 pass | partial | fail | not_assessable，由
 *   validation/review domain adapter 再映射 canonical outcome（本文件不映射）；
 * - facet-to-mastery-policy-v1 七条固定规则（01-2 §8.3）在 applyFacetToMasteryPolicy
 *   实现：assisted/stale 结果 0 升级、0 延长 interval；
 * - 多 artifact 只消费 content assistance 前、effective trusted 且 locked 的
 *   bindings；practice artifact 不参与正式归约（artifactEligibilityFilter）。
 *
 * 收口迁移说明：EpisodeTrustDecision / RubricAssessment / ReducerResult /
 * RubricSessionResult 的单一来源契约位于
 * packages/shared/src/learning-trust-contracts.ts，当前 @ailearn/shared 的
 * packages/shared/src/index.ts 尚未 re-export 该模块（由主代理统一收口追加），
 * 故本文件本地声明同型接口（structural 兼容）。主代理收口后应改为
 * `import { EpisodeTrustDecision, ReducerResult, ... } from "@ailearn/shared"`。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import { DomainError, RubricVerdict, TrustClass } from "@ailearn/shared";

// ─── 本地契约类型（收口迁移至 @ailearn/shared/learning-trust-contracts）────

export const RubricSessionResult = {
  PASS: "pass",
  PARTIAL: "partial",
  FAIL: "fail",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type RubricSessionResult =
  (typeof RubricSessionResult)[keyof typeof RubricSessionResult];

export const RUBRIC_SESSION_REDUCER_VERSION = "rubric-session-reducer-v2" as const;

export interface ReducerResult {
  result: RubricSessionResult;
  weightedCoverage: number;
  hasContradiction: boolean;
  allRequiredCovered: boolean;
  missingRequired: boolean;
  notAssessableRequired: boolean;
  reducerVersion: typeof RUBRIC_SESSION_REDUCER_VERSION;
  invariantViolation: boolean;
  reasonCodes: string[];
}

export interface RubricAssessmentResponseBinding {
  responseArtifactId: string;
  answerExcerpt?: string;
  interactionRefs?: string[];
}

export interface RubricAssessment {
  rubricItemId: string;
  verdict: RubricVerdict;
  responseBindings: RubricAssessmentResponseBinding[];
  evidenceRefIds: string[];
  assessmentSource: "deterministic" | "critic" | "user_declared_unable";
  rationale: string;
  confidence: number;
}

export interface EpisodeTrustDecision {
  episodeId: string;
  effectiveClass: TrustClass;
  sourceArtifactIds: string[];
  frozenProbeSetHash: string;
  requiredRubricCoverageHash: string;
  bundlePolicyVersion?: string;
  assistanceSnapshotHash: string;
  reasonCodes: string[];
  decisionHash: string;
}

// ─── 确定性哈希原语（与 session-service/canonical-events 同模式）───────────

/** 稳定化 JSON 序列化：对象键排序（递归）、数组保序、undefined 属性跳过。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(",")}}`;
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// ─── Trust Class 保守度（01-2 §7.3）───────────────────────────────────────

/** 保守度排序：not_assessable 最保守（0）→ mastery_eligible 最高（4）。 */
const TRUST_RANK: Record<TrustClass, number> = {
  [TrustClass.NOT_ASSESSABLE]: 0,
  [TrustClass.PRACTICE_ONLY]: 1,
  [TrustClass.DIAGNOSTIC_ONLY]: 2,
  [TrustClass.FACET_ELIGIBLE]: 3,
  [TrustClass.MASTERY_ELIGIBLE]: 4,
};

/** 取一组 TrustClass 中最保守（等级最低）者；空输入 fail closed 为 not_assessable。 */
export function mostConservativeTrustClass(classes: readonly TrustClass[]): TrustClass {
  if (classes.length === 0) return TrustClass.NOT_ASSESSABLE;
  let min = classes[0] ?? TrustClass.NOT_ASSESSABLE;
  for (const c of classes) {
    if (TRUST_RANK[c] < TRUST_RANK[min]) min = c;
  }
  return min;
}

// ─── 1. computeEffectiveTrustClass（服务端 lock 时签发）────────────────────

export interface EffectiveTrustInput {
  /** Agent 唯一可请求的等级（永不作为最终值直接落库） */
  requestedTrustClass: TrustClass;
  /** Scene policy 冻结的 templateTrustCeiling（FrozenProbeRef） */
  templateTrustCeiling: TrustClass;
  /** disclosureProfile 允许证明的最高等级（01-2 §3.2/§6.3） */
  disclosureMaxProvable: TrustClass;
  /** formalPlan.kind 允许的最高等级（practice→practice_only，facet_only→facet_eligible） */
  planKindCeiling: TrustClass;
  /** content assistance 已激活（assistance 先赢或 lock 前已 contentAssisted） */
  assistanceActivated: boolean;
  /** 操作次数超过 Scene 最大上限 / 反复试对（01-2 §6.4 降级） */
  attemptsExceeded: boolean;
  /** 关键输入不可靠（ASR 低置信、契约不完整）→ not_assessable */
  inputUnreliable: boolean;
  /** integrity 失败：任一 hash 失配 / 非 locked / private solution 缺失 */
  integrityFailure: boolean;
  /** episode target fingerprint 失配 → stale */
  stale: boolean;
}

/**
 * 服务端 lock 时按 disclosure、attempts、assistance、stale 和 integrity 计算
 * 单 Artifact 最保守 effectiveTrustClass。多条件取最低等级：
 * - stale / integrityFailure / inputUnreliable → not_assessable（fail closed，无正式副作用）；
 * - assistanceActivated / attemptsExceeded → practice_only（0 升级）；
 * - 其余取 requested / ceiling / disclosure / planKind 中最保守者。
 * 本函数不接收、也不读取任何客户端提交的 effective 值。
 */
export function computeEffectiveTrustClass(input: EffectiveTrustInput): TrustClass {
  if (input.stale || input.integrityFailure || input.inputUnreliable) {
    return TrustClass.NOT_ASSESSABLE;
  }
  const candidates: TrustClass[] = [
    input.requestedTrustClass,
    input.templateTrustCeiling,
    input.disclosureMaxProvable,
    input.planKindCeiling,
  ];
  if (input.assistanceActivated || input.attemptsExceeded) {
    candidates.push(TrustClass.PRACTICE_ONLY);
  }
  return mostConservativeTrustClass(candidates);
}

// ─── 2. issueEpisodeTrustDecision（服务端签发，01-2 §6.3）──────────────────

export interface IssueEpisodeTrustDecisionInput {
  episodeId: string;
  effectiveClass: TrustClass;
  sourceArtifactIds: readonly string[];
  frozenProbeSetHash: string;
  requiredRubricCoverageHash: string;
  bundlePolicyVersion?: string;
  assistanceSnapshotHash: string;
  reasonCodes: readonly string[];
}

const EPISODE_TRUST_HASH_PREFIX = "episode-trust-v1:";

/** 计算 EpisodeTrustDecision 的 decisionHash（不含 decisionHash 字段本身）。
 *  暴露为独立纯函数以便验证与重放。 */
export function computeEpisodeTrustDecisionHash(
  decision: Omit<EpisodeTrustDecision, "decisionHash">,
): string {
  const canonical = {
    ...decision,
    sourceArtifactIds: sortIds(decision.sourceArtifactIds),
    reasonCodes: sortIds(decision.reasonCodes),
  };
  return sha256Hex(EPISODE_TRUST_HASH_PREFIX + stableStringify(canonical));
}

/**
 * 服务端签发 EpisodeTrustDecision。decisionHash 由冻结字段确定性推导
 * （sourceArtifactIds / reasonCodes 排序幂等）→ 相同冻结输入 → 相同 hash，
 * 同 artifact 重放 hash 一致。客户端/Agent 不能签发或覆盖该记录。
 */
export function issueEpisodeTrustDecision(
  input: IssueEpisodeTrustDecisionInput,
): EpisodeTrustDecision {
  const decision: Omit<EpisodeTrustDecision, "decisionHash"> = {
    episodeId: input.episodeId,
    effectiveClass: input.effectiveClass,
    sourceArtifactIds: sortIds(input.sourceArtifactIds),
    frozenProbeSetHash: input.frozenProbeSetHash,
    requiredRubricCoverageHash: input.requiredRubricCoverageHash,
    assistanceSnapshotHash: input.assistanceSnapshotHash,
    reasonCodes: sortIds(input.reasonCodes),
  };
  if (input.bundlePolicyVersion !== undefined) {
    decision.bundlePolicyVersion = input.bundlePolicyVersion;
  }
  return { ...decision, decisionHash: computeEpisodeTrustDecisionHash(decision) };
}

/** 重建校验 decisionHash 是否与冻结字段一致（COMMIT 前重放校验）。 */
export function verifyEpisodeTrustDecision(decision: EpisodeTrustDecision): boolean {
  const { decisionHash, ...rest } = decision;
  return computeEpisodeTrustDecisionHash(rest) === decisionHash;
}

// ─── 3. runRubricSessionReducer（01-2 §8.4 四态纯函数）─────────────────────

export interface RubricSessionItemInput {
  rubricItemId: string;
  verdict: RubricVerdict;
  weight: number; // 1 | 2 | 3
  required: boolean;
}

export const RUBRIC_SESSION_COVERAGE_THRESHOLD = 0.7;

export const REDUCER_REASON = {
  CONTRADICTED: "contradicted_present",
  REQUIRED_NOT_ASSESSABLE: "required_not_assessable",
  ALL_UNASSESSED: "all_items_unassessed",
  REQUIRED_MISSING: "required_missing",
  COVERAGE_BELOW_THRESHOLD: "coverage_below_threshold",
  ALL_REQUIRED_COVERED: "all_required_covered",
  PARTIAL_ASSESSED: "partial_assessed",
  INVARIANT_VIOLATION: "reducer_invariant_violation",
} as const;

export class ReducerError extends DomainError {
  declare readonly code: "empty_rubric" | "invalid_verdict" | "invalid_weight" | "no_required_item";
  constructor(
    code: "empty_rubric" | "invalid_verdict" | "invalid_weight" | "no_required_item",
  ) {
    super({ name: "ReducerError", code, message: code, statusCode: 500 });
  }
}

const RUBRIC_VERDICT_VALUES = new Set<string>(Object.values(RubricVerdict));

function validateReducerItems(items: readonly RubricSessionItemInput[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ReducerError("empty_rubric");
  }
  const hasRequired = items.some((item) => item.required);
  if (!hasRequired) {
    throw new ReducerError("no_required_item");
  }
  for (const item of items) {
    if (!RUBRIC_VERDICT_VALUES.has(item.verdict)) {
      throw new ReducerError("invalid_verdict");
    }
    if (!Number.isInteger(item.weight) || item.weight < 1 || item.weight > 3) {
      throw new ReducerError("invalid_weight");
    }
  }
}

/**
 * rubric-session-reducer-v2：对冻结 rubric 的逐项 assessment verdict 做四态归约。
 *
 * 规则总序（全部组合 fail closed，绝无未命中分支）：
 * 1. 任一 item（required 或 optional）为 contradicted → fail；
 * 2. 任一 required 为 not_assessable → not_assessable（fail closed，可无损重试）；
 * 3. 全部 item 均为 missing | not_assessable → not_assessable（无法评估）；
 * 4. 任一 required 为 missing → fail；
 * 5. 全部 required 为 covered 且加权覆盖 ≥ 0.70 → pass；
 * 6. 全部 required 为 covered 但覆盖 < 0.70 → partial；
 * 7. 其余（有已评估内容但 required 未全 covered，如 required 为 partial）→ partial。
 *
 * 输出四态由 validation/review domain adapter 再映射 canonical outcome；confidence
 * 不进入 reducer/mastery（01-2 §9）。
 */
export function runRubricSessionReducer(
  items: readonly RubricSessionItemInput[],
): ReducerResult {
  validateReducerItems(items);

  const hasContradiction = items.some(
    (item) => item.verdict === RubricVerdict.CONTRADICTED,
  );
  const notAssessableRequired = items.some(
    (item) => item.required && item.verdict === RubricVerdict.NOT_ASSESSABLE,
  );
  const allUnassessed = items.every(
    (item) =>
      item.verdict === RubricVerdict.MISSING || item.verdict === RubricVerdict.NOT_ASSESSABLE,
  );
  const missingRequired = items.some(
    (item) => item.required && item.verdict === RubricVerdict.MISSING,
  );
  const allRequiredCovered = items
    .filter((item) => item.required)
    .every((item) => item.verdict === RubricVerdict.COVERED);

  let coveredWeight = 0;
  let partialWeight = 0;
  let totalWeight = 0;
  for (const item of items) {
    totalWeight += item.weight;
    if (item.verdict === RubricVerdict.COVERED) {
      coveredWeight += item.weight;
    } else if (item.verdict === RubricVerdict.PARTIAL) {
      partialWeight += item.weight;
    }
  }
  const weightedCoverage =
    totalWeight > 0 ? (coveredWeight + 0.5 * partialWeight) / totalWeight : 0;

  const base = {
    weightedCoverage,
    hasContradiction,
    allRequiredCovered,
    missingRequired,
    notAssessableRequired,
    reducerVersion: RUBRIC_SESSION_REDUCER_VERSION,
    invariantViolation: false,
  };

  if (hasContradiction) {
    return { ...base, result: RubricSessionResult.FAIL, reasonCodes: [REDUCER_REASON.CONTRADICTED] };
  }
  if (notAssessableRequired) {
    return {
      ...base,
      result: RubricSessionResult.NOT_ASSESSABLE,
      reasonCodes: [REDUCER_REASON.REQUIRED_NOT_ASSESSABLE],
    };
  }
  if (allUnassessed) {
    return {
      ...base,
      result: RubricSessionResult.NOT_ASSESSABLE,
      reasonCodes: [REDUCER_REASON.ALL_UNASSESSED],
    };
  }
  if (missingRequired) {
    return {
      ...base,
      result: RubricSessionResult.FAIL,
      reasonCodes: [REDUCER_REASON.REQUIRED_MISSING],
    };
  }
  if (allRequiredCovered && weightedCoverage >= RUBRIC_SESSION_COVERAGE_THRESHOLD) {
    return {
      ...base,
      result: RubricSessionResult.PASS,
      reasonCodes: [REDUCER_REASON.ALL_REQUIRED_COVERED],
    };
  }
  if (allRequiredCovered) {
    return {
      ...base,
      result: RubricSessionResult.PARTIAL,
      reasonCodes: [REDUCER_REASON.COVERAGE_BELOW_THRESHOLD],
    };
  }
  return {
    ...base,
    result: RubricSessionResult.PARTIAL,
    reasonCodes: [REDUCER_REASON.PARTIAL_ASSESSED],
  };
}

// ─── 4. applyFacetToMasteryPolicy（01-2 §8.3 七条固定规则）─────────────────

export type FormalPlanKind =
  | "voice_mastery"
  | "structured_mastery_bundle"
  | "facet_only"
  | "practice";

export type AuthorizedAction =
  | "create_initial"
  | "consume_pending"
  | "record_only"
  | "no_effect";

/** policy 层允许的唯一 schedule 副作用；"none" 表示 0 写（不消费/不创建/不延长）。
 *  record_only / no_effect 是预冻结授权（01-2 §5.2），本身即「不写 schedule」。 */
export type ScheduleSideEffect = "create_initial" | "consume_pending" | "none";

export interface FacetToMasteryPolicyInput {
  planKind: FormalPlanKind;
  /** 预冻结的调度授权（01-2 §5.2：facet_only 配 record_only，practice 配 no_effect） */
  authorizedAction: AuthorizedAction;
  /** rubric-session-reducer-v2 输出 */
  reducerResult: ReducerResult;
  /** 服务端签发的 EpisodeTrustDecision.effectiveClass */
  effectiveClass: TrustClass;
  /** 是否完整 Episode（全部 required Scene 完成并锁定） */
  episodeComplete: boolean;
  /** 已完成并通过的 required Scene 数（structured_mastery_bundle） */
  completedRequiredSceneCount: number;
  /** required Scene 总数（structured_mastery_bundle） */
  requiredSceneCount: number;
  /** structured-proof-v1 资格：≥2 预冻结互补无中途反馈高区分度场景 + 联合覆盖
   *  全部 required rubric + 跨模态 Gold false-upgrade/false-downgrade Gate */
  structuredProofEligible: boolean;
  /** 等价 Gate 是否通过（false-upgrade/false-downgrade Gate） */
  equivalenceGatePassed: boolean;
  /** bundle 中任一 required Scene 未完成 / stale / assisted / not_assessable / 未通过 */
  anyRequiredSceneBlocked: boolean;
}

export interface FacetToMasteryPolicyVerdict {
  /** 是否允许正式归约写入（facet evidence 或 canonical outcome）；false 仅 support artifact */
  allowed: boolean;
  /** policy 允许的最高 effective trust class（可能被 4/5/7 降级） */
  maxTrustClass: TrustClass;
  /** 唯一允许的 schedule 副作用；"none" = 0 写 */
  scheduleSideEffect: ScheduleSideEffect;
  /** 命中的规则编号（1..7，排序去重） */
  ruleHits: number[];
  reasonCodes: string[];
}

/**
 * facet-to-mastery-policy-v1 七条固定规则（01-2 §8.3）：
 *
 * R1. 单个 facet_eligible 成功或失败只写 facet evidence，不消费/完成/缩短/延长 schedule；
 * R2. 只有预声明为 facet_only 的完整 Episode 才能 commit facet evidence；
 * R3. structured_mastery_bundle 未完成时，已完成 Scene 只保留为 support artifact，
 *     不写 canonical facet 或 schedule 副作用；
 * R4. Voice Teach-back 只有在覆盖全部 required rubric/facets 时才可签发 mastery_eligible；
 * R5. structured-proof-v1 由 ≥2 预冻结、互补、无中途反馈且高区分度的结构 Scene 组成，
 *     必须联合覆盖全部 required rubric，并通过跨模态 Gold Gate；
 * R6. bundle 中任一 required Scene 未完成/stale/assisted/not-assessable/未通过，
 *     不能消费 input schedule；
 * R7. 等价 Gate 通过前所有结构 Scene 最高只为 facet_eligible；且
 *     create_initial/consume_pending 的可评估 Episode 恰好一个 schedule，
 *     record_only/no_effect 的 schedule 写入必须为 0。
 *
 * 纯函数：assisted/stale 输入 → allowed=false / scheduleSideEffect=none（0 升级、0 延长）。
 */
export function applyFacetToMasteryPolicy(
  input: FacetToMasteryPolicyInput,
): FacetToMasteryPolicyVerdict {
  const ruleHits = new Set<number>();
  const reasonCodes: string[] = [];
  let maxTrustClass = input.effectiveClass;
  let allowed = true;
  let scheduleSideEffect: ScheduleSideEffect = "none";

  // R7（前置）：等价 Gate 通过前结构 Scene 最高 facet_eligible。
  if (input.planKind === "structured_mastery_bundle" && !input.equivalenceGatePassed) {
    ruleHits.add(7);
    maxTrustClass = mostConservativeTrustClass([maxTrustClass, TrustClass.FACET_ELIGIBLE]);
    reasonCodes.push("rule7_equivalence_gate_not_passed");
  }

  // R5：structured-proof-v1 资格不足（场景数/互补性/联合覆盖/Gold Gate）→ 不能 mastery。
  if (input.planKind === "structured_mastery_bundle" && !input.structuredProofEligible) {
    ruleHits.add(5);
    maxTrustClass = mostConservativeTrustClass([maxTrustClass, TrustClass.FACET_ELIGIBLE]);
    reasonCodes.push("rule5_structured_proof_not_eligible");
  }

  // R4：voice_mastery 必须 reducer PASS（覆盖全部 required rubric/facets）才可 mastery。
  if (
    input.planKind === "voice_mastery" &&
    maxTrustClass === TrustClass.MASTERY_ELIGIBLE &&
    input.reducerResult.result !== RubricSessionResult.PASS
  ) {
    ruleHits.add(4);
    maxTrustClass = mostConservativeTrustClass([maxTrustClass, TrustClass.FACET_ELIGIBLE]);
    reasonCodes.push("rule4_mastery_requires_full_rubric_coverage");
  }

  // R1：facet_eligible 结果只写 facet evidence，不消费/延长 schedule（0 写）。
  if (maxTrustClass === TrustClass.FACET_ELIGIBLE) {
    ruleHits.add(1);
    reasonCodes.push("rule1_facet_no_schedule_side_effect");
    scheduleSideEffect = "none";
  }

  // R2：只有预声明 facet_only 的完整 Episode 才能 commit facet evidence。
  if (
    maxTrustClass === TrustClass.FACET_ELIGIBLE &&
    (input.planKind !== "facet_only" || !input.episodeComplete)
  ) {
    ruleHits.add(2);
    allowed = false;
    scheduleSideEffect = "none";
    reasonCodes.push("rule2_facet_commit_requires_facet_only_complete_episode");
  }

  // R3：structured_mastery_bundle 未完成 → 已完成 Scene 仅 support artifact。
  if (input.planKind === "structured_mastery_bundle" && !input.episodeComplete) {
    ruleHits.add(3);
    allowed = false;
    scheduleSideEffect = "none";
    reasonCodes.push("rule3_incomplete_bundle_support_artifact_only");
  }

  // R6：bundle 任一 required Scene 未完成/stale/assisted/not-assessable/未通过
  //     → 不能消费 input schedule。
  const isMasteryKind = input.planKind === "structured_mastery_bundle" || input.planKind === "voice_mastery";
  if (isMasteryKind && input.anyRequiredSceneBlocked) {
    ruleHits.add(6);
    allowed = false;
    scheduleSideEffect = "none";
    reasonCodes.push("rule6_required_scene_blocked_no_schedule");
  }

  // R7（收尾）：record_only/no_effect 的 schedule 写入必须为 0。
  if (input.authorizedAction === "record_only" || input.authorizedAction === "no_effect") {
    ruleHits.add(7);
    scheduleSideEffect = "none";
  }

  // practice plan：正式归约一律禁止，无任何副作用（01-2 §5.2 practice→no_effect）。
  if (input.planKind === "practice") {
    allowed = false;
    scheduleSideEffect = "none";
    reasonCodes.push("practice_no_side_effect");
  }

  // mastery 路径：全部规则通过时允许 create_initial/consume_pending 恰一 schedule。
  if (maxTrustClass === TrustClass.MASTERY_ELIGIBLE && allowed) {
    if (input.authorizedAction === "create_initial" || input.authorizedAction === "consume_pending") {
      scheduleSideEffect = input.authorizedAction;
      reasonCodes.push("mastery_schedule_allowed");
    } else {
      scheduleSideEffect = "none";
    }
  }

  return {
    allowed,
    maxTrustClass,
    scheduleSideEffect,
    ruleHits: [...ruleHits].sort((a, b) => a - b),
    reasonCodes,
  };
}

// ─── 5. artifactEligibilityFilter（多 artifact 正式归约前过滤）──────────────

export type ArtifactBindingStatus =
  | "locked"
  | "draft"
  | "awaiting_confirmation"
  | "superseded"
  | "stale"
  | "redacted";

export interface TrustArtifactBindingInput {
  artifactId: string;
  status: ArtifactBindingStatus;
  effectiveTrustClass: TrustClass;
  /** lock 时冻结的 assistance snapshot（01-2 §7.2 / §7.6）；null 表示从未辅助 */
  assistanceSnapshot: {
    assistanceLevel: string; // none | content_assisted | practice_only
    contentAssisted: boolean;
    capturedBy: "lock" | "assistance";
  } | null;
  planKind: FormalPlanKind;
  /** episode target fingerprint 是否匹配（失配 → stale，无正式副作用） */
  fingerprintMatch: boolean;
}

export interface EligibleArtifact {
  artifactId: string;
  effectiveTrustClass: TrustClass;
}

export interface RejectedArtifact {
  artifactId: string;
  reasonCode: string;
}

export interface ArtifactEligibilityFilterResult {
  eligible: EligibleArtifact[];
  rejected: RejectedArtifact[];
}

function artifactEligibilityReason(a: TrustArtifactBindingInput): string | null {
  if (a.planKind === "practice") return "practice_plan_excluded";
  if (a.status !== "locked") return "not_locked";
  if (!a.fingerprintMatch) return "stale_fingerprint";
  if (a.assistanceSnapshot?.contentAssisted) return "assisted";
  if (a.assistanceSnapshot?.capturedBy === "assistance") return "assisted";
  if (
    a.effectiveTrustClass !== TrustClass.MASTERY_ELIGIBLE &&
    a.effectiveTrustClass !== TrustClass.FACET_ELIGIBLE
  ) {
    return "not_trusted";
  }
  return null;
}

/**
 * 正式归约前过滤（01-2 §7.5）：只消费 content assistance 前、effective trusted
 * 且 locked 的 bindings；practice artifact 不参与正式归约。
 * - lock 先赢：snapshot capturedBy="lock" && contentAssisted=false → 合格
 *   （之后 reveal 不追溯污染已锁 artifact）；
 * - assistance 先赢：snapshot capturedBy="assistance" → 一律拒绝（practice-only）；
 * - stale（fingerprint 失配）→ 拒绝，无正式副作用。
 */
export function artifactEligibilityFilter(
  artifacts: readonly TrustArtifactBindingInput[],
): ArtifactEligibilityFilterResult {
  const eligible: EligibleArtifact[] = [];
  const rejected: RejectedArtifact[] = [];
  for (const artifact of artifacts) {
    const reason = artifactEligibilityReason(artifact);
    if (reason === null) {
      eligible.push({
        artifactId: artifact.artifactId,
        effectiveTrustClass: artifact.effectiveTrustClass,
      });
    } else {
      rejected.push({ artifactId: artifact.artifactId, reasonCode: reason });
    }
  }
  return { eligible, rejected };
}

/** 正式可信 artifact 的 effectiveTrustClass 集合（01-2 §7.3）。 */
export const TRUSTED_CLASSES = [
  TrustClass.MASTERY_ELIGIBLE,
  TrustClass.FACET_ELIGIBLE,
] as const satisfies readonly TrustClass[];
