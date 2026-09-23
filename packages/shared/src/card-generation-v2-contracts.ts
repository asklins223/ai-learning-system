/**
 * 方案 20（learning-card-v2 价值优先生成与 LearningTarget 重基）Generation
 * 域 Shared Contracts（C1 交付）。
 *
 * 覆盖方案 20 §7.1/7.2/7.6 基础枚举、§8 CardPlan、§9 GenerationSpec、
 * §11 Candidate、§13.2 Deck Gate、§17.1/17.2/17.4/17.5/17.6 API 合同。
 *
 * 硬约束（§1.4 裁决顺序 / §9.5）：
 * - 所有 schema `.strict()`，unknown field fail closed；
 * - 所有 hash 经版本化 canonical serializer（§9.5），实现位于
 *   card-generation-v2-hashing.ts（服务端子路径），禁止各模块直接
 *   JSON.stringify；
 * - 允许 0 张是服务端永久不变量；不存在任何 minCards；
 * - `no_cards_recommended` / `activated` / `closed_without_activation` 都是
 *   成功终态，`failed` / `needs_attention` 有独立语义（§13.4）；
 * - Candidate 三态（quality/review/publish）分离，`review_ready` 是派生视图
 *   （§11.4），不是可独立写入的状态字段；
 * - 答案（canonicalAnswer/rubric/私有 evidence）绝不进入 public DTO 或事件
 *   payload（§17.6 / §11.3）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出（客户端 bundle 安全）。
 */

import { z } from "zod";
import { taskIntentSchema } from "./learning-run-contracts.ts";

// ─── §7/§9 基础枚举 ──────────────────────────────────────────────────────

export const CardLearningGoalValuesV2 = [
  "remember",
  "understand",
  "apply",
  "exam",
] as const;
export const cardLearningGoalV2Schema = z.enum(CardLearningGoalValuesV2);
export type CardLearningGoalV2 = z.infer<typeof cardLearningGoalV2Schema>;

export const CardDetailThresholdValuesV2 = [
  "concise",
  "balanced",
  "deep",
] as const;
export const cardDetailThresholdV2Schema = z.enum(CardDetailThresholdValuesV2);
export type CardDetailThresholdV2 = z.infer<typeof cardDetailThresholdV2Schema>;

export const CardStrategyValuesV2 = [
  "recall",
  "cloze",
  "compare",
  "sequence",
  "why",
  "boundary",
  "application",
] as const;
export const cardStrategyV2Schema = z.enum(CardStrategyValuesV2);
export type CardStrategyV2 = z.infer<typeof cardStrategyV2Schema>;

export const KnowledgeFormValuesV2 = [
  "fact",
  "definition",
  "relationship",
  "comparison",
  "sequence",
  "procedure",
  "causal_model",
  "boundary",
  "application_rule",
] as const;
export const knowledgeFormV2Schema = z.enum(KnowledgeFormValuesV2);
export type KnowledgeFormV2 = z.infer<typeof knowledgeFormV2Schema>;

export const TeachingTransformationValuesV2 = [
  "retrieval_definition",
  "mechanism_reconstruction",
  "structured_comparison",
  "procedure_reconstruction",
  "boundary_discrimination",
  "misconception_correction",
  "source_grounded_application",
] as const;
export const teachingTransformationV2Schema = z.enum(
  TeachingTransformationValuesV2,
);
export type TeachingTransformationV2 = z.infer<
  typeof teachingTransformationV2Schema
>;

export const CardGenerationFeedbackReasonValuesV2 = [
  "too_many",
  "missing_key_objective",
  "surface_paraphrase",
  "wrong_learning_goal",
  "duplicate_existing_card",
  "not_worth_reviewing",
] as const;
export const cardGenerationFeedbackReasonV2Schema = z.enum(
  CardGenerationFeedbackReasonValuesV2,
);
export type CardGenerationFeedbackReasonV2 = z.infer<
  typeof cardGenerationFeedbackReasonV2Schema
>;

export const NoCardReasonCodeValuesV2 = [
  "no_learnable_objective",
  "review_cost_exceeds_value",
  "already_covered_by_active_objectives",
  "source_is_temporary_or_operational",
  "insufficient_reliable_evidence",
  "no_pedagogically_useful_transformation",
  "unsupported_for_requested_goal",
] as const;
export const noCardReasonCodeV2Schema = z.enum(NoCardReasonCodeValuesV2);
export type NoCardReasonCodeV2 = z.infer<typeof noCardReasonCodeV2Schema>;

/** §17.2 Generation Run 状态机。成功终态：no_cards_recommended / activated / closed_without_activation。 */
export const CardGenerationRunStatusValuesV2 = [
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "review_ready",
  "no_cards_recommended",
  "needs_attention",
  "activating",
  "activated",
  "closed_without_activation",
  "failed",
  "cancelled",
  "stale",
] as const;
export const cardGenerationRunStatusV2Schema = z.enum(
  CardGenerationRunStatusValuesV2,
);
export type CardGenerationRunStatusV2 = z.infer<
  typeof cardGenerationRunStatusV2Schema
>;

/** 成功终态（§17.2 说明段）。 */
export const CARD_GENERATION_SUCCESS_TERMINAL_STATUSES_V2: ReadonlySet<CardGenerationRunStatusV2> =
  new Set(["no_cards_recommended", "activated", "closed_without_activation"]);

// ─── §9.1 客户端请求 ─────────────────────────────────────────────────────

export const sourceScopeV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whole_note") }),
  z.strictObject({
    kind: z.literal("section"),
    sectionKey: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("selection"),
    blockRanges: z
      .array(
        z
          .strictObject({
            blockId: z.string().uuid(),
            startOffset: z.number().int().min(0),
            endOffset: z.number().int().min(0),
          })
          .superRefine((range, ctx) => {
            if (range.endOffset <= range.startOffset) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "endOffset must be greater than startOffset",
                path: ["endOffset"],
              });
            }
          }),
      )
      .min(1)
      .max(500),
  }),
]);
export type SourceScopeV2 = z.infer<typeof sourceScopeV2Schema>;

