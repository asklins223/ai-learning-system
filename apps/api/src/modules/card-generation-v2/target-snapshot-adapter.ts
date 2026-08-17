/**
 * 方案 20 C5：LearningTargetSnapshotV2 Adapter。
 *
 * §16.1–16.3:
 * - PREPARE 从激活的 LearningObjectiveV2 + LearningCardV2 冻结完整
 *   LearningTargetSnapshotV2（全部 §16.1 字段）；
 * - 正式链路（planner/structured/critic/commit）只消费 frozen snapshot，
 *   不再直接读取 card_key_points.claim/quoteText；
 * - keyPointId 只作为 Objective ID alias。
 *
 * 职责：
 * 1. freezeTargetSnapshotV2：workspace-scoped query active Objective + current
 *    revision + active Card + current publication revision + evidence bindings
 *    + eligibility + exposures → 组装完整 §16.1 对象并持久化；任一环节缺失
 *    fail closed。
 * 2. loadFrozenTargetSnapshotV2：按 runId 读回并重建 §16.1 对象。
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningTargetSnapshotsV2,
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
  learningCardPublicationRevisionsV2,
  learningObjectiveEvidenceBindingsV2,
  evidenceSnapshotsV2,
  evidenceEligibilityStatesV2,
  learningExposuresV2,
  cardContentCapabilityStateV2,
} from "../../db/schema/card-generation-v2.ts";
import type {
  LearningTargetSnapshotV2,
  LearningRunTargetPublicV2,
} from "@ailearn/shared";
import {
  computeTargetRevisionHashV2,
  computeRubricHashV2,
  computeCanonicalAnswerHashV2,
  computeLearningSupportHashV2,
  computeRelationsHashV2,
  computeEvidenceBindingSetHashV2,
  computeEvidenceEligibilityVectorHashV2,
  computeSemanticSupportReportSetHashV2,
  computeLearningTargetSnapshotHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import type {
  ObjectiveRubricV2,
  CanonicalAnswerV2,
  ObjectiveRelationV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type {
  EvidenceBindingTargetUnitV2,
  EvidenceBindingRelationV2,
  EvidenceSupportStrengthV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import type { KnowledgeFormV2, TaskIntentV1 } from "@ailearn/shared";

/** rubricHash 计算前剔除自引用字段（§11.3/§15.6）。 */
function stripRubricHash(rubric: ObjectiveRubricV2): Omit<ObjectiveRubricV2, "rubricHash"> {
  const { rubricHash: _rubricHash, ...rest } = rubric;
  return rest;
}

// ─── Target Snapshot Adapter ─────────────────────────────────────────────

export interface TargetSnapshotInput {
  workspaceId: string;
  userId: string;
  runId: string;
  objectiveId: string;
  /**
   * §16.2：cardContentEpoch 只 fence Card V2 generation/action/activation 与
   * 新 Run PREPARE 起点，由调用方（PREPARE 流程）从冻结的 epoch 传入。
   * 禁止把 Card revision 或任意行内值冒充 content epoch。
   */
  cardContentEpoch: number;
  /** §16.1 snapshotHash 版本（迁移期随策略演进）。 */
  targetSnapshotPolicyVersion?: string;
  /** §16.2 pre-run reveal eligibility policy 版本。 */
  preRunRevealPolicyVersion?: string;
  /** 当前 ISO 时间（可注入便于测试）；默认 Date.now。 */
  now?: () => Date;
}

const DEFAULT_TARGET_SNAPSHOT_POLICY_VERSION = "learning-target-snapshot-v2.1";
const DEFAULT_PRE_RUN_REVEAL_POLICY_VERSION = "pre-run-reveal-v1";
/** 默认 cooldown：暴露过后的资格延后窗口（§21.3/§30.2）。 */
const REVEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** same-cue reveal 判定窗口（§15.2 受控 Reveal 的近期判定）。 */
const RECENT_REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** §16.1 的 server-private 冻结结果（含完整对象与公共投影）。 */
export interface FrozenTargetSnapshotV2 {
  snapshot: LearningTargetSnapshotV2;
  /** 浏览器侧唯一公开投影。 */
  publicTarget: LearningRunTargetPublicV2;
  /** PREPARE 时读取到的 expected objective lifecycle epoch。 */
  objectiveLifecycleEpoch: number;
  /** PREPARE 时读取到的 evidence eligibility vector hash。 */
  evidenceEligibilityVectorHash: string;
  cardContentEpoch: number;
}

