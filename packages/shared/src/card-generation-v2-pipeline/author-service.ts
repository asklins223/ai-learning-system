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
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：本文件自 apps/api/src/modules/card-generation-v2/
 * 下沉至 packages/shared（纯逻辑、无 DB/provider 依赖）。worker 与 api 作为平级
 * 消费者经 @ailearn/shared/card-generation-v2-pipeline 子路径引用，消除 worker
 * 该模块是 card-generation-v2 pipeline 的 canonical authoring 实现。
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
} from "../card-generation-v2-contracts.ts";
import {
  computeCandidateRevisionHashV2,
  computeRubricHashV2,
} from "../card-generation-v2-hashing.ts";
import { hashCanonicalV2 } from "../hash-canonical-v2.ts";
import { DomainError } from "../domain-error.ts";
import { deriveConceptLabel } from "./concept-label.ts";
import { DEFAULT_V2_STAGE_CONCURRENCY, mapWithConcurrency } from "./concurrency.ts";

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
  /**
   * M2（2026-09-15 管线评审）：调用方基于 sealed manifest 计算的 evidenceSetHash。
   *
   * 该值是 candidateRevisionHash 的闭包输入之一。provider 必须原样回传（不得
   * 自行编造），否则 revision hash 会用错误的 evidenceSetHash 计算，与下游
   * 独立重算的值永久不一致（审计/跨服务校验必然 mismatch）。
   */
  evidenceSetHash?: string;
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。 */
  signal?: AbortSignal;
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
  /**
   * M2（2026-09-15 管线评审）：sealed manifest 的 evidenceSetHash。
   *
   * 存在时**以它为准**参与 candidateRevisionHash 计算（provider 自报值不参与），
   * 保证 revision hash 的闭包输入与落库的 `evidence_set_hash` 列一致。
   */
  evidenceSetHash?: string;
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 provider/LLM 调用。 */
  signal?: AbortSignal;
  /**
   * 阶段内并发上限（2026-09-17 性能改造）。
   *
   * Author 各候选之间无数据依赖，串行调用时墙钟 = N × 单次 provider 延迟。
   * 默认 `DEFAULT_V2_STAGE_CONCURRENCY`；调用方（worker）可用
   * `V2_STAGE_CONCURRENCY` 覆盖。结果**保序**，与串行版本逐字一致。
   */
  providerConcurrency?: number;
}

export interface AuthorResult {
  candidates: LearningCardCandidateRevisionV2[];
}

/**
 * Author 的候选预算（§8.5）：`plan.activationHardMax`，**不得扩大**。
 *
 * 2026-09-17（修复交付失败）：handler 的注释一直写着"budget = plan.activationHardMax，
 * 不得扩大"，但实现是"对 plan.result.objectives 全量出卡"。当计划里的目标数**超过**
 * 预算（micro-note 上限 3、客户端 hardMaxCards、服务端上限都可能小于目标池）时，
 * 产出的候选数就会超过 `activationHardMax`，deck gate 以 `count_out_of_plan`
 * **硬失败整条 run**——内容是全部通过 grounding + pedagogy 的，却交付不了。
 *
 * 现在预算在 shared 层收敛成单一实现：`executeAuthor` 与 worker 的按候选流水线都
 * 只对预算内的目标出卡，decisions 里被截断的原子由 planner 记 `omit_over_budget`。
 */
export function budgetedPlanObjectives(plan: CardPlanV2): PlannedObjectiveV2[] {
  if (plan.result.kind !== "author_candidates") return [];
  const budget = Math.max(0, plan.result.activationHardMax);
  return plan.result.objectives.slice(0, budget);
}

/**
 * 为**单个** PlannedObjective 生成候选 revision（§11.5 的单候选形式）。
 *
 * 2026-09-17（极限延迟改造）：拆出本函数是为了让调用方能做**按候选流水线**——
 * 候选 i 的 grounding 可以在候选 i 的 author 一返回时就发起，而不必等"全部
 * author 完成"再统一进入 grounding 波。两种调度的调用次数与数据完全相同，但
 * 墙钟从 `max(author_i) + max(grounding_i)` 变为 `max(author_i + grounding_i)`：
 * 单次延迟方差越大（实测 p50 7s / p90 12s / max 37s），收益越明显。
 *
 * `executeAuthor` 保留为"并发 + 保序"的批量入口（replan 等路径仍用它），
 * 两者共用同一份校验/冻结逻辑。
 */
export async function authorCandidateForObjective(
  input: AuthorInput,
  planObj: PlannedObjectiveV2,
): Promise<LearningCardCandidateRevisionV2> {
  const providerOutput = await input.provider.authorCandidate({
    planObjective: planObj,
    sourceContent: input.sourceContent,
    semanticSpecHash: input.semanticSpecHash,
    planHash: input.plan.planHash,
    evidenceList: input.evidenceList,
    evidenceSetHash: input.evidenceSetHash,
    signal: input.signal,
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

  // M2（管线评审）：evidenceSetHash 取调用方给出的 sealed manifest 值（权威），
  // provider 只在调用方未提供时自报。它必须与 candidateRevisionHash 的闭包
  // 输入一致——否则落库的 revision hash 与任何下游独立重算的值 mismatch。
  const evidenceSetHash = input.evidenceSetHash ?? providerOutput.evidenceSetHash;

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
    evidenceSetHash,
  };

  const candidateRevisionHash = computeCandidateRevisionHashV2(candidateWithoutHash);
  return { ...candidateWithoutHash, candidateRevisionHash };
}

/**
 * §11.5: 执行 Candidate Authoring（批量入口）。
 *
 * 2026-09-17（性能改造）：provider 调用由"逐候选串行 await"改为**有界并发**，
 * 候选之间没有数据依赖，因此并发不改变任何输入；结果按下标保序，rubric hash
 * 校验、candidateId 分配与数组顺序与串行版本完全一致。
 *
 * 失败语义不变：任一候选失败即整体抛出，`AuthorValidationError`
 * （rubric hash mismatch）仍是确定性失败。
 */
export async function executeAuthor(input: AuthorInput): Promise<AuthorResult> {
  if (input.plan.result.kind !== "author_candidates") {
    // no_cards_recommended: Author 不调用
    return { candidates: [] };
  }
  // §8.5：只对预算内的目标出卡（超出预算会让 deck gate 以 count_out_of_plan 硬失败）。
  const candidates = await mapWithConcurrency(
    budgetedPlanObjectives(input.plan),
    input.providerConcurrency ?? DEFAULT_V2_STAGE_CONCURRENCY,
    (planObj) => authorCandidateForObjective(input, planObj),
  );
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
