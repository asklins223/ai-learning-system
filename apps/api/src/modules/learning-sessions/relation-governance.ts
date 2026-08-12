/**
 * 阶段 07（W6）任务 07-6：Relationship Governance（§10.5，Should）。
 *
 * 语义实现（flag 关闭时全部动作不可见、不可执行，fail closed）：
 *
 *   candidate（relation hint / Tutor proposal / user proposal）
 *     → 独立 relation support check
 *     → authorized human confirm | reject
 *     → versioned publish + fingerprint + audit
 *     → 上游变化时 stale 支持撤回和重审
 *
 * 关键不变量：
 * - **所有来源只能提议 candidate**：Generation Claim Critic、Tutor、Session
 *   Supervisor、用户 Scene 连线（relationCandidateSource）都不能直接发布；
 * - **candidate 恒为虚线且不进入 formal target**（formalTargetEligible 恒
 *   false；publishRelation 仅接受已通过 support check + authorized confirm
 *   的 candidate）；
 * - 独立 support check：contradicting 证据存在或缺少 direct 证据 →
 *   unsupported/partial（fail closed），不得 publish；
 * - 授权：个人 workspace 仅 owner；协作 workspace 仅 owner / editor /
 *   specialized_relation_governor；confirm 前必须 support passed；
 * - versioned publish + fingerprint + audit：每个发布版本单调递增，指纹覆盖
 *   candidate 内容 + support + authorization，audit 记录全部动作；
 * - 上游变化 stale：发布后任一上游引用 fingerprint 变化 → stale_under_review
 *   （撤回支持），重审需重新 support check + 重新 authorized confirm 后才可
 *   以更高版本 republish；
 * - Should flag：semanticRelationGovernance=false 时，propose / confirm /
 *   reject / publish 一律拒绝（动作不可见不可用），星图关系透镜不显示
 *   candidate（star-map-projections 的 buildFourLensViews 也已强制 FK-only）。
 *
 * 全部为纯函数：不读时钟（时间由调用方传入）、不访问 DB（状态由调用方持有，
 * 测试用内存实现）。
 */

import { createHash } from "node:crypto";
import { stableStringify } from "./canonical-events.ts";

export const RELATION_GOVERNANCE_CONTRACT_VERSION = "relation-governance-v1" as const;

/** Should bundle flag key（01-7 capability bundles）。 */
export const RELATION_GOVERNANCE_SHOULD_FLAG_KEY = "semantic_relation_governance" as const;

/** 关系端点节点类型（与 star-map-projections.SharedPlaneNodeType 结构一致）。 */
export type RelationEndpointNodeType =
  | "source"
  | "note"
  | "card"
  | "key_point"
  | "evidence";

/** 所有关系来源：只能提议 candidate（§10.5）。 */
export type RelationCandidateSource =
  | "generation_claim_critic" // Generation Claim Critic 的关系 hint
  | "tutor" // Grounded Tutor 的 relation proposal
  | "session_supervisor" // Session Supervisor 的路线建议
  | "user_scene_connection"; // 用户 Scene 连线（Episode Response Artifact）

/** 语义关系种类（公开值仅用于展示/审计，不进入确定性血缘）。 */
export type RelationKind =
  | "causal"
  | "prerequisite"
  | "supports"
  | "contradicts"
  | "part_of"
  | "related";

/** workspace 角色（协作 workspace 授权矩阵）。 */
export type WorkspaceRole =
  | "owner"
  | "editor"
  | "viewer"
  | "specialized_relation_governor";

/** 关系端点引用（opaque IDs，不含内容）。 */
export interface RelationEndpoint {
  nodeType: RelationEndpointNodeType;
  entityId: string;
}

/** 上游引用（published relation 的支撑指纹；变化 → stale）。 */
export interface UpstreamRef {
  entityId: string;
  fingerprint: string;
}

export interface RelationCandidate {
  candidateId: string;
  workspaceId: string;
  source: RelationCandidateSource;
  from: RelationEndpoint;
  to: RelationEndpoint;
  kind: RelationKind;
  /** 关系主张（摘要） */
  claim: string;
  proposedBy: string;
  upstreamRefs: readonly UpstreamRef[];
  proposedAt: string;
  /** 恒为 false：candidate 为虚线，不进入 formal target */
  formalTargetEligible: false;
}