/** 温度/概率在 hash 中按 integer basis points 序列化（§9.5 禁止浮点）。 */
const samplingTemperatureSchema = z
  .number()
  .min(0)
  .max(2)
  .refine((n) => Math.round(n * 10_000) === n * 10_000, {
    message: "temperature must have at most 4 decimal places",
  });

export const createCardGenerationRunRequestV2Schema = z
  .strictObject({
    version: z.literal(2),
    noteVersionId: z.string().uuid(),
    sourceScope: sourceScopeV2Schema,
    learningGoal: cardLearningGoalV2Schema,
    detailThreshold: cardDetailThresholdV2Schema,
    quantity: z
      .strictObject({
        kind: z.literal("adaptive"),
        hardMaxCards: z.number().int().min(0).max(50).optional(),
      })
      .strict(),
    preferredStrategies: z
      .array(cardStrategyV2Schema)
      .max(8)
      .optional(),
    feedbackContext: z
      .strictObject({
        previousRunId: z.string().uuid(),
        reasonCodes: z
          .array(cardGenerationFeedbackReasonV2Schema)
          .min(1)
          .max(8),
        optionalNote: z.string().min(1).max(2000).optional(),
      })
      .optional(),
    reusePolicy: z
      .enum(["allow_exact_reuse", "force_recompute"])
      .optional(),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict();
export type CreateCardGenerationRunRequestV2 = z.infer<
  typeof createCardGenerationRunRequestV2Schema
>;

// ─── §9.2 Semantic Spec / Input Snapshot ─────────────────────────────────

export const generationStageRuntimeSnapshotV2Schema = z
  .strictObject({
    stage: z.enum([
      "planner",
      "author",
      "grounding_critic",
      "pedagogy_critic",
    ]),
    providerId: z.string().min(1).max(200),
    modelSnapshot: z.string().min(1).max(500),
    deploymentId: z.string().min(1).max(200),
    capabilityFingerprint: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(200),
    sampling: z
      .strictObject({
        temperature: samplingTemperatureSchema,
        topP: samplingTemperatureSchema.optional(),
        seed: z.number().int().optional(),
      })
      .strict(),
    outputSchemaVersion: z.string().min(1).max(200),
  })
  .strict();
export type GenerationStageRuntimeSnapshotV2 = z.infer<
  typeof generationStageRuntimeSnapshotV2Schema
>;

export const generationSemanticSpecV2Schema = z
  .strictObject({
    version: z.literal(2),
    semanticRequest: z
      .strictObject({
        sourceScope: sourceScopeV2Schema,
        learningGoal: cardLearningGoalV2Schema,
        detailThreshold: cardDetailThresholdV2Schema,
        quantity: z
          .strictObject({
            kind: z.literal("adaptive"),
            hardMaxCards: z.number().int().min(0).max(50).optional(),
          })
          .strict(),
        preferredStrategies: z
          .array(cardStrategyV2Schema)
          .max(8)
          .optional(),
        feedbackContext: z
          .strictObject({
            previousRunId: z.string().uuid(),
            reasonCodes: z
              .array(cardGenerationFeedbackReasonV2Schema)
              .min(1)
              .max(8),
            optionalNote: z.string().min(1).max(2000).optional(),
          })
          .optional(),
      })
      .strict(),
    policies: z
      .strictObject({
        plannerPolicyVersion: z.string().min(1).max(200),
        deterministicGateVersion: z.string().min(1).max(200),
        evidencePolicyVersion: z.string().min(1).max(200),
        targetPolicyVersion: z.string().min(1).max(200),
        cardContractVersion: z.literal("learning-card-v2"),
        targetSnapshotVersion: z.literal("learning-target-snapshot-v2"),
        stageRuntimes: z.array(generationStageRuntimeSnapshotV2Schema).min(1),
      })
      .strict(),
    governancePolicyVersion: z.string().min(1).max(200),
    semanticSpecHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GenerationSemanticSpecV2 = z.infer<
  typeof generationSemanticSpecV2Schema
>;

export const generationInputSnapshotV2Schema = z
  .strictObject({
    version: z.literal(2),
    generationRunId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
    rawRequest: createCardGenerationRunRequestV2Schema,
    sourceSnapshot: z
      .strictObject({
        sourceSnapshotId: z.string().uuid(),
        noteId: z.string().uuid(),
        noteVersionId: z.string().uuid(),
        sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
        sourceContentHash: z.string().regex(/^[0-9a-f]{64}$/),
        blockManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
        assetManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
        scopeManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    semanticSpecHash: z.string().regex(/^[0-9a-f]{64}$/),
    generationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    cardContentEpoch: z.number().int().min(1),
    inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GenerationInputSnapshotV2 = z.infer<
  typeof generationInputSnapshotV2Schema
>;

// ─── §8 Knowledge Atom / CardPlan ────────────────────────────────────────

export const knowledgeAtomV2Schema = z
  .strictObject({
    atomId: z.string().min(1).max(160),
    proposition: z.string().min(1).max(4000),
    evidenceRefIds: z.array(z.string().uuid()).max(100),
    sourceSectionKeys: z.array(z.string().min(1).max(200)).max(50),
    importanceBps: z.number().int().min(0).max(10_000),
    learnabilityBps: z.number().int().min(0).max(10_000),
    confidenceBps: z.number().int().min(0).max(10_000),
  })
  .strict();
export type KnowledgeAtomV2 = z.infer<typeof knowledgeAtomV2Schema>;

export const atomDecisionV2Schema = z.discriminatedUnion("decision", [
  z.strictObject({
    atomId: z.string().min(1).max(160),
    decision: z.literal("create_objective"),
    objectiveLocalId: z.string().min(1).max(160),
  }),
  z.strictObject({
    atomId: z.string().min(1).max(160),
    decision: z.literal("support_objective"),
    objectiveLocalId: z.string().min(1).max(160),
  }),
  z.strictObject({
    atomId: z.string().min(1).max(160),
    decision: z.literal("covered_by_existing_objective"),
    existingLearningObjectiveId: z.string().uuid(),
  }),
  z.strictObject({
    atomId: z.string().min(1).max(160),
    decision: z.enum([
      "omit_trivial",
      "omit_duplicate",
      "omit_not_learnable",
      "omit_unreliable",
      "unsupported_for_requested_goal",
      /**
       * 2026-09-17：原子本身可学，但计划预算（`activationHardMax`）已满——
       * §8.5 要求 `recommendedCardCount ≤ activationHardMax`，而预算含
       * micro-note / 服务端 / 客户端上限，可能小于可学原子数。显式记账，
       * 使"这个知识点为什么没成卡"在计划里可审计。
       */
      "omit_over_budget",
    ]),
  }),
]);
export type AtomDecisionV2 = z.infer<typeof atomDecisionV2Schema>;

/**
 * v25：按知识形态限定"这道客观题该长什么样"。
 *
 * 依据（2026-09-21 真跑实测）：v24 之后模型愿意填 practiceItem 了，但它总挑
 * `ordering`。看着像偷懒，查了知识形态才发现——那两张卡本来就是 sequence/procedure，
 * ordering 是**正确形状**。真正的空白是另一头：fact / definition / boundary 这类
 * 没有内在次序的知识，一条选择题都没产出过。所以不能靠"多写点提示"碰运气，
 * 得按形态给形状，并把这条变成一个可以单点断言的表。
 *
 * 顺序即优先级：第一个是首选形状。声明放在这里（而不是紧挨着 practiceItem 合同），
 * 是因为 planner 分配的 `practiceForm` 要用它做枚举——同一份清单不另抄一遍。
 */
export const PracticeItemFormValuesV2 = [
  "single_choice", "true_false", "ordering", "matching",
] as const;
export type PracticeItemFormV2 = (typeof PracticeItemFormValuesV2)[number];

export const plannedObjectiveV2Schema = z
  .strictObject({
    objectiveLocalId: z.string().min(1).max(160),
    objectiveStatement: z.string().min(1).max(2000),
    priority: z.enum(["critical", "important", "optional"]),
    knowledgeForm: knowledgeFormV2Schema,
    /**
     * 题型由 planner 在整批目标上统一分配（`allocateStrategies`），author 只能
     * 执行不能自选——此前 strategy 完全交给模型，而 author 提示的输出模板与唯一
     * 示例都写死 `recall`，模型照抄导致整批卡同一个题型。
     */
    strategy: cardStrategyV2Schema,
    /**
     * 这张卡本轮**必须**交出的客观练习件形状（D6 的批次配额，planner 分配）。
     * null = 不强制，作者仍可自愿交。和 `strategy` 同一个道理：整批层面的配额
     * 不能在 author 逐张出题时决定——它看不到别的卡。
     */
    practiceForm: z.enum(PracticeItemFormValuesV2).nullable(),
    sourceAtomIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(20),
    estimatedReviewCostSeconds: z.number().int().min(1).max(3600),
    changeContext: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("create_new") }),
      z.strictObject({
        kind: z.literal("update_existing"),
        cardId: z.string().uuid(),
        objectiveId: z.string().uuid(),
        expectedPublicationRevision: z.number().int().min(1),
        expectedObjectiveRevision: z.number().int().min(1),
        expectedObjectiveLifecycleEpoch: z.number().int().min(1),
      }),
    ]),
  })
  .strict();
export type PlannedObjectiveV2 = z.infer<typeof plannedObjectiveV2Schema>;

export const plannedExistingLifecycleActionV2Schema = z
  .strictObject({
    actionId: z.string().uuid(),
    kind: z.enum(["keep_existing", "propose_archive"]),
    cardId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    expectedPublicationRevision: z.number().int().min(1),
    expectedObjectiveLifecycleEpoch: z.number().int().min(1),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(20),
  })
  .strict();
export type PlannedExistingLifecycleActionV2 = z.infer<
  typeof plannedExistingLifecycleActionV2Schema
>;

/**
 * 计划的结论单独成 schema：读路径（候选列表要按整批点名结算练习件配额）只拿得到
 * `result` 这一列，而 `cardPlanV2Schema` 经过 `superRefine` 之后不再暴露 `.shape`，
 * 没法从它身上取下嵌套合同。两处各写一份联合类型，就会有一份悄悄过期。
 */
export const cardPlanResultV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("no_cards_recommended"),
    reasonCodes: z.array(noCardReasonCodeV2Schema).min(1).max(8),
  }),
  z.strictObject({
    kind: z.literal("author_candidates"),
    recommendedCardCount: z.number().int().min(0),
    activationHardMax: z.number().int().min(0),
    objectives: z.array(plannedObjectiveV2Schema).min(1),
    existingActions: z
      .array(plannedExistingLifecycleActionV2Schema)
      .max(50),
  }),
]);
export type CardPlanResultV2 = z.infer<typeof cardPlanResultV2Schema>;

