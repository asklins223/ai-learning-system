/**
 * 方案 20 C5：LearningTargetSnapshotV2 Adapter。
 *
 * §16.1–16.3:
 * - PREPARE 从激活的 LearningObjectiveV2 冻结完整 LearningTargetSnapshotV2
 *   （全部 §16.1 字段；LearningCardV2 **由必备降为可选**，39d W3-4／D1 §4.3）；
 * - 正式链路（planner/structured/critic/commit）只消费 frozen snapshot，
 *   不再直接读取 card_key_points.claim/quoteText（表已删除）；
 * - run/objective identity is carried by the V2 snapshot contract.
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
  learningObjectiveOriginsV2,
  learningCardsV2,
  learningCardPublicationRevisionsV2,
  learningObjectiveEvidenceBindingsV2,
  evidenceSnapshotsV2,
  evidenceEligibilityStatesV2,
  learningExposuresV2,
  cardContentCapabilityStateV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import type {
  LearningTargetSnapshotV2,
  LearningRunTargetPublicV2,
} from "@ailearn/shared";
import {
  computeTargetRevisionHashV2,
  computeRubricHashV2,
  computeCanonicalAnswerHashV2,
  computeLearningSupportHashV2,
  computePracticeItemHashV2,
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
  PracticeItemV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type {
  EvidenceBindingTargetUnitV2,
  EvidenceBindingRelationV2,
  EvidenceSupportStrengthV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import type { KnowledgeFormV2, TaskIntentV1 } from "@ailearn/shared";
import { DomainError } from "@ailearn/shared";

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
 * 无卡冻结的依据判据（D1 §4.3 里"无卡有依据"与"无卡无依据"两行的分界）。三条都要过：
 * ① 一条依据都没有 ⇒ 拒（不许出现"既没卡也没依据"的空快照）；
 * ② 该目标修订必须有**笔记版本锚**——版本只存在 `learning_objective_origins_v2`
 *    的 note 来源上（evidence 快照只有 `note_id`，没有 `note_version_id`）；
 * ③ 每条依据必须出自那篇笔记。
 * 三种不满足都 fail closed 成同一个码：对用户它都是"这个目标还没有可冻结的原稿依据"，
 * 差别只在服务端消息里（不放宽成"当作没卡处理"）。
 */
async function requireNoteBackedEvidence(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveRevisionId: string,
  evidence: LearningTargetSnapshotV2["target"]["evidence"],
): Promise<void> {
  if (evidence.length === 0) {
    throw new TargetSnapshotError("target_evidence_missing",
      `无卡目标没有可冻结的笔记依据：objective_revision=${objectiveRevisionId}`);
  }
  const originRows = await tx
    .select({ noteId: learningObjectiveOriginsV2.noteId })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.objectiveRevisionId, objectiveRevisionId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
    ))
    .limit(1);
  const noteId = originRows[0]?.noteId;
  if (!noteId) {
    throw new TargetSnapshotError("target_evidence_missing",
      `无卡目标缺笔记版本锚（origins 里没有 note 来源）：objective_revision=${objectiveRevisionId}`);
  }
  const snapshotIds = [...new Set(evidence.map((e) => e.evidenceSnapshotId))];
  // 同 loadEvidenceClosure 的 R32：数组参数用显式 `{uuid,...}::uuid[]` 字面量
  // （drizzle+postgres-js 对数组参数序列化不可靠）。id 全部来自本库行，无注入面。
  const snapshotIdsLiteral = `{${snapshotIds.join(",")}}`;
  const foreign = await tx
    .select({ id: evidenceSnapshotsV2.evidenceSnapshotId })
    .from(evidenceSnapshotsV2)
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, workspaceId),
      sql`${evidenceSnapshotsV2.evidenceSnapshotId} = ANY(${snapshotIdsLiteral}::uuid[])`,
      sql`${evidenceSnapshotsV2.noteId} IS DISTINCT FROM ${noteId}`,
    ))
    .limit(1);
  if (foreign.length > 0) {
    throw new TargetSnapshotError("target_evidence_missing",
      `无卡目标的依据不都出自它那篇笔记：evidence=${foreign[0].id} 属于另一篇笔记`);
  }
}

