/**
 * Learning Session Supervisor 四阶段外壳编排器（阶段 03 / W2 任务 03-3）
 *
 * 冻结依据（01-1 §4 四阶段确定性外壳 / §6 Agent Loop 硬边界、01-2 §3.3 scene-safety-v1
 * 与 §5 冻结合同、03-w2 任务 03-3）：
 * - PREPARE → SESSION_AGENT → INDEPENDENT_ASSESS → COMMIT 外壳骨架；
 *   编排层显式传入 phase（对应 03-2 的 sessionLoop 状态机，phase 无独立 DB 落点，
 *   prepared/session_agent/independent_assess 语义都保持 episode status='active'）；
 * - `RUBRIC_AND_SCENE_PREPARE` 子流程：首个 formal probe 展示前执行、不向用户展示，
 *   顺序固定为 解析 RubricTarget → Scene Author 草案 → deterministic schema/safety →
 *   独立 Rubric/Scene Critic → 确定性激活 immutable private/public contracts
 *   （本阶段提供编排接口 + staging 落点；Scene 具体实现由 W4 任务 05 完成）；
 * - 每个 RubricTarget 冻结 criterion / server-only expected target/hash / weight /
 *   required / facet / target / 逐项 evidence refs / semantic-support report；
 * - 公测 v1 同一 formal Episode 首次回答前冻结全部 trusted probes 和分支；
 *   Supervisor 只能请求 requestedTrustClass，不能签发 effective trust；
 * - trusted 阶段不读取内容性 gap 动态出题，只接收无答案控制信号；
 * - 不进入无限聊天、不新增评分目标、不替用户完成答案；
 * - Agent Loop 硬边界：turns≤8、trusted 内容性 follow-up=0、Encounter 2~5、
 *   同时 active 会话每用户 1、turn deadline≤120s、inactivity 30min、
 *   Pause TTL 恢复重查 stale；
 * - Supervisor staging plan，**0 canonical write**（类型 + 注释双重保证）。
 *
 * 实现策略：
 * - 本文件是纯逻辑 + 可注入端口（Scene Author / Rubric/Scene Critic），不直接依赖
 *   DB / Scene 实现；DB / Scene 交互通过接口注入（Scene 实现于 W4 任务 05）；
 * - 不写掌握 / schedule 真值：全部产物是 `LearningStagingResult`（canonicalWrite=false）。
 */

import { createHash } from "node:crypto";
import {
  TrustClass,
  type RubricTarget,
  type FrozenProbeRef,
} from "@ailearn/shared";
import type { LearningStagingResult } from "./types.ts";
import { LearningSessionPhase } from "./session.ts";
import type { LearningSessionPhase as LearningSessionPhaseType } from "./session.ts";
import type { LearningBudgetPolicy } from "./budget.ts";
import { createDefaultLearningBudgetPolicy } from "./budget.ts";

// ─── 0. 基础冻结枚举（01-2 §4/§7/§8.1）────────────────────────────────────

// Trust Class / Capability Facet / RubricTarget / FrozenProbeRef 单一来源：
// packages/shared/src/learning-session-contracts.ts（01-2 §5 冻结语义，禁止本地重定义）。

/** ValidationModality（01-2 §6.1 模态 payload） */
export const ValidationModality = {
  VOICE: "voice",
  TEXT_OR_MIXED: "text_or_mixed",
  DRAG_GRAPH: "drag_graph",
  ORDERING: "ordering",
  REPAIR: "repair",
  SCENARIO: "scenario",
} as const;
export type ValidationModality = (typeof ValidationModality)[keyof typeof ValidationModality];

// ─── 1. 冻结合同类型（01-2 §5，服务端 private）────────────────────────────
// RubricTarget / FrozenProbeRef 见 packages/shared/src/learning-session-contracts.ts。

/** 确定性 hash（同 PREPARE 冻结输入恒等） */
export function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ─── 2. 四阶段确定性外壳：runPhase ───────────────────────────────────────

/**
 * 外壳推进动作（对应 03-2 sessionLoop typed actions，编排层显式传入 phase）。
 * phase 无独立 DB 落点：prepared/session_agent/independent_assess 语义保持
 * episode status='active'，committed→completed、cancelled/stale 原样映射。
 */
export const ShellAdvanceAction = {
  /** prepared → session_agent（SESSION_AGENT 有界编排开始） */
  BEGIN_SESSION_AGENT: "begin_session_agent",
  /** session_agent → independent_assess（正式答案锁定；内容实现于后续任务） */
  LOCK_ANSWER: "lock_answer",
  /** independent_assess → committed（确定性 COMMIT；实现于 03-6/06） */
  COMMIT_EPISODE: "commit_episode",
  /** 任意进行中 → cancelled（取消当前与未开始 Episode，已 commit 保留） */
  CANCEL: "cancel",
  /** 任意进行中 → stale（fingerprint/epoch 失配，03-6 驱动） */
  MARK_STALE: "mark_stale",
} as const;
export type ShellAdvanceAction = (typeof ShellAdvanceAction)[keyof typeof ShellAdvanceAction];