export const cardPlanV2Schema = z
  .strictObject({
    version: z.literal(2),
    planRevisionId: z.string().uuid(),
    runId: z.string().uuid(),
    inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    cardContentEpoch: z.number().int().min(1),
    planVersion: z.number().int().min(1),
    previousPlanRevisionId: z.string().uuid().nullable(),
    result: cardPlanResultV2Schema,
    atomDecisions: z.array(atomDecisionV2Schema).max(1000),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((plan, ctx) => {
    // §8.5：recommendedCardCount 不得超过 activationHardMax（服务端 policy
    // cap 由 planner policy 保证，不属于 contract 可校验范围）。
    if (
      plan.result.kind === "author_candidates" &&
      plan.result.recommendedCardCount > plan.result.activationHardMax
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recommendedCardCount must not exceed activationHardMax",
        path: ["result", "recommendedCardCount"],
      });
    }
  });
export type CardPlanV2 = z.infer<typeof cardPlanV2Schema>;

// ─── §11 Candidate ───────────────────────────────────────────────────────

export const canonicalAnswerV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    unit: z.strictObject({
      unitId: z.string().min(1).max(160),
      text: z.string().min(1).max(8000),
    }),
  }),
  z.strictObject({
    kind: z.literal("bullets"),
    items: z
      .array(
        z.strictObject({
          unitId: z.string().min(1).max(160),
          text: z.string().min(1).max(4000),
        }),
      )
      .min(1)
      .max(60),
  }),
  z.strictObject({
    kind: z.literal("ordered_steps"),
    steps: z
      .array(
        z.strictObject({
          unitId: z.string().min(1).max(160),
          text: z.string().min(1).max(4000),
        }),
      )
      .min(2)
      .max(60),
  }),
  z.strictObject({
    kind: z.literal("mapping"),
    pairs: z
      .array(
        z.strictObject({
          unitId: z.string().min(1).max(160),
          left: z.string().min(1).max(2000),
          right: z.string().min(1).max(4000),
        }),
      )
      .min(1)
      .max(80),
  }),
  z.strictObject({
    kind: z.literal("comparison"),
    columns: z.array(z.string().min(1).max(300)).min(2).max(12),
    rows: z
      .array(
        z.strictObject({
          unitId: z.string().min(1).max(160),
          dimension: z.string().min(1).max(1000),
          values: z.array(z.string().min(1).max(4000)).min(1).max(12),
        }),
      )
      .min(1)
      .max(60),
  }),
  z.strictObject({
    kind: z.literal("formula"),
    unitId: z.string().min(1).max(160),
    latex: z.string().min(1).max(4000),
    variableMeanings: z
      .array(
        z.strictObject({
          symbol: z.string().min(1).max(100),
          meaning: z.string().min(1).max(1000),
        }),
      )
      .min(1)
      .max(60),
  }),
  z.strictObject({
    kind: z.literal("code"),
    unitId: z.string().min(1).max(160),
    language: z.string().min(1).max(100),
    code: z.string().min(1).max(20_000),
    explanation: z.string().min(1).max(4000).optional(),
  }),
]);
export type CanonicalAnswerV2 = z.infer<typeof canonicalAnswerV2Schema>;

