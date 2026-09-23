/**
 * LearningRun V1 公共合同（冻结：docs/plans/learning-companion/16 §12）
 *
 * 单一权威来源：统一 LearningRun / Task / Artifact / Assessment 四对象语言。
 * 文档 16 §1.1 冲突裁决：本文件合同与 zod schemas 是 wire contract 权威；
 * 任何模块（web / api / worker）禁止再定义同型接口或第二套枚举。
 *
 * 分层：
 * - 公共类型（§12.1–§12.5、§13.1）：客户端与服务端共同可见，必须通过
 *   strict zod schema；Public contract 严禁包含 private solution、正确顺序、
 *   hidden rubric、答案文本或能推导答案的调试字段。
 * - Server-private 类型（§12.6）：只存服务端表，公共 API 账号无 SELECT 路径；
 *   类型在此统一声明（存储形状的唯一定义），但 schema 仅用于服务端入库校验。
 *
 * 本文件是现行 LearningRun 语言的唯一来源；旧 Session/Episode 合同已删除。
 */

import { z } from "zod";

// ─── §7.3 通用 Interaction 类型 ──────────────────────────────────────────

export const RelationEdgeKind = {
  CAUSES: "causes",
  DEPENDS_ON: "depends_on",
  PART_OF: "part_of",
  CONTRASTS_WITH: "contrasts_with",
  SUPPORTS: "supports",
  PRECEDES: "precedes",
} as const;
export type RelationEdgeKindV1 = (typeof RelationEdgeKind)[keyof typeof RelationEdgeKind];

export const relationEdgeKindSchema = z.enum([
  RelationEdgeKind.CAUSES,
  RelationEdgeKind.DEPENDS_ON,
  RelationEdgeKind.PART_OF,
  RelationEdgeKind.CONTRASTS_WITH,
  RelationEdgeKind.SUPPORTS,
  RelationEdgeKind.PRECEDES,
]);

// ─── §12.2 基础枚举 ──────────────────────────────────────────────────────

export const TaskIntent = {
  RECALL: "recall",
  PARAPHRASE: "paraphrase",
  EXPLAIN: "explain",
  EXAMPLE: "example",
  APPLY: "apply",
  BOUNDARY: "boundary",
  PROCEDURE: "procedure",
  RELATE: "relate",
  REPAIR: "repair",
} as const;
export type TaskIntentV1 = (typeof TaskIntent)[keyof typeof TaskIntent];

export const TaskPurpose = {
  FORMAL: "formal",
  FACET: "facet",
  DIAGNOSTIC: "diagnostic",
  PRACTICE: "practice",
} as const;
export type TaskPurposeV1 = (typeof TaskPurpose)[keyof typeof TaskPurpose];

export const CapabilityFacet = {
  RECALL: "recall",
  EXPLAIN: "explain",
  APPLY: "apply",
  BOUNDARY: "boundary",
  PROCEDURE: "procedure",
  RELATE: "relate",
} as const;
export type CapabilityFacet = (typeof CapabilityFacet)[keyof typeof CapabilityFacet];

