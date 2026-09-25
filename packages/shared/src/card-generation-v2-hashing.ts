/**
 * 方案 20 Generation 域 hash 计算（C1 交付，服务端专用）。
 *
 * §9.5：所有方案 20 hash 共用版本化 canonical serializer（hash-canonical-v2），
 * 禁止各模块直接 JSON.stringify。本文件依赖 node:crypto（惰性），从子路径
 * `@ailearn/shared/card-generation-v2-hashing` 导入，不进入 index 全量导出
 * （客户端 bundle 约定，见 index.ts 2026-08-13 注释）。
 */

import {
  hashCanonicalV2,
  hashIdSetV2,
  hashSetElementsV2,
} from "./hash-canonical-v2.ts";
import type {
  CardPlanV2,
  CardSetGateReportV2,
  GenerationInputSnapshotV2,
  GenerationSemanticSpecV2,
  LearningCardCandidateRevisionV2,
  ObjectiveRubricV2,
} from "./card-generation-v2-contracts.ts";
import type {
  ObjectiveEquivalenceReportV2,
  ObjectiveEquivalenceBindingV2,
} from "./learning-card-v2-contracts.ts";

/** §15.6 semanticTargetFingerprint */
export function computeSemanticTargetFingerprintV2(input: {
  workspaceId: string;
  objectiveId: string;
  semanticIdentityClassId: string;
  semanticIdentityPolicyVersion: string;
}): string {
  return hashCanonicalV2("learning-objective-semantic-identity-v2", input);
}

/** §15.6 targetRevisionHash */
export function computeTargetRevisionHashV2(input: {
  semanticTargetFingerprint: string;
  objectiveRevision: number;
  objectiveStatement: string;
  publicSummary: string;
  // Plan 23 W1-05：概念级标题参与 target revision hash（2026-08-22 补）。
  // 历史快照不含该输入：hash 每次写入时重算，不存在跨版本比对问题。
  conceptLabel: string;
  knowledgeForm: string;
  canonicalAnswerHash: string;
  learningSupportHash: string;
  rubricHash: string;
  relationsHash: string;
  // 0245：客观练习件（后加的哈希输入，与上面 conceptLabel 同理 —— hash 每次写入
  // 时重算，历史快照不参与跨版本比对）。
  practiceItemHash: string;
  evidenceBindingSetHash: string;
  semanticSupportReportSetHash: string;
}): string {
  return hashCanonicalV2("learning-objective-target-revision-v2", input);
}

/** §15.6 privatePayloadHash */
export function computePrivatePayloadHashV2(input: {
  canonicalAnswerHash: string;
  rubricHash: string;
  learningSupportHash: string;
}): string {
  return hashCanonicalV2("learning-objective-private-payload-v2", input);
}

/** §15.6 cardPresentationHash */
export function computeCardPresentationHashV2(input: {
  workspaceId: string;
  cardId: string;
  cardRevision: number;
  front: unknown;
  strategy: string;
  publicSerializationPolicyVersion: string;
}): string {
  return hashCanonicalV2("learning-card-presentation-v2", input);
}

/** §15.6 cardPublicationPublicPayloadHash */
export function computeCardPublicationPublicPayloadHashV2(input: {
  workspaceId: string;
  cardId: string;
  publicationRevision: number;
  cardPresentationHash: string;
  objectiveId: string;
  objectiveRevision: number;
  publicSummaryHash: string;
  knowledgeForm: string;
  lifecycle: string;
  sourceLabel: string | null;
  publicSerializationPolicyVersion: string;
}): string {
  return hashCanonicalV2("learning-card-publication-public-v2", input);
}

/** §15.6 cardPublicationRevealPayloadHash */
export function computeCardPublicationRevealPayloadHashV2(input: {
  workspaceId: string;
  cardId: string;
  publicationRevision: number;
  targetRevisionHash: string;
  evidencePreviewPolicyVersion: string;
}): string {
  return hashCanonicalV2("learning-card-publication-reveal-v2", input);
}

/** §15.6 exposureScopeId */
export function computeExposureScopeIdV2(input: {
  workspaceId: string;
  objectiveId: string;
}): string {
  return hashCanonicalV2("learning-objective-exposure-v2", input);
}

/** §9.2：semantic hash 明确排除 noteVersionId/clientRequestId/idempotency/reusePolicy。 */
export function computeGenerationSemanticSpecHashV2(
  spec: Omit<GenerationSemanticSpecV2, "semanticSpecHash">,
): string {
  return hashCanonicalV2("card-generation-v2/semantic-spec", {
    semanticRequest: spec.semanticRequest,
    policies: spec.policies,
    governancePolicyVersion: spec.governancePolicyVersion,
  });
}