/**
 * 把 DB binding 行的 targetUnitKind/targetUnitId 重建为
 * EvidenceBindingTargetUnitV2 discriminated union。
 */
function rebuildTargetUnit(
  kind: string | null,
  id: string | null,
): EvidenceBindingTargetUnitV2 {
  switch (kind) {
    case "answer":
      if (!id) throw new TargetSnapshotError("evidence_binding_bad_target_unit", `answer unit missing id`);
      return { kind: "answer", answerUnitId: id };
    case "rubric":
      if (!id) throw new TargetSnapshotError("evidence_binding_bad_target_unit", `rubric unit missing id`);
      return { kind: "rubric", rubricUnitId: id };
    case "relation":
      if (!id) throw new TargetSnapshotError("evidence_binding_bad_target_unit", `relation unit missing id`);
      return { kind: "relation", relationId: id };
    case "learning_support": {
      const allowed = new Set(["explanation", "boundary", "misconception", "workedExample"]);
      if (!id || !allowed.has(id)) {
        throw new TargetSnapshotError("evidence_binding_bad_target_unit", `unsupported learning support field: ${id ?? "null"}`);
      }
      return { kind: "learning_support", field: id as "explanation" | "boundary" | "misconception" | "workedExample" };
    }
    default:
      throw new TargetSnapshotError("evidence_binding_bad_target_unit", `unsupported target unit kind: ${kind ?? "null"}`);
  }
}

/**
 * 读取 objective current revision 的全部 evidence bindings，join evidence
 * snapshot hash 与 eligibility，按稳定 bindingId 顺序返回 §16.1 evidence 数组。
 * §16.2 step 4：全部 eligibility 必须 usable，否则 fail closed。
 */