export const TrustClass = {
  MASTERY_ELIGIBLE: "mastery_eligible",
  FACET_ELIGIBLE: "facet_eligible",
  DIAGNOSTIC_ONLY: "diagnostic_only",
  PRACTICE_ONLY: "practice_only",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type TrustClass = TrustClassV1;
export type TrustClassV1 = (typeof TrustClass)[keyof typeof TrustClass];

export const taskIntentSchema = z.enum([
  TaskIntent.RECALL,
  TaskIntent.PARAPHRASE,
  TaskIntent.EXPLAIN,
  TaskIntent.EXAMPLE,
  TaskIntent.APPLY,
  TaskIntent.BOUNDARY,
  TaskIntent.PROCEDURE,
  TaskIntent.RELATE,
  TaskIntent.REPAIR,
]);

export const taskPurposeSchema = z.enum([
  TaskPurpose.FORMAL,
  TaskPurpose.FACET,
  TaskPurpose.DIAGNOSTIC,
  TaskPurpose.PRACTICE,
]);

export const trustClassSchema = z.enum([
  TrustClass.MASTERY_ELIGIBLE,
  TrustClass.FACET_ELIGIBLE,
  TrustClass.DIAGNOSTIC_ONLY,
  TrustClass.PRACTICE_ONLY,
  TrustClass.NOT_ASSESSABLE,
]);

/** §7.3 TaskInteractionV1：当前被激活的确定性交互合同。 */
export type TaskInteractionV1 =
  | { kind: "voice_teachback"; maxSeconds: number }
  | { kind: "text_response"; maxChars: number }
  | { kind: "ordering"; publicTokenIds: string[]; publicTokenLabels?: Record<string, string> }
  /**
   * 客观题（2026-09-21 方案 §3 D1/D2）：选择题与判断题都只做练习/诊断，
   * 判分走确定性通道，`templateTrustCeiling` 恒为 practice_only。
   * 正确项**不在** public 载荷里（`correctOptionId` 只存在于私有 solution），
   * option id 由内容哈希派生 —— 与 ordering 的 token id 同一姿态，防止从 id 猜答案。
   */
  | {
      kind: "single_choice";
      publicOptionIds: string[];
      publicOptionLabels?: Record<string, string>;
    }
  | { kind: "true_false"; proposition: string }
  /**
   * 配对题：左右两列各自打乱，学习者把左端连到右端。正确映射只在私有 solution 里。
   */
  | {
      kind: "matching";
      publicLeftIds: string[];
      publicRightIds: string[];
      publicLabels?: Record<string, string>;
    }
  | {
      kind: "relation_canvas";
      publicNodeIds: string[];
      allowedEdgeKinds: RelationEdgeKindV1[];
      publicNodeLabels?: Record<string, string>;
    }
  | {
      kind: "repair";
      publicElementIds: string[];
      allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">;
      replacementOptionIds: string[];
      publicElementLabels?: Record<string, string>;
      replacementOptionLabels?: Record<string, string>;
    }
  | {
      kind: "structured_bundle";
      parts: [StructuredPartPublicV1] | [StructuredPartPublicV1, StructuredPartPublicV1];
    };

export const repairOperationKindSchema = z.enum(["move", "replace", "remove", "insert"]);

// ─── §12.2 Structured Part / Variant / Task Public ───────────────────────

export type StructuredPartPublicV1 =
  | {
      kind: "ordering";
      partId: string;
      publicTokenIds: string[];
      publicTokenLabels?: Record<string, string>;
      partTrustCeiling: "facet_eligible" | "practice_only";
      qualificationProfileHash: string | null;
    }
  | {
      kind: "relation";
      partId: string;
      publicNodeIds: string[];
      allowedEdgeKinds: RelationEdgeKindV1[];
      publicNodeLabels?: Record<string, string>;
      partTrustCeiling: "facet_eligible" | "practice_only";
      qualificationProfileHash: string | null;
    }
  | {
      kind: "repair";
      partId: string;
      publicElementIds: string[];
      allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">;
      replacementOptionIds: string[];
      publicElementLabels?: Record<string, string>;
      replacementOptionLabels?: Record<string, string>;
      partTrustCeiling: "facet_eligible" | "practice_only";
      qualificationProfileHash: string | null;
    };

export type TaskVariantPublicV1 = {
  variantId: string;
  purpose: TaskPurposeV1;
  interaction: TaskInteractionV1;
  templateTrustCeiling: TrustClassV1;
  estimatedActiveSeconds: number;
  publicPayloadHash: string;
  inputSchemaHash: string;
  disclosureProfileHash: string;
  revision: number;
};

export type TaskAlternativeDescriptorV1 = {
  alternativeId: string;
  family: "voice" | "text" | "structured";
  estimatedActiveSeconds: number;
  maximumPurpose: TaskPurposeV1;
};

export type LearningTaskPublicV1 = {
  version: 1;
  taskId: string;
  runId: string;
  sequence: number;
  intent: TaskIntentV1;
  prompt: string;
  targetSummary: string;
  activeVariant: TaskVariantPublicV1;
  availableAlternatives: TaskAlternativeDescriptorV1[];
  assistancePolicy: {
    hintLevels: 0 | 1 | 2 | 3;
    exposureLowersTrust: true;
  };
  status: "pending" | "active" | "answered" | "skipped" | "completed" | "stale";
  revision: number;
};

// ─── §12.1 Run Public Contract ───────────────────────────────────────────

/** §15.2 UnderstandingLensV1（§12.1 star_map origin 引用）。 */
export type UnderstandingLensV1 = "current_target" | "evidence" | "provenance" | "issues";
export const understandingLensSchema = z.enum(["current_target", "evidence", "provenance", "issues"]);

/** §15.2 UnderstandingGraphFilterV1（§12.1 star_map origin 引用）。 */
export type UnderstandingGraphFilterV1 = {
  showArchived: boolean;
  sourceId?: string;
  cardId?: string;
  relationKinds?: Array<"derived_from" | "supports" | "contains" | "prerequisite" | "next">;
};

/** §15.1 ProjectionCheckpointV1：opaque token，客户端不得解析或比较。 */
export type ProjectionCheckpointV1 = {
  version: 1;
  workspaceId: string;
  userId: string;
  token: string;
  capturedAt: string;
};

export type LearningRunOriginV1 =
  | { kind: "card"; cardId: string; keyPointId: string }
  | { kind: "review"; scheduleId: string; keyPointId: string; scheduleGeneration: number }
  | {
      kind: "star_map";
      keyPointId: string;
      lens: UnderstandingLensV1;
      filter: UnderstandingGraphFilterV1;
      routePlanId?: string;
      baselineCheckpoint: ProjectionCheckpointV1;
    }
  | { kind: "today"; recommendationId?: string; keyPointId: string }
  | {
      kind: "onboarding";
      sampleMode: "own_content" | "sandbox";
      keyPointId: string;
      /** sandbox 模式：隔离教学空间 id（§16.4）；缺失时服务端校验拒绝。 */
      sandboxNamespaceId?: string;
    };

export type LearningRunReturnTargetV1 =
  // objectiveId 为 V2 卡标记（V2 卡 run 返回走 /learning-cards/:cardId）
  | { kind: "card"; cardId: string; keyPointId: string; objectiveId?: string }
  | { kind: "review"; scheduleId?: string; keyPointId: string }
  | {
      kind: "star_map";
      keyPointId: string;
      lens: UnderstandingLensV1;
      filter: UnderstandingGraphFilterV1;
      routePlanId?: string;
    }
  | { kind: "today" }
  | { kind: "onboarding"; destination: "today" | "card" | "star_map" };

export type LearningTaskSummaryV1 = {
  taskId: string;
  sequence: number;
  intent: TaskIntentV1;
  status: "pending" | "active" | "answered" | "skipped" | "completed" | "stale";
  estimatedActiveSeconds: number;
};

export type LearningRunFailureV1 =
  | {
      stage: "prepare";
      code: "planner_unavailable" | "task_generation_failed" | "task_activation_denied";
      retryable: boolean;
    }
  | {
      stage: "assessment";
      code: "critic_unavailable" | "assessment_timeout" | "assessment_contract_mismatch";
      retryable: boolean;
    }
  | {
      stage: "commit";
      code: "commit_conflict" | "scheduler_unavailable" | "canonical_outbox_failed";
      retryable: boolean;
    };

export type LearningRunTerminalReasonCodeV1 =
  | "user_ended"
  | "runtime_cancelled"
  | "target_fingerprint_changed"
  | "schedule_generation_changed"
  | "permission_revoked";

/** §12.1 LearningRunPublicV1（含 §12.4/§12.5 引用）。 */
export type LearningRunPublicV1 = {
  version: 1;
  runId: string;
  workspaceId: string;
  userId: string;
  assistantSessionId: string | null;
  origin: LearningRunOriginV1;
  returnTarget: LearningRunReturnTargetV1;
  target: {
    kind: "key_point";
    keyPointId: string;
    fingerprint: string;
  };
  projectionBaselineCheckpoint: ProjectionCheckpointV1 | null;
  goal: "stabilize" | "clarify" | "repair" | "transfer" | "explore";
  schedulePolicySummary:
    | { kind: "create_on_canonical_outcome"; eligibleOutcomes: ["demonstrated", "declared_unable"] }
    | {
        kind: "consume_on_canonical_outcome";
        scheduleId: string;
        scheduleGeneration: number;
        eligibleOutcomes: ["demonstrated", "declared_unable"];
      }
    | { kind: "no_schedule_effect"; reasonCode: "practice" | "diagnostic" | "sandbox" | "not_eligible" };
  phase:
    | "preparing"
    | "active"
    | "assessing"
    | "checkpoint"
    | "committing"
    | "paused"
    | "completed"
    | "ended"
    | "skipped"
    | "cancelled"
    | "stale"
    | "recoverable_error";

  timeBudgetSeconds: number; // 30..180，默认 180
  plannedActiveSeconds: number; // <= timeBudgetSeconds
  activeSecondsUsed: number;
  planningClosesAtActiveSecond: 150;
  activeTaskId: string | null;
  taskSummaries: LearningTaskSummaryV1[];
  activeTask: LearningTaskPublicV1 | null;
  activeAssessment: AssessmentPublicV1 | null;
  checkpoint: {
    kind: "partial" | "not_assessable" | "skipped_task";
    allowedFollowupIds: string[];
    /**
     * 审计 F28：为什么这一轮判不出结论。`no_frozen_evidence` = 系统侧缺冻结证据
     * （补回答补不上，界面不得再提供「继续补充证据」）；`critic_unavailable` =
     * 评估通道不可用；`input_incomplete` = 这次提交本身不足。历史行缺省。
     */
    reasonCode?: "no_frozen_evidence" | "critic_unavailable" | "input_incomplete";
  } | null;
  failure: LearningRunFailureV1 | null;
  projectionStatus: "not_requested" | "pending" | "ready" | "retrying" | "failed";
  revision: number;
  runtimeEpoch: number;
  eventCursor: number;
  result: LearningRunResultV1 | null;
};

// ─── §12.3 Artifact 通用提交 ─────────────────────────────────────────────

export type RepairOperationV1 =
  | { op: "move"; elementId: string; toIndex: number }
  | { op: "replace"; elementId: string; replacementOptionId: string }
  | { op: "remove"; elementId: string }
  | { op: "insert"; afterElementId: string | null; replacementOptionId: string };

export type StructuredPartAnswerV1 =
  | { kind: "ordering"; partId: string; orderedTokenIds: string[] }
  | {
      kind: "relation";
      partId: string;
      edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
    }
  | { kind: "repair"; partId: string; operations: RepairOperationV1[] };

export type ArtifactPayloadV1 =
  | {
      kind: "voice";
      confirmedTranscript: string;
      voiceArtifactRef?: string;
    }
  | { kind: "text"; text: string }
  | {
      kind: "ordering";
      orderedTokenIds: string[];
      interactionRefs: string[];
    }
  | {
      kind: "choice";
      /** 省略 = 还没选。界面因此不需要"空串"或"默认选第一项"这种假状态。 */
      selectedOptionId?: string;
      interactionRefs: string[];
    }
  | {
      kind: "true_false";
      /** 省略 = 还没判。 */
      answer?: boolean;
      interactionRefs: string[];
    }
  | {
      kind: "matching";
      assignments: Array<{ leftId: string; rightId: string }>;
      interactionRefs: string[];
    }
  | {
      kind: "relation";
      edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
      interactionRefs: string[];
    }
  | {
      kind: "repair";
      operations: RepairOperationV1[];
      interactionRefs: string[];
    }
  | {
      kind: "structured_bundle";
      partAnswers: [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1];
      interactionRefs: string[];
    }
  | {
      kind: "declared_unable";
      reasonCode?: "not_learned_yet" | "cannot_recall" | "concept_unclear";
    };

export type SubmitTaskArtifactV1 = {
  version: 1;
  variantId: string;
  variantRevision: number;
  runRevision: number;
  taskRevision: number;
  inputSchemaHash: string;
  payload: ArtifactPayloadV1;
  baseArtifactId?: string;
  baseRevision?: number;
  idempotencyKey: string;
};

export type SubmitTaskArtifactReceiptV1 = {
  version: 1;
  runId: string;
  taskId: string;
  artifactId: string;
  artifactRevision: number;
  artifactStatus: "locked";
  assessment: {
    assessmentId: string;
    status: "queued";
  };
  runRevision: number;
  taskRevision: number;
  eventCursor: number;
};

// ─── §12.4 Assessment Public Contract ────────────────────────────────────

export type AssessmentPublicV1 = {
  version: 1;
  assessmentId: string;
  runId: string;
  taskId: string;
  artifactId: string;
  source: "assessment_critic" | "deterministic_declared_unable" | "deterministic_structured";
  status: "queued" | "running" | "completed" | "not_assessable" | "failed";
  rubricResults: Array<{
    rubricItemId: string;
    facet: TaskIntentV1;
    verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
    userFacingReason: string;
  }>;
  trustClass: TrustClassV1 | null;
  reportHash: string | null;
};

// ─── §12.5 Run Result ────────────────────────────────────────────────────

/** §15.4 ProjectionSourceChangeV1。 */
export type ProjectionSourceChangeV1 =
  | { kind: "canonical"; canonicalEventId: string }
  | { kind: "practice_only"; practiceEventId: string }
  | { kind: "none" };

export type LearningRunResultV1 = {
  outcome:
    | "demonstrated"
    | "partial"
    | "needs_repair"
    | "not_assessable"
    | "practice_completed"
    | "skipped"
    | "declared_unable";
  demonstratedFacets: TaskIntentV1[];
  gapFacets: TaskIntentV1[];
  scheduleImpact:
    | {
        kind: "none";
        reasonCode:
          | "not_authorized"
          | "facet_only"
          | "record_only"
          | "practice_only"
          | "diagnostic_only"
          | "sandbox"
          | "not_assessable"
          | "skipped"
          | "ended"
          | "stale";
      }
    | { kind: "created"; dueAt: string; policyReason: "demonstrated" | "declared_unable" }
    | {
        kind: "rescheduled";
        dueAt: string;
        consumedScheduleId: string;
        policyReason: "demonstrated" | "declared_unable";
      };
  returnTarget: LearningRunReturnTargetV1;
  projection?: {
    baselineCheckpoint: ProjectionCheckpointV1;
    sourceChange: ProjectionSourceChangeV1;
    /** §15.5 一次性显影：结果页返回星图时携带（只作显影注释，客户端不解析）。 */
    changeSetId?: string;
  };
};

// ─── §12.6 Server-private Task、Safety 与 Trust 闭包 ─────────────────────
// 只存服务端表，公共 API 账号无 SELECT 路径。类型为存储形状唯一定义。

export type PrivateTaskSolutionV1 =
  | {
      kind: "open_response";
      rubricTargetIds: string[];
      evidenceRefIds: string[];
      contradictionRuleIds: string[];
    }
  | { kind: "ordering"; correctTokenIds: string[]; rubricTargetIds: string[] }
  /** 客观题的正确项只存在于这一层（public 载荷带不出去）。 */
  | { kind: "choice"; correctOptionId: string; rubricTargetIds: string[] }
  | { kind: "true_false"; expected: boolean; rubricTargetIds: string[] }
  | {
      kind: "matching";
      correctPairs: Array<{ leftId: string; rightId: string }>;
      rubricTargetIds: string[];
    }
  | {
      kind: "relation";
      requiredEdges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
      forbiddenEdges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
      rubricTargetIds: string[];
    }
  | {
      kind: "repair";
      acceptedOperationSignatures: string[];
      rubricTargetIds: string[];
    }
  | {
      kind: "structured_bundle";
      partSolutionRefs: [string] | [string, string];
      bundleQualificationId: string;
      rubricTargetIds: string[];
    };

export type TaskSafetyReportV1 = {
  version: 1;
  taskId: string;
  variantId: string;
  publicPayloadHash: string;
  inputSchemaHash: string;
  privateSolutionHash: string;
  disclosureProfileHash: string;
  qualificationProfileHash: string | null;
  runPlanHash: string;
  injectionScan: "passed";
  privateLeakageScan: "passed";
  schemaValidation: "passed";
  accessibilityProfile: "passed" | "restricted";
  activationDecision: "allowed" | "denied";
  reportHash: string;
};

export type DisclosureProfileV1 = {
  version: 1;
  disclosedFieldPaths: string[];
  hiddenFieldPaths: string[];
  answerBearingFieldsHidden: true;
  profileHash: string;
};

export type ArtifactTrustDecisionV1 = {
  version: 1;
  artifactId: string;
  runEvidenceAuthorization: "mastery_candidate" | "facet_candidate" | "record_only" | "no_effect";
  variantPurpose: TaskPurposeV1;
  templateTrustCeiling: TrustClassV1;
  structuredPartCeilings: Array<{
    partId: string;
    ceiling: TrustClassV1;
    qualificationProfileHash: string | null;
  }>;
  qualificationId: string | null;
  assistanceSnapshotHash: string;
  inputCompleteness: "complete" | "incomplete";
  assessmentTrust: TrustClassV1 | "canonical_unable";
  effectiveTrustClass: TrustClassV1 | "canonical_unable";
  reasonCodes: Array<
    | "run_not_authorized"
    | "variant_ceiling"
    | "qualification_ceiling"
    | "hint_exposure"
    | "evidence_exposure"
    | "input_incomplete"
    | "assessment_abstained"
    | "assessment_lowered"
  >;
  decisionHash: string;
};

export type LearningArtifactStoredV1 = {
  version: 1;
  artifactId: string;
  runId: string;
  taskId: string;
  variantId: string;
  revision: number;
  status: "locked" | "superseded" | "abandoned";
  payload: ArtifactPayloadV1;
  payloadHash: string;
  publicPayloadHash: string;
  inputSchemaHash: string;
  privateSolutionHash: string;
  safetyReportHash: string;
  disclosureProfileHash: string;
  assistanceSnapshotHash: string;
  qualificationProfileHash: string | null;
  supersedesArtifactId: string | null;
  lockedAt: string;
};

export type TaskActivationDecisionV1 = {
  version: 1;
  runId: string;
  taskId: string;
  variantId: string;
  runtimeEpoch: number;
  runPlanHash: string;
  publicPayloadHash: string;
  inputSchemaHash: string;
  privateSolutionHash: string;
  safetyReportHash: string;
  disclosureProfileHash: string;
  qualificationProfileHash: string | null;
  decision: "activate" | "deny";
  reasonCode: "all_checks_passed" | "hash_mismatch" | "unsafe" | "unqualified" | "stale";
  decisionHash: string;
};

export type SchedulingAuthorizationV1 =
  | {
      kind: "create_initial";
      keyPointId: string;
      targetFingerprint: string;
      schedulerPolicyId: string;
    }
  | {
      kind: "consume_pending";
      scheduleId: string;
      scheduleGeneration: number;
      keyPointId: string;
      targetFingerprint: string;
      dueAt: string;
      schedulerPolicyId: string;
    }
  | { kind: "record_only"; reasonCode: "facet_only" | "not_published_target" }
  | {
      kind: "no_effect";
      reasonCode: "practice" | "diagnostic" | "sandbox" | "not_authorized";
    };

export type PrivateRunContractV1 = {
  version: 1;
  runId: string;
  workspaceId: string;
  userId: string;
  keyPointId: string;
  targetFingerprint: string;
  runtimeEpoch: number;
  timeBudgetSeconds: number;
  planningClosesAtActiveSecond: number;
  schedulingAuthorization: SchedulingAuthorizationV1;
  taskPlanHash: string;
  projectionBaselineCheckpointToken: string | null;
  contractHash: string;
};

// ─── §12.7 Draft 与跨设备恢复合同 ───────────────────────────────────────

export type LearningRendererDraftStateV1 =
  | { kind: "voice"; asrState: "idle" | "transcribing" | "ready" | "failed" }
  | { kind: "text"; selectionStart: number; selectionEnd: number }
  | { kind: "structured"; activePartId: string | null; focusedElementId: string | null };

export type LearningDraftPayloadV1 =
  | { kind: "voice"; unconfirmedTranscript: string }
  | Exclude<ArtifactPayloadV1, { kind: "voice" } | { kind: "declared_unable" }>;

export type LearningTaskDraftV1 = {
  version: 1;
  runId: string;
  taskId: string;
  variantId: string;
  taskRevision: number;
  draftRevision: number;
  payload: LearningDraftPayloadV1 | null;
  rendererState: LearningRendererDraftStateV1;
  savedAt: string;
  expiresAt: string;
};

export type PutLearningTaskDraftRequestV1 = {
  version: 1;
  variantId: string;
  variantRevision: number;
  taskRevision: number;
  expectedDraftRevision: number | null;
  payload: LearningDraftPayloadV1 | null;
  rendererState: LearningRendererDraftStateV1;
  idempotencyKey: string;
};

// ─── §13.1 API 请求/动作/响应 ────────────────────────────────────────────

export type CreateLearningRunRequestV1 = {
  version: 1;
  origin: LearningRunOriginV1;
  goal: "stabilize" | "clarify" | "repair" | "transfer" | "explore";
  requestedTimeBudgetSeconds?: number; // 服务端 clamp 30..180
  responsePreference?: "adaptive" | "voice" | "text" | "structured";
  clientRequestId: string;
  idempotencyKey: string;
};

export type LearningRunActionV1 =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "switch_variant"; alternativeId: string }
  | { kind: "request_hint"; level: 1 | 2 | 3 }
  | { kind: "skip_run" }
  | { kind: "activate_followup"; followupId: string }
  | { kind: "finish_current_evidence" }
  | { kind: "finish_without_commit" }
  | { kind: "retry_prepare" }
  | { kind: "retry_assessment"; assessmentId: string }
  | { kind: "retry_commit" }
  | { kind: "end"; abandonLockedEvidence: boolean };

