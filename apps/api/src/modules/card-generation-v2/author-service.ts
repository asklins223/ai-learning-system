/**
 * 方案 20 C2：Candidate Author（§11）。
 *
 * 职责（§11.1–11.6）：
 * - 从 PlannedObjective 生成 CardV2 草案（objective + presentation + rubric + evidence）；
 * - 遵守 CardPlan 冻结的 budget（不扩预算、不增卡数）；
 * - 输出 LearningCardCandidateRevisionV2（含 candidateRevisionHash）。
 *
 * 硬约束：
 * - Author 无 publish 权；
 * - 内部备选不是用户可见 Candidate；
 * - 不得用扩大 proposal 数量提高最终卡数；
 * - 不得为了 coverage 把每个 Atom 各生成一张。
 *
 * 本模块由 worker V2 handler 驱动，模型调用由调用方注入。
 */

import { randomUUID } from "node:crypto";
import type {
  CardPlanV2,
  LearningCardCandidateRevisionV2,
  LearningObjectiveDraftV2,
  CardPresentationDraftV2,
  ObjectiveRubricV2,
  CanonicalAnswerV2,
  PlannedObjectiveV2,
  KnowledgeFormV2,
  CardStrategyV2,
  TeachingTransformationV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeCandidateRevisionHashV2,
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { DomainError } from "@ailearn/shared";
import { deriveConceptLabel } from "./concept-label.ts";

// ─── Authoring Provider 接口 ─────────────────────────────────────────────

/**
 * 模型调用接口：调用方注入实际的 LLM 调用。
 * 本模块不直接调用 provider。
 */
export interface AuthoringProvider {
  /**
   * 为单个 PlannedObjective 生成 objective draft + presentation draft。
   * 返回的结构化内容必须经 zod strict parse。
   */
  authorCandidate(input: AuthoringProviderInput): Promise<AuthoringProviderOutput>;
}

export interface AuthoringProviderInput {
  planObjective: PlannedObjectiveV2;
  sourceContent: string;
  semanticSpecHash: string;
  planHash: string;
  /** R26：sealed evidence 清单（ID + quote hash），供 Author 引用（evidenceRefIds）。 */
  evidenceList?: Array<{ evidenceSnapshotId: string; quoteHash?: string | null }>;
}

export interface AuthoringProviderOutput {
  objective: LearningObjectiveDraftV2;
  presentation: CardPresentationDraftV2;
  evidenceSetHash: string;
}

// ─── Author Service ──────────────────────────────────────────────────────

export interface AuthorInput {
  runId: string;
  workspaceId: string;
  plan: CardPlanV2;
  sourceContent: string;
  semanticSpecHash: string;
  /** 注入的模型 authoring provider */
  provider: AuthoringProvider;
  /** R26：sealed evidence 清单（透传给 provider 供 prompt 引用） */
  evidenceList?: Array<{ evidenceSnapshotId: string; quoteHash?: string | null }>;
}

export interface AuthorResult {
  candidates: LearningCardCandidateRevisionV2[];
}

/**
 * §11.5: 执行 Candidate Authoring。
 *
 * 对 plan.result.objectives 中的每个 PlannedObjective，
 * 调用 provider 生成 objective draft + presentation draft，
 * 然后冻结为 LearningCardCandidateRevisionV2。
 */
export async function executeAuthor(input: AuthorInput): Promise<AuthorResult> {
  if (input.plan.result.kind !== "author_candidates") {
    // no_cards_recommended: Author 不调用
    return { candidates: [] };
  }

  const candidates: LearningCardCandidateRevisionV2[] = [];
  const planObjectives = input.plan.result.objectives;

  for (const planObj of planObjectives) {
    const providerOutput = await input.provider.authorCandidate({
      planObjective: planObj,
      sourceContent: input.sourceContent,
      semanticSpecHash: input.semanticSpecHash,
      planHash: input.plan.planHash,
      evidenceList: input.evidenceList,
    });

    // Validate rubric hash
    const expectedRubricHash = computeRubricHashV2(
      stripRubricHash(providerOutput.objective.rubric),
    );
    if (expectedRubricHash !== providerOutput.objective.rubric.rubricHash) {
      throw new AuthorValidationError(
        "rubric_hash_mismatch",
        `Rubric hash mismatch for objective ${planObj.objectiveLocalId}`,
      );
    }

    // Build candidate revision
    const candidateId = randomUUID();
    const candidateRevisionId = randomUUID();
    const revision = 1;

    const candidateWithoutHash: Omit<LearningCardCandidateRevisionV2, "candidateRevisionHash"> = {
      version: 2,
      candidateRevisionId,
      candidateId,
      revision,
      runId: input.runId,
      planRevisionId: input.plan.planRevisionId,
      planVersion: input.plan.planVersion,
      planHash: input.plan.planHash,
      cardContentEpoch: input.plan.cardContentEpoch,
      planObjectiveLocalId: planObj.objectiveLocalId,
      recommendation: {
        recommended: true,
        reasonCodes: planObj.reasonCodes,
      },
      derivedFromCandidateRevisions: [],
      objective: providerOutput.objective,
      presentation: providerOutput.presentation,
      evidenceSetHash: providerOutput.evidenceSetHash,
    };

    const candidateRevisionHash = computeCandidateRevisionHashV2(candidateWithoutHash);
    candidates.push({ ...candidateWithoutHash, candidateRevisionHash });
  }

  return { candidates };
}

// ─── Deterministic Authoring Fallback ────────────────────────────────────

/**
 * 确定性 Authoring fallback：不调用模型，从 PlannedObjective 直接构建
 * 最小可用的 objective draft + presentation draft。
 *
 * 仅用于测试或模型不可用时的 deterministic precheck。
 * 方案 20 §10.5 禁止把此 fallback 作为最终发布——必须经 Critic 门禁。
 */
export class DeterministicAuthoringProvider implements AuthoringProvider {
  async authorCandidate(input: AuthoringProviderInput): Promise<AuthoringProviderOutput> {
    const { planObjective, sourceContent } = input;

    // Build canonical answer from source
    const canonicalAnswer: CanonicalAnswerV2 = {
      kind: "text",
      unit: {
        unitId: `ans-${planObjective.objectiveLocalId}`,
        text: sourceContent.slice(0, 4000),
      },
    };

    // Build rubric
    const rubricWithoutHash: Omit<ObjectiveRubricV2, "rubricHash"> = {
      version: 2,
      units: [{
        rubricUnitId: `rubric-${planObjective.objectiveLocalId}`,
        facet: "recall",
        criterion: `能正确回答：${planObjective.objectiveStatement}`,
        required: true,
        answerUnitIds: [`ans-${planObjective.objectiveLocalId}`],
        evidenceRefIds: [],
      }],
      passingPolicy: {
        requireAllRequiredUnits: true,
        allowContradiction: false,
      },
    };
    const rubricHash = computeRubricHashV2(rubricWithoutHash);
    const rubric: ObjectiveRubricV2 = { ...rubricWithoutHash, rubricHash };

    // Build objective draft
    const objective: LearningObjectiveDraftV2 = {
      objectiveStatement: planObjective.objectiveStatement,
      publicSummary: planObjective.objectiveStatement.slice(0, 200),
      // W1-05：确定性 fallback 用派生标题（仅测试/precheck 路径，发布前仍过 Critic）。
      conceptLabel: deriveConceptLabel({
        objectiveStatement: planObjective.objectiveStatement,
      }),
      knowledgeForm: planObjective.knowledgeForm,
      preferredTaskIntents: ["recall"],
      canonicalAnswer,
      learningSupport: {
        explanation: sourceContent.slice(0, 6000),
      },
      rubric,
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [],
    };

    // Build presentation
    const strategy = mapKnowledgeFormToStrategy(planObjective.knowledgeForm);
    const transformationKind = mapKnowledgeFormToTransformation(planObjective.knowledgeForm);
    const presentation: CardPresentationDraftV2 = {
      strategy,
      transformationKind,
      front: {
        cue: planObjective.objectiveStatement.slice(0, 200),
        prompt: `请回答：${planObjective.objectiveStatement}`,
      },
      estimatedReviewSeconds: planObjective.estimatedReviewCostSeconds,
    };

    const evidenceSetHash = hashCanonicalV2("evidence-set-v2", { source: sourceContent.slice(0, 500) });

    return { objective, presentation, evidenceSetHash };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function stripRubricHash(rubric: ObjectiveRubricV2): Omit<ObjectiveRubricV2, "rubricHash"> {
  const { rubricHash: _, ...rest } = rubric;
  return rest;
}

function mapKnowledgeFormToStrategy(form: KnowledgeFormV2): CardStrategyV2 {
  const map: Record<KnowledgeFormV2, CardStrategyV2> = {
    fact: "recall",
    definition: "recall",
    relationship: "compare",
    comparison: "compare",
    sequence: "sequence",
    procedure: "sequence",
    causal_model: "why",
    boundary: "boundary",
    application_rule: "application",
  };
  return map[form] ?? "recall";
}

function mapKnowledgeFormToTransformation(form: KnowledgeFormV2): TeachingTransformationV2 {
  const map: Record<KnowledgeFormV2, TeachingTransformationV2> = {
    fact: "retrieval_definition",
    definition: "retrieval_definition",
    relationship: "structured_comparison",
    comparison: "structured_comparison",
    sequence: "procedure_reconstruction",
    procedure: "procedure_reconstruction",
    causal_model: "mechanism_reconstruction",
    boundary: "boundary_discrimination",
    application_rule: "source_grounded_application",
  };
  return map[form] ?? "retrieval_definition";
}

// ─── Errors ──────────────────────────────────────────────────────────────

export class AuthorValidationError extends DomainError {
  constructor(code: string, message: string) {
    super({ name: "AuthorValidationError", code, message, statusCode: 500 });
  }
}