/**
 * §16.1: 从激活的 LearningObjectiveV2 + LearningCardV2 冻结完整 TargetSnapshot。
 *
 * PREPARE 流程唯一入口（§16.2 step 3–7，卡前置按 39d W3-4 改成三分支）：
 *  1. workspace-scoped active Objective（**必备**，查不到 fail closed）；
 *  2. current objective revision；
 *  3. evidence closure（binding + snapshot hash + eligibility, 全 usable）——
 *     先于卡判定，因为"没卡"这条出路要拿它当依据判据；
 *  4. Card：**可选**。有卡 ⇒ 照旧查 current publication revision（查不到仍 fail closed，
 *     禁静默用 revision 1）；无卡 ⇒ 必须"该修订有笔记版本锚 ＋ 全部依据出自那篇笔记"，
 *     否则 fail closed 为 `target_evidence_missing`（不许既没卡也没依据地空冻结）；
 *  5. planning exposure（objective-scoped）+ eligibility ceiling；
 *  6. 组装 §16.1 对象，snapshotHash，持久化，返回。
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

  // 3. evidence closure —— **先于**卡判定。无卡那条出路要拿它当依据判据，
  //    而它自身仍然逐条 fail closed（缺快照 / 缺 eligibility / 非 usable 一律拒）。
  const evidenceClosure = await loadEvidenceClosure(tx, workspaceId, revision.objectiveRevisionId);

  // 4. Card：**由必备降为可选**（39d W3-4 / D1 §4.3 的三分支）。
  //    放宽的只有"必须有卡"这一条：上面两步（active Objective ＋ current revision）
  //    一个字没动——无卡 ≠ 无目标，目标必须先落成正式目标才有资格进冻结链。
  const cardRows = await tx
    .select()
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, workspaceId),
      eq(learningCardsV2.objectiveId, objectiveId),
      eq(learningCardsV2.lifecycle, "active"),
    ))
    .limit(1);
  const card = cardRows[0] ?? null;

  // 5. 有卡：publication revision 照旧（查不到仍 fail closed）；
  //    无卡：必须"该修订有笔记版本锚、且全部依据都出自那篇笔记"，否则拒。
  let publicPayloadHash: string | null;
  let revealPayloadHash: string | null;
  if (card) {
    const pubRows = await tx
      .select({
        publicPayloadHash: learningCardPublicationRevisionsV2.publicPayloadHash,
        revealPayloadHash: learningCardPublicationRevisionsV2.revealPayloadHash,
      })
      .from(learningCardPublicationRevisionsV2)
      .where(and(
        eq(learningCardPublicationRevisionsV2.workspaceId, workspaceId),
        eq(learningCardPublicationRevisionsV2.cardId, card.cardId),
        eq(learningCardPublicationRevisionsV2.publicationRevision, card.currentPublicationRevision),
      ))
      .limit(1);
    const pub = pubRows[0];
    if (!pub) {
      throw new TargetSnapshotError("card_publication_not_found",
        `Card publication revision not found: ${card.cardId}@${card.currentPublicationRevision}`);
    }
    publicPayloadHash = pub.publicPayloadHash;
    revealPayloadHash = pub.revealPayloadHash;
  } else {
    await requireNoteBackedEvidence(
      tx, workspaceId, revision.objectiveRevisionId, evidenceClosure.evidence,
    );
    publicPayloadHash = null;
    revealPayloadHash = null;
  }
  const cardId = card?.cardId ?? null;
  const cardRevision = card?.cardRevision ?? null;
  const publicationRevision = card?.currentPublicationRevision ?? null;
  // cardContentEpoch 是 `notNull` 列（也是快照哈希的一部分）：有卡时它就是 PREPARE
  // 传进来的"卡内容能力 epoch"；无卡时那个数字描述的是卡内容变没变，对本目标
  // 没有语义 ⇒ 改用目标自己的 lifecycle epoch（D1 §4.3 明写"不许用 0 蒙混"）。
  // 今天没有任何比较读它（提交复验比的是 objectiveLifecycleEpoch，
  // 见 run-processing-tick.ts 的 revalidateV2CommitEpochs），所以两种取值不互相打脸；
  // 谁要新增比较，必须先按"有没有卡"分支。
  if (!Number.isInteger(objectiveLifecycleEpoch) || objectiveLifecycleEpoch < 1) {
    throw new TargetSnapshotError("card_content_epoch_invalid",
      `无卡冻结需要一个 >=1 的 objective lifecycle epoch 作为内容 epoch，读到 ${objectiveLifecycleEpoch}`);
  }
  const cardContentEpoch = card ? input.cardContentEpoch : objectiveLifecycleEpoch;

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
  // 0245：作者产出的客观练习件；NULL = 这张卡没有练习件（不伪造）。
  const practiceItem = (revision as { practiceItem?: unknown }).practiceItem as
    | PracticeItemV2
    | null
    | undefined;
  const knowledgeForm = revision.knowledgeForm as KnowledgeFormV2;
  const preferredIntents = (revision.preferredIntents ?? []) as TaskIntentV1[];

  // ── 组件哈希 ──
  const canonicalAnswerHash = computeCanonicalAnswerHashV2(canonicalAnswer);
  const learningSupportHash = computeLearningSupportHashV2(revision.learningSupport);
  const rubricHash = computeRubricHashV2(stripRubricHash(scoringRubric));
  const relationsHash = computeRelationsHashV2(relations);
  const practiceItemHash = computePracticeItemHashV2(practiceItem ?? null);
  const semanticSupportReportSetHash = computeSemanticSupportReportSetHashV2(
    evidenceClosure.evidence.map((e) => e.semanticSupportReportHash),
  );

  const targetRevisionHash = computeTargetRevisionHashV2({
    semanticTargetFingerprint: objective.semanticTargetFingerprint,
    objectiveRevision: revision.revision,
    objectiveStatement: revision.objectiveStatement,
    publicSummary: revision.publicSummary,
    // 迁移期存量 revision 的 concept_label 可能为 NULL（回填前）；快照 hash 为
    // 写入时全新计算，与 revision 行上历史存值不存在比对关系，缺省按空串参与。
    conceptLabel: revision.conceptLabel ?? "",
    knowledgeForm,
    canonicalAnswerHash,
    learningSupportHash,
    rubricHash,
    relationsHash,
    practiceItemHash,
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
    cardContentEpoch: cardContentEpoch,
    objectiveLifecycleEpoch,
    target: {
      objectiveId,
      objectiveRevision: revision.revision,
      cardId,
      publicationRevision,
      cardRevision,
      publicPayloadHash: publicPayloadHash,
      revealPayloadHash: revealPayloadHash,
      objectiveStatement: revision.objectiveStatement,
      publicSummary: revision.publicSummary,
      knowledgeForm,
      preferredIntents,
      canonicalAnswer,
      learningSupport: revision.learningSupport as LearningTargetSnapshotV2["target"]["learningSupport"],
      scoringRubric,
      relations,
      practiceItem: practiceItem ?? null,
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
    cardContentEpoch: cardContentEpoch,
    objectiveLifecycleEpoch,
    cardId,
    publicationRevision,
    cardRevision,
    publicPayloadHash: publicPayloadHash,
    revealPayloadHash: revealPayloadHash,
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
    publicPayloadHash: publicPayloadHash,
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
    cardContentEpoch: cardContentEpoch,
    assistanceSnapshotHash: null,
    cardId,
    publicationRevision,
    cardRevision,
    publicPayloadHash: publicPayloadHash,
    revealPayloadHash: revealPayloadHash,
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
    cardContentEpoch: cardContentEpoch,
  };
}

/**
 * 从 run 加载已冻结的 TargetSnapshot（重建 §16.1 对象）。
 * run 没有 snapshot 行时返回 null；已有 snapshot 但缺少完整 target 时直接
 * fail closed，不再从 scalar 列拼装不完整目标。
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

  if (!row.target) {
    throw new TargetSnapshotError("snapshot_incomplete", "Frozen target snapshot has no target payload");
  }
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

export class TargetSnapshotError extends DomainError {
  constructor(code: string, message: string) {
    super({ name: "TargetSnapshotError", code, message, statusCode: 500 });
  }
}