export type LearningRunActionRequestV1 = {
  version: 1;
  runRevision: number;
  taskRevision?: number;
  runtimeEpoch: number;
  action: LearningRunActionV1;
  idempotencyKey: string;
};

export type LearningRunActionResponseV1 = {
  version: 1;
  acceptedActionId: string;
  actionResult:
    | { kind: "state_changed" }
    | {
        kind: "hint_revealed";
        hintId: string;
        level: 1 | 2 | 3;
        text: string;
        exposureEventId: string;
        resultingTrustCeiling: "practice_only";
      }
    | { kind: "variant_switched"; previousVariantId: string; activeVariantId: string };
  snapshot: LearningRunPublicV1;
};

export type GetLearningRunResultResponseV1 =
  | { status: "pending"; httpStatus: 202; phase: LearningRunPublicV1["phase"]; revision: number }
  | { status: "learning_result"; httpStatus: 200; result: LearningRunResultV1 }
  | {
      status: "terminal_without_result";
      httpStatus: 200;
      phase: "ended" | "cancelled" | "stale";
      reasonCode: LearningRunTerminalReasonCodeV1;
    };

/** §13.1 统一错误码（至少包括以下）。 */
export const LearningRunErrorCode = {
  STALE_RUN_REVISION: "stale_run_revision",
  STALE_TASK_REVISION: "stale_task_revision",
  EPOCH_MISMATCH: "epoch_mismatch",
  INVALID_PHASE: "invalid_phase",
  ARTIFACT_ALREADY_LOCKED: "artifact_already_locked",
  SCHEDULE_GENERATION_CHANGED: "schedule_generation_changed",
  VARIANT_NOT_AUTHORIZED: "variant_not_authorized",
  CONTEXT_STALE: "context_stale",
  PERMISSION_DENIED: "permission_denied",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
} as const;
export type LearningRunErrorCode = (typeof LearningRunErrorCode)[keyof typeof LearningRunErrorCode];