/** 编排层持有的 phase（复用 session.ts 的 LearningSessionPhase 语义） */
export type ShellPhase = LearningSessionPhaseType;

/** phase 推进所需上下文（身份 + 冻结计划；全部必填，缺一 fail closed） */
export interface RunPhaseContext {
  action: ShellAdvanceAction;
  sessionId: string;
  episodeId: string;
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  planHash: string;
}

export interface RunPhaseResult {
  /** 推进后的 phase（非法动作时保持原 phase） */
  phase: ShellPhase;
  allowed: boolean;
  reason: string | null;
}

/**
 * 四阶段外壳状态推进矩阵（01-1 §4 / 03-2 §2）：
 * prepared → session_agent → independent_assess → committed；
 * 任意进行中 → cancelled / stale；cancelled / stale 无出边；committed 的 commit 幂等。
 */
export const SHELL_PHASE_TRANSITIONS: Readonly<
  Record<ShellPhase, Readonly<Partial<Record<ShellAdvanceAction, ShellPhase>>>>
> = {
  [LearningSessionPhase.PREPARED]: {
    [ShellAdvanceAction.BEGIN_SESSION_AGENT]: LearningSessionPhase.SESSION_AGENT,
    [ShellAdvanceAction.CANCEL]: LearningSessionPhase.CANCELLED,
    [ShellAdvanceAction.MARK_STALE]: LearningSessionPhase.STALE,
  },
  [LearningSessionPhase.SESSION_AGENT]: {
    [ShellAdvanceAction.LOCK_ANSWER]: LearningSessionPhase.INDEPENDENT_ASSESS,
    [ShellAdvanceAction.CANCEL]: LearningSessionPhase.CANCELLED,
    [ShellAdvanceAction.MARK_STALE]: LearningSessionPhase.STALE,
  },
  [LearningSessionPhase.INDEPENDENT_ASSESS]: {
    [ShellAdvanceAction.COMMIT_EPISODE]: LearningSessionPhase.COMMITTED,
    [ShellAdvanceAction.CANCEL]: LearningSessionPhase.CANCELLED,
    [ShellAdvanceAction.MARK_STALE]: LearningSessionPhase.STALE,
  },
  // 已 commit Episode：cancel 不动它（验收：已 commit Episode 保留）；commit 幂等。
  [LearningSessionPhase.COMMITTED]: {
    [ShellAdvanceAction.COMMIT_EPISODE]: LearningSessionPhase.COMMITTED,
  },
  [LearningSessionPhase.CANCELLED]: {},
  [LearningSessionPhase.STALE]: {},
};

/**
 * 四阶段外壳编排入口（纯函数，对应 03-2 的 session 状态机）。
 *
 * @param phase   当前 phase（编排层显式传入，不读写 DB phase 列）
 * @param context 推进上下文（action + 身份 + 冻结计划）
 */
export function runPhase(phase: ShellPhase, context: RunPhaseContext): RunPhaseResult {
  // 防御：phase 推进必须有上下文身份与冻结计划（fail closed，0 副作用）
  if (
    context.sessionId.length === 0
    || context.episodeId.length === 0
    || context.planHash.length === 0
    || context.runtimeEpochSnapshot < 0
    || context.episodeEpoch < 0
  ) {
    return {
      phase,
      allowed: false,
      reason: "phase 推进缺少 session/episode/planHash/epoch 上下文（fail closed）",
    };
  }
  const nextPhase = SHELL_PHASE_TRANSITIONS[phase]?.[context.action];
  if (nextPhase === undefined) {
    return {
      phase,
      allowed: false,
      reason: `action '${context.action}' 不允许从 phase '${phase}' 转移（无限 loop 不可达）`,
    };
  }
  return { phase: nextPhase, allowed: true, reason: `${phase} → ${nextPhase}` };
}

// ─── 3. RUBRIC_AND_SCENE_PREPARE 子流程 ──────────────────────────────────

/**
 * Scene Author 端口（可注入；Scene 具体实现于 W4 任务 05）。
 * Scene Author 只读当前 target 已发布 claim/evidence 与 private Rubric staging，
 * 写未激活 Scene staging；禁止激活/展示 Scene、跨 target 检索、读用户回答、签发 trust。
 */
export interface SceneAuthorPort {
  proposeSceneDraft(input: SceneDraftRequest): Promise<SceneDraft>;
}

/** 独立 Rubric / Scene Critic 端口（可注入；scene-safety-v1 对动态 formal Scene mandatory） */
export interface RubricSceneCriticPort {
  reviewScene(input: SceneCriticRequest): Promise<SceneCriticVerdict>;
}

