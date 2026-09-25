/**
 * 方案 20（learning-card-v2）§16 LearningTargetSnapshotV2 合同。
 *
 * 冻结决策（§0/§5/§30.1）：
 * - LearningRun 永远评估 PREPARE 冻结的 Target Snapshot；
 * - 正式链路不再直接读取 live claim/quoteText；
 * - keyPointId 只作为 Objective ID alias。
 *
 * 冻结依据（§16.1）：
 * - Snapshot 是 server-private 对象，浏览器只能看到 LearningRunTargetPublicV2；
 * - snapshotHash 绑定本次 Run 的 exact target 与 PREPARE 时 planning exposure
 *   cutoff；同一 Objective 的不同 Run 可以拥有不同 Snapshot；
 * - snapshotHash 不能代替方案 16 在 Artifact lock 时冻结的 assistanceSnapshotHash，
 *   两者都进入新 V2 Run 的审计闭包（§16.2）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */

import { z } from "zod";
import {
  taskIntentSchema,
  understandingLensSchema,
  understandingGraphFilterSchema,
  projectionCheckpointSchema,
} from "./learning-run-contracts.ts";
import {
  canonicalAnswerV2Schema,
  objectiveRubricV2Schema,
  objectiveRelationV2Schema,
  practiceItemV2Schema,
  knowledgeFormV2Schema,
} from "./card-generation-v2-contracts.ts";
import { evidenceBindingTargetUnitV2Schema } from "./card-quality-v2-contracts.ts";

// ─── §16.3 Run Origin V2 ──────────────────────────────────────────────

export const learningRunOriginV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("card"),
    cardId: z.string().uuid(),
    objectiveId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("review"),
    scheduleId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    scheduleGeneration: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal("star_map"),
    objectiveId: z.string().uuid(),
    lens: understandingLensSchema,
    filter: understandingGraphFilterSchema,
    routePlanId: z.string().uuid().optional(),
    baselineCheckpoint: projectionCheckpointSchema,
  }),
  z.strictObject({
    kind: z.literal("today"),
    recommendationId: z.string().uuid().optional(),
    objectiveId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("onboarding"),
    sampleMode: z.enum(["own_content", "sandbox"]),
    objectiveId: z.string().uuid(),
    sandboxNamespaceId: z.string().uuid().optional(),
  }),
]);
export type LearningRunOriginV2 = z.infer<typeof learningRunOriginV2Schema>;

/**
 * §16.3 V2 PREPARE 请求（wire 上带 originV2；与 V1 origin 互斥）。
 */
export const createLearningRunV2RequestSchema = z.strictObject({
  version: z.literal(2).default(2),
  originV2: learningRunOriginV2Schema,
  goal: z.enum(["stabilize", "clarify", "repair", "transfer", "explore"]),
  requestedTimeBudgetSeconds: z.number().int().min(30).max(180).optional(),
  responsePreference: z.enum(["adaptive", "voice", "text", "structured"]).optional(),
  idempotencyKey: z.string().min(1).max(200),
});
export type CreateLearningRunRequestV2 = z.infer<
  typeof createLearningRunV2RequestSchema
>;

export const learningRunReturnTargetV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("card"),
    cardId: z.string().uuid(),
    objectiveId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("review"),
    scheduleId: z.string().uuid(),
    objectiveId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("star_map"),
    objectiveId: z.string().uuid(),
    lens: understandingLensSchema,
    filter: understandingGraphFilterSchema,
    routePlanId: z.string().uuid().optional(),
  }),
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({
    kind: z.literal("onboarding"),
    destination: z.enum(["today", "card", "star_map"]),
  }),
]);
export type LearningRunReturnTargetV2 = z.infer<
  typeof learningRunReturnTargetV2Schema
>;

// ─── §16.1 Server-private Target Snapshot ──────────────────────────────