/** §9.3 generation fingerprint：identity + source 内容 + semantic spec。 */
export function computeGenerationFingerprintV2(input: {
  workspaceId: string;
  noteVersionId: string;
  sourceContentHash: string;
  blockManifestHash: string;
  assetManifestHash: string;
  scopeManifestHash: string;
  generationSemanticSpecHash: string;
}): string {
  return hashCanonicalV2("card-generation-v2/fingerprint", {
    workspaceId: input.workspaceId,
    noteVersionId: input.noteVersionId,
    sourceContentHash: input.sourceContentHash,
    blockManifestHash: input.blockManifestHash,
    assetManifestHash: input.assetManifestHash,
    scopeManifestHash: input.scopeManifestHash,
    generationSemanticSpecHash: input.generationSemanticSpecHash,
  });
}

export function computeInputSnapshotHashV2(
  snapshot: Omit<GenerationInputSnapshotV2, "inputSnapshotHash">,
): string {
  return hashCanonicalV2("card-generation-v2/input-snapshot", snapshot);
}

/** §8.5：planHash 覆盖 plan 的不可变语义内容（排除自引用 planHash）。 */
export function computeCardPlanHashV2(
  plan: Omit<CardPlanV2, "planHash">,
): string {
  return hashCanonicalV2("card-generation-v2/card-plan", plan);
}

/** §11.3：rubric 属 server-private 合同，不进 public DTO。 */
export function computeRubricHashV2(
  rubric: Omit<ObjectiveRubricV2, "rubricHash">,
): string {
  return hashCanonicalV2("card-generation-v2/objective-rubric", rubric);
}

// ─── §15.6 targetRevisionHash 组件哈希（统一域，生产/消费两侧必须一致）──

/** canonicalAnswer 组件哈希（域与 activation/adapter 两侧统一）。 */
export function computeCanonicalAnswerHashV2(input: unknown): string {
  return hashCanonicalV2("objective-canonical-answer-v2", input);
}

/** learningSupport 组件哈希。 */
export function computeLearningSupportHashV2(input: unknown): string {
  return hashCanonicalV2("objective-learning-support-v2", input);
}

/** relations 组件哈希。 */
export function computeRelationsHashV2(input: unknown): string {
  return hashCanonicalV2("objective-relations-v2", input);
}

/**
 * 0245 practiceItem 组件哈希。
 *
 * 与 hints 相反：练习件的正确项是**判分内容**，必须进 target revision hash 闭包
 * （用户 2026-09-20 的原话是"提示不能进判分内容的同一条审计链"，反过来说判分内容
 * 就必须在里面）。没有练习件时用固定标记参与哈希，而不是跳过该输入 —— 跳过会让
 * "没有练习件"和"这一版还没算练习件"两种状态撞出同一个 hash。
 */
export function computePracticeItemHashV2(input: unknown): string {
  return hashCanonicalV2(
    "objective-practice-item-v2",
    input ?? { absent: "no-practice-item" },
  );
}

/**
 * §15.6 semanticSupportReportSetHash：set 语义（§9.5 按稳定 element hash
 * 排序）。当前无 semantic support report 时传空数组得到稳定空集哈希。
 */
export function computeSemanticSupportReportSetHashV2(
  reportHashes: string[],
): string {
  return hashCanonicalV2("objective-semantic-support-report-set-v2", {
    sortedReportHashes: hashIdSetV2(reportHashes),
  });
}

// ─── §14.3 Evidence hash 闭包 ───────────────────────────────────────────

/**
 * §14.3 evidenceSnapshotHash：
 * H("evidence-snapshot-v2" + evidence kind + workspaceId + sourceSnapshotId
 *   + note/block/asset exact locator + protected content hash
 *   + source/block/asset version hashes + modality/support metadata)
 */
export function computeEvidenceSnapshotHashV2(input: {
  kind: "text" | "region";
  workspaceId: string;
  sourceSnapshotId: string;
  noteId: string | null;
  blockId: string | null;
  startOffset?: number;
  endOffset?: number;
  assetId?: string;
  assetVersionHash?: string;
  protectedContentHash: string;
  sourceContentHash: string;
  blockContentHash?: string;
  modality?: string;
  supportDescription?: string;
}): string {
  return hashCanonicalV2("evidence-snapshot-v2", input);
}

/**
 * 证据预览的落点状态（doc 34 L21 §2）。
 *
 * 密封时写下的两个哈希是"这张卡当初对齐的是哪段文字"的唯一凭据：
 * `block` 域锚住整块内容，`evidence-quote` 域锚住切片。笔记会被就地改写，
 * 块也可能被删掉（`note/document-state.ts` 的 stale 清理），所以任何"把原文
 * 切给界面看"的读点都必须先复算这两个域，否则展示的是**现在的**文字，
 * 而用户以为自己在核对**当初的**依据。与 `evidence-seal-core.ts:211-213` 同一对域。
 */