/** Scene Author 草案请求 */
export interface SceneDraftRequest {
  sessionId: string;
  episodeId: string;
  workspaceId: string;
  userId: string;
  rubricTarget: RubricTarget;
  scenePolicyVersion: string;
  /** 单次修复轮（01-2 §3.3：失败最多修复一次，仍失败 → question_retryable/blocked） */
  repairOf?: string;
}

/** Scene Author 草案（未激活 Scene staging 内容，0 canonical write） */
export interface SceneDraft {
  probeId: string;
  /** versioned Scene schema 模板 ID（模型不能任意生成界面，01-2 §3） */
  sceneTemplate: string;
  sceneVersion: string;
  /** public payload 与 secret solution 的独立 hash（01-2 §3.1） */
  publicPayloadHash: string;
  privateSolutionHash: string;
  disclosureProfileHash: string;
  templateTrustCeiling: TrustClass;
  /** allowlisted token/node/edge/option IDs（01-2 §3.1） */
  allowedTokenIds: readonly string[];
  /** 逐 rubric evidence binding（01-2 §3.1/§9） */
  rubricEvidenceBindings: ReadonlyArray<{
    rubricTargetId: string;
    evidenceRefIds: readonly string[];
  }>;
}

/** deterministic schema/safety 校验结果（scene-safety-v1 的确定性部分） */
export interface SceneSafetyResult {
  valid: boolean;
  issues: readonly string[];
}

/** scene-safety-v1 确定性校验（01-2 §3.3：schema、public/secret 分离、allowlisted IDs、可评估性、evidence 子集） */
export function validateSceneDraft(
  draft: SceneDraft,
  rubricTarget: RubricTarget,
  allowlist: Readonly<{ sceneTemplates: readonly string[]; trustCeilings: readonly TrustClass[] }>,
): SceneSafetyResult {
  const issues: string[] = [];

  if (!allowlist.sceneTemplates.includes(draft.sceneTemplate)) {
    issues.push(`sceneTemplate '${draft.sceneTemplate}' 不在 allowlist 中（不允许模型任意生成界面）`);
  }
  if (draft.sceneVersion.length === 0) issues.push("sceneVersion 为空");
  if (draft.publicPayloadHash.length === 0) issues.push("publicPayloadHash 为空");
  if (draft.privateSolutionHash.length === 0) issues.push("privateSolutionHash 为空");
  if (draft.publicPayloadHash === draft.privateSolutionHash) {
    issues.push("publicPayloadHash 与 privateSolutionHash 相同：public payload 与 secret solution 未分离");
  }
  if (draft.disclosureProfileHash.length === 0) issues.push("disclosureProfileHash 为空");
  if (!allowlist.trustCeilings.includes(draft.templateTrustCeiling)) {
    issues.push(`templateTrustCeiling '${draft.templateTrustCeiling}' 不在 allowlist 中`);
  }
  const seenTokenIds = new Set<string>();
  for (const id of draft.allowedTokenIds) {
    if (seenTokenIds.has(id)) issues.push(`allowedTokenIds 重复：${id}`);
    seenTokenIds.add(id);
  }

  const binding = draft.rubricEvidenceBindings.find((b) => b.rubricTargetId === rubricTarget.id);
  if (binding === undefined) {
    issues.push(`缺少 rubric target '${rubricTarget.id}' 的 evidence binding`);
  } else {
    for (const evidenceRef of binding.evidenceRefIds) {
      if (!rubricTarget.evidenceRefIds.includes(evidenceRef)) {
        issues.push(
          `evidence ref '${evidenceRef}' 不在 rubric target '${rubricTarget.id}' 的 evidenceRefIds 中（01-2 §9 证据子集规则）`,
        );
      }
    }
  }
  if (rubricTarget.required && draft.rubricEvidenceBindings.length === 0) {
    issues.push("required rubric 无任何 evidence binding（不可评估）");
  }

  return { valid: issues.length === 0, issues };
}

/** Scene Critic 审查请求 */
export interface SceneCriticRequest {
  sessionId: string;
  episodeId: string;
  workspaceId: string;
  userId: string;
  rubricTarget: RubricTarget;
  draft: SceneDraft;
  scenePolicyVersion: string;
}

/** Rubric / Scene Critic 激活 verdict（scene-safety-v1 强制调用） */
export interface SceneCriticVerdict {
  approved: boolean;
  verdictRef: string;
  reasonCodes: readonly string[];
  sceneSafetyReportId: string;
  sceneSafetyReportHash: string;
}

/** 激活结果：immutable FrozenProbeRef + 隔离 staging 落点（0 canonical write） */
export interface ActivatedProbe {
  frozenProbe: FrozenProbeRef;
  staging: LearningStagingResult;
}

export interface ActivateSceneContractInput {
  sessionId: string;
  episodeId: string;
  episodeTargetFingerprint: string;
  planHash: string;
  sequence: number;
  draft: SceneDraft;
  safety: SceneSafetyResult;
  verdict: SceneCriticVerdict;
}

