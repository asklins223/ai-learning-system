/**
 * LearningRun 公开视图构建（§12.1/§12.4）。
 *
 * 只从 DB 行投影 public contract；private solution/rubric/safety 闭包
 * 绝不进入本模块输出。构建结果必须通过 learningRunPublicSchema 校验。
 */

import type {
  AssessmentPublicV1,
  LearningRunOriginV1,
  LearningRunPublicV1,
  LearningRunResultV1,
  LearningRunReturnTargetV1,
  LearningTaskPublicV1,
  LearningTaskSummaryV1,
  ProjectionCheckpointV1,
  TaskAlternativeDescriptorV1,
  TaskInteractionV1,
  TaskIntentV1,
  TaskPurposeV1,
  TrustClassV1,
  UnderstandingGraphFilterV1,
  UnderstandingLensV1,
} from "@ailearn/shared";
import { learningRunPublicSchema } from "@ailearn/shared";

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 存储的 run origin（jsonb）→ 公开合同 LearningRunOriginV1。
 *
 * createRunV2 写入严格 V2 形状（objectiveId），而内部 public snapshot
 * contract 仍使用 keyPointId 字段；这里做唯一的 V2→snapshot 投影。
 */
export function normalizeOriginToV1(origin: unknown): LearningRunOriginV1 {
  if (!origin || typeof origin !== "object") {
    throw new Error("run origin 缺失或形状非法");
  }
  const o = origin as Record<string, unknown>;
  const keyPointId = readString(o, "objectiveId");
  if (!keyPointId) throw new Error("run origin 缺少 objectiveId");
  switch (o.kind) {
    case "card":
      return { kind: "card", cardId: readString(o, "cardId") ?? "", keyPointId };
    case "review":
      return {
        kind: "review",
        scheduleId: readString(o, "scheduleId") ?? "",
        keyPointId,
        scheduleGeneration: typeof o.scheduleGeneration === "number" ? o.scheduleGeneration : 1,
      };
    case "star_map":
      return {
        kind: "star_map",
        keyPointId,
        lens: o.lens as UnderstandingLensV1,
        filter: o.filter as UnderstandingGraphFilterV1,
        ...(readString(o, "routePlanId") ? { routePlanId: readString(o, "routePlanId") } : {}),
        baselineCheckpoint: o.baselineCheckpoint as ProjectionCheckpointV1,
      };
    case "today":
      return {
        kind: "today",
        ...(readString(o, "recommendationId") ? { recommendationId: readString(o, "recommendationId") } : {}),
        keyPointId,
      };
    case "onboarding":
      return {
        kind: "onboarding",
        sampleMode: o.sampleMode === "sandbox" ? "sandbox" : "own_content",
        keyPointId,
        ...(readString(o, "sandboxNamespaceId") ? { sandboxNamespaceId: readString(o, "sandboxNamespaceId") } : {}),
      };
    default:
      throw new Error(`run origin kind 非法: ${String(o.kind)}`);
  }
}

/**
 * 由 origin 推导公开合同 LearningRunReturnTargetV1。
 *
 * 所有字段都从严格 V2 origin 确定性推导，保证 return target 与 frozen
 * origin 使用同一事实源。
 * onboarding destination 无历史消费者，约定：own_content→card、sandbox→today。
 */
export function deriveReturnTargetV1(origin: unknown): LearningRunReturnTargetV1 {
  const o = (origin && typeof origin === "object" ? origin : {}) as Record<string, unknown>;
  const keyPointId = readString(o, "objectiveId") ?? "";
  switch (o.kind) {
    case "card": {
      const cardId = readString(o, "cardId") ?? "";
      return {
        kind: "card",
        cardId,
        keyPointId,
        objectiveId: keyPointId,
      };
    }
    case "review":
      return {
        kind: "review",
        scheduleId: readString(o, "scheduleId"),
        keyPointId,
      };
    case "star_map":
      return {
        kind: "star_map",
        keyPointId,
        lens: o.lens as UnderstandingLensV1,
        filter: o.filter as UnderstandingGraphFilterV1,
        ...(readString(o, "routePlanId")
          ? { routePlanId: readString(o, "routePlanId") }
          : {}),
      };
    case "today":
      return { kind: "today" };
    case "onboarding":
      return {
        kind: "onboarding",
        destination: o.sampleMode === "sandbox" ? "today" : "card",
      };
    default:
      throw new Error(`run origin kind 非法: ${String(o.kind)}`);
  }
}