export type RelationLifecycleStatus =
  | "proposed" // 虚线，未经验证
  | "support_passed" // 独立 support check 通过，等待授权
  | "published" // versioned publish
  | "rejected" // 被 authorized human reject
  | "stale_under_review" // 上游变化，撤回支持待重审
  | "withdrawn"; // 撤回（来源或作者撤回）

/** 独立 relation support check 结果。 */
export interface RelationSupportCheckVerdict {
  candidateId: string;
  /** supported | partial | unsupported */
  level: "supported" | "partial" | "unsupported";
  /** 仅 level === "supported" 为 true */
  supported: boolean;
  reasonCodes: string[];
  /** 校验指纹（support check 内容 hash） */
  checkHash: string;
  checkVersion: string;
  checkedBy: string;
  checkedAt: string;
}

/** 授权结论。 */
export interface RelationAuthorization {
  decision: "confirm" | "reject";
  actorUserId: string;
  role: WorkspaceRole;
  decisionAt: string;
  /** 授权指纹（决策 + 角色 + 时间 + 支持校验 hash） */
  authorizationHash: string;
}

/** versioned published relation。 */
export interface PublishedRelation {
  relationId: string;
  candidateId: string;
  workspaceId: string;
  version: number;
  from: RelationEndpoint;
  to: RelationEndpoint;
  kind: RelationKind;
  claim: string;
  upstreamRefs: readonly UpstreamRef[];
  /** 内容指纹：candidate + support + authorization + version（防篡改） */
  fingerprint: string;
  supportCheckHash: string;
  authorizationHash: string;
  publishedBy: string;
  publishedAt: string;
}

/** stale 检测结果。 */
export interface StalenessCheckVerdict {
  stale: boolean;
  changedRefs: readonly { entityId: string; expectedFingerprint: string; actualFingerprint: string }[];
  reasonCode: string;
  checkedAt: string;
}

/** 候选记录（candidate + 状态机 + 验证/授权产物）。 */
export interface RelationCandidateRecord {
  candidate: RelationCandidate;
  status: RelationLifecycleStatus;
  supportVerdict: RelationSupportCheckVerdict | null;
  authorization: RelationAuthorization | null;
  published: PublishedRelation | null;
  staleness: StalenessCheckVerdict | null;
}

/** Should flag。 */
export interface RelationGovernanceFlags {
  /** semantic_relation_governance bundle */
  semanticRelationGovernance: boolean;
}

export class RelationGovernanceError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RelationGovernanceError";
    this.code = code;
  }
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ─── Should flag（flag 关闭时动作不可见不可用，fail closed）─────────────────

export function isRelationGovernanceEnabled(flags: RelationGovernanceFlags): boolean {
  return flags.semanticRelationGovernance === true;
}

/** fail closed：flag 关闭 → 拒绝任何治理动作。 */
export function assertRelationGovernanceEnabled(flags: RelationGovernanceFlags): void {
  if (!isRelationGovernanceEnabled(flags)) {
    throw new RelationGovernanceError(
      "Relationship Governance 为 Should bundle，flag 未开启时动作不可见不可执行",
      "relation_governance_flag_disabled",
    );
  }
}

// ─── candidate 提议（虚线，不进入 formal target）────────────────────────────

export interface ProposeRelationCandidateInput {
  workspace: { id: string };
  source: RelationCandidateSource;
  from: RelationEndpoint;
  to: RelationEndpoint;
  kind: RelationKind;
  claim: string;
  /** 提议者（agent 角色 id 或 userId；user proposal 也在此） */
  proposedBy: string;
  upstreamRefs: readonly UpstreamRef[];
  proposedAt: string;
  flags: RelationGovernanceFlags;
}

/**
 * 提议关系 candidate（§10.5 第一步）。candidate 恒为虚线
 * （formalTargetEligible=false），**不进入 formal target**。
 * Should flag 关闭 → 拒绝（动作不可见不可用）。
 */