/**
 * 确定性激活 immutable private/public contracts。
 *
 * 唯一激活权限属于 deterministic Scene Activation Service（01-2 §3.3）：
 * Author / Supervisor / Critic / Companion 都没有 activate_scene_contract 权限。
 * 前置条件（fail closed）：schema/safety 通过 且 Critic=approved，否则抛错不激活。
 * 本函数只产生 FrozenProbeRef 与 staging 落点，**不写 canonical 事实**。
 */
export function activateSceneContract(input: ActivateSceneContractInput): ActivatedProbe {
  if (!input.safety.valid) {
    throw new Error("scene-safety-v1 未通过，禁止激活（fail closed）");
  }
  if (!input.verdict.approved) {
    throw new Error("Rubric/Scene Critic 未批准，禁止激活（fail closed）");
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new Error(`probe sequence 非法：${String(input.sequence)}`);
  }
  if (input.episodeTargetFingerprint.length === 0 || input.planHash.length === 0) {
    throw new Error("激活缺少 episodeTargetFingerprint/planHash（fail closed）");
  }

  const frozenProbe: FrozenProbeRef = {
    probeId: input.draft.probeId,
    publicSceneContractId: `${input.draft.probeId}/public`,
    publicPayloadHash: input.draft.publicPayloadHash,
    privateSolutionId: `${input.draft.probeId}/solution`,
    privateSolutionHash: input.draft.privateSolutionHash,
    sceneSafetyReportId: input.verdict.sceneSafetyReportId,
    sceneSafetyReportHash: input.verdict.sceneSafetyReportHash,
    templateTrustCeiling: input.draft.templateTrustCeiling,
    disclosureProfileHash: input.draft.disclosureProfileHash,
  };

  const staging: LearningStagingResult = {
    kind: "learning_staging",
    stagingKind: "probe",
    stagingRef: input.draft.probeId,
    stagingHash: hashText(
      [input.planHash, input.episodeTargetFingerprint, input.draft.probeId].join("|"),
    ),
    status: "approved",
    canonicalWrite: false,
  };

  return { frozenProbe, staging };
}

/** planHash 追加全部 frozen probe hash（01-2 §5.3；03-2 §3 第 4 步追加落点） */
export function extendPlanHashWithFrozenProbes(
  planHash: string,
  frozenProbes: readonly FrozenProbeRef[],
): string {
  const probeHashes = frozenProbes
    .map((p) =>
      hashText(
        `${p.probeId}|${p.publicPayloadHash}|${p.privateSolutionHash}|${p.sceneSafetyReportHash}|${p.disclosureProfileHash}`,
      ),
    )
    .sort();
  return hashText(`planHash=${planHash};frozenProbeHashes=${probeHashes.join(",")}`);
}

/** RUBRIC_AND_SCENE_PREPARE 子流程编排输入 */
export interface RubricAndScenePrepareInput {
  sessionId: string;
  episodeId: string;
  workspaceId: string;
  userId: string;
  episodeTargetFingerprint: string;
  planHash: string;
  rubricTargets: readonly RubricTarget[];
  scenePolicyVersion: string;
  sceneTemplateAllowlist: readonly string[];
  trustCeilingAllowlist: readonly TrustClass[];
  ports: {
    sceneAuthor: SceneAuthorPort;
    rubricSceneCritic: RubricSceneCriticPort;
  };
}

/** RUBRIC_AND_SCENE_PREPARE 子流程编排结果 */
export interface RubricAndScenePrepareResult {
  ok: boolean;
  /** 激活的 immutable trusted probes（公测 v1 首次回答前全部冻结） */
  frozenProbes: FrozenProbeRef[];
  /** planHash 追加 frozenProbeHashes 后的新值（ok=true 时非 null） */
  extendedPlanHash: string | null;
  /** 全部隔离 staging 落点（canonicalWrite=false） */
  stagings: LearningStagingResult[];
  /** 实际执行顺序（供审计/单测验证「草案→safety→Critic→激活」固定顺序） */
  order: ReadonlyArray<"author" | "safety" | "critic" | "activate" | "blocked">;
  blockedReason: string | null;
}

function blockedPrepare(
  order: RubricAndScenePrepareResult["order"],
  reason: string,
): RubricAndScenePrepareResult {
  return {
    ok: false,
    frozenProbes: [],
    extendedPlanHash: null,
    stagings: [],
    order: [...order, "blocked"],
    blockedReason: reason,
  };
}

/**
 * RUBRIC_AND_SCENE_PREPARE 子流程编排（不向用户展示，01-1 §4）：
 *
 *   解析 RubricTarget → Scene Author 提出草案 → deterministic schema/safety 校验
 *   → 独立 Rubric/Scene Critic → 确定性激活 immutable private/public contracts
 *
 * - Critic 拒绝时允许单次修复轮（01-2 §3.3：失败最多修复一次，仍失败 → blocked，
 *   不激活、0 副作用）；
 * - 每个激活 probe 只产生 FrozenProbeRef + staging（canonicalWrite=false）；
 * - 没有 RubricTarget 无法冻结 trusted probes → fail closed。
 */