// ─── §7.7 Interaction Qualification / §7.8 Presentation History ──────────

export type InteractionQualificationV1 = {
  version: 1;
  qualificationId: string;
  family:
    | "open_text"
    | "open_voice"
    | "ordering"
    | "relation"
    | "repair"
    | "structured_bundle";
  locale: string;
  datasetVersion: string;
  rubricSetHash: string;
  sampleSize: number;
  adversarialSampleSize: number;
  annotatorCount: number;
  adjudicationVersion: string;
  metrics: {
    falseUpgradeRate: number;
    falseDowngradeRate: number;
    abstainRate: number;
    interRaterAgreement: number;
  };
  approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible";
  approvedAt: string;
  expiresAt: string | null;
};

export type TaskPresentationHistoryV1 = {
  userId: string;
  keyPointId: string;
  intent: TaskIntentV1;
  publicPayloadHash: string;
  interactionFamily: TaskInteractionV1["kind"];
  presentedAt: string;
  outcome: LearningRunResultV1["outcome"] | "not_answered";
  exposed: boolean;
};

// ─── zod schemas（wire contract 校验；全部 strict）────────────────────────

const baseVersionSchema = z.strictObject({ version: z.literal(1) }).strict();

export const understandingGraphFilterSchema = z
  .object({
    showArchived: z.boolean(),
    sourceId: z.string().uuid().optional(),
    cardId: z.string().uuid().optional(),
    relationKinds: z
      .array(z.enum(["derived_from", "supports", "contains", "prerequisite", "next"]))
      .optional(),
  })
  .strict();

export const projectionCheckpointSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    token: z.string().min(1),
    capturedAt: z.string().min(1),
  })
  .strict();

export const learningRunOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("card"), cardId: z.string().uuid(), keyPointId: z.string().uuid() }),
  z.strictObject({
    kind: z.literal("review"),
    scheduleId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    scheduleGeneration: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid(),
    lens: understandingLensSchema,
    filter: understandingGraphFilterSchema,
    routePlanId: z.string().uuid().optional(),
    baselineCheckpoint: projectionCheckpointSchema,
  }),
  z.strictObject({
    kind: z.literal("today"),
    recommendationId: z.string().uuid().optional(),
    keyPointId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("onboarding"),
    sampleMode: z.enum(["own_content", "sandbox"]),
    keyPointId: z.string().uuid(),
    sandboxNamespaceId: z.string().uuid().optional(),
  }),
]);