async function loadEvidenceClosure(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveRevisionId: string,
): Promise<{
  evidence: LearningTargetSnapshotV2["target"]["evidence"];
  evidenceBindingSetHash: string;
  evidenceEligibilityVectorHash: string;
}> {
  const bindings = await tx
    .select({
      bindingId: learningObjectiveEvidenceBindingsV2.bindingId,
      targetUnitKind: learningObjectiveEvidenceBindingsV2.targetUnitKind,
      targetUnitId: learningObjectiveEvidenceBindingsV2.targetUnitId,
      evidenceSnapshotId: learningObjectiveEvidenceBindingsV2.evidenceSnapshotId,
      relation: learningObjectiveEvidenceBindingsV2.relation,
      supportStrength: learningObjectiveEvidenceBindingsV2.supportStrength,
      semanticSupportReportId: learningObjectiveEvidenceBindingsV2.semanticSupportReportId,
      semanticSupportReportHash: learningObjectiveEvidenceBindingsV2.semanticSupportReportHash,
      derivationReportId: learningObjectiveEvidenceBindingsV2.derivationReportId,
      derivationReportHash: learningObjectiveEvidenceBindingsV2.derivationReportHash,
      bindingHash: learningObjectiveEvidenceBindingsV2.bindingHash,
    })
    .from(learningObjectiveEvidenceBindingsV2)
    .where(and(
      eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId),
      eq(learningObjectiveEvidenceBindingsV2.objectiveRevisionId, objectiveRevisionId),
    ))
    .orderBy(learningObjectiveEvidenceBindingsV2.bindingId);

  if (bindings.length === 0) return { evidence: [], evidenceBindingSetHash: computeEvidenceBindingSetHashV2([]), evidenceEligibilityVectorHash: computeEvidenceEligibilityVectorHashV2([]) };

  // 一次性读取涉及的全量 evidence snapshot hash 与 eligibility。
  const snapshotIds = [...new Set(bindings.map((b) => b.evidenceSnapshotId))];
  // R32：drizzle+postgres-js 对数组参数的序列化不可靠（malformed array literal，
  // 单元素数组尤甚）——用显式 `{uuid,...}::uuid[]` 字面量（同 R29 worker 修法）。
  // snapshotIds 全部来自本库 binding 行（合法 uuid），无注入面。
  const snapshotIdsLiteral = `{${snapshotIds.join(",")}}`;
  const snapRows = snapshotIds.length > 0
    ? await tx
        .select({ evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId, evidenceSnapshotHash: evidenceSnapshotsV2.evidenceSnapshotHash })
        .from(evidenceSnapshotsV2)
        .where(and(eq(evidenceSnapshotsV2.workspaceId, workspaceId), sql`${evidenceSnapshotsV2.evidenceSnapshotId} = ANY(${snapshotIdsLiteral}::uuid[])`))
    : [];
  const snapHash = new Map(snapRows.map((s) => [s.evidenceSnapshotId, s.evidenceSnapshotHash]));
  const snapIdsSet = new Set<string>();
  for (const id of snapshotIds) {
    const h = snapHash.get(id);
    if (!h) throw new TargetSnapshotError("evidence_snapshot_not_found", `Evidence snapshot not found: ${id}`);
    snapIdsSet.add(id);
  }
  if (snapIdsSet.size !== snapshotIds.length) {
    throw new TargetSnapshotError("evidence_snapshot_not_found", "Some evidence snapshots are missing");
  }

  const eligRows = snapshotIds.length > 0
    ? await tx
        .select({
          evidenceSnapshotId: evidenceEligibilityStatesV2.evidenceSnapshotId,
          status: evidenceEligibilityStatesV2.status,
          eligibilityEpoch: evidenceEligibilityStatesV2.eligibilityEpoch,
        })
        .from(evidenceEligibilityStatesV2)
        .where(and(eq(evidenceEligibilityStatesV2.workspaceId, workspaceId), sql`${evidenceEligibilityStatesV2.evidenceSnapshotId} = ANY(${snapshotIdsLiteral}::uuid[])`))
    : [];
  const eligById = new Map(eligRows.map((e) => [e.evidenceSnapshotId, e]));

  // §16.2 step 4：要求全部 eligibility 行存在且 usable（fail closed）。
  const eligibilityVector: Array<{ evidenceSnapshotId: string; eligibilityEpoch: number; status: string; stateHash: string }> = [];
  for (const id of [...snapshotIds].sort()) {
    const e = eligById.get(id);
    if (!e) throw new TargetSnapshotError("evidence_eligibility_missing", `No eligibility state for evidence: ${id}`);
    if (e.status !== "usable") {
      throw new TargetSnapshotError("evidence_not_usable", `Evidence eligibility is ${e.status} for ${id}`);
    }
    eligibilityVector.push({ evidenceSnapshotId: e.evidenceSnapshotId, eligibilityEpoch: e.eligibilityEpoch, status: e.status, stateHash: snapHash.get(id)! });
  }
  const evidenceEligibilityVectorHash = computeEvidenceEligibilityVectorHashV2(eligibilityVector);

  const evidence = bindings.map<LearningTargetSnapshotV2["target"]["evidence"][number]>((b) => {
    const targetUnit = rebuildTargetUnit(b.targetUnitKind, b.targetUnitId);
    const elig = eligById.get(b.evidenceSnapshotId);
    // 每个 binding 都带 eligibility epoch（用于 Artifact lock / Commit 复验）。
    if (!elig) throw new TargetSnapshotError("evidence_eligibility_missing", `No eligibility state for evidence: ${b.evidenceSnapshotId}`);
    const relation = b.relation as EvidenceBindingRelationV2;
    const supportStrength = b.supportStrength as EvidenceSupportStrengthV2;
    return {
      bindingId: b.bindingId,
      targetUnit,
      evidenceSnapshotId: b.evidenceSnapshotId,
      evidenceSnapshotHash: snapHash.get(b.evidenceSnapshotId)!,
      expectedEvidenceEligibilityEpoch: elig.eligibilityEpoch,
      relation,
      supportStrength,
      bindingHash: b.bindingHash,
      semanticSupportReportId: b.semanticSupportReportId,
      semanticSupportReportHash: b.semanticSupportReportHash,
      derivationReportId: b.derivationReportId ?? undefined,
      derivationReportHash: b.derivationReportHash ?? undefined,
    };
  });

  // §14.3 evidenceBindingSetHash：按 bindingId + evidenceBindingHash。
  const setEntries = evidence.map((e) => ({
    bindingId: e.bindingId,
    evidenceBindingHash: e.bindingHash,
  }));
  const evidenceBindingSetHash = computeEvidenceBindingSetHashV2(setEntries);

  return { evidence, evidenceBindingSetHash, evidenceEligibilityVectorHash };
}