export const objectiveRubricV2Schema = z
  .strictObject({
    version: z.literal(2),
    units: z
      .array(
        z.strictObject({
          rubricUnitId: z.string().min(1).max(160),
          facet: taskIntentSchema,
          criterion: z.string().min(1).max(2000),
          required: z.boolean(),
          answerUnitIds: z.array(z.string().min(1).max(160)).min(1).max(80),
          evidenceRefIds: z.array(z.string().uuid()).min(1).max(100),
          contradictionRules: z
            .array(z.string().min(1).max(1000))
            .max(20)
            .optional(),
        }),
      )
      .min(1)
      .max(80),
    passingPolicy: z.strictObject({
      requireAllRequiredUnits: z.literal(true),
      allowContradiction: z.literal(false),
    }),
    rubricHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    if (!rubric.units.some((unit) => unit.required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["units"],
        message: "at least one rubric unit must be required",
      });
    }

    const rubricUnitIds = new Set<string>();
    rubric.units.forEach((unit, index) => {
      if (rubricUnitIds.has(unit.rubricUnitId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index, "rubricUnitId"],
          message: "rubricUnitId must be unique",
        });
      }
      rubricUnitIds.add(unit.rubricUnitId);
    });
  });
export type ObjectiveRubricV2 = z.infer<typeof objectiveRubricV2Schema>;

export const objectiveRelationV2Schema = z
  .strictObject({
    relationId: z.string().min(1).max(160),
    fromAnswerUnitId: z.string().min(1).max(160),
    toAnswerUnitId: z.string().min(1).max(160),
    kind: z.enum(["before", "depends_on", "causes", "contrasts_with"]),
    evidenceRefIds: z.array(z.string().uuid()).min(1).max(100),
    relationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ObjectiveRelationV2 = z.infer<typeof objectiveRelationV2Schema>;

/**
 * 一张卡的两级提示（2026-09-20 实走复盘 #10）。
 *
 * 此前提示由 `buildDeterministicHint`（learning-runs/run-planner.ts:746）从一张
 * 9 意图 × 3 文案的常量表里取，卡片正文完全不参与——任意两张卡的第一级提示一字不差。
 * 现在改为**作者制卡时随卡片一起产出**，作答时按级下发。
 *
 * 两级都不许出现 canonicalAnswer 的判分要点（与 front 同一纪律，由 Pedagogy Critic
 * 语义裁决）：一级给结构线索（"先说出它由哪两部分构成"），二级给更强的定位但不给结论
 * （首字、组成部分数量、易混点）。
 */
export const cardHintPairV2Schema = z.strictObject({
  level1: z.string().min(1).max(600),
  level2: z.string().min(1).max(600),
});
export type CardHintPairV2 = z.infer<typeof cardHintPairV2Schema>;

/**
 * 客观练习件（2026-09-21 方案 D1/D4，docs/plans/objective-card-items-2026-09-21.md）。
 *
 * 与 `canonicalAnswer` **并列**而不是取代它：正式验证仍是产出型（文档明文：纯选择题
 * 不能可靠证明理解），练习件只走练习/诊断通道、由确定性判分器比对。
 *
 * 因为它落在 `objective_draft` 里，所以自动进 revision 哈希闭包 —— 与 hints 相反，
 * 提示不是判分内容、被明确排除在闭包之外，而这里的正确项**必须**在闭包内。
 */
const practiceItemOptionSchema = z.strictObject({
  unitId: z.string().min(1).max(40),
  text: z.string().min(1).max(400),
  /** 干扰项也必须可追溯：给不出证据的干扰项应由作者不产出整件，而不是硬造（§16.5）。 */
  evidenceRefIds: z.array(z.string().uuid()).max(20).optional(),
});

const practiceItemPairSchema = z.strictObject({
  leftId: z.string().min(1).max(40),
  leftText: z.string().min(1).max(400),
  rightId: z.string().min(1).max(40),
  rightText: z.string().min(1).max(400),
  evidenceRefIds: z.array(z.string().uuid()).max(20).optional(),
});

export const practiceItemV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("single_choice"),
    options: z.array(practiceItemOptionSchema).min(2).max(6),
    correctUnitId: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal("true_false"),
    proposition: z.string().min(1).max(2000),
    expected: z.boolean(),
    evidenceRefIds: z.array(z.string().uuid()).max(20).optional(),
  }),
  z.strictObject({
    kind: z.literal("ordering"),
    units: z.array(practiceItemOptionSchema).min(2).max(8),
    correctUnitOrder: z.array(z.string().min(1).max(40)).min(2).max(8),
  }),
  z.strictObject({
    kind: z.literal("matching"),
    pairs: z.array(practiceItemPairSchema).min(2).max(8),
  }),
]);
export type PracticeItemV2 = z.infer<typeof practiceItemV2Schema>;