export interface RunRow {
  id: string;
  workspaceId: string;
  userId: string;
  assistantSessionId: string | null;
  /** 存储原值：严格 V2 origin。公开值经 normalizeOriginToV1 投影。 */
  origin: unknown;
  /** 数据库中的返回目标快照。 */
  returnTarget: unknown;
  keyPointId: string;
  targetFingerprint: string;
  goal: LearningRunPublicV1["goal"];
  phase: LearningRunPublicV1["phase"];
  timeBudgetSeconds: number;
  plannedActiveSeconds: number;
  activeSecondsUsed: number;
  activeTaskId: string | null;
  checkpoint: NonNullable<LearningRunPublicV1["checkpoint"]> | null;
  failure: LearningRunPublicV1["failure"];
  projectionStatus: LearningRunPublicV1["projectionStatus"];
  projectionBaselineCheckpointToken: string | null;
  revision: number;
  runtimeEpoch: number;
  eventCursor: number;
  result: LearningRunResultV1 | null;
}

export interface TaskRow {
  id: string;
  runId: string;
  sequence: number;
  intent: TaskIntentV1;
  prompt: string;
  targetSummary: string;
  hintLevels: 0 | 1 | 2 | 3;
  status: LearningTaskSummaryV1["status"];
  revision: number;
  activeVariantId: string | null;
}

export interface VariantRow {
  id: string;
  taskId: string;
  purpose: TaskPurposeV1;
  templateTrustCeiling: TrustClassV1;
  estimatedActiveSeconds: number;
  interaction: TaskInteractionV1;
  publicPayloadHash: string;
  inputSchemaHash: string;
  disclosureProfileHash: string;
  revision: number;
  status: "active" | "standby" | "superseded" | "abandoned";
  alternativeFamily: "voice" | "text" | "structured" | null;
}

export interface AssessmentRow {
  id: string;
  runId: string;
  taskId: string;
  artifactId: string;
  source: "assessment_critic" | "deterministic_declared_unable";
  status: AssessmentPublicV1["status"];
  rubricResults: AssessmentPublicV1["rubricResults"];
  trustClass: TrustClassV1 | null;
  reportHash: string | null;
}

export interface RunViewInput {
  run: RunRow;
  tasks: TaskRow[];
  variants: VariantRow[];
  assessment: AssessmentRow | null;
  /** keyPoint 到 fingerprint 的映射：由 view 层调用方提供（含已解析 checkpoint）。 */
  baselineCheckpoint: ProjectionCheckpointV1 | null;
  /** 来自 private contract 的调度授权（只投影摘要，不返回原文）。 */
  schedulingAuthorization: unknown;
}

/** 计算 schedulePolicySummary（§12.1）。 */
export function buildSchedulePolicySummary(schedulingAuthorization: unknown): LearningRunPublicV1["schedulePolicySummary"] {
  const auth = schedulingAuthorization as
    | { kind: string; scheduleId?: string; scheduleGeneration?: number; reasonCode?: string }
    | null;
  if (auth?.kind === "create_initial") {
    return { kind: "create_on_canonical_outcome", eligibleOutcomes: ["demonstrated", "declared_unable"] };
  }
  if (auth?.kind === "consume_pending" && typeof auth.scheduleId === "string" && typeof auth.scheduleGeneration === "number") {
    return {
      kind: "consume_on_canonical_outcome",
      scheduleId: auth.scheduleId,
      scheduleGeneration: auth.scheduleGeneration,
      eligibleOutcomes: ["demonstrated", "declared_unable"],
    };
  }
  const reasonCode = auth?.reasonCode;
  if (reasonCode === "practice" || reasonCode === "diagnostic" || reasonCode === "sandbox" || reasonCode === "not_eligible") {
    return { kind: "no_schedule_effect", reasonCode };
  }
  return { kind: "no_schedule_effect", reasonCode: "not_eligible" };
}