export const learningRunReturnTargetSchema = z.discriminatedUnion("kind", [
  // objectiveId 为 V2 卡标记：V2 学习 run 返回时应回 V2 卡详情 /learning-cards/:cardId
  // （V1 returnTarget 无此字段，仍走 /cards/:cardId）。
  z.strictObject({
    kind: z.literal("card"),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    objectiveId: z.string().uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal("review"),
    scheduleId: z.string().uuid().optional(),
    keyPointId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid(),
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

export const learningRunFailureSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    stage: z.literal("prepare"),
    code: z.enum(["planner_unavailable", "task_generation_failed", "task_activation_denied"]),
    retryable: z.boolean(),
  }),
  z.strictObject({
    stage: z.literal("assessment"),
    code: z.enum(["critic_unavailable", "assessment_timeout", "assessment_contract_mismatch"]),
    retryable: z.boolean(),
  }),
  z.strictObject({
    stage: z.literal("commit"),
    code: z.enum(["commit_conflict", "scheduler_unavailable", "canonical_outbox_failed"]),
    retryable: z.boolean(),
  }),
]);

export const learningTaskSummarySchema = z
  .object({
    taskId: z.string().uuid(),
    sequence: z.number().int().min(1),
    intent: taskIntentSchema,
    status: z.enum(["pending", "active", "answered", "skipped", "completed", "stale"]),
    estimatedActiveSeconds: z.number().int().min(0),
  })
  .strict();

// ─── structured part public ──────────────────────────────────────────────

const structuredPartBase = z.strictObject({
  partId: z.string().min(1),
  qualificationProfileHash: z.string().min(1).nullable(),
});

export const structuredPartPublicSchema = z.discriminatedUnion("kind", [
  structuredPartBase.extend({
    kind: z.literal("ordering"),
    publicTokenIds: z.array(z.string().min(1)).min(2),
    publicTokenLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
    partTrustCeiling: z.enum(["facet_eligible", "practice_only"]),
  }),
  structuredPartBase.extend({
    kind: z.literal("relation"),
    publicNodeIds: z.array(z.string().min(1)).min(2),
    allowedEdgeKinds: z.array(relationEdgeKindSchema).min(1),
    publicNodeLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
    partTrustCeiling: z.enum(["facet_eligible", "practice_only"]),
  }),
  structuredPartBase.extend({
    kind: z.literal("repair"),
    publicElementIds: z.array(z.string().min(1)).min(1),
    allowedOperationKinds: z.array(repairOperationKindSchema).min(1),
    replacementOptionIds: z.array(z.string().min(1)),
    publicElementLabels: z.record(z.string(), z.string().min(1).max(500)).optional(),
    replacementOptionLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
    partTrustCeiling: z.enum(["facet_eligible", "practice_only"]),
  }),
]);

// ─── task interaction ────────────────────────────────────────────────────

export const taskInteractionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("voice_teachback"),
    maxSeconds: z.number().int().min(1).max(600),
  }),
  z.strictObject({
    kind: z.literal("text_response"),
    maxChars: z.number().int().min(1).max(20_000),
  }),
  z.strictObject({
    kind: z.literal("ordering"),
    publicTokenIds: z.array(z.string().min(1)).min(2),
    // P4 展示层：token id → 文本（乱序片段，非答案承载；可选展示字段）。
    publicTokenLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
  }),
  z.strictObject({
    kind: z.literal("relation_canvas"),
    publicNodeIds: z.array(z.string().min(1)).min(2),
    allowedEdgeKinds: z.array(relationEdgeKindSchema).min(1),
    publicNodeLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
  }),
  z.strictObject({
    kind: z.literal("repair"),
    publicElementIds: z.array(z.string().min(1)).min(1),
    allowedOperationKinds: z.array(repairOperationKindSchema).min(1),
    replacementOptionIds: z.array(z.string().min(1)),
    publicElementLabels: z.record(z.string(), z.string().min(1).max(500)).optional(),
    replacementOptionLabels: z.record(z.string(), z.string().min(1).max(200)).optional(),
  }),
  z.strictObject({
    kind: z.literal("single_choice"),
    publicOptionIds: z.array(z.string().min(1)).min(2).max(8),
    publicOptionLabels: z.record(z.string(), z.string().min(1).max(400)).optional(),
  }),
  z.strictObject({
    kind: z.literal("true_false"),
    proposition: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("matching"),
    publicLeftIds: z.array(z.string().min(1)).min(2).max(8),
    publicRightIds: z.array(z.string().min(1)).min(2).max(8),
    publicLabels: z.record(z.string(), z.string().min(1).max(400)).optional(),
  }),
  z.strictObject({
    kind: z.literal("structured_bundle"),
    parts: z.union([
      z.tuple([structuredPartPublicSchema]),
      z.tuple([structuredPartPublicSchema, structuredPartPublicSchema]),
    ]),
  }),
]);

export const taskVariantPublicSchema = z
  .object({
    variantId: z.string().min(1),
    purpose: taskPurposeSchema,
    interaction: taskInteractionSchema,
    templateTrustCeiling: trustClassSchema,
    estimatedActiveSeconds: z.number().int().min(0),
    publicPayloadHash: z.string().min(1),
    inputSchemaHash: z.string().min(1),
    disclosureProfileHash: z.string().min(1),
    revision: z.number().int().min(1),
  })
  .strict();

export const taskAlternativeDescriptorSchema = z
  .object({
    alternativeId: z.string().min(1),
    family: z.enum(["voice", "text", "structured"]),
    /**
     * 备选的**作答模态**（2026-09-21 方案 §3 D5）：界面要能直接说出「改做选择题」，
     * 而不是把所有备选都写成同一个「换一种方式」。kind 本来就是公开信息（切过去之后
     * `activeVariant.interaction` 就带着它），这里只是提前一格告诉界面。
     */
    interactionKind: z.enum([
      "voice_teachback",
      "text_response",
      "ordering",
      "single_choice",
      "true_false",
      "matching",
      "relation_canvas",
      "repair",
      "structured_bundle",
    ]),
    estimatedActiveSeconds: z.number().int().min(0),
    maximumPurpose: taskPurposeSchema,
  })
  .strict();

export const learningTaskPublicSchema = baseVersionSchema
  .extend({
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    sequence: z.number().int().min(1),
    intent: taskIntentSchema,
    prompt: z.string().min(1),
    targetSummary: z.string().min(1),
    activeVariant: taskVariantPublicSchema,
    availableAlternatives: z.array(taskAlternativeDescriptorSchema),
    assistancePolicy: z
      .object({
        hintLevels: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        exposureLowersTrust: z.literal(true),
      })
      .strict(),
    status: z.enum(["pending", "active", "answered", "skipped", "completed", "stale"]),
    revision: z.number().int().min(1),
  })
  .strict();

// ─── artifact payload / submission ───────────────────────────────────────

export const repairOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("move"), elementId: z.string().min(1), toIndex: z.number().int().min(0) }),
  z.strictObject({
    op: z.literal("replace"),
    elementId: z.string().min(1),
    replacementOptionId: z.string().min(1),
  }),
  z.strictObject({ op: z.literal("remove"), elementId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("insert"),
    afterElementId: z.string().min(1).nullable(),
    replacementOptionId: z.string().min(1),
  }),
]);

export const structuredPartAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ordering"),
    partId: z.string().min(1),
    orderedTokenIds: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    partId: z.string().min(1),
    edges: z
      .array(
        z
          .object({
            fromNodeId: z.string().min(1),
            toNodeId: z.string().min(1),
            edgeKind: relationEdgeKindSchema,
          })
          .strict(),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal("repair"),
    partId: z.string().min(1),
    operations: z.array(repairOperationSchema).min(1),
  }),
]);