export async function runRubricAndScenePrepare(
  input: RubricAndScenePrepareInput,
): Promise<RubricAndScenePrepareResult> {
  if (input.rubricTargets.length === 0) {
    return blockedPrepare([], "没有 RubricTarget，无法冻结 trusted probes（fail closed）");
  }

  const order: RubricAndScenePrepareResult["order"][number][] = [];
  const frozenProbes: FrozenProbeRef[] = [];
  const stagings: LearningStagingResult[] = [];
  const allowlist = {
    sceneTemplates: input.sceneTemplateAllowlist,
    trustCeilings: input.trustCeilingAllowlist,
  };

  for (const rubricTarget of input.rubricTargets) {
    // 1. Scene Author 提出草案（只读当前 target published claim/evidence + private rubric staging）
    const draft = await input.ports.sceneAuthor.proposeSceneDraft({
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      rubricTarget,
      scenePolicyVersion: input.scenePolicyVersion,
    });
    order.push("author");

    // 2. deterministic schema/safety 校验
    let safety = validateSceneDraft(draft, rubricTarget, allowlist);
    order.push("safety");
    if (!safety.valid) {
      return blockedPrepare(order, `scene-safety-v1 校验失败：${safety.issues.join("；")}`);
    }

    // 3. 独立 Rubric/Scene Critic
    let verdict = await input.ports.rubricSceneCritic.reviewScene({
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      rubricTarget,
      draft,
      scenePolicyVersion: input.scenePolicyVersion,
    });
    order.push("critic");

    // Critic 拒绝 → 最多一次修复轮，仍失败 → blocked（不激活，0 副作用）
    let finalDraft = draft;
    let finalSafety = safety;
    let finalVerdict = verdict;
    if (!verdict.approved) {
      const repaired = await input.ports.sceneAuthor.proposeSceneDraft({
        sessionId: input.sessionId,
        episodeId: input.episodeId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        rubricTarget,
        scenePolicyVersion: input.scenePolicyVersion,
        repairOf: draft.probeId,
      });
      order.push("author");

      finalDraft = repaired;
      finalSafety = validateSceneDraft(repaired, rubricTarget, allowlist);
      order.push("safety");
      if (!finalSafety.valid) {
        return blockedPrepare(order, `scene-safety-v1 修复后仍失败：${finalSafety.issues.join("；")}`);
      }

      finalVerdict = await input.ports.rubricSceneCritic.reviewScene({
        sessionId: input.sessionId,
        episodeId: input.episodeId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        rubricTarget,
        draft: repaired,
        scenePolicyVersion: input.scenePolicyVersion,
      });
      order.push("critic");
      if (!finalVerdict.approved) {
        return blockedPrepare(
          order,
          `Rubric/Scene Critic 修复后仍拒绝：${finalVerdict.reasonCodes.join("；")}`,
        );
      }
    }

    // 4. 确定性激活 immutable private/public contracts（唯一激活权限属于 Scene Activation Service）
    const activated = activateSceneContract({
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      episodeTargetFingerprint: input.episodeTargetFingerprint,
      planHash: input.planHash,
      sequence: frozenProbes.length + 1,
      draft: finalDraft,
      safety: finalSafety,
      verdict: finalVerdict,
    });
    order.push("activate");
    frozenProbes.push(activated.frozenProbe);
    stagings.push(activated.staging);
  }

  return {
    ok: true,
    frozenProbes,
    extendedPlanHash: extendPlanHashWithFrozenProbes(input.planHash, frozenProbes),
    stagings,
    order,
    blockedReason: null,
  };
}

// ─── 4. 默认路线与「换一个」备选 ──────────────────────────────────────────

/** 合法路线候选（Encounter 2~5；route 无 route-level mastery 或 schedule 副作用） */
export interface RouteCandidate {
  routeId: string;
  keyPointId: string;
  /** 每条路线 Encounter 2~5（01-1 §6） */
  episodeCount: number;
  sceneTemplates: readonly string[];
  reasonCodes: readonly string[];
}

/** 用户显式偏好（PREPARE 冻结的用户偏好快照的只读视图） */
export interface RoutePreferences {
  modality?: ValidationModality;
  /** 用户显式偏好的 Encounter 数（2~5） */
  episodeCount?: number;
  avoidSceneTemplates?: readonly string[];
  preferSceneTemplates?: readonly string[];
}

/** 一条路线提议（默认或「换一个」备选） */
export interface RouteProposal {
  routeId: string;
  kind: "default" | "alternate";
  keyPointId: string;
  episodeCount: number;
  sceneTemplates: readonly string[];
  reasonCodes: readonly string[];
}