export function buildRunPublicView(input: RunViewInput): LearningRunPublicV1 {
  const { run, tasks, variants, assessment, baselineCheckpoint } = input;
  // 公开 origin 一律从严格 V2 形状投影为 snapshot contract。
  const publicOrigin = normalizeOriginToV1(run.origin);
  const publicReturnTarget = deriveReturnTargetV1(run.origin);

  // 预索引：taskId → active variant，避免每个 task 线性扫描 variants。
  const activeVariantByTaskId = new Map<string, typeof variants[number]>();
  for (const v of variants) {
    if (v.status === "active" && !activeVariantByTaskId.has(v.taskId)) {
      activeVariantByTaskId.set(v.taskId, v);
    }
  }

  const summaries: LearningTaskSummaryV1[] = tasks.map((task) => {
    const activeVariant = activeVariantByTaskId.get(task.id);
    return {
      taskId: task.id,
      sequence: task.sequence,
      intent: task.intent,
      status: task.status,
      estimatedActiveSeconds: activeVariant?.estimatedActiveSeconds ?? 0,
    };
  });

  let activeTask: LearningTaskPublicV1 | null = null;
  const activeTaskRow = tasks.find((t) => t.id === run.activeTaskId) ?? null;
  if (activeTaskRow) {
    const activeVariantRow = activeVariantByTaskId.get(activeTaskRow.id);
    if (activeVariantRow) {
      const alternatives: TaskAlternativeDescriptorV1[] = variants
        .filter((v) => v.taskId === activeTaskRow.id && v.id !== activeVariantRow.id && v.status === "standby")
        .map((v) => ({
          alternativeId: v.id,
          family: variantFamily(v.interaction),
          // D5：把模态一起给界面，按钮才写得出「改做选择题」而不是统一的「换一种方式」。
          interactionKind: v.interaction.kind,
          estimatedActiveSeconds: v.estimatedActiveSeconds,
          maximumPurpose: v.purpose,
        }));
      activeTask = {
        version: 1,
        taskId: activeTaskRow.id,
        runId: activeTaskRow.runId,
        sequence: activeTaskRow.sequence,
        intent: activeTaskRow.intent,
        prompt: activeTaskRow.prompt,
        targetSummary: activeTaskRow.targetSummary,
        activeVariant: {
          variantId: activeVariantRow.id,
          purpose: activeVariantRow.purpose,
          interaction: activeVariantRow.interaction,
          templateTrustCeiling: activeVariantRow.templateTrustCeiling,
          estimatedActiveSeconds: activeVariantRow.estimatedActiveSeconds,
          publicPayloadHash: activeVariantRow.publicPayloadHash,
          inputSchemaHash: activeVariantRow.inputSchemaHash,
          disclosureProfileHash: activeVariantRow.disclosureProfileHash,
          revision: activeVariantRow.revision,
        },
        availableAlternatives: alternatives,
        assistancePolicy: { hintLevels: activeTaskRow.hintLevels, exposureLowersTrust: true },
        status: activeTaskRow.status,
        revision: activeTaskRow.revision,
      };
    }
  }

  const activeAssessment: AssessmentPublicV1 | null = assessment
    ? {
        version: 1,
        assessmentId: assessment.id,
        runId: assessment.runId,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        source: assessment.source,
        status: assessment.status,
        rubricResults: assessment.rubricResults,
        trustClass: assessment.trustClass,
        reportHash: assessment.reportHash,
      }
    : null;

  const view: LearningRunPublicV1 = {
    version: 1,
    runId: run.id,
    workspaceId: run.workspaceId,
    userId: run.userId,
    assistantSessionId: run.assistantSessionId,
    origin: publicOrigin,
    returnTarget: publicReturnTarget,
    target: { kind: "key_point", keyPointId: run.keyPointId, fingerprint: run.targetFingerprint },
    projectionBaselineCheckpoint: baselineCheckpoint,
    goal: run.goal,
    schedulePolicySummary: buildSchedulePolicySummary(input.schedulingAuthorization),
    phase: run.phase,
    timeBudgetSeconds: run.timeBudgetSeconds,
    plannedActiveSeconds: run.plannedActiveSeconds,
    activeSecondsUsed: run.activeSecondsUsed,
    planningClosesAtActiveSecond: 150,
    activeTaskId: run.activeTaskId,
    taskSummaries: summaries,
    activeTask,
    activeAssessment,
    checkpoint: run.checkpoint,
    failure: run.failure,
    projectionStatus: run.projectionStatus,
    revision: run.revision,
    runtimeEpoch: run.runtimeEpoch,
    eventCursor: run.eventCursor,
    result: run.result,
  };
  // 头注释承诺的合同防线（2026-08-22 接线）：公开视图必须严格满足 V1 合同，
  // 形状漂移（如 origin/returnTarget 带 V2 字段）在此 fail-loud 而非静默出网。
  return learningRunPublicSchema.parse(view) as LearningRunPublicV1;
}

function variantFamily(interaction: TaskInteractionV1): "voice" | "text" | "structured" {
  if (interaction.kind === "voice_teachback") return "voice";
  if (interaction.kind === "text_response") return "text";
  return "structured";
}