export const EVIDENCE_PREVIEW_SOURCE_STATES_V2 = ["located", "drifted", "missing"] as const;
export type EvidencePreviewSourceStateV2 =
  (typeof EVIDENCE_PREVIEW_SOURCE_STATES_V2)[number];

export function classifyEvidencePreviewV2(input: {
  /** 当前块正文；块行不存在（或证据没有 blockId）时为 null。 */
  blockContent: string | null;
  blockContentHash: string | null;
  quoteHash: string | null;
  startOffset: number | null;
  endOffset: number | null;
}): { state: EvidencePreviewSourceStateV2; quote: string } {
  if (input.blockContent === null) return { state: "missing", quote: "" };
  const blockChanged =
    typeof input.blockContentHash !== "string"
    || hashCanonicalV2("block", { content: input.blockContent }) !== input.blockContentHash;
  const start = input.startOffset ?? 0;
  const end = input.endOffset ?? input.blockContent.length;
  const spanAddressable = Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && end > start && end <= input.blockContent.length;
  const quote = spanAddressable ? input.blockContent.slice(start, end) : "";
  const quoteChanged = !spanAddressable
    || typeof input.quoteHash !== "string"
    || hashCanonicalV2("evidence-quote", { quote }) !== input.quoteHash;
  if (blockChanged || quoteChanged) return { state: "drifted", quote };
  return { state: "located", quote };
}

/**
 * §14.3 candidateEvidenceSetHash：
 * H("candidate-evidence-set-v2" + sorted(evidenceSnapshotId + evidenceSnapshotHash))
 */
export function computeCandidateEvidenceSetHashV2(
  entries: Array<{ evidenceSnapshotId: string; evidenceSnapshotHash: string }>,
): string {
  const sorted = hashSetElementsV2(entries);
  return hashCanonicalV2("candidate-evidence-set-v2", { sortedEvidence: sorted });
}

/**
 * §14.3 candidateEvidenceBindingPlanHash：
 * H("candidate-evidence-binding-plan-v2" + candidateRevisionId
 *   + sorted(targetUnit + evidenceSnapshotId + evidenceSnapshotHash
 *     + relation + supportStrength + semanticSupportReportId/hash
 *     + optional derivationReportId/hash))
 */
export function computeCandidateEvidenceBindingPlanHashV2(input: {
  candidateRevisionId: string;
  bindings: Array<Record<string, unknown>>;
}): string {
  const sorted = hashSetElementsV2(input.bindings);
  return hashCanonicalV2("candidate-evidence-binding-plan-v2", {
    candidateRevisionId: input.candidateRevisionId,
    sortedBindings: sorted,
  });
}

/**
 * §14.3 evidenceBindingHash：
 * H("objective-evidence-binding-v2" + objectiveRevisionId + targetUnit
 *   + evidenceSnapshotId + evidenceSnapshotHash + relation + supportStrength
 *   + semanticSupportReportId/hash + optional derivationReportId/hash)
 */
export function computeEvidenceBindingHashV2(input: {
  objectiveRevisionId: string;
  targetUnit: unknown;
  evidenceSnapshotId: string;
  evidenceSnapshotHash: string;
  relation: string;
  supportStrength: string;
  semanticSupportReportId: string;
  semanticSupportReportHash: string;
  derivationReportId?: string;
  derivationReportHash?: string;
}): string {
  return hashCanonicalV2("objective-evidence-binding-v2", input);
}

/**
 * §14.3 evidenceBindingSetHash：
 * H("objective-evidence-binding-set-v2" + sorted(bindingId + evidenceBindingHash))
 */
export function computeEvidenceBindingSetHashV2(
  entries: Array<{ bindingId: string; evidenceBindingHash: string }>,
): string {
  const sorted = hashSetElementsV2(entries);
  return hashCanonicalV2("objective-evidence-binding-set-v2", {
    sortedBindings: sorted,
  });
}

/**
 * §14.3 evidenceEligibilityVectorHash：
 * H("evidence-eligibility-vector-v2"
 *   + sorted(evidenceSnapshotId + eligibilityEpoch + status + stateHash))
 */
export function computeEvidenceEligibilityVectorHashV2(
  entries: Array<{
    evidenceSnapshotId: string;
    eligibilityEpoch: number;
    status: string;
    stateHash: string;
  }>,
): string {
  const sorted = hashSetElementsV2(entries);
  return hashCanonicalV2("evidence-eligibility-vector-v2", {
    sortedEligibility: sorted,
  });
}

// ─── §15.2 Reveal context hash ──────────────────────────────────────────