export const PRACTICE_FORMS_BY_KNOWLEDGE_FORM: Record<KnowledgeFormV2, readonly PracticeItemFormV2[]> = {
  fact: ["single_choice", "true_false"],
  definition: ["single_choice", "true_false"],
  boundary: ["true_false", "single_choice"],
  application_rule: ["single_choice"],
  causal_model: ["true_false", "single_choice"],
  relationship: ["matching", "single_choice"],
  comparison: ["matching", "single_choice"],
  sequence: ["ordering"],
  procedure: ["ordering", "matching"],
};

export function practiceFormsForKnowledgeForm(
  form: KnowledgeFormV2,
): readonly PracticeItemFormV2[] {
  return PRACTICE_FORMS_BY_KNOWLEDGE_FORM[form] ?? [];
}

/**
 * 正确项必须是**给出过的**选项，否则判分器永远比不中、这道题变成死题。
 * 模型输出的 id 空间由它自己编，所以这条必须在合同层兜住。
 */
export function practiceItemCrossRefError(item: PracticeItemV2): string | null {
  if (item.kind === "single_choice") {
    const ids = item.options.map((option) => option.unitId);
    if (!ids.includes(item.correctUnitId)) return "correctUnitId 不在 options 里";
    if (new Set(ids).size !== ids.length) return "options unitId 重复";
    if (ids.length < 2) return "选项不足两项";
    return null;
  }
  if (item.kind === "ordering") {
    const ids = item.units.map((unit) => unit.unitId);
    if (new Set(ids).size !== ids.length) return "units unitId 重复";
    if (
      item.correctUnitOrder.length !== ids.length
      || item.correctUnitOrder.some((id) => !ids.includes(id))
      || new Set(item.correctUnitOrder).size !== ids.length
    ) return "correctUnitOrder 不是 units 的一个全排列";
    return null;
  }
  if (item.kind === "matching") {
    const lefts = item.pairs.map((pair) => pair.leftId);
    const rights = item.pairs.map((pair) => pair.rightId);
    if (new Set(lefts).size !== lefts.length) return "配对左端 id 重复";
    if (new Set(rights).size !== rights.length) return "配对右端 id 重复";
    return null;
  }
  return null;
}

/**
 * 作者没交 practiceItem、但 canonicalAnswer 本身就是结构化时，**零模型**派生一道
 * 客观练习件（2026-09-21 方案 D6）。
 *
 * 这不是伪造：单元、文本、顺序全部来自作者已经写下的答案，这里只是把"排出正确
 * 顺序 / 连出正确配对"这个任务形状显式化。反过来，`text`/`bullets` 这类没有内在
 * 次序的答案**不派生** —— 那需要编造干扰项，正是 §16.5 与本方案 D4 禁止的事。
 */
export function derivePracticeItemFromCanonicalAnswer(
  answer: CanonicalAnswerV2,
): PracticeItemV2 | undefined {
  if (answer.kind === "ordered_steps" && answer.steps.length >= 2) {
    return {
      kind: "ordering",
      units: answer.steps.map((step) => ({ unitId: step.unitId, text: step.text })),
      correctUnitOrder: answer.steps.map((step) => step.unitId),
    };
  }
  if (answer.kind === "mapping" && answer.pairs.length >= 2) {
    return {
      kind: "matching",
      pairs: answer.pairs.map((pair, index) => ({
        leftId: `left-${index + 1}`,
        leftText: pair.left,
        rightId: `right-${index + 1}`,
        rightText: pair.right,
      })),
    };
  }
  return undefined;
}