export const artifactPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("voice"),
    confirmedTranscript: z.string().min(1).max(20_000),
    voiceArtifactRef: z.string().min(1).optional(),
    // §7.5：手工修改/重录必须标记 correction method（不冒充原样确认的逐字稿）。
    correctionMethod: z.enum(["none", "re_recorded", "manual_text_edit"]).optional(),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(20_000) }),
  z.strictObject({
    kind: z.literal("ordering"),
    orderedTokenIds: z.array(z.string().min(1)).min(1),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    selectedOptionId: z.string().min(1).optional(),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("true_false"),
    answer: z.boolean().optional(),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("matching"),
    assignments: z
      .array(
        z.strictObject({
          leftId: z.string().min(1),
          rightId: z.string().min(1),
        }),
      )
      .max(8),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    edges: z
      .array(
        z
          .object({
            fromNodeId: z.string().min(1),
            toNodeId: z.string().min(1),
            edgeKind: relationEdgeKindSchema,
          })
          .strict(),
      )
      .min(1),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("repair"),
    operations: z.array(repairOperationSchema).min(1),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("structured_bundle"),
    partAnswers: z.union([
      z.tuple([structuredPartAnswerSchema]),
      z.tuple([structuredPartAnswerSchema, structuredPartAnswerSchema]),
    ]),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("declared_unable"),
    reasonCode: z.enum(["not_learned_yet", "cannot_recall", "concept_unclear"]).optional(),
  }),
]);

export const submitTaskArtifactSchema = baseVersionSchema
  .extend({
    variantId: z.string().min(1),
    variantRevision: z.number().int().min(1),
    runRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(1),
    inputSchemaHash: z.string().min(1),
    payload: artifactPayloadSchema,
    baseArtifactId: z.string().uuid().optional(),
    baseRevision: z.number().int().min(0).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const submitTaskArtifactReceiptSchema = baseVersionSchema
  .extend({
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    artifactId: z.string().uuid(),
    artifactRevision: z.number().int().min(1),
    artifactStatus: z.literal("locked"),
    assessment: z
      .object({
        assessmentId: z.string().uuid(),
        status: z.literal("queued"),
      })
      .strict(),
    runRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(1),
    eventCursor: z.number().int().min(0),
  })
  .strict();

// ─── assessment public ───────────────────────────────────────────────────

export const assessmentPublicSchema = baseVersionSchema
  .extend({
    assessmentId: z.string().uuid(),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    artifactId: z.string().uuid(),
    source: z.enum(["assessment_critic", "deterministic_declared_unable", "deterministic_structured"]),
    status: z.enum(["queued", "running", "completed", "not_assessable", "failed"]),
    rubricResults: z.array(
      z
        .object({
          rubricItemId: z.string().min(1),
          facet: taskIntentSchema,
          verdict: z.enum(["covered", "partial", "missing", "contradicted", "not_assessable"]),
          userFacingReason: z.string(),
        })
        .strict(),
    ),
    trustClass: trustClassSchema.nullable(),
    reportHash: z.string().min(1).nullable(),
  })
  .strict()
  // §12.4：queued/running/failed 时 rubricResults=[]、trustClass=null、reportHash=null。
  .superRefine((value, ctx) => {
    if (value.status === "queued" || value.status === "running" || value.status === "failed") {
      if (value.rubricResults.length > 0 || value.trustClass !== null || value.reportHash !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "non-terminal assessment must not carry rubric results/trust/report",
        });
      }
    } else if (value.reportHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed/not_assessable assessment must carry reportHash",
      });
    }
  });

// ─── result / run public ─────────────────────────────────────────────────

export const learningRunOutcomeSchema = z.enum([
  "demonstrated",
  "partial",
  "needs_repair",
  "not_assessable",
  "practice_completed",
  "skipped",
  "declared_unable",
]);

export const learningRunScheduleImpactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("none"),
    reasonCode: z.enum([
      "not_authorized",
      "facet_only",
      "record_only",
      "practice_only",
      "diagnostic_only",
      "sandbox",
      "not_assessable",
      "skipped",
      "ended",
      "stale",
    ]),
  }),
  z.strictObject({
    kind: z.literal("created"),
    dueAt: z.string().min(1),
    policyReason: z.enum(["demonstrated", "declared_unable"]),
  }),
  z.strictObject({
    kind: z.literal("rescheduled"),
    dueAt: z.string().min(1),
    consumedScheduleId: z.string().uuid(),
    policyReason: z.enum(["demonstrated", "declared_unable"]),
  }),
]);

export const projectionSourceChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("canonical"), canonicalEventId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("practice_only"), practiceEventId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("none") }),
]);

export const learningRunProjectionSchema = z
  .object({
    baselineCheckpoint: projectionCheckpointSchema,
    sourceChange: projectionSourceChangeSchema,
    // §15.5 一次性显影：结果页返回星图时携带（只作显影注释，客户端不解析）。
    changeSetId: z.string().min(1).optional(),
  })
  .strict();

export const learningRunResultSchema = z
  .object({
    outcome: learningRunOutcomeSchema,
    demonstratedFacets: z.array(taskIntentSchema),
    gapFacets: z.array(taskIntentSchema),
    scheduleImpact: learningRunScheduleImpactSchema,
    returnTarget: learningRunReturnTargetSchema,
    projection: learningRunProjectionSchema.optional(),
  })
  .strict();

export const learningRunPublicSchema = baseVersionSchema
  .extend({
    runId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    assistantSessionId: z.string().uuid().nullable(),
    origin: learningRunOriginSchema,
    returnTarget: learningRunReturnTargetSchema,
    target: z
      .object({
        kind: z.literal("key_point"),
        keyPointId: z.string().uuid(),
        fingerprint: z.string().min(1),
      })
      .strict(),
    projectionBaselineCheckpoint: projectionCheckpointSchema.nullable(),
    goal: z.enum(["stabilize", "clarify", "repair", "transfer", "explore"]),
    schedulePolicySummary: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("create_on_canonical_outcome"),
        eligibleOutcomes: z.tuple([z.literal("demonstrated"), z.literal("declared_unable")]),
      }),
      z.strictObject({
        kind: z.literal("consume_on_canonical_outcome"),
        scheduleId: z.string().uuid(),
        scheduleGeneration: z.number().int().min(1),
        eligibleOutcomes: z.tuple([z.literal("demonstrated"), z.literal("declared_unable")]),
      }),
      z.strictObject({
        kind: z.literal("no_schedule_effect"),
        reasonCode: z.enum(["practice", "diagnostic", "sandbox", "not_eligible"]),
      }),
    ]),
    phase: z.enum([
      "preparing",
      "active",
      "assessing",
      "checkpoint",
      "committing",
      "paused",
      "completed",
      "ended",
      "skipped",
      "cancelled",
      "stale",
      "recoverable_error",
    ]),
    timeBudgetSeconds: z.number().int().min(30).max(180),
    plannedActiveSeconds: z.number().int().min(0).max(180),
    activeSecondsUsed: z.number().int().min(0),
    planningClosesAtActiveSecond: z.literal(150),
    activeTaskId: z.string().uuid().nullable(),
    taskSummaries: z.array(learningTaskSummarySchema),
    activeTask: learningTaskPublicSchema.nullable(),
    activeAssessment: assessmentPublicSchema.nullable(),
    checkpoint: z
      .object({
        kind: z.enum(["partial", "not_assessable", "skipped_task"]),
        allowedFollowupIds: z.array(z.string().min(1)),
        /**
         * 审计 F28：`not_assessable` 至少有两种互不相同的原因，而界面过去只有一句
         * 「这次没有形成可记录的结论」——用户读成"我答得不好"，于是按提示去
         * 「继续补充证据」，再失败一次。
         *
         * `no_frozen_evidence` 是**系统侧**的缺口（评分点没有冻结原文证据，结算闸
         * fail closed），补充回答永远补不上；`critic_unavailable` 是评估通道暂时
         * 不可用；`input_incomplete` 才是这次提交本身不足。缺省（历史行）按
         * `input_incomplete` 读，不编造系统侧原因。
         */
        reasonCode: z.enum(["no_frozen_evidence", "critic_unavailable", "input_incomplete"]).optional(),
      })
      .strict()
      .nullable(),
    failure: learningRunFailureSchema.nullable(),
    projectionStatus: z.enum(["not_requested", "pending", "ready", "retrying", "failed"]),
    revision: z.number().int().min(1),
    runtimeEpoch: z.number().int().min(0),
    eventCursor: z.number().int().min(0),
    result: learningRunResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // §12.1：activeTaskId 与 activeTask 必须同时为 null 或同时非 null。
    if ((value.activeTaskId === null) !== (value.activeTask === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activeTaskId and activeTask must be both null or both present",
      });
    }
    if (value.plannedActiveSeconds > value.timeBudgetSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plannedActiveSeconds must not exceed timeBudgetSeconds",
      });
    }
  });