export const learningTargetSnapshotV2Schema = z
  .strictObject({
    version: z.literal(2),
    snapshotId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    runId: z.string().uuid(),
    cardContentEpoch: z.number().int().min(1),
    objectiveLifecycleEpoch: z.number().int().min(1),
    target: z
      .strictObject({
        objectiveId: z.string().uuid(),
        objectiveRevision: z.number().int().min(1),
        // 39d W3-4（D1 §4.3）：目标不再依赖卡片——这五个卡身份字段可空，
        // 但 `cardContentEpoch`（上面）与 objective 那一组**不放宽**。
        // 放宽的是类型，不是判据：无卡冻结仍然要求"非空且指向该修订的笔记依据"。
        cardId: z.string().uuid().nullable(),
        publicationRevision: z.number().int().min(1).nullable(),
        cardRevision: z.number().int().min(1).nullable(),
        publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        revealPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        objectiveStatement: z.string().min(1).max(2000),
        publicSummary: z.string().min(1).max(1500),
        knowledgeForm: knowledgeFormV2Schema,
        preferredIntents: z.array(taskIntentSchema).min(1).max(6),
        canonicalAnswer: canonicalAnswerV2Schema,
        learningSupport: z
          .strictObject({
            explanation: z.string().min(1).max(6000),
            boundary: z.string().min(1).max(3000).optional(),
            misconception: z.string().min(1).max(3000).optional(),
            workedExample: z.string().min(1).max(6000).optional(),
          })
          .strict(),
        scoringRubric: objectiveRubricV2Schema,
        relations: z.array(objectiveRelationV2Schema).max(100),
        /**
         * 0245：随目标一起冻下来的客观练习件（选择 / 判断 / 排序 / 配对）。
         * null = 这张卡没有练习件。规划器只从冻结快照消费（§16.4），所以它必须
         * 在这里，而不是只在候选行上。
         */
        practiceItem: practiceItemV2Schema.nullable(),
        evidence: z
          .array(
            z.strictObject({
              bindingId: z.string().uuid(),
              targetUnit: evidenceBindingTargetUnitV2Schema,
              evidenceSnapshotId: z.string().uuid(),
              evidenceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
              expectedEvidenceEligibilityEpoch: z.number().int().min(1),
              relation: z.enum([
                "entails",
                "defines_boundary",
                "supports_example",
                "supports_contrast",
              ]),
              supportStrength: z.enum(["direct", "derived"]),
              bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
              semanticSupportReportId: z.string().uuid(),
              semanticSupportReportHash: z.string().regex(/^[0-9a-f]{64}$/),
              derivationReportId: z.string().uuid().optional(),
              derivationReportHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
            }),
          )
          .max(200),
        evidenceBindingSetHash: z.string().regex(/^[0-9a-f]{64}$/),
        evidenceEligibilityVectorHash: z.string().regex(/^[0-9a-f]{64}$/),
        semanticTargetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        targetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    planningExposure: z
      .strictObject({
        scope: z.literal("objective"),
        lastExposedAt: z.string().datetime({ offset: true }).nullable(),
        exposureIds: z.array(z.string().uuid()).max(500),
        sameCueRecentlyRevealed: z.boolean(),
        qualificationNotBefore: z.string().datetime({ offset: true }).nullable(),
        preRunRevealPolicyVersion: z.string().min(1).max(200),
      })
      .strict(),
    lifecycleAtPrepare: z.literal("active"),
    publishedTargetEligibility: z.enum(["eligible", "practice_only", "blocked"]),
    preparedAt: z.string().datetime({ offset: true }),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LearningTargetSnapshotV2 = z.infer<
  typeof learningTargetSnapshotV2Schema
>;

/**
 * §16.1 浏览器侧唯一公开目标视图。
 * 绝不含 canonicalAnswer / scoringRubric / relations / evidence / planningExposure。
 */
export const learningRunTargetPublicV2Schema = z
  .strictObject({
    objectiveId: z.string().uuid(),
    objectiveRevision: z.number().int().min(1),
    // 这条 schema **每次 V2 读都要 parse**（`run-service.ts:1258` 的 loadV2RunContext
    // 撑起公共快照、动作与结果三个端点），所以无卡投影必须在它这里先通过，
    // 否则第一条无卡快照就会把三个端点全打成 500。形状照已有的
    // `learningRunTargetRevealV2Schema`（那两个字段早就是 .nullable()）。
    cardId: z.string().uuid().nullable(),
    publicationRevision: z.number().int().min(1).nullable(),
    cardRevision: z.number().int().min(1).nullable(),
    publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    publicSummary: z.string().min(1).max(1500),
    semanticTargetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    targetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LearningRunTargetPublicV2 = z.infer<
  typeof learningRunTargetPublicV2Schema
>;

// ─── Parse helpers ─────────────────────────────────────────────────────

export function parseLearningTargetSnapshotV2(
  input: unknown,
): LearningTargetSnapshotV2 {
  return learningTargetSnapshotV2Schema.parse(input);
}

export function parseLearningRunOriginV2(
  input: unknown,
): LearningRunOriginV2 {
  return learningRunOriginV2Schema.parse(input);
}

export function parseLearningRunTargetPublicV2(
  input: unknown,
): LearningRunTargetPublicV2 {
  return learningRunTargetPublicV2Schema.parse(input);
}

/**
 * 「为这个目标开一轮」该用哪一种 origin：**有卡走 `card`，没卡走 `today`**。
 *
 * 这条规则原本写在两个地方（39d W4-2 把它放进 api 的 `startPayload()`，而 worker 的
 * `buildActionPayload` 只会 `JOIN learning_cards_v2` 拿卡，没卡就返回 null ⇒ 她说
 * 「开始学习」时报"当前不可用"，页面上那颗「开始学习」却点得动）。现在两边都调这里，
 * 少一个 origin 就少一处会各自漂移的地方。
 *
 * `today` 是这一族里唯一不带实体 id 的无卡档（`learningRunOriginV2Schema`），
 * W3-4 已经证明它能冻结、能开跑、能结算。**不给 `objective` 那一档**——合同里没有。
 */
export function startRunOriginV2(input: {
  readonly objectiveId: string;
  readonly cardId: string | null | undefined;
}): LearningRunOriginV2 {
  return input.cardId
    ? { kind: "card", cardId: input.cardId, objectiveId: input.objectiveId }
    : { kind: "today", objectiveId: input.objectiveId };
}