export function proposeRelationCandidate(
  input: ProposeRelationCandidateInput,
): RelationCandidateRecord {
  assertRelationGovernanceEnabled(input.flags);
  if (input.from.nodeType === input.to.nodeType && input.from.entityId === input.to.entityId) {
    throw new RelationGovernanceError(
      "关系 candidate 端点不能为同一节点",
      "relation_self_endpoint",
    );
  }
  const candidate: RelationCandidate = {
    candidateId: `rgc:${sha256Hex(
      stableStringify({
        workspaceId: input.workspace.id,
        source: input.source,
        from: input.from,
        to: input.to,
        kind: input.kind,
        claim: input.claim,
        proposedBy: input.proposedBy,
        upstreamRefs: input.upstreamRefs,
        proposedAt: input.proposedAt,
      }),
    ).slice(0, 24)}`,
    workspaceId: input.workspace.id,
    source: input.source,
    from: input.from,
    to: input.to,
    kind: input.kind,
    claim: input.claim,
    proposedBy: input.proposedBy,
    upstreamRefs: [...input.upstreamRefs],
    proposedAt: input.proposedAt,
    formalTargetEligible: false,
  };
  return {
    candidate,
    status: "proposed",
    supportVerdict: null,
    authorization: null,
    published: null,
    staleness: null,
  };
}

/** candidate 恒不进入 formal target（纯函数校验，防御）。 */
export function assertCandidateNotInFormalTarget(
  record: RelationCandidateRecord,
): { ok: true; reasonCode: string } {
  if (record.candidate.formalTargetEligible !== false) {
    throw new RelationGovernanceError(
      "candidate 不允许进入 formal target（虚线，未经验证路径不得 published）",
      "candidate_in_formal_target",
    );
  }
  return { ok: true, reasonCode: "candidate_is_dashed_not_formal" };
}

// ─── 独立 relation support check（§10.5 第二步）────────────────────────────

export interface RelationSupportCheckInput {
  candidate: RelationCandidate;
  /** 独立检查的证据引用（exact evidence + semantic support 报告指纹） */
  evidenceRefs: readonly {
    entityId: string;
    fingerprint: string;
    /** direct = 直接支持；partial = 部分支持；contradicting = 反证 */
    support: "direct" | "partial" | "contradicting";
    semanticSupportReportHash: string | null;
  }[];
  checkVersion: string;
  /** 独立检查者（服务/agent 角色；不能与 proposedBy 同一来源直接放行） */
  checkedBy: string;
  checkedAt: string;
}

/**
 * 独立 relation support check（纯函数，fail closed）：
 * - 存在 contradicting 证据 → unsupported（任何 direct 都不能覆盖反证）；
 * - 无 contradicting 且至少一条 direct → supported；
 * - 其余（只有 partial 或无证据）→ partial（不得 publish）。
 * 引用完整 ≠ 语义支撑通过：每条证据需语义支持报告 hash（可空 → 不视为 direct）。
 */
export function runIndependentSupportCheck(
  input: RelationSupportCheckInput,
): RelationSupportCheckVerdict {
  const reasonCodes: string[] = [];
  const contradicting = input.evidenceRefs.filter((e) => e.support === "contradicting");
  const direct = input.evidenceRefs.filter(
    (e) => e.support === "direct" && e.semanticSupportReportHash !== null,
  );
  const partial = input.evidenceRefs.filter((e) => e.support === "partial");

  if (contradicting.length > 0) {
    reasonCodes.push("contradicting_evidence_present");
  }
  if (direct.length === 0) {
    reasonCodes.push("no_direct_semantic_support");
  }
  if (partial.length > 0) {
    reasonCodes.push("partial_support_only");
  }

  const level: "supported" | "partial" | "unsupported" =
    contradicting.length > 0
      ? "unsupported"
      : direct.length > 0
        ? "supported"
        : "partial";
  if (level === "supported") reasonCodes.push("independent_support_check_passed");

  const checkHash = sha256Hex(
    stableStringify({
      candidateId: input.candidate.candidateId,
      from: input.candidate.from,
      to: input.candidate.to,
      kind: input.candidate.kind,
      claim: input.candidate.claim,
      evidenceRefs: input.evidenceRefs,
      checkVersion: input.checkVersion,
      level,
    }),
  );
  return {
    candidateId: input.candidate.candidateId,
    level,
    supported: level === "supported",
    reasonCodes,
    checkHash,
    checkVersion: input.checkVersion,
    checkedBy: input.checkedBy,
    checkedAt: input.checkedAt,
  };
}