// ─── draft ───────────────────────────────────────────────────────────────

export const learningRendererDraftStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("voice"), asrState: z.enum(["idle", "transcribing", "ready", "failed"]) }),
  z.strictObject({
    kind: z.literal("text"),
    selectionStart: z.number().int().min(0),
    selectionEnd: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("structured"),
    activePartId: z.string().min(1).nullable(),
    focusedElementId: z.string().min(1).nullable(),
  }),
]);

export const learningDraftPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("voice"),
    unconfirmedTranscript: z.string().max(20_000),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().max(20_000) }),
  z.strictObject({
    kind: z.literal("ordering"),
    orderedTokenIds: z.array(z.string().min(1)),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    selectedOptionId: z.string().min(1).optional(),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("true_false"),
    answer: z.boolean().optional(),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("matching"),
    assignments: z
      .array(z.strictObject({ leftId: z.string().min(1), rightId: z.string().min(1) }))
      .max(8),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    edges: z
      .array(
        z
          .object({
            fromNodeId: z.string().min(1),
            toNodeId: z.string().min(1),
            edgeKind: relationEdgeKindSchema,
          })
          .strict(),
      ),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("repair"),
    operations: z.array(repairOperationSchema),
    interactionRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    kind: z.literal("structured_bundle"),
    partAnswers: z.union([
      z.tuple([structuredPartAnswerSchema]),
      z.tuple([structuredPartAnswerSchema, structuredPartAnswerSchema]),
    ]),
    interactionRefs: z.array(z.string().min(1)),
  }),
]);

export const putLearningTaskDraftRequestSchema = baseVersionSchema
  .extend({
    variantId: z.string().min(1),
    variantRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(1),
    expectedDraftRevision: z.number().int().min(1).nullable(),
    payload: learningDraftPayloadSchema.nullable(),
    rendererState: learningRendererDraftStateSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const learningTaskDraftSchema = baseVersionSchema
  .extend({
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    variantId: z.string().min(1),
    taskRevision: z.number().int().min(1),
    draftRevision: z.number().int().min(0),
    payload: learningDraftPayloadSchema.nullable(),
    rendererState: learningRendererDraftStateSchema,
    savedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const learningTaskDraftWriteReceiptSchema = baseVersionSchema
  .extend({
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    variantId: z.string().min(1),
    taskRevision: z.number().int().min(1),
    draftRevision: z.number().int().min(0),
    savedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

// ─── §13.1 request/action ────────────────────────────────────────────────

export const createLearningRunRequestSchema = baseVersionSchema
  .extend({
    origin: learningRunOriginSchema,
    goal: z.enum(["stabilize", "clarify", "repair", "transfer", "explore"]),
    requestedTimeBudgetSeconds: z.number().int().min(30).max(180).optional(),
    responsePreference: z.enum(["adaptive", "voice", "text", "structured"]).optional(),
    clientRequestId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const learningRunActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pause") }),
  z.strictObject({ kind: z.literal("resume") }),
  z.strictObject({ kind: z.literal("switch_variant"), alternativeId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("request_hint"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.strictObject({ kind: z.literal("skip_run") }),
  z.strictObject({ kind: z.literal("activate_followup"), followupId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("finish_current_evidence") }),
  z.strictObject({ kind: z.literal("finish_without_commit") }),
  z.strictObject({ kind: z.literal("retry_prepare") }),
  z.strictObject({ kind: z.literal("retry_assessment"), assessmentId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("retry_commit") }),
  z.strictObject({ kind: z.literal("end"), abandonLockedEvidence: z.boolean() }),
]);

export const learningRunActionRequestSchema = baseVersionSchema
  .extend({
    runRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(1).optional(),
    runtimeEpoch: z.number().int().min(0),
    action: learningRunActionSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const learningRunActionResponseSchema = baseVersionSchema
  .extend({
    acceptedActionId: z.string().min(1),
    actionResult: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("state_changed") }),
      z.strictObject({
        kind: z.literal("hint_revealed"),
        hintId: z.string().min(1),
        level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        text: z.string().min(1),
        exposureEventId: z.string().min(1),
        resultingTrustCeiling: z.literal("practice_only"),
      }),
      z.strictObject({
        kind: z.literal("variant_switched"),
        previousVariantId: z.string().min(1),
        activeVariantId: z.string().min(1),
      }),
    ]),
    snapshot: learningRunPublicSchema,
  })
  .strict();

export const getLearningRunResultResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    httpStatus: z.literal(202),
    phase: z.enum([
      "preparing",
      "active",
      "assessing",
      "checkpoint",
      "committing",
      "paused",
      "recoverable_error",
    ]),
    revision: z.number().int().min(1),
  }),
  z.strictObject({
    status: z.literal("learning_result"),
    httpStatus: z.literal(200),
    result: learningRunResultSchema,
  }),
  z.strictObject({
    status: z.literal("terminal_without_result"),
    httpStatus: z.literal(200),
    phase: z.enum(["ended", "cancelled", "stale"]),
    reasonCode: z.enum([
      "user_ended",
      "runtime_cancelled",
      "target_fingerprint_changed",
      "schedule_generation_changed",
      "permission_revoked",
    ]),
  }),
]);

// ─── §15 canonical envelope / practice trail（projection 唯一输入）────────

export type CanonicalLearningFactKindV1 =
  | "initial_validation"
  | "scheduled_review"
  | "facet_observation"
  | "canonical_unable";

export type CanonicalAssessmentRefV1 =
  | {
      source: "assessment_critic";
      assessmentId: string;
      reportHash: string;
      trustClass: "mastery_eligible" | "facet_eligible";
    }
  | {
      source: "deterministic_declared_unable";
      assessmentId: string;
      reportHash: string;
    };

export type CanonicalLearningEventEnvelopeV1 = {
  version: 1;
  canonicalEventId: string;
  eventHash: string;
  commitId: string;
  workspaceId: string;
  userId: string;
  runId: string;
  taskIds: [string, ...string[]];
  artifactIds: [string, ...string[]];
  keyPointId: string;
  targetFingerprint: string;
  fact: {
    kind: CanonicalLearningFactKindV1;
    factId: string;
    disposition: "mastery_evidence" | "facet_evidence" | "unable_evidence";
  };
  assessments: [CanonicalAssessmentRefV1, ...CanonicalAssessmentRefV1[]];
  occurredAt: string;
};

export type PracticeTrailEventV1 = {
  version: 1;
  practiceEventId: string;
  eventHash: string;
  workspaceId: string;
  userId: string;
  runId: string;
  taskIds: [string, ...string[]];
  keyPointId: string;
  targetFingerprint: string;
  artifactIds: string[];
  scope: "official_user" | "sandbox";
  reasons: [
    "hint_used" | "diagnostic_only" | "practice_task" | "sandbox",
    ...Array<"hint_used" | "diagnostic_only" | "practice_task" | "sandbox">
  ];
  occurredAt: string;
  expiresAt: string | null;
};

export const canonicalLearningEventEnvelopeSchema = baseVersionSchema
  .extend({
    canonicalEventId: z.string().min(1),
    eventHash: z.string().min(1),
    commitId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    runId: z.string().uuid(),
    taskIds: z.array(z.string().uuid()).min(1),
    artifactIds: z.array(z.string().uuid()).min(1),
    keyPointId: z.string().uuid(),
    targetFingerprint: z.string().min(1),
    fact: z
      .object({
        kind: z.enum([
          "initial_validation",
          "scheduled_review",
          "facet_observation",
          "canonical_unable",
        ]),
        factId: z.string().min(1),
        disposition: z.enum(["mastery_evidence", "facet_evidence", "unable_evidence"]),
      })
      .strict(),
    assessments: z
      .array(
        z
          .discriminatedUnion("source", [
            z
              .object({
                source: z.literal("assessment_critic"),
                assessmentId: z.string().uuid(),
                reportHash: z.string().min(1),
                trustClass: z.enum(["mastery_eligible", "facet_eligible"]),
              })
              .strict(),
            z
              .object({
                source: z.literal("deterministic_declared_unable"),
                assessmentId: z.string().uuid(),
                reportHash: z.string().min(1),
              })
              .strict(),
          ]),
      )
      .min(1),
    occurredAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    // §15.1：taskIds/artifactIds/assessments 必须等长、同序、无重复，长度 1–2。
    if (value.taskIds.length !== value.artifactIds.length || value.taskIds.length !== value.assessments.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "taskIds/artifactIds/assessments must be equal length",
      });
    }
    if (value.taskIds.length > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "V1 canonical envelope supports at most 2 tasks",
      });
    }
    if (new Set(value.taskIds).size !== value.taskIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "taskIds must be unique" });
    }
    if (new Set(value.artifactIds).size !== value.artifactIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifactIds must be unique" });
    }
  });