/**
 * 读取该 user 对该 objective 的 planning exposure（objective-scoped）。
 * §16.2/§15.2：same-cue reveal 近期判定 + qualificationNotBefore（cooldown）。
 */
async function loadPlanningExposure(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  objectiveId: string,
  nowMs: number,
  preRunRevealPolicyVersion: string,
): Promise<LearningTargetSnapshotV2["planningExposure"]> {
  const rows = await tx
    .select({
      exposureId: learningExposuresV2.exposureId,
      exposureKind: learningExposuresV2.exposureKind,
      exposedAt: learningExposuresV2.exposedAt,
    })
    .from(learningExposuresV2)
    .where(and(
      eq(learningExposuresV2.workspaceId, workspaceId),
      eq(learningExposuresV2.userId, userId),
      eq(learningExposuresV2.objectiveId, objectiveId),
    ))
    .orderBy(sql`${learningExposuresV2.exposedAt} DESC`)
    .limit(50);

  const exposureIds = rows.map((r) => r.exposureId);
  // 只 count answer-bearing/受控 Reveal 类 exposure（§16.2 只受控 Reveal 污染）。
  const revealRows = rows.filter(
    (r) => ["answer_reveal", "evidence_reveal", "answer_editor_view"].includes(r.exposureKind),
  );
  const lastRevealMs = revealRows.length > 0 ? revealRows[0].exposedAt.getTime() : null;
  const sameCueRecentlyRevealed =
    lastRevealMs !== null && (nowMs - lastRevealMs) < RECENT_REVEAL_WINDOW_MS;

  let qualificationNotBefore: string | null = null;
  if (lastRevealMs !== null) {
    const coolDownEnd = lastRevealMs + REVEAL_COOLDOWN_MS;
    qualificationNotBefore = new Date(coolDownEnd).toISOString();
  }

  return {
    scope: "objective" as const,
    lastExposedAt: lastRevealMs !== null ? new Date(lastRevealMs).toISOString() : null,
    exposureIds,
    sameCueRecentlyRevealed,
    qualificationNotBefore,
    preRunRevealPolicyVersion,
  };
}

/**
 * 从当前 card_content_capability_state 读取 ws 的 cardContentEpoch。
 * §16.2：PREPARE 起点必须 < 冻结起点后提升的 epoch；读取失败 fail closed。
 */
async function readCardContentEpoch(tx: ApiTransaction, workspaceId: string): Promise<number> {
  const rows = await tx
    .select({ contentEpoch: cardContentCapabilityStateV2.contentEpoch })
    .from(cardContentCapabilityStateV2)
    .where(eq(cardContentCapabilityStateV2.workspaceId, workspaceId))
    .limit(1);
  const epoch = rows[0]?.contentEpoch ?? 1;
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new TargetSnapshotError("card_content_epoch_invalid", `Invalid cardContentEpoch: ${epoch}`);
  }
  return epoch;
}

/**
 * 计算 publishedTargetEligibility（§16.1/§16.2）：
 * - lifecycle/evidence 异常 → blocked；
 * - 有近期 reveal → practice_only；
 * - 其余 → eligible。
 */