export const learningObjectiveDraftV2Schema = z
  .strictObject({
    objectiveStatement: z.string().min(1).max(2000),
    publicSummary: z.string().min(1).max(1500),
    // Plan 23 W1-05：概念级知识标题（名词短语；不把 cue/prompt/完整命题当标题）。
    // 2026-08-22 修复：此前合同缺此字段导致 revision.concept_label 永远为 NULL，
    // 前端标题回退 publicSummary 造成"标题=摘要"。空值只允许迁移期存量记录。
    conceptLabel: z.string().min(1).max(200),
    knowledgeForm: knowledgeFormV2Schema,
    preferredTaskIntents: z.array(taskIntentSchema).min(1).max(6),
    canonicalAnswer: canonicalAnswerV2Schema,
    /** 客观练习件；作者给不出可追溯的干扰项时就该缺省，绝不为凑数硬造。 */
    practiceItem: practiceItemV2Schema.optional(),
    learningSupport: z.strictObject({
      explanation: z.string().min(1).max(6000),
      boundary: z.string().min(1).max(3000).optional(),
      misconception: z.string().min(1).max(3000).optional(),
      workedExample: z.string().min(1).max(6000).optional(),
    }),
    rubric: objectiveRubricV2Schema,
    relations: z.array(objectiveRelationV2Schema).max(60),
    difficulty: z.enum(["introductory", "intermediate", "advanced"]),
    evidenceRefIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();
export type LearningObjectiveDraftV2 = z.infer<
  typeof learningObjectiveDraftV2Schema
>;

export const cardPresentationDraftV2Schema = z
  .strictObject({
    strategy: cardStrategyV2Schema,
    transformationKind: teachingTransformationV2Schema,
    front: z.strictObject({
      cue: z.string().min(1).max(2000),
      context: z.string().min(1).max(3000).optional(),
      prompt: z.string().min(1).max(2000),
      mediaRefs: z.array(z.string().min(1).max(200)).max(20).optional(),
    }),
    estimatedReviewSeconds: z.number().int().min(1).max(3600),
  })
  .strict();
export type CardPresentationDraftV2 = z.infer<
  typeof cardPresentationDraftV2Schema
>;

export const candidateDerivationRefV2Schema = z
  .strictObject({
    candidateRevisionId: z.string().uuid(),
    candidateId: z.string().uuid(),
    revision: z.number().int().min(1),
    revisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CandidateDerivationRefV2 = z.infer<
  typeof candidateDerivationRefV2Schema
>;

export const learningCardCandidateRevisionV2Schema = z
  .strictObject({
    version: z.literal(2),
    candidateRevisionId: z.string().uuid(),
    candidateId: z.string().uuid(),
    revision: z.number().int().min(1),
    runId: z.string().uuid(),
    planRevisionId: z.string().uuid(),
    planVersion: z.number().int().min(1),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    cardContentEpoch: z.number().int().min(1),
    planObjectiveLocalId: z.string().min(1).max(160),
    recommendation: z.strictObject({
      recommended: z.boolean(),
      reasonCodes: z.array(z.string().min(1).max(120)).max(20),
    }),
    derivedFromCandidateRevisions: z
      .array(candidateDerivationRefV2Schema)
      .max(50),
    objective: learningObjectiveDraftV2Schema,
    presentation: cardPresentationDraftV2Schema,
    evidenceSetHash: z.string().regex(/^[0-9a-f]{64}$/),
    candidateRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LearningCardCandidateRevisionV2 = z.infer<
  typeof learningCardCandidateRevisionV2Schema
>;

// ─── §11.4 Candidate 三维状态 ────────────────────────────────────────────

export const CandidateQualityStateValuesV2 = [
  "authored",
  "checking",
  "passed",
  "failed",
  // "过了各自门禁、但没进这一批的最终牌堆"。审核判据要求 passed，所以它不会
  // 被当成可保留/可激活（§52：不这么做，审核页就会把牌堆外的卡多发出来）。
  "dropped",
] as const;
export const candidateQualityStateV2Schema = z.enum(
  CandidateQualityStateValuesV2,
);
export type CandidateQualityStateV2 = z.infer<
  typeof candidateQualityStateV2Schema
>;

export const CandidateReviewDecisionValuesV2 = [
  "undecided",
  "keep",
  "reject",
  "merged",
] as const;
export const candidateReviewDecisionV2Schema = z.enum(
  CandidateReviewDecisionValuesV2,
);
export type CandidateReviewDecisionV2 = z.infer<
  typeof candidateReviewDecisionV2Schema
>;

export const CandidatePublishStateValuesV2 = [
  "unpublished",
  "activating",
  "activated",
  "activation_failed",
  "superseded",
  "expired",
] as const;
export const candidatePublishStateV2Schema = z.enum(
  CandidatePublishStateValuesV2,
);
export type CandidatePublishStateV2 = z.infer<
  typeof candidatePublishStateV2Schema
>;

/** §11.4：review_ready 是派生视图，不是可独立写入的第四状态。 */
export function isCandidateReviewReadyV2(state: {
  qualityState: CandidateQualityStateV2;
  reviewDecision: CandidateReviewDecisionV2;
  publishState: CandidatePublishStateV2;
}): boolean {
  return (
    state.qualityState === "passed" &&
    state.reviewDecision === "undecided" &&
    state.publishState === "unpublished"
  );
}

// ─── §13.2 Deck Gate ─────────────────────────────────────────────────────

export const cardSetGateReportV2Schema = z
  .strictObject({
    version: z.literal(2),
    runId: z.string().uuid(),
    planRevisionId: z.string().uuid(),
    planVersion: z.number().int().min(1),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    candidateRevisionHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    candidateEvidenceBindingPlanHashes: z.array(
      z.string().regex(/^[0-9a-f]{64}$/),
    ),
    finalCandidateIds: z.array(z.string().uuid()),
    finalCount: z.number().int().min(0),
    recommendedCount: z.number().int().min(0),
    activationHardMax: z.number().int().min(0),
    semanticClusters: z
      .array(
        z.strictObject({
          clusterId: z.string().min(1).max(160),
          candidateIds: z.array(z.string().uuid()).min(1),
          relation: z.enum(["distinct", "mergeable", "duplicate"]),
        }),
      )
      .max(200),
    issues: z
      .array(
        z.strictObject({
          code: z.enum([
            "count_out_of_plan",
            "semantic_duplicate",
            "mergeable_fragmentation",
            "objective_overlap",
            "critical_objective_missing",
            "unsupported_overview",
            "candidate_revision_mismatch",
          ]),
          candidateIds: z.array(z.string().uuid()),
          hard: z.literal(true),
        }),
      )
      .max(100),
    passed: z.boolean(),
    gateVersion: z.string().min(1).max(200),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CardSetGateReportV2 = z.infer<typeof cardSetGateReportV2Schema>;

// ─── §17.4 Candidate Action ──────────────────────────────────────────────

export const candidateEditablePatchV2Schema = z
  .strictObject({
    objectiveStatement: z.string().min(1).max(2000).optional(),
    front: z
      .strictObject({
        cue: z.string().min(1).max(2000).optional(),
        context: z.string().min(1).max(3000).optional(),
        prompt: z.string().min(1).max(2000),
      })
      .optional(),
    canonicalAnswer: canonicalAnswerV2Schema.optional(),
    explanation: z.string().min(1).max(6000).optional(),
    boundary: z.string().min(1).max(3000).nullable().optional(),
    misconception: z.string().min(1).max(3000).nullable().optional(),
    workedExample: z.string().min(1).max(6000).nullable().optional(),
    knowledgeForm: knowledgeFormV2Schema.optional(),
    strategy: cardStrategyV2Schema.optional(),
    evidenceRefIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  })
  .strict();
export type CandidateEditablePatchV2 = z.infer<
  typeof candidateEditablePatchV2Schema
>;

/**
 * Why a reviewer dropped a candidate. Named here because the desktop review UI
 * offers the same vocabulary as a choice, and an inline enum would have to be
 * copied into the renderer to do it.
 */
export const cardRejectReasonV2Schema = z.enum([
  "not_useful",
  "duplicate",
  "too_trivial",
  "wrong",
  "too_fragmented",
  "other",
]);
export type CardRejectReasonV2 = z.infer<typeof cardRejectReasonV2Schema>;

export const candidateActionV2Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("keep"),
    candidateId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    expectedRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    type: z.literal("reject"),
    candidateId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    expectedRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    reasonCode: cardRejectReasonV2Schema,
    note: z.string().min(1).max(2000).optional(),
  }),
  z.strictObject({
    type: z.literal("edit"),
    candidateId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    expectedRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    patch: candidateEditablePatchV2Schema,
  }),
  z.strictObject({
    type: z.literal("merge"),
    candidateIds: z
      .array(z.string().uuid())
      .min(2)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "candidateIds must be unique",
      }),
    expectedRevisions: z
      .array(
        z.strictObject({
          candidateId: z.string().uuid(),
          revision: z.number().int().min(1),
          hash: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(2)
      .max(20),
    mergedDraft: candidateEditablePatchV2Schema,
  }),
  z.strictObject({
    type: z.literal("undo_decision"),
    candidateId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    expectedRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    type: z.literal("regenerate_candidate"),
    candidateId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    expectedRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    feedbackReasonCodes: z
      .array(cardGenerationFeedbackReasonV2Schema)
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("replan_set"),
    feedbackReasonCodes: z
      .array(cardGenerationFeedbackReasonV2Schema)
      .min(1)
      .max(8),
  }),
]);
export type CandidateActionV2 = z.infer<typeof candidateActionV2Schema>;

export const candidateActionCommandV2Schema = z
  .strictObject({
    version: z.literal(2),
    runId: z.string().uuid(),
    expectedCardContentEpoch: z.number().int().min(1),
    expectedPlanVersion: z.number().int().min(1),
    expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedReviewDraftRevision: z.number().int().min(1),
    action: candidateActionV2Schema,
  })
  .strict();
export type CandidateActionCommandV2 = z.infer<
  typeof candidateActionCommandV2Schema
>;

/** §17.4：edit/merge 触及答案字段必须原子写 answer_editor_view Exposure。 */
export function candidateActionTouchesAnswerV2(
  action: CandidateActionV2,
): boolean {
  if (action.type === "edit" || action.type === "merge") {
    const patch =
      action.type === "edit" ? action.patch : action.mergedDraft;
    return (
      patch.canonicalAnswer !== undefined ||
      patch.explanation !== undefined ||
      patch.boundary !== undefined ||
      patch.misconception !== undefined ||
      patch.workedExample !== undefined
    );
  }
  return false;
}

// ─── §17.5 Activation ────────────────────────────────────────────────────

export const activationIntentV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create_new") }),
  z.strictObject({
    kind: z.literal("presentation_update"),
    cardId: z.string().uuid(),
    expectedPublicationRevision: z.number().int().min(1),
    expectedPublicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("target_equivalent_update"),
    cardId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    expectedPublicationRevision: z.number().int().min(1),
    expectedCardRevision: z.number().int().min(1),
    expectedPublicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedObjectiveRevision: z.number().int().min(1),
    expectedTargetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    equivalenceReportHash: z.string().regex(/^[0-9a-f]{64}$/),
    presentationChange: z.enum([
      "unchanged",
      "create_candidate_card_revision",
    ]),
  }),
  z.strictObject({
    kind: z.literal("semantic_replace"),
    replacedCardId: z.string().uuid(),
    replacedObjectiveId: z.string().uuid(),
    expectedObjectiveLifecycleEpoch: z.number().int().min(1),
  }),
]);
export type ActivationIntentV2 = z.infer<typeof activationIntentV2Schema>;

export const activateCardCandidatesRequestV2Schema = z
  .strictObject({
    version: z.literal(2),
    runId: z.string().uuid(),
    sourceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    semanticSpecHash: z.string().regex(/^[0-9a-f]{64}$/),
    inputSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCardContentEpoch: z.number().int().min(1),
    planRevisionId: z.string().uuid(),
    expectedPlanVersion: z.number().int().min(1),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    selectedCandidates: z
      .array(
        z.strictObject({
          candidateRevisionId: z.string().uuid(),
          candidateId: z.string().uuid(),
          revision: z.number().int().min(1),
          revisionHash: z.string().regex(/^[0-9a-f]{64}$/),
          candidateEvidenceBindingPlanHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/),
          qualityReportHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
          intent: activationIntentV2Schema,
        }),
      )
      .min(1)
      .max(50),
    existingLifecycleActions: z
      .array(
        z.strictObject({
          actionId: z.string().uuid(),
          kind: z.enum(["keep_existing", "archive_existing"]),
          cardId: z.string().uuid(),
          objectiveId: z.string().uuid(),
          expectedPublicationRevision: z.number().int().min(1),
          expectedObjectiveLifecycleEpoch: z.number().int().min(1),
        }),
      )
      .max(50),
    expectedReviewDraftRevision: z.number().int().min(1),
    clientReviewHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ActivateCardCandidatesRequestV2 = z.infer<
  typeof activateCardCandidatesRequestV2Schema
>;

export const cardActivationReceiptV2Schema = z
  .strictObject({
    version: z.literal(2),
    receiptId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    runId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    mappings: z
      .array(
        z.strictObject({
          candidateRevisionId: z.string().uuid(),
          candidateEvidenceBindingPlanId: z.string().uuid(),
          candidateEvidenceBindingPlanHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/),
          cardId: z.string().uuid(),
          objectiveId: z.string().uuid(),
          objectiveRevisionId: z.string().uuid(),
          publicationRevision: z.number().int().min(1),
          resultingEvidenceBindingSetHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1),
    lifecycleResults: z
      .array(
        z.strictObject({
          actionId: z.string().uuid(),
          cardId: z.string().uuid(),
          objectiveId: z.string().uuid(),
          resultingLifecycle: z.enum(["active", "archived", "superseded"]),
          resultingLifecycleEpoch: z.number().int().min(1),
        }),
      )
      .max(50),
    responseHash: z.string().regex(/^[0-9a-f]{64}$/),
    committedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CardActivationReceiptV2 = z.infer<
  typeof cardActivationReceiptV2Schema
>;

// ─── §17.6 Reveal 请求/响应 ──────────────────────────────────────────────

export const revealCandidateRequestV2Schema = z
  .strictObject({
    candidateId: z.string().uuid(),
    expectedCandidateRevision: z.number().int().min(1),
    expectedCandidateRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RevealCandidateRequestV2 = z.infer<
  typeof revealCandidateRequestV2Schema
>;

/** Candidate reveal 响应（答案 exposure-first 持久化提交后才返回）。 */
export const candidateRevealV2Schema = z
  .strictObject({
    version: z.literal(2),
    candidateId: z.string().uuid(),
    candidateRevisionId: z.string().uuid(),
    revision: z.number().int().min(1),
    exposureId: z.string().uuid(),
    canonicalAnswer: canonicalAnswerV2Schema,
    explanation: z.string().min(1).max(6000),
    boundary: z.string().min(1).max(3000).optional(),
    misconception: z.string().min(1).max(3000).optional(),
    workedExample: z.string().min(1).max(6000).optional(),
    evidencePreviews: z
      .array(
        z.strictObject({
          evidenceSnapshotId: z.string().uuid(),
          preview: z.string().max(2000),
          sourceLabel: z.string().min(1).max(300).nullable(),
          sourceState: z.enum(["located", "drifted", "missing"]),
          // 0275 之后才有值：密封时冻住的原文。null 有两种来源（存量证据 / 副本行缺失），
          // 界面必须把它当成"这段没被冻住"而不是"没有原文"。
          originalPreview: z.string().max(2000).nullable(),
        }),
      )
      .max(20),
    exposedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CandidateRevealV2 = z.infer<typeof candidateRevealV2Schema>;

// ─── 领域事件（§17.7）────────────────────────────────────────────────────

export const CardGenerationEventTypeValuesV2 = [
  "card_generation.created",
  "card_generation.source_sealed",
  "card_generation.plan_completed",
  "card_generation.no_cards_recommended",
  "card_generation.needs_attention",
  "card_generation.failed",
  "card_generation.closed_without_activation",
  "card_candidate.authored",
  "card_candidate.grounding_passed",
  "card_candidate.grounding_failed",
  "card_candidate.pedagogy_passed",
  "card_candidate.pedagogy_failed",
  "card_candidate.review_ready",
  "card_candidate.revealed",
  "card_candidate.edited",
  "card_candidate.merged",
  "card_candidate.rejected",
  "card_candidate.activation_requested",
  "learning_objective.activated",
  "learning_objective.revised",
  "learning_objective.superseded",
  "learning_objective.archived",
  "learning_card.activated",
  "learning_card.revised",
  "learning_card.archived",
  "learning_card.revealed",
  "initial_validation_reminder.created",
  "initial_validation_reminder.deferred",
  "initial_validation_reminder.ready",
  "initial_validation_reminder.completed",
  "initial_validation_reminder.cancelled",
] as const;
export type CardGenerationEventTypeV2 =
  (typeof CardGenerationEventTypeValuesV2)[number];

/** §17.7 事件路由白名单：generation/candidate 事件不得产生 Card/Run/Schedule/mastery 副作用。 */
export const CARD_GENERATION_EVENT_CONSUMERS_V2 = [
  "review-ui",
  "metrics",
  "quality-analysis",
] as const;

// ─── 严格 parse helpers（unknown field fail closed）──────────────────────

export function parseActivateCardCandidatesRequestV2(
  input: unknown,
): ActivateCardCandidatesRequestV2 {
  return activateCardCandidatesRequestV2Schema.parse(input);
}

export function parseCardActivationReceiptV2(
  input: unknown,
): CardActivationReceiptV2 {
  return cardActivationReceiptV2Schema.parse(input);
}

export function parseCandidateRevealV2(input: unknown): CandidateRevealV2 {
  return candidateRevealV2Schema.parse(input);
}

// ─── 0249 实时进度读数（migration 0249，计划 §21 的 A2）─────────────────────

/**
 * 写进 `card_generation_run_progress_v2.progress` 的形状。它与桌面合同里的
 * `cardGenerationProgressV1Schema` **同形**（同样那四格计数），读取端因此可以在
 * "实时读数 / 候选表"之间整体换源，界面不必知道数字是从哪来的。
 *
 * 定义在服务端合同而不是复用桌面合同：这张表是 worker→API 的内部通道，
 * 它的合同不该由桌面端文件来定。
 */
export const cardGenerationLiveProgressV2Schema = z.strictObject({
  plannedCards: z.number().int().min(0).max(1000),
  authored: z.number().int().min(0).max(1000),
  gatePassed: z.number().int().min(0).max(1000),
  gateFailed: z.number().int().min(0).max(1000),
});
export type CardGenerationLiveProgressV2 = z.infer<typeof cardGenerationLiveProgressV2Schema>;