/** 候选合法性过滤：目的地匹配 + Encounter 2~5 + 显式排除模板 */
function filterEligibleCandidates(
  candidates: readonly RouteCandidate[],
  destination: { keyPointId: string },
  preferences: RoutePreferences,
): RouteCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.keyPointId !== destination.keyPointId) return false;
    if (candidate.episodeCount < 2 || candidate.episodeCount > 5) return false;
    if (
      preferences.avoidSceneTemplates
      && candidate.sceneTemplates.some((t) => preferences.avoidSceneTemplates!.includes(t))
    ) {
      return false;
    }
    return true;
  });
}

/** 确定性排序分数（越小越优先）：匹配显式 Encounter 偏好 > 匹配偏好模板 > routeId 字典序兜底 */
function scoreRouteCandidate(candidate: RouteCandidate, preferences: RoutePreferences): number {
  let score = 0;
  if (preferences.episodeCount !== undefined && candidate.episodeCount !== preferences.episodeCount) {
    score += 10;
  }
  if (preferences.preferSceneTemplates && preferences.preferSceneTemplates.length > 0) {
    const matched = candidate.sceneTemplates.filter(
      (t) => preferences.preferSceneTemplates!.includes(t),
    ).length;
    score += 5 - matched * 2;
  }
  return score;
}