export function computePublishedTargetEligibility(input: {
  lifecycleActive: boolean;
  evidenceUsable: boolean;
  sameCueRecentlyRevealed: boolean;
}): "eligible" | "practice_only" | "blocked" {
  if (!input.lifecycleActive || !input.evidenceUsable) return "blocked";
  if (input.sameCueRecentlyRevealed) return "practice_only";
  return "eligible";
}

/**
 * §16.1: 从激活的 LearningObjectiveV2 + LearningCardV2 冻结完整 TargetSnapshot。
 *
 * PREPARE 流程唯一入口（§16.2 step 3–7）：
 *  1. workspace-scoped active Objective；
 *  2. current objective revision；
 *  3. active Card（查不到 fail closed；禁静默用 revision 1）；
 *  4. current publication revision（public/reveal payload hash）；
 *  5. evidence closure（binding + snapshot hash + eligibility, 全 usable）；
 *  6. planning exposure（objective-scoped）+ eligibility ceiling；
 *  7. 组装 §16.1 对象，snapshotHash，持久化，返回。
 * 任一 fail closed。
 */
export async function freezeTargetSnapshotV2(
  tx: ApiTransaction,
  input: TargetSnapshotInput,
): Promise<FrozenTargetSnapshotV2> {
  const now = (input.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const targetSnapshotPolicyVersion =
    input.targetSnapshotPolicyVersion ?? DEFAULT_TARGET_SNAPSHOT_POLICY_VERSION;
  const preRunRevealPolicyVersion =
    input.preRunRevealPolicyVersion ?? DEFAULT_PRE_RUN_REVEAL_POLICY_VERSION;
  const workspaceId = input.workspaceId;
  const userId = input.userId;
  const runId = input.runId;
  const objectiveId = input.objectiveId;

  // 1. active Objective —— fail closed
  const objRows = await tx
    .select()
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      eq(learningObjectivesV2.objectiveId, objectiveId),
      eq(learningObjectivesV2.lifecycle, "active"),
    ))
    .limit(1);
  const objective = objRows[0];
  if (!objective) {
    throw new TargetSnapshotError("objective_not_found_or_inactive",
      `Active objective not found: ${objectiveId}`);
  }
  const lifecycleActive = objective.lifecycle === "active";
  const objectiveLifecycleEpoch = objective.lifecycleEpoch;

  // 2. current objective revision
  const revRows = await tx
    .select()
    .from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveRevisionId, objective.currentObjectiveRevisionId!),
    ))
    .limit(1);
  const revision = revRows[0];
  if (!revision) {
    throw new TargetSnapshotError("objective_revision_not_found",
      `Objective revision not found: ${objective.currentObjectiveRevisionId}`);
  }

  // 3. active Card（§16.2 step 2/3：PREPARE 必须 workspace-scoped 查到 active
  //    Card，查不到 fail closed）
  const cardRows = await tx
    .select()
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, workspaceId),
      eq(learningCardsV2.objectiveId, objectiveId),
      eq(learningCardsV2.lifecycle, "active"),
    ))
    .limit(1);
  const card = cardRows[0];
  if (!card) {
    throw new TargetSnapshotError("card_not_found_or_inactive",
      `Active card not found for objective: ${objectiveId}`);
  }
  const cardId = card.cardId;
  const cardRevision = card.cardRevision;
  const publicationRevision = card.currentPublicationRevision;

  // 4. current publication revision → public/reveal payload hash
  const pubRows = await tx
    .select({
      publicPayloadHash: learningCardPublicationRevisionsV2.publicPayloadHash,
      revealPayloadHash: learningCardPublicationRevisionsV2.revealPayloadHash,
    })
    .from(learningCardPublicationRevisionsV2)
    .where(and(
      eq(learningCardPublicationRevisionsV2.workspaceId, workspaceId),
      eq(learningCardPublicationRevisionsV2.cardId, cardId),
      eq(learningCardPublicationRevisionsV2.publicationRevision, publicationRevision),
    ))
    .limit(1);
  const pub = pubRows[0];
  if (!pub) {
    throw new TargetSnapshotError("card_publication_not_found",
      `Card publication revision not found: ${cardId}@${publicationRevision}`);
  }

  // 5. evidence closure
  const evidenceClosure = await loadEvidenceClosure(tx, workspaceId, revision.objectiveRevisionId);

  // 6. planning exposure
  const planningExposure = await loadPlanningExposure(
    tx, workspaceId, userId, objectiveId, nowMs, preRunRevealPolicyVersion,
  );

  // eligibility ceiling
  const publishedTargetEligibility = computePublishedTargetEligibility({
    lifecycleActive,
    evidenceUsable: true, // loadEvidenceClosure 已 fail closed 保证全部 usable
    sameCueRecentlyRevealed: planningExposure.sameCueRecentlyRevealed,
  });

  const canonicalAnswer = revision.canonicalAnswer as CanonicalAnswerV2;
  const scoringRubric = revision.scoringRubric as ObjectiveRubricV2;
  const relations = (revision.relations ?? []) as ObjectiveRelationV2[];
  const knowledgeForm = revision.knowledgeForm as KnowledgeFormV2;
  const preferredIntents = (revision.preferredIntents ?? []) as TaskIntentV1[];

  // ── 组件哈希 ──
  const canonicalAnswerHash = computeCanonicalAnswerHashV2(canonicalAnswer);
  const learningSupportHash = computeLearningSupportHashV2(revision.learningSupport);
  const rubricHash = computeRubricHashV2(stripRubricHash(scoringRubric));
  const relationsHash = computeRelationsHashV2(relations);
  const semanticSupportReportSetHash = computeSemanticSupportReportSetHashV2(
    evidenceClosure.evidence.map((e) => e.semanticSupportReportHash),
  );

  const targetRevisionHash = computeTargetRevisionHashV2({
    semanticTargetFingerprint: objective.semanticTargetFingerprint,
    objectiveRevision: revision.revision,
    objectiveStatement: revision.objectiveStatement,
    publicSummary: revision.publicSummary,
    knowledgeForm,
    canonicalAnswerHash,
    learningSupportHash,
    rubricHash,
    relationsHash,
    evidenceBindingSetHash: evidenceClosure.evidenceBindingSetHash,
    semanticSupportReportSetHash,
  });

  const semanticTargetFingerprint = objective.semanticTargetFingerprint;

  const snapshotId = randomUUID();
  const preparedAt = now.toISOString();

  const snapshotWithoutHash: Omit<LearningTargetSnapshotV2, "snapshotHash"> = {
    version: 2,
    snapshotId,
    workspaceId,
    userId,
    runId,
    cardContentEpoch: input.cardContentEpoch,
    objectiveLifecycleEpoch,
    target: {
      objectiveId,
      objectiveRevision: revision.revision,
      cardId,
      publicationRevision,
      cardRevision,
      publicPayloadHash: pub.publicPayloadHash,
      revealPayloadHash: pub.revealPayloadHash,
      objectiveStatement: revision.objectiveStatement,
      publicSummary: revision.publicSummary,
      knowledgeForm,
      preferredIntents,
      canonicalAnswer,
      learningSupport: revision.learningSupport as LearningTargetSnapshotV2["target"]["learningSupport"],
      scoringRubric,
      relations,
      evidence: evidenceClosure.evidence,
      evidenceBindingSetHash: evidenceClosure.evidenceBindingSetHash,
      evidenceEligibilityVectorHash: evidenceClosure.evidenceEligibilityVectorHash,
      semanticTargetFingerprint,
      targetRevisionHash,
    },
    planningExposure,
    lifecycleAtPrepare: "active",
    publishedTargetEligibility,
    preparedAt,
  };

  const snapshotHash = computeLearningTargetSnapshotHashV2({
    workspaceId,
    userId,
    runId,
    objectiveId,
    objectiveRevision: revision.revision,
    semanticTargetFingerprint,
    targetRevisionHash,
    cardContentEpoch: input.cardContentEpoch,
    objectiveLifecycleEpoch,
    cardId,
    publicationRevision,
    cardRevision,
    publicPayloadHash: pub.publicPayloadHash,
    revealPayloadHash: pub.revealPayloadHash,
    canonicalAnswerHash,
    learningSupportHash,
    rubricHash,
    evidenceBindingSetHash: evidenceClosure.evidenceBindingSetHash,
    evidenceEligibilityVectorHash: evidenceClosure.evidenceEligibilityVectorHash,
    planningExposure: {
      scope: "objective",
      lastExposedAt: planningExposure.lastExposedAt,
      exposureIds: planningExposure.exposureIds,
      sameCueRecentlyRevealed: planningExposure.sameCueRecentlyRevealed,
      qualificationNotBefore: planningExposure.qualificationNotBefore,
      preRunRevealPolicyVersion: planningExposure.preRunRevealPolicyVersion,
    },
    lifecycleAtPrepare: "active",
    publishedTargetEligibility,
    targetSnapshotPolicyVersion,
  });

  const snapshot: LearningTargetSnapshotV2 = { ...snapshotWithoutHash, snapshotHash };

  const publicTarget: LearningRunTargetPublicV2 = {
    objectiveId,
    objectiveRevision: revision.revision,
    cardId,
    publicationRevision,
    cardRevision,
    publicPayloadHash: pub.publicPayloadHash,
    publicSummary: revision.publicSummary,
    semanticTargetFingerprint,
    targetRevisionHash,
  };

  // ── 持久化（0138/0139 列）──
  await tx.insert(learningTargetSnapshotsV2).values({
    workspaceId,
    snapshotId,
    runId,
    userId,
    objectiveId,
    objectiveRevisionId: revision.objectiveRevisionId,
    objectiveRevision: revision.revision,
    semanticTargetFingerprint,
    targetRevisionHash,
    semanticIdentityClassId: objective.semanticIdentityClassId,
    semanticIdentityPolicyVersion: objective.semanticIdentityPolicyVersion,
    objectiveLifecycleEpoch,
    cardContentEpoch: input.cardContentEpoch,
    assistanceSnapshotHash: null,
    cardId,
    publicationRevision,
    cardRevision,
    publicPayloadHash: pub.publicPayloadHash,
    revealPayloadHash: pub.revealPayloadHash,
    evidenceBindingSetHash: evidenceClosure.evidenceBindingSetHash,
    evidenceEligibilityVectorHash: evidenceClosure.evidenceEligibilityVectorHash,
    planningExposure: planningExposure as never,
    lifecycleAtPrepare: "active",
    publishedTargetEligibility,
    preparedAt: now,
    targetSnapshotPolicyVersion,
    canonicalAnswer: revision.canonicalAnswer,
    scoringRubric: revision.scoringRubric,
    relations: revision.relations ?? [],
    evidenceBindings: evidenceClosure.evidence as unknown[],
    preferredIntents,
    target: snapshotWithoutHash.target as never,
    snapshotHash,
    frozenAt: now,
  });

  return {
    snapshot,
    publicTarget,
    objectiveLifecycleEpoch,
    evidenceEligibilityVectorHash: evidenceClosure.evidenceEligibilityVectorHash,
    cardContentEpoch: input.cardContentEpoch,
  };
}