/** §15.2 candidateRevealContextHash。 */
export function computeCandidateRevealContextHashV2(input: {
  workspaceId: string;
  userId: string;
  candidateRevisionId: string;
  candidateRevisionHash: string;
  canonicalAnswerHash: string;
  revealPolicyVersion: string;
}): string {
  return hashCanonicalV2("candidate-reveal-v2", input);
}

/** §15.2 cardRevealContextHash。 */
export function computeCardRevealContextHashV2(input: {
  workspaceId: string;
  userId: string;
  objectiveId: string;
  exposureScopeId: string;
  publicationRevision: number;
  publicPayloadHash: string;
  revealPayloadHash: string;
  canonicalAnswerHash: string;
  revealPolicyVersion: string;
}): string {
  return hashCanonicalV2("card-reveal-v2", input);
}

// ─── §16.1 LearningTargetSnapshotV2 snapshotHash ────────────────────────

/**
 * §16.1 snapshotHash：绑定本次 Run 的 exact target 与 PREPARE 时 planning
 * exposure cutoff；同一 Objective 的不同 Run 因初始 exposure/eligibility
 * 不同可以拥有不同 Snapshot。
 */
export function computeLearningTargetSnapshotHashV2(input: {
  workspaceId: string;
  userId: string;
  runId: string;
  objectiveId: string;
  objectiveRevision: number;
  semanticTargetFingerprint: string;
  targetRevisionHash: string;
  cardContentEpoch: number;
  objectiveLifecycleEpoch: number;
  /**
   * 39d W3-4（D1 §4.3）：无卡目标可以进冻结链，所以这一组卡身份字段可空。
   * **必须传显式 `null`，不许省键**——`canonicalJsonV2` 把 `undefined` 整个跳过，
   * 省键与置空算出的是两个不同摘要（同一行数据会在两种构造路径下得到两个 hash）。
   * 已核对：非空输入下放宽类型不改动摘要（golden 向量见 learning-target-v2-contracts.test.ts）。
   */
  cardId: string | null;
  publicationRevision: number | null;
  cardRevision: number | null;
  publicPayloadHash: string | null;
  revealPayloadHash: string | null;
  canonicalAnswerHash: string;
  learningSupportHash: string;
  rubricHash: string;
  evidenceBindingSetHash: string;
  evidenceEligibilityVectorHash: string;
  planningExposure: {
    scope: "objective";
    lastExposedAt: string | null;
    exposureIds: string[];
    sameCueRecentlyRevealed: boolean;
    qualificationNotBefore: string | null;
    preRunRevealPolicyVersion: string;
  };
  lifecycleAtPrepare: "active";
  publishedTargetEligibility: "eligible" | "practice_only" | "blocked";
  targetSnapshotPolicyVersion: string;
}): string {
  return hashCanonicalV2("learning-target-snapshot-v2", input);
}

// ─── §5.4 Equivalence report/binding hash ───────────────────────────────

export function computeObjectiveEquivalenceReportHashV2(
  report: Omit<ObjectiveEquivalenceReportV2, "reportHash">,
): string {
  return hashCanonicalV2("learning-objective-equivalence-report-v2", report);
}

export function computeObjectiveEquivalenceBindingHashV2(
  binding: Omit<ObjectiveEquivalenceBindingV2, "bindingHash">,
): string {
  return hashCanonicalV2("learning-objective-equivalence-binding-v2", binding);
}

/**
 * §11.6 candidateRevisionHash：contractVersion + generationRunId + planHash +
 * stable objective draft + stable presentation draft + evidenceSetHash +
 * lineage。
 */
export function computeCandidateRevisionHashV2(
  candidate: Omit<LearningCardCandidateRevisionV2, "candidateRevisionHash">,
): string {
  return hashCanonicalV2("card-generation-v2/candidate-revision", candidate);
}

export function computeCardSetGateReportHashV2(
  report: Omit<CardSetGateReportV2, "reportHash">,
): string {
  return hashCanonicalV2("card-generation-v2/card-set-gate-report", report);
}

/**
 * §17.5 clientReviewHash：H(runId + expectedReviewDraftRevision + sorted
 * selected candidateId/revision/revisionHash + reviewUiContractVersion)。
 * set 语义（§9.5）按稳定 element hash 排序。
 */
export function computeClientReviewHashV2(input: {
  runId: string;
  expectedReviewDraftRevision: number;
  selected: Array<{
    candidateId: string;
    revision: number;
    revisionHash: string;
  }>;
  reviewUiContractVersion: string;
}): string {
  const selectedSet = hashIdSetV2(
    input.selected.map((s) => `${s.candidateId}:${s.revision}:${s.revisionHash}`),
  );
  return hashCanonicalV2("card-generation-v2/client-review", {
    runId: input.runId,
    expectedReviewDraftRevision: input.expectedReviewDraftRevision,
    selectedSet,
    reviewUiContractVersion: input.reviewUiContractVersion,
  });
}