function sortRoutes(
  candidates: RouteCandidate[],
  preferences: RoutePreferences,
): RouteCandidate[] {
  // 先按 routeId 字典序稳定排序，再按分数稳定排序 → 完全确定性
  const sorted = [...candidates].sort((a, b) => (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
  sorted.sort((a, b) => scoreRouteCandidate(a, preferences) - scoreRouteCandidate(b, preferences));
  return sorted;
}

function toRouteProposal(candidate: RouteCandidate, kind: RouteProposal["kind"]): RouteProposal {
  return {
    routeId: candidate.routeId,
    kind,
    keyPointId: candidate.keyPointId,
    episodeCount: candidate.episodeCount,
    sceneTemplates: [...candidate.sceneTemplates],
    reasonCodes: [...candidate.reasonCodes],
  };
}

/**
 * 默认提议一条路线（根据目的地和显式偏好，01-1 §4）。
 *
 * 语义：只返回**一条**默认路线，不生成备选列表；「换一个」由 alternateRoute 显式触发
 * （默认不会自动生成备选）。
 */
export function defaultRoute(
  destination: { keyPointId: string },
  explicitPreferences: RoutePreferences,
  candidates: readonly RouteCandidate[],
): RouteProposal | null {
  const eligible = filterEligibleCandidates(candidates, destination, explicitPreferences);
  if (eligible.length === 0) return null;
  const best = sortRoutes(eligible, explicitPreferences)[0]!;
  return toRouteProposal(best, "default");
}

/**
 * 生成「换一个」备选（只在用户明确要求时才调用）。
 *
 * - 排除当前 routeId 与已看过的 seenRouteIds，从确定性排序的候选中取下一条；
 * - 备选耗尽返回 null（明确提示无更多备选，不自动生成新路线、不进入无限聊天）。
 */
export function alternateRoute(
  destination: { keyPointId: string },
  explicitPreferences: RoutePreferences,
  candidates: readonly RouteCandidate[],
  current: { routeId: string } | null,
  seenRouteIds: ReadonlySet<string>,
): RouteProposal | null {
  const eligible = filterEligibleCandidates(candidates, destination, explicitPreferences);
  const ordered = sortRoutes(eligible, explicitPreferences);
  const excluded = new Set<string>(seenRouteIds);
  if (current) excluded.add(current.routeId);
  const next = ordered.find((candidate) => !excluded.has(candidate.routeId));
  return next ? toRouteProposal(next, "alternate") : null;
}

// ─── 5. trusted 阶段无答案控制信号白名单 ─────────────────────────────────

/**
 * trusted 控制信号（01-1 §4 / 03-w2 任务 03-3）。
 *
 * trusted 阶段不读取内容性 gap 动态出题，只能接收无答案控制信号；
 * 内容性 assessment gap 只在正式答案锁定并完成 Independent Assess 后
 * 供结果解释或 practice 使用（trusted 内容性动态 follow-up = 0，W0 冻结）。
 */
export const TrustedControlSignal = {
  CONTINUE: "continue",
  STOP: "stop",
  NOT_ASSESSABLE: "not_assessable",
  SWITCH_MODALITY: "switch_modality",
} as const;
export type TrustedControlSignal = (typeof TrustedControlSignal)[keyof typeof TrustedControlSignal];

export const TRUSTED_CONTROL_SIGNALS: readonly TrustedControlSignal[] = [
  TrustedControlSignal.CONTINUE,
  TrustedControlSignal.STOP,
  TrustedControlSignal.NOT_ASSESSABLE,
  TrustedControlSignal.SWITCH_MODALITY,
];

export interface TrustedControlSignalResult {
  allowed: boolean;
  signal: TrustedControlSignal | null;
  reason: string | null;
}

/**
 * trusted 控制信号白名单校验（纯函数）。
 *
 * - 仅在 SESSION_AGENT trusted 阶段生效（其他 phase 一律拒绝）；
 * - 只接受 continue/stop/not_assessable/switch_modality；
 * - 任何答案/内容性信号（如「再解释一下这个概念的答案」）一律拒绝。
 */
export function trustedControlSignals(
  signal: string,
  context: { phase: ShellPhase },
): TrustedControlSignalResult {
  if (context.phase !== LearningSessionPhase.SESSION_AGENT) {
    return {
      allowed: false,
      signal: null,
      reason: `trusted 控制信号仅在 SESSION_AGENT 阶段有效（当前 phase=${context.phase}）`,
    };
  }
  if ((TRUSTED_CONTROL_SIGNALS as readonly string[]).includes(signal)) {
    return { allowed: true, signal: signal as TrustedControlSignal, reason: null };
  }
  return {
    allowed: false,
    signal: null,
    reason:
      `'${signal}' 不是 trusted 控制信号；trusted 阶段不接受答案/内容性信号，`
      + "只能接收 continue/stop/not_assessable/switch_modality（无答案控制信号）",
  };
}

// ─── 6. Agent Loop 硬边界：loopGuard ─────────────────────────────────────

/** loopGuard 输入（全部来自编排运行时快照） */
export interface LoopGuardInput {
  /** Session Supervisor 已用 turns（≤8，W0 冻结） */
  supervisorTurnsUsed: number;
  /** trusted 内容性动态 follow-up（=0，公测 v1；全部 formal probe 预冻结） */
  trustedContentFollowUpUsed: number;
  /** 当前路线已进行的 Encounter 数（2~5） */
  routeEncounterCount: number;
  /** 该用户同时 active 学习会话数（每用户 ≤1） */
  activeSessionsForUser: number;
  /** 当前 turn 起始时间（ms）；0 表示无进行中 turn（跳过 deadline 检查） */
  turnStartedAtMs: number;
  /** 最近用户活动时间（ms）；0 表示未知（跳过 inactivity 检查） */
  lastActivityAtMs: number;
  /** 当前时间（ms） */
  nowMs: number;
  /** 是否从 Pause 恢复（恢复时必须重查 source/policy/assistance stale） */
  resumingFromPause: boolean;
  /** Pause 恢复时的 stale 重查结果；null 表示尚未重查 */
  staleRecheck: { checked: boolean; stale: boolean } | null;
}

export interface LoopGuardResult {
  allowed: boolean;
  /** 违反的边界名（allowed=true 时为 null） */
  violatedBound: string | null;
  reason: string | null;
}

/**
 * Agent Loop 硬边界执行（01-1 §6 / 03-w2 任务 03-3，fail closed）：
 *
 * | 维度 | 上限 |
 * | --- | ---: |
 * | Session Supervisor turns | ≤8 |
 * | trusted 内容性动态 follow-up | =0 |
 * | 每条路线 Encounter | 2~5 |
 * | 同时 active 学习会话 | 每用户 1 |
 * | 单次 Agent turn deadline | ≤120s（policy 冻结） |
 * | Session inactivity expiry | 30min（只结束 active UI，不回滚已 commit Episode） |
 * | Pause TTL 恢复 | 必须重查 stale，stale 禁止继续 |
 *
 * 任一违反立即返回 allowed=false，0 副作用；全部满足才返回 allowed=true。
 */
export function loopGuard(
  policy: LearningBudgetPolicy,
  input: LoopGuardInput,
): LoopGuardResult {
  if (input.supervisorTurnsUsed > policy.maxSessionSupervisorTurns) {
    return {
      allowed: false,
      violatedBound: "maxSessionSupervisorTurns",
      reason: `Session Supervisor turns 超限：${input.supervisorTurnsUsed}/${policy.maxSessionSupervisorTurns}`,
    };
  }
  if (input.trustedContentFollowUpUsed > policy.trustedContentFollowUp) {
    return {
      allowed: false,
      violatedBound: "trustedContentFollowUp",
      reason: `trusted 内容性动态 follow-up 必须为 0（当前 ${input.trustedContentFollowUpUsed}）`,
    };
  }
  if (
    input.routeEncounterCount < policy.routeEncounterMin
    || input.routeEncounterCount > policy.routeEncounterMax
  ) {
    return {
      allowed: false,
      violatedBound: "routeEncounter",
      reason: `route Encounter 越界：${input.routeEncounterCount}（允许 ${policy.routeEncounterMin}~${policy.routeEncounterMax}）`,
    };
  }
  if (input.activeSessionsForUser > policy.maxConcurrentActiveSessionsPerUser) {
    return {
      allowed: false,
      violatedBound: "maxConcurrentActiveSessionsPerUser",
      reason: `同时 active 学习会话超限：${input.activeSessionsForUser}/${policy.maxConcurrentActiveSessionsPerUser}（每用户 1）`,
    };
  }
  if (input.turnStartedAtMs > 0 && input.nowMs - input.turnStartedAtMs > policy.turnDeadlineMs) {
    return {
      allowed: false,
      violatedBound: "turnDeadlineMs",
      reason: `单次 Agent turn deadline 超时（>${policy.turnDeadlineMs}ms）`,
    };
  }
  if (input.lastActivityAtMs > 0 && input.nowMs - input.lastActivityAtMs > policy.inactivityExpiryMs) {
    return {
      allowed: false,
      violatedBound: "inactivityExpiryMs",
      reason: "Session inactivity 过期（只结束 active UI，不回滚已 commit Episode）",
    };
  }
  if (input.resumingFromPause) {
    if (input.staleRecheck === null || !input.staleRecheck.checked) {
      return {
        allowed: false,
        violatedBound: "pauseTtlStaleRecheck",
        reason: "Pause TTL 恢复必须重查 source/policy/assistance stale 后才能继续",
      };
    }
    if (input.staleRecheck.stale) {
      return {
        allowed: false,
        violatedBound: "pauseTtlStaleRecheck",
        reason: "Pause 恢复后检测到 stale，禁止继续（无正式副作用）",
      };
    }
  }
  return { allowed: true, violatedBound: null, reason: null };
}

// ─── 7. Supervisor staging plan（0 canonical write）──────────────────────

/**
 * Supervisor staging plan。
 *
 * **0 canonical write 语义（类型 + 注释双重保证）**：
 * - `entries` 的元素类型是 `LearningStagingResult`（kind="learning_staging"，
 *   canonicalWrite=false 字面量）——编译器在类型层面禁止把 staging 结果当 canonical 结果消费；
 * - `canonicalWrite: false` 是字面量类型字段；
 * - canonical 事实（mastery / schedule / published semantic relation / canonical Card /
 *   review outcome / validation_point_assessments）只允许由 deterministic COMMIT
 *   （01-1 §5 固定锁序 + 完整 CAS，任务 03-6/06）投影产生；
 * - 本模块全程不写掌握 / schedule 真值，不替用户完成答案，不新增评分目标。
 */
export interface SupervisorStagingPlan {
  entries: LearningStagingResult[];
  /** 字面量 false：本 plan 永不表示 canonical 写成功 */
  canonicalWrite: false;
  counts: { route: number; probe: number; scene: number; assessment: number; audit: number };
}

function makeStaging(
  stagingKind: LearningStagingResult["stagingKind"],
  stagingRef: string,
  hashSeed: string,
  status: LearningStagingResult["status"],
): LearningStagingResult {
  return {
    kind: "learning_staging",
    stagingKind,
    stagingRef,
    stagingHash: hashText(hashSeed),
    status,
    canonicalWrite: false,
  };
}

/**
 * 生成 Supervisor 全程 staging plan（编排中要落的所有隔离 staging 记录）。
 * 全部条目 canonicalWrite=false；不产生任何 canonical 写。
 */
export function stagingPlan(input: {
  sessionId: string;
  episodeId: string;
  episodeTargetFingerprint: string;
  routeId: string | null;
  probeCount: number;
  hasAssessmentReport: boolean;
}): SupervisorStagingPlan {
  const entries: LearningStagingResult[] = [];
  const counts = { route: 0, probe: 0, scene: 0, assessment: 0, audit: 0 };

  if (input.routeId !== null) {
    entries.push(makeStaging("route", input.routeId, `${input.episodeId}:route:${input.routeId}`, "prepared"));
    counts.route += 1;
  }
  for (let i = 1; i <= input.probeCount; i += 1) {
    const probeRef = `${input.episodeId}:probe:${i}`;
    entries.push(makeStaging("probe", probeRef, `${probeRef}:${input.episodeTargetFingerprint}`, "approved"));
    counts.probe += 1;
  }
  if (input.hasAssessmentReport) {
    const assessmentRef = `${input.episodeId}:assessment`;
    entries.push(makeStaging("assessment", assessmentRef, `${assessmentRef}:${input.episodeTargetFingerprint}`, "prepared"));
    counts.assessment += 1;
  }
  const auditRef = `${input.episodeId}:audit`;
  entries.push(makeStaging("audit", auditRef, `${auditRef}:${input.episodeTargetFingerprint}`, "prepared"));
  counts.audit += 1;

  return { entries, canonicalWrite: false, counts };
}

// ─── 8. 默认 Loop 策略导出（供编排运行使用 W0 冻结值）────────────────────

/** 默认 Agent Loop 硬边界策略（W0 冻结值；预算策略由 PREPARE 冻结不可修改） */
export const DEFAULT_LOOP_POLICY: LearningBudgetPolicy = createDefaultLearningBudgetPolicy();
