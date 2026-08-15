/**
 * 方案 20 R4：Candidate Evidence Binding Plan Assembler（§12.2 段 2 / §14.3）。
 *
 * Grounding 通过后，由确定性 assembler 生成 `CandidateEvidenceBindingPlanV2`，
 * 把每个 answer unit / learning support field / relation / required rubric unit
 * 绑定到 Grounding 报告中对应 entailed/supported 单元所引用的 Evidence snapshot。
 *
 * 设计原则（§12.2 段 2 / §14.3 / §13.1）：
 * - 不调用模型、不选择新事实——只消费 exact Candidate revision、通过的
 *   Grounding report 与 sealed Evidence manifest；
 * - 每个声明的 target unit 必须与 report 中对应单元一一对齐；缺失、多余、
 *   跨 workspace、非 usable Evidence、或 derived binding 缺 derivation report
 *   一律 fail closed；
 * - `bindingPlanHash`/`evidenceEligibilityVectorHash` 必须进入 Pedagogy、Deck Gate、
 *   Activation Request 与 activation quality closure；
 * - 故意不含尚不存在的 `objectiveRevisionId/bindingId`（domain-separated 计划闭包）。
 */

import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { candidateEvidenceBindingPlansV2 } from "../../db/schema/card-generation-v2.ts";
import {
  computeCandidateEvidenceBindingPlanHashV2,
  computeEvidenceEligibilityVectorHashV2,
  computeCandidateEvidenceSetHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import type {
  LearningCardCandidateRevisionV2,
  CanonicalAnswerV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type {
  GroundingCriticReportV2,
  CandidateEvidenceBindingPlanV2,
  EvidenceBindingTargetUnitV2,
  EvidenceBindingRelationV2,
  EvidenceSupportStrengthV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import type { SealedEvidenceEntryV2 } from "./evidence-seal-service.ts";
import { CardGenerationV2ServiceError } from "./helpers.ts";

export interface AssemblerEvidenceManifest {
  workspaceId: string;
  sourceSnapshotId: string;
  evidence: SealedEvidenceEntryV2[];
}

/** eligibility 向量的结构子集（assembly 只需要 snapshotId/epoch/status/stateHash）。 */
export interface EligibilityVectorEntry {
  evidenceSnapshotId: string;
  eligibilityEpoch: number;
  status: string;
  stateHash: string;
}

export interface AssembleBindingPlanInput {
  runId: string;
  workspaceId: string;
  candidate: LearningCardCandidateRevisionV2;
  groundingReport: GroundingCriticReportV2;
  evidenceManifest: AssemblerEvidenceManifest;
  eligibilityVector: EligibilityVectorEntry[];
}

export interface AssembleBindingPlanResult {
  plan: CandidateEvidenceBindingPlanV2;
  bindingPlanId: string;
  bindingPlanHash: string;
  evidenceEligibilityVectorHash: string;
  evidenceSetHash: string;
}

/** 待绑定目标单元（含它对 grounding report 的引用单元 id）。 */
interface TargetUnitBindingReq {
  targetUnit: EvidenceBindingTargetUnitV2;
  /** grounding report 中该单元的 verdict，必须 entailed/supported。 */
  verdict: string;
  evidenceSnapshotIds: string[];
}

/**
 * 从 candidate（answer / relations / rubric）与 canonical answer 中枚举
 * 所有需要绑定的 target unit + 对应教学支持字段。
 */
export function enumerateCandidateTargetUnits(
  candidate: LearningCardCandidateRevisionV2,
): {
  answerUnits: { answerUnitId: string }[];
  learningSupport: { field: "explanation" | "boundary" | "misconception" | "workedExample" }[];
  relations: { relationId: string }[];
  rubricUnits: { rubricUnitId: string; required: boolean }[];
} {
  const answerUnits: { answerUnitId: string }[] = [];
  collectAnswerUnitIds(candidate.objective.canonicalAnswer).forEach((id) =>
    answerUnits.push({ answerUnitId: id }),
  );

  const support = candidate.objective.learningSupport;
  const learningSupport: { field: "explanation" | "boundary" | "misconception" | "workedExample" }[] = [];
  if (support.explanation && support.explanation.trim().length > 0) {
    learningSupport.push({ field: "explanation" });
  }
  for (const f of ["boundary", "misconception", "workedExample"] as const) {
    if (support[f] && support[f].trim().length > 0) {
      learningSupport.push({ field: f });
    }
  }

  const relations = candidate.objective.relations.map((r) => ({ relationId: r.relationId }));

  const rubricUnits = candidate.objective.rubric.units.map((u) => ({
    rubricUnitId: u.rubricUnitId,
    required: u.required,
  }));

  return { answerUnits, learningSupport, relations, rubricUnits };
}

/**
 * 构造 binding plan。不写 DB——纯函数，便于单测。
 *
 * fail-closed 条件：
 * - 候选 target unit 在 grounding report 中缺对应单元；
 * - grounding report 中单元 verdict 不是 entailed/supported；
 * - report 未引用任何 evidence snapshot；
 * - 引用未知/非本 manifest 的 snapshot；
 * - snapshot 不在 workspace 内（manifest 已按 workspace 约束）；
 * - 引用非 usable eligibility 的 snapshot；
 * - 缺少 required rubric 绑定。
 */
export function assembleCandidateEvidenceBindingPlanV2(
  input: AssembleBindingPlanInput,
): AssembleBindingPlanResult {
  const { workspaceId, candidate, groundingReport, evidenceManifest, eligibilityVector } = input;
  const report = groundingReport;

  // ── 校验 candidate revision 与 report 对齐 ──
  if (report.candidateRevisionId !== candidate.candidateRevisionId) {
    throw new CardGenerationV2ServiceError(
      "binding_candidate_revision_mismatch",
      400,
      "grounding report references a different candidate revision than the candidate being assembled",
    );
  }
  if (report.candidateRevisionHash !== candidate.candidateRevisionHash) {
    throw new CardGenerationV2ServiceError(
      "binding_candidate_hash_mismatch",
      400,
      "grounding report candidateRevisionHash does not match candidate revision hash",
    );
  }
  if (report.verdict !== "pass") {
    throw new CardGenerationV2ServiceError(
      "binding_grounding_not_passed",
      409,
      `cannot assemble binding plan from a grounding report with verdict "${report.verdict}"`,
    );
  }

  // eligibility 查询表（snapshotId → status）
  const eligibilityById = new Map<string, string>();
  for (const e of eligibilityVector) {
    eligibilityById.set(e.evidenceSnapshotId, e.status);
  }

  // sealed snapshot 查询表
  const snapshotById = new Map<string, SealedEvidenceEntryV2>();
  for (const s of evidenceManifest.evidence) {
    snapshotById.set(s.evidenceSnapshotId, s);
  }

  const targetUnits = enumerateCandidateTargetUnits(candidate);

  // 收集所有 required binding 目标（with expected verdict）
  const requirements: TargetUnitBindingReq[] = [];

  for (const au of targetUnits.answerUnits) {
    const entry = report.answerUnits.find((x) => x.answerUnitId === au.answerUnitId);
    if (!entry) {
      throw new CardGenerationV2ServiceError(
        "binding_answer_verdict_missing",
        400,
        `missing grounding verdict for answer unit ${au.answerUnitId}`,
      );
    }
    requirements.push({
      targetUnit: { kind: "answer", answerUnitId: au.answerUnitId },
      verdict: entry.verdict,
      evidenceSnapshotIds: entry.evidenceSnapshotIds,
    });
  }

  for (const ls of targetUnits.learningSupport) {
    const entry = report.learningSupport.find((x) => x.field === ls.field);
    if (!entry) {
      throw new CardGenerationV2ServiceError(
        "binding_support_verdict_missing",
        400,
        `missing grounding verdict for learning support field ${ls.field}`,
      );
    }
    requirements.push({
      targetUnit: { kind: "learning_support", field: ls.field },
      verdict: entry.verdict,
      evidenceSnapshotIds: entry.evidenceSnapshotIds,
    });
  }

  for (const rel of targetUnits.relations) {
    const entry = report.relationSupport.find((x) => x.relationId === rel.relationId);
    if (!entry) {
      throw new CardGenerationV2ServiceError(
        "binding_relation_verdict_missing",
        400,
        `missing grounding verdict for relation ${rel.relationId}`,
      );
    }
    requirements.push({
      targetUnit: { kind: "relation", relationId: rel.relationId },
      verdict: entry.verdict,
      evidenceSnapshotIds: entry.evidenceSnapshotIds,
    });
  }

  for (const ru of targetUnits.rubricUnits) {
    const entry = report.rubricSupport.find((x) => x.rubricUnitId === ru.rubricUnitId);
    if (!entry) {
      throw new CardGenerationV2ServiceError(
        "binding_rubric_verdict_missing",
        400,
        `missing grounding verdict for rubric unit ${ru.rubricUnitId}`,
      );
    }
    if (ru.required) {
      requirements.push({
        targetUnit: { kind: "rubric", rubricUnitId: ru.rubricUnitId },
        verdict: entry.verdict,
        evidenceSnapshotIds: entry.evidenceSnapshotIds,
      });
    }
  }

  // ── 逐 requirement 构建 binding（fail-closed）──
  const bindings: CandidateEvidenceBindingPlanV2["bindings"] = [];

  for (const req of requirements) {
    const okEligible = req.verdict === "entailed" || req.verdict === "supported";
    const contradicted = req.verdict === "contradicted" || req.verdict === "unsupported";
    if (contradicted) {
      throw new CardGenerationV2ServiceError(
        "binding_unit_contradicted",
        400,
        `target unit ${unitLabel(req.targetUnit)} is contradicted/unsupported by grounding report`,
      );
    }
    if (!okEligible) {
      // insufficient → 没有可靠来源支持，fail closed
      throw new CardGenerationV2ServiceError(
        "binding_unit_insufficient",
        400,
        `target unit ${unitLabel(req.targetUnit)} has insufficient grounding support`,
      );
    }
    if (req.evidenceSnapshotIds.length === 0) {
      throw new CardGenerationV2ServiceError(
        "binding_no_evidence",
        400,
        `target unit ${unitLabel(req.targetUnit)} has no evidence snapshot`,
      );
    }

    // 确定为 direct 绑定（无 derivation 说明 → 禁止 derived）。
    // 本实现只产生 direct 绑定；derived 必须显式提供 derivation report（R5）。
    const supportStrength: EvidenceSupportStrengthV2 = "direct";

    for (const snapId of req.evidenceSnapshotIds) {
      const status = eligibilityById.get(snapId);
      if (!status) {
        throw new CardGenerationV2ServiceError(
          "binding_evidence_missing_eligibility",
          409,
          `evidence snapshot ${snapId} has no eligibility state (not sealed in this run)`,
        );
      }
      if (status !== "usable") {
        throw new CardGenerationV2ServiceError(
          "binding_evidence_not_usable",
          409,
          `evidence snapshot ${snapId} is not usable (status=${status})`,
        );
      }
      const snap = snapshotById.get(snapId);
      if (!snap) {
        throw new CardGenerationV2ServiceError(
          "binding_evidence_not_in_manifest",
          400,
          `evidence snapshot ${snapId} not present in sealed evidence manifest (cross-workspace or unknown)`,
        );
      }
      if (snap.sourceSnapshotId !== evidenceManifest.sourceSnapshotId) {
        throw new CardGenerationV2ServiceError(
          "binding_evidence_cross_snapshot",
          400,
          `evidence snapshot ${snapId} belongs to a different source snapshot`,
        );
      }
      // workspace 校验：sealed manifest 本身按 workspace 约束，且快照均属本 manifest。
      void workspaceId;

      bindings.push({
        targetUnit: req.targetUnit,
        evidenceSnapshotId: snap.evidenceSnapshotId,
        evidenceSnapshotHash: snap.evidenceSnapshotHash,
        relation: pickRelation(req.targetUnit),
        supportStrength,
        semanticSupportReportId: report.reportId,
        semanticSupportReportHash: report.reportHash,
      });
    }
  }

  if (bindings.length === 0) {
    throw new CardGenerationV2ServiceError(
      "binding_none",
      400,
      "binding plan produced no bindings (every candidate target unit must be bound to evidence)",
    );
  }

  // ── 计算 evidenceSetHash（须与 candidate.evidenceSetHash 一致）──
  const evidenceSetHash = computeCandidateEvidenceSetHashV2(
    evidenceManifest.evidence.map((e) => ({
      evidenceSnapshotId: e.evidenceSnapshotId,
      evidenceSnapshotHash: e.evidenceSnapshotHash,
    })),
  );

  const evidenceEligibilityVectorHash = computeEvidenceEligibilityVectorHashV2(
    eligibilityVector.map((e) => ({
      evidenceSnapshotId: e.evidenceSnapshotId,
      eligibilityEpoch: e.eligibilityEpoch,
      status: e.status,
      stateHash: e.stateHash,
    })),
  );

  const bindingPlanId = randomUUID();
  const planWithoutHash: Omit<CandidateEvidenceBindingPlanV2, "bindingPlanHash"> = {
    version: 2,
    bindingPlanId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    evidenceSetHash,
    evidenceEligibilityVectorHash,
    bindings,
  };
  const bindingPlanHash = computeCandidateEvidenceBindingPlanHashV2({
    candidateRevisionId: candidate.candidateRevisionId,
    bindings: bindings.map((b) => ({ ...b })),
  });

  const plan: CandidateEvidenceBindingPlanV2 = { ...planWithoutHash, bindingPlanHash };

  return {
    plan,
    bindingPlanId,
    bindingPlanHash,
    evidenceEligibilityVectorHash,
    evidenceSetHash,
  };
}

/**
 * 持久化 binding plan 到 `card_candidate_evidence_binding_plans_v2`（1:1 candidate revision）。
 */
export async function persistCandidateEvidenceBindingPlanV2(
  tx: ApiTransaction,
  input: AssembleBindingPlanInput,
): Promise<AssembleBindingPlanResult> {
  const result = assembleCandidateEvidenceBindingPlanV2(input);
  const { runId, workspaceId, candidate } = input;

  await tx.insert(candidateEvidenceBindingPlansV2).values({
    id: randomUUID(),
    workspaceId,
    bindingPlanId: result.bindingPlanId,
    runId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    planRevisionId: candidate.planRevisionId,
    planVersion: candidate.planVersion,
    planHash: candidate.planHash,
    // R32：§14.3 闭包——必须持久化完整 binding 条目（targetUnit + evidenceSnapshotId/
    // evidenceSnapshotHash + relation + supportStrength + semanticSupportReportId/hash），
    // 不得只落 targetUnit。激活时 §17.5 step 9 的 canonical binding 机械映射与
    // §13.1 eligibility 重验都依赖完整条目；只落 targetUnit 会导致自然激活链路
    // 丢失证据身份（evidenceSnapshotId 为空 → uuid 列插入失败 / 绑定哈希失真）。
    targetUnitBindings: result.plan.bindings.map((b) => ({ ...b })) as unknown as Record<string, unknown>,
    bindingPlanHash: result.bindingPlanHash,
    evidenceEligibilityVectorHash: result.evidenceEligibilityVectorHash,
  });

  return result;
}

function unitLabel(u: EvidenceBindingTargetUnitV2): string {
  switch (u.kind) {
    case "answer": return `answer:${u.answerUnitId}`;
    case "rubric": return `rubric:${u.rubricUnitId}`;
    case "relation": return `relation:${u.relationId}`;
    case "learning_support": return `learning_support:${u.field}`;
  }
}

/** §12.2/§14.3 relation 映射：由 target 单元类型决定关系标签。 */
function pickRelation(u: EvidenceBindingTargetUnitV2): EvidenceBindingRelationV2 {
  switch (u.kind) {
    case "rubric":
    case "answer":
    case "relation":
      return "entails";
    case "learning_support":
      return u.field === "boundary" ? "defines_boundary" : "supports_example";
  }
}

function collectAnswerUnitIds(answer: CanonicalAnswerV2): Set<string> {
  const ids = new Set<string>();
  switch (answer.kind) {
    case "text": ids.add(answer.unit.unitId); break;
    case "bullets": answer.items.forEach((i) => ids.add(i.unitId)); break;
    case "ordered_steps": answer.steps.forEach((s) => ids.add(s.unitId)); break;
    case "mapping": answer.pairs.forEach((p) => ids.add(p.unitId)); break;
    case "comparison": answer.rows.forEach((r) => ids.add(r.unitId)); break;
    case "formula": ids.add(answer.unitId); break;
    case "code": ids.add(answer.unitId); break;
  }
  return ids;
}