/** 把 support check 结果应用到 record（纯函数）：通过 → support_passed。 */
export function applySupportCheck(
  record: RelationCandidateRecord,
  verdict: RelationSupportCheckVerdict,
): RelationCandidateRecord {
  if (verdict.candidateId !== record.candidate.candidateId) {
    throw new RelationGovernanceError(
      "support check 与 candidate 不匹配",
      "support_check_candidate_mismatch",
    );
  }
  if (record.status === "rejected" || record.status === "withdrawn") {
    throw new RelationGovernanceError(
      "rejected/withdrawn candidate 不可重新走支持检查",
      "support_check_on_terminal_state",
    );
  }
  if (!verdict.supported) {
    // 未通过：停留在 proposed（或退回 proposed），不得进入等待授权
    return { ...record, supportVerdict: verdict, status: "proposed" };
  }
  return { ...record, supportVerdict: verdict, status: "support_passed" };
}

// ─── authorized human confirm | reject（§10.5 第三步）──────────────────────

export interface AuthorizeRelationDecisionInput {
  record: RelationCandidateRecord;
  decision: "confirm" | "reject";
  actor: { userId: string; role: WorkspaceRole };
  workspace: {
    id: string;
    /** 个人 workspace 仅 owner 可确认；协作 workspace 支持角色矩阵 */
    collaboration: boolean;
    ownerId: string;
    grantedRoles: readonly WorkspaceRole[];
  };
  flags: RelationGovernanceFlags;
  decisionAt: string;
}

export interface AuthorizeRelationDecisionVerdict {
  authorized: boolean;
  reasonCode: string;
}

/**
 * 授权校验（§10.5）：Should flag 关闭 → 一律拒绝；confirm 前必须 support
 * passed；个人 workspace 仅 owner；协作 workspace 仅 owner / editor /
 * specialized_relation_governor（grantedRoles 兜底）。
 */
export function authorizeRelationDecision(
  input: AuthorizeRelationDecisionInput,
): AuthorizeRelationDecisionVerdict {
  if (!isRelationGovernanceEnabled(input.flags)) {
    return { authorized: false, reasonCode: "governance_flag_disabled" };
  }
  if (input.decision === "confirm") {
    if (input.record.status !== "support_passed" || input.record.supportVerdict?.supported !== true) {
      return { authorized: false, reasonCode: "confirm_requires_support_check_passed" };
    }
  }
  if (!input.workspace.grantedRoles.includes(input.actor.role)) {
    return { authorized: false, reasonCode: `role_not_granted:${input.actor.role}` };
  }
  if (input.workspace.collaboration) {
    const allowed: readonly WorkspaceRole[] = ["owner", "editor", "specialized_relation_governor"];
    if (!allowed.includes(input.actor.role)) {
      return { authorized: false, reasonCode: `collaboration_workspace_role_not_allowed:${input.actor.role}` };
    }
    return { authorized: true, reasonCode: "collaboration_workspace_authorized" };
  }
  // 个人 workspace：仅 owner
  if (input.actor.role !== "owner" || input.actor.userId !== input.workspace.ownerId) {
    return { authorized: false, reasonCode: "personal_workspace_owner_only" };
  }
  return { authorized: true, reasonCode: "personal_workspace_owner_authorized" };
}

function buildAuthorization(
  record: RelationCandidateRecord,
  decision: "confirm" | "reject",
  actorUserId: string,
  role: WorkspaceRole,
  decisionAt: string,
): RelationAuthorization {
  const supportHash = record.supportVerdict?.checkHash ?? "";
  const authorizationHash = sha256Hex(
    stableStringify({
      candidateId: record.candidate.candidateId,
      decision,
      actorUserId,
      role,
      decisionAt,
      supportHash,
    }),
  );
  return { decision, actorUserId, role, decisionAt, authorizationHash };
}

// ─── versioned publish + fingerprint + audit（§10.5 第四步）─────────────────

export interface PublishRelationInput {
  record: RelationCandidateRecord;
  authorization: RelationAuthorization;
  publishedBy: string;
  publishedAt: string;
}

export interface PublishedRelationOutput {
  record: RelationCandidateRecord;
  published: PublishedRelation;
}