/**
 * 从 run 加载已冻结的 TargetSnapshot（重建 §16.1 对象）。
 * 返回 null 表示该 run 是 V1 run（无 V2 snapshot）；调用方据此走 legacy 分支。
 */
export async function loadFrozenTargetSnapshotV2(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
): Promise<LearningTargetSnapshotV2 | null> {
  const rows = await tx
    .select()
    .from(learningTargetSnapshotsV2)
    .where(and(
      eq(learningTargetSnapshotsV2.workspaceId, workspaceId),
      eq(learningTargetSnapshotsV2.runId, runId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // 优先用 0139 target jsonb 无损重建；缺列（旧行）回退拼装 scalar。
  if (row.target) {
    const target = row.target as LearningTargetSnapshotV2["target"];
    return {
      version: 2,
      snapshotId: row.snapshotId,
      workspaceId: row.workspaceId,
      userId: row.userId as string,
      runId: row.runId,
      cardContentEpoch: row.cardContentEpoch,
      objectiveLifecycleEpoch: row.objectiveLifecycleEpoch,
      target,
      planningExposure: (row.planningExposure as LearningTargetSnapshotV2["planningExposure"]),
      lifecycleAtPrepare: (row.lifecycleAtPrepare as "active") ?? "active",
      publishedTargetEligibility: (row.publishedTargetEligibility as LearningTargetSnapshotV2["publishedTargetEligibility"]),
      preparedAt: row.preparedAt ? row.preparedAt.toISOString() : row.frozenAt.toISOString(),
      snapshotHash: row.snapshotHash,
    };
  }

  // 回退：从 scalar 列拼装（无需 objectiveStatement 的消费者场景）。
  return {
    version: 2,
    snapshotId: row.snapshotId,
    workspaceId: row.workspaceId,
    userId: row.userId as string,
    runId: row.runId,
    cardContentEpoch: row.cardContentEpoch,
    objectiveLifecycleEpoch: row.objectiveLifecycleEpoch,
    target: {
      objectiveId: row.objectiveId,
      objectiveRevision: row.objectiveRevision,
      cardId: row.cardId as string,
      publicationRevision: row.publicationRevision as number,
      cardRevision: row.cardRevision as number,
      publicPayloadHash: row.publicPayloadHash as string,
      revealPayloadHash: row.revealPayloadHash as string,
      objectiveStatement: "",
      publicSummary: "",
      knowledgeForm: "concept" as KnowledgeFormV2,
      preferredIntents: row.preferredIntents as TaskIntentV1[],
      canonicalAnswer: row.canonicalAnswer as unknown as CanonicalAnswerV2,
      learningSupport: undefined as unknown as LearningTargetSnapshotV2["target"]["learningSupport"],
      scoringRubric: row.scoringRubric as unknown as ObjectiveRubricV2,
      relations: (row.relations ?? []) as ObjectiveRelationV2[],
      evidence: (row.evidenceBindings ?? []) as LearningTargetSnapshotV2["target"]["evidence"],
      evidenceBindingSetHash: row.evidenceBindingSetHash as string,
      evidenceEligibilityVectorHash: row.evidenceEligibilityVectorHash as string,
      semanticTargetFingerprint: row.semanticTargetFingerprint,
      targetRevisionHash: row.targetRevisionHash,
    },
    planningExposure: (row.planningExposure as LearningTargetSnapshotV2["planningExposure"]),
    lifecycleAtPrepare: (row.lifecycleAtPrepare as "active") ?? "active",
    publishedTargetEligibility: (row.publishedTargetEligibility as LearningTargetSnapshotV2["publishedTargetEligibility"]),
    preparedAt: row.preparedAt ? row.preparedAt.toISOString() : row.frozenAt.toISOString(),
    snapshotHash: row.snapshotHash,
  };
}

/** §16.1 browser-only public target projection。 */
export function buildLearningRunTargetPublicV2(
  snapshot: LearningTargetSnapshotV2,
): LearningRunTargetPublicV2 {
  const t = snapshot.target;
  return {
    objectiveId: t.objectiveId,
    objectiveRevision: t.objectiveRevision,
    cardId: t.cardId,
    publicationRevision: t.publicationRevision,
    cardRevision: t.cardRevision,
    publicPayloadHash: t.publicPayloadHash,
    publicSummary: t.publicSummary,
    semanticTargetFingerprint: t.semanticTargetFingerprint,
    targetRevisionHash: t.targetRevisionHash,
  };
}

/**
 * 读取 ws 的 cardContentEpoch（PREPARE 调用方用）。
 * §16.2：PREPARE 起点必须携带冻结的 epoch，禁止把 Card revision 冒充 epoch。
 */
export async function prepareCardContentEpoch(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<number> {
  return readCardContentEpoch(tx, workspaceId);
}

// ─── Error ───────────────────────────────────────────────────────────────

export class TargetSnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TargetSnapshotError";
    this.code = code;
  }
}