export const practiceTrailEventSchema = baseVersionSchema
  .extend({
    practiceEventId: z.string().min(1),
    eventHash: z.string().min(1),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    runId: z.string().uuid(),
    taskIds: z.tuple([z.string().uuid()]).rest(z.string().uuid()),
    keyPointId: z.string().uuid(),
    targetFingerprint: z.string().min(1),
    artifactIds: z.array(z.string().uuid()),
    scope: z.enum(["official_user", "sandbox"]),
    reasons: z
      .tuple([z.enum(["hint_used", "diagnostic_only", "practice_task", "sandbox"])])
      .rest(z.enum(["hint_used", "diagnostic_only", "practice_task", "sandbox"])),
    occurredAt: z.string().min(1),
    expiresAt: z.string().nullable(),
  })
  .strict();

// ─── §15.4 Return Contract ───────────────────────────────────────────────

export type LearningRunReturnContractV1 =
  | {
      version: 1;
      status: "run_active";
      runPhase: "preparing" | "active" | "assessing" | "checkpoint" | "committing" | "paused" | "recoverable_error";
      returnTarget: LearningRunReturnTargetV1;
    }
  | {
      version: 1;
      status: "no_projection_change";
      sourceChange: { kind: "none" };
      returnTarget: LearningRunReturnTargetV1;
    }
  | {
      version: 1;
      status: "projection_pending";
      sourceChange: Exclude<ProjectionSourceChangeV1, { kind: "none" }>;
      currentCheckpoint: ProjectionCheckpointV1;
      returnTarget: LearningRunReturnTargetV1;
      retryAfterMs: number;
    }
  | {
      version: 1;
      status: "ready";
      sourceChange: Exclude<ProjectionSourceChangeV1, { kind: "none" }>;
      targetCheckpoint: ProjectionCheckpointV1;
      returnTarget: LearningRunReturnTargetV1;
      changeSetId: string;
    }
  | {
      version: 1;
      status: "unavailable";
      reason:
        | "run_not_found"
        | "return_target_deleted"
        | "permission_revoked"
        | "projection_failed";
      fallbackTarget: LearningRunReturnTargetV1 | null;
    };

export const learningRunReturnContractSchema = z.discriminatedUnion("status", [
  z.strictObject({
    version: z.literal(1),
    status: z.literal("run_active"),
    runPhase: z.enum(["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"]),
    returnTarget: learningRunReturnTargetSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("no_projection_change"),
    sourceChange: z.strictObject({ kind: z.literal("none") }),
    returnTarget: learningRunReturnTargetSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("projection_pending"),
    sourceChange: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("canonical"), canonicalEventId: z.string().min(1) }),
      z.strictObject({ kind: z.literal("practice_only"), practiceEventId: z.string().min(1) }),
    ]),
    currentCheckpoint: projectionCheckpointSchema,
    returnTarget: learningRunReturnTargetSchema,
    retryAfterMs: z.number().int().min(0),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("ready"),
    sourceChange: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("canonical"), canonicalEventId: z.string().min(1) }),
      z.strictObject({ kind: z.literal("practice_only"), practiceEventId: z.string().min(1) }),
    ]),
    targetCheckpoint: projectionCheckpointSchema,
    returnTarget: learningRunReturnTargetSchema,
    changeSetId: z.string().min(1),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("unavailable"),
    reason: z.enum([
      "run_not_found",
      "return_target_deleted",
      "permission_revoked",
      "projection_failed",
    ]),
    fallbackTarget: learningRunReturnTargetSchema.nullable(),
  }),
]);

// ─── 导出类型推导 ────────────────────────────────────────────────────────

export type LearningRunOrigin = z.infer<typeof learningRunOriginSchema>;
export type LearningRunPublic = z.infer<typeof learningRunPublicSchema>;
export type AssessmentPublic = z.infer<typeof assessmentPublicSchema>;
export type LearningRunResult = z.infer<typeof learningRunResultSchema>;
export type ArtifactPayload = z.infer<typeof artifactPayloadSchema>;
export type SubmitTaskArtifact = z.infer<typeof submitTaskArtifactSchema>;
export type SubmitTaskArtifactReceipt = z.infer<typeof submitTaskArtifactReceiptSchema>;
export type CreateLearningRunRequest = z.infer<typeof createLearningRunRequestSchema>;
export type LearningRunAction = z.infer<typeof learningRunActionSchema>;
export type LearningRunActionRequest = z.infer<typeof learningRunActionRequestSchema>;
export type LearningRunActionResponse = z.infer<typeof learningRunActionResponseSchema>;
export type GetLearningRunResultResponse = z.infer<typeof getLearningRunResultResponseSchema>;
export type LearningTaskPublic = z.infer<typeof learningTaskPublicSchema>;
export type LearningTaskSummary = z.infer<typeof learningTaskSummarySchema>;
export type LearningRunFailure = z.infer<typeof learningRunFailureSchema>;
export type PutLearningTaskDraftRequest = z.infer<typeof putLearningTaskDraftRequestSchema>;
export type LearningTaskDraft = z.infer<typeof learningTaskDraftSchema>;
export type LearningTaskDraftWriteReceipt = z.infer<typeof learningTaskDraftWriteReceiptSchema>;
export type LearningDraftPayload = z.infer<typeof learningDraftPayloadSchema>;
export type LearningRendererDraftState = z.infer<typeof learningRendererDraftStateSchema>;
export type CanonicalLearningEventEnvelope = z.infer<typeof canonicalLearningEventEnvelopeSchema>;
export type PracticeTrailEvent = z.infer<typeof practiceTrailEventSchema>;
export type LearningRunReturnContract = z.infer<typeof learningRunReturnContractSchema>;