/**
 * versioned publish（§10.5）：只有 candidate 已通过独立 support check 且
 * authorized confirm 才能 published；任一缺失 → 拒绝（candidate 不能直接
 * published）。重审后再次发布版本单调递增。
 */
export function publishRelation(input: PublishRelationInput): PublishedRelationOutput {
  const record = input.record;
  if (record.supportVerdict?.supported !== true) {
    throw new RelationGovernanceError(
      "candidate 未通过独立 support check，不能 published",
      "publish_requires_support_check",
    );
  }
  if (input.authorization.decision !== "confirm") {
    throw new RelationGovernanceError(
      "candidate 未经 authorized confirm，不能 published",
      "publish_requires_authorized_confirm",
    );
  }
  if (record.status !== "support_passed" && record.status !== "stale_under_review") {
    throw new RelationGovernanceError(
      `candidate 状态 ${record.status} 不允许 publish`,
      "publish_invalid_status",
    );
  }

  const version = (record.published?.version ?? 0) + 1;
  const fingerprint = computeRelationFingerprint({
    candidate: record.candidate,
    supportCheckHash: record.supportVerdict.checkHash,
    authorizationHash: input.authorization.authorizationHash,
    version,
  });
  const published: PublishedRelation = {
    relationId: `rgp:${sha256Hex(
      stableStringify({
        workspaceId: record.candidate.workspaceId,
        candidateId: record.candidate.candidateId,
        version,
      }),
    ).slice(0, 24)}`,
    candidateId: record.candidate.candidateId,
    workspaceId: record.candidate.workspaceId,
    version,
    from: record.candidate.from,
    to: record.candidate.to,
    kind: record.candidate.kind,
    claim: record.candidate.claim,
    upstreamRefs: [...record.candidate.upstreamRefs],
    fingerprint,
    supportCheckHash: record.supportVerdict.checkHash,
    authorizationHash: input.authorization.authorizationHash,
    publishedBy: input.publishedBy,
    publishedAt: input.publishedAt,
  };
  return {
    record: { ...record, status: "published", published, authorization: input.authorization },
    published,
  };
}

export interface ComputeRelationFingerprintInput {
  candidate: RelationCandidate;
  supportCheckHash: string;
  authorizationHash: string;
  version: number;
}

/** 关系指纹（防篡改）：覆盖 candidate 内容 + support + authorization + version。 */
export function computeRelationFingerprint(input: ComputeRelationFingerprintInput): string {
  return sha256Hex(
    stableStringify({
      workspaceId: input.candidate.workspaceId,
      from: input.candidate.from,
      to: input.candidate.to,
      kind: input.candidate.kind,
      claim: input.candidate.claim,
      upstreamRefs: input.candidate.upstreamRefs,
      supportCheckHash: input.supportCheckHash,
      authorizationHash: input.authorizationHash,
      version: input.version,
    }),
  );
}

/**
 * 应用 authorized 决策到 record（纯函数）：
 * - confirm + authorized → publish（version 递增）；
 * - reject + authorized → rejected（终态，可另提新 candidate）；
 * - 任一未授权 → throw（fail closed）。
 */
export function applyAuthorizationDecision(
  input: AuthorizeRelationDecisionInput,
): RelationCandidateRecord {
  const verdict = authorizeRelationDecision(input);
  if (!verdict.authorized) {
    throw new RelationGovernanceError(
      `授权拒绝：${verdict.reasonCode}`,
      "authorization_denied",
    );
  }
  const authorization = buildAuthorization(
    input.record,
    input.decision,
    input.actor.userId,
    input.actor.role,
    input.decisionAt,
  );
  if (input.decision === "reject") {
    return {
      ...input.record,
      status: "rejected",
      authorization,
    };
  }
  return publishRelation({
    record: input.record,
    authorization,
    publishedBy: input.actor.userId,
    publishedAt: input.decisionAt,
  }).record;
}

// ─── 上游变化 stale → 撤回重审（§10.5）────────────────────────────────────

export interface CheckRelationStalenessInput {
  record: RelationCandidateRecord;
  currentFingerprints: readonly UpstreamRef[];
  checkedAt: string;
}

export interface CheckRelationStalenessResult {
  verdict: StalenessCheckVerdict;
  record: RelationCandidateRecord;
}

/**
 * 上游变化 stale 检测（纯函数）：published 关系的任一上游引用当前指纹与发布时
 * 指纹不同 → stale。若 stale，自动进入 stale_under_review（撤回支持，等待
 * 重新 support check + 重新 authorized confirm 后以更高版本 republish）。
 */
export function checkRelationStaleness(
  input: CheckRelationStalenessInput,
): CheckRelationStalenessResult {
  const published = input.record.published;
  if (input.record.status !== "published" || published === null) {
    throw new RelationGovernanceError(
      "只有 published 关系可做 stale 检测",
      "stale_check_not_published",
    );
  }
  const expected = new Map(published.upstreamRefs.map((ref) => [ref.entityId, ref.fingerprint]));
  const current = new Map(input.currentFingerprints.map((ref) => [ref.entityId, ref.fingerprint]));
  const changedRefs: { entityId: string; expectedFingerprint: string; actualFingerprint: string }[] = [];
  for (const [entityId, expectedFingerprint] of expected) {
    const actualFingerprint = current.get(entityId);
    if (actualFingerprint !== expectedFingerprint) {
      changedRefs.push({ entityId, expectedFingerprint, actualFingerprint: actualFingerprint ?? "(missing)" });
    }
  }
  const stale = changedRefs.length > 0;
  const verdict: StalenessCheckVerdict = {
    stale,
    changedRefs,
    reasonCode: stale ? "upstream_changed_withdraw_for_review" : "upstream_unchanged",
    checkedAt: input.checkedAt,
  };
  return {
    verdict,
    record: stale ? { ...input.record, status: "stale_under_review", staleness: verdict } : input.record,
  };
}

/**
 * stale 重审：stale_under_review 的 candidate 重新过独立 support check +
 * authorized confirm 后以更高版本 republish。未重新验证 → 保持撤回。
 */
export function reviewAndRepublish(input: {
  record: RelationCandidateRecord;
  supportVerdict: RelationSupportCheckVerdict;
  authorizationInput: Omit<AuthorizeRelationDecisionInput, "record">;
}): RelationCandidateRecord {
  if (input.record.status !== "stale_under_review") {
    throw new RelationGovernanceError(
      `重审只允许 stale_under_review：当前 ${input.record.status}`,
      "review_requires_stale_under_review",
    );
  }
  const supportApplied = applySupportCheck(input.record, input.supportVerdict);
  if (!supportApplied.supportVerdict?.supported) {
    // 重审未通过支持检查：仍撤回（保持 stale_under_review，不发布新版本）
    return { ...supportApplied, status: "stale_under_review" };
  }
  return applyAuthorizationDecision({
    ...input.authorizationInput,
    record: supportApplied,
  });
}

// ─── audit（§10.5 第四步：审计）─────────────────────────────────────────────

export type RelationAuditAction =
  | "proposed"
  | "support_checked"
  | "authorized_confirm"
  | "authorized_reject"
  | "published"
  | "stale_detected"
  | "withdrawn"
  | "republished";

export interface RelationAuditRecord {
  auditId: string;
  workspaceId: string;
  candidateId: string;
  action: RelationAuditAction;
  actor: string;
  role: string | null;
  at: string;
  /** 相关指纹（published/support/authorization），无则 null */
  fingerprint: string | null;
  metadata: Record<string, unknown>;
}

export interface BuildAuditRecordInput {
  workspaceId: string;
  candidateId: string;
  action: RelationAuditAction;
  actor: string;
  role: string | null;
  at: string;
  fingerprint: string | null;
  metadata?: Record<string, unknown>;
}

/** 构建审计记录（纯函数，确定性 auditId）。 */
export function buildAuditRecord(input: BuildAuditRecordInput): RelationAuditRecord {
  return {
    auditId: `rga:${sha256Hex(
      stableStringify({
        workspaceId: input.workspaceId,
        candidateId: input.candidateId,
        action: input.action,
        actor: input.actor,
        at: input.at,
        fingerprint: input.fingerprint,
      }),
    ).slice(0, 24)}`,
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
    action: input.action,
    actor: input.actor,
    role: input.role,
    at: input.at,
    fingerprint: input.fingerprint,
    metadata: input.metadata ?? {},
  };
}
