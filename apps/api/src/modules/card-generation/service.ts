import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import {
  CardGenerationStage,
  JobResourceClass,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  SUPERVISOR_AGENT_ENGINE_MODE,
  SUPERVISOR_SHELL_VERSION,
  AgentUnitKind,
  SupervisorRunStatus,
  SupervisorShellStage,
  isFeedbackCollectionEnabled,
  isRunErrorRetryable,
} from "@ailearn/shared";
import { resolveSystemProviderForCapability } from "@ailearn/shared/task-router";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import {
  isCardGenerationV1WriterEnabled,
  isCardGenerationV2Enabled,
} from "../../config/learning-companion-flags.ts";
import { recordLegacyWriterHit } from "../card-generation-v2/legacy-consumer-audit.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { learningCards } from "../../db/schema/card.ts";
import { cardGenerationAgentEvents,
  cardGenerationCandidates,
  cardGenerationDrafts,
  cardGenerationEvents,
  cardGenerationQualityReports,
  cardGenerationRuns,
  cardGenerationSourceBundles,
  cardGenerationUnits,
  type CardGenerationAssetManifestEntry,
  type CardGenerationBlockManifestEntry,
} from "../../db/schema/card-generation.ts";
import { jobs } from "../../db/schema/job.ts";
import { noteBlocks, noteImageAssets, notes, noteVersions } from "../../db/schema/note.ts";

import type {
  CreateCardGenerationRunInput,
} from "./schema.ts";

const TERMINAL_STATUSES = [
  SupervisorRunStatus.PARTIAL_READY,
  SupervisorRunStatus.SUCCEEDED,
  SupervisorRunStatus.NEEDS_ATTENTION,
  SupervisorRunStatus.CANCELLED,
  SupervisorRunStatus.SUPERSEDED,
] as const;
const CANCELLABLE_STATUSES = new Set<string>([
  SupervisorRunStatus.QUEUED,
  SupervisorRunStatus.PREPARING,
  SupervisorRunStatus.RUNNING,
  SupervisorRunStatus.VALIDATING,
  SupervisorRunStatus.PUBLISHING,
]);

type GenerationRunRow = typeof cardGenerationRuns.$inferSelect;

export class CardGenerationServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "CardGenerationServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CardGenerationRunView = {
  runId: string;
  noteId: string;
  noteVersionId: string;
  status: string;
  stage: string;
  stateVersion: number;
  sequence: number;
  engineMode: string;
  shellVersion: string | null;
  sourceSnapshot: {
    noteVersionId: string;
    versionNo: number;
    contentHash: string;
  };
  progress: { completed: number; total: number; unit: string };
  shellStage: string | null;
  coverage: {
    sourceUnitsCompleted: number;
    sourceUnitsTotal: number;
    imagesCompleted: number;
    imagesTotal: number;
    sourceCoverageBps: number | null;
    imageCoverageBps: number | null;
  };
  coverageReport: Record<string, unknown> | null;
  providerCapabilityFingerprint: string | null;
  warnings: Array<{ code: string; details?: Record<string, unknown> }>;
  actions: {
    retryable: boolean;
    restartable: boolean;
    cancellable: boolean;
  };
  result: { cardId: string | null; cardSetId: string | null } | null;
  error: { code: string; retryable: boolean } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * E2 阶段一（计划 §2.9）：生成质量报告。
   * 当 isFeedbackCollectionEnabled() 为 true 时填充，null 表示未启用采集。
   * 包含从 run 状态、覆盖率、事件中聚合的质量信号。
   */
  qualityReport: GenerationQualityReport | null;
  /**
   * Phase C（设计 §5.4）：真实计数聚合。
   * 从 units/candidates/drafts/quality_reports/source_bundles 同事务聚合，
   * 供前端四阶段轨道与汇总卡展示。向后兼容的纯新增字段。
   */
  metrics: CardGenerationRunMetrics;
};

/**
 * 生成 run 的真实计数聚合（设计 §5.4）。
 * 每个字段对应真实存储（非百分比、非合成值）。
 */
export type CardGenerationRunMetrics = {
  bundles: {
    planned: number;
    assigned: number;
    decided: number;
    required: number;
  };
  childTasks: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  candidates: {
    extracted: number;
    canonical: number;
    eligible: number;
    rejected: number;
  };
  draft: {
    version: number;
    producedByRole: string | null;
  };
  critic: {
    status: string | null;
    hardIssues: number;
    softIssues: number;
  };
  /**
   * verify 逐项 check 无表列，只持久化在 agent 事件的 tool_result safePayload
   * （eventKey 前缀 `verify:`）。此处从最近一次 verify 事件聚合；
   * 尚未执行校验时为 null。
   */
  verify: { passedChecks: number; totalChecks: number } | null;
  semanticIndex: {
    mode: string | null;
    status: string | null;
  };
  usageTokens: number | null;
};

/**
 * E2 阶段一（计划 §2.9）：生成质量报告类型。
 * 只采集不干预——不改变生成行为，只聚合和展示质量信号。
 */
export type GenerationQualityReport = {
  signals: Array<{
    issueType: string;
    description: string;
    severity: "info" | "warning" | "critical";
    detectedAt: string;
  }>;
  summary: {
    totalSignals: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
  };
};

export type CardGenerationRunAccepted = {
  runId: string;
  status: string;
  sourceSnapshot: { noteVersionId: string; versionNo: number; contentHash: string } | null;
  canContinueEditing: boolean;
  /**
   * B1（计划 §2.4）：表示此 run 是复用的已有 succeeded run，而非新创建。
   * 前端据此显示"内容未变，已复用上次结果"提示并提供"强制重新生成"入口。
   */
  reused?: boolean;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function buildGenerationManifests(
  blocks: Array<{ id: string; ordinal: number; type: string; content: string; imageAssetId?: string | null }>,
  assetHashById: ReadonlyMap<string, string> = new Map(),
): {
  blockManifest: CardGenerationBlockManifestEntry[];
  assetManifest: CardGenerationAssetManifestEntry[];
  blockManifestHash: string;
  assetManifestHash: string;
} {
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const blockManifest = ordered.map((block) => ({
    blockId: block.id,
    ordinal: block.ordinal,
    type: block.type,
    contentHash: sha256(block.content),
  }));
  const assetManifest = ordered
    .filter((block) => block.type === "image")
    .map((block) => ({
      blockId: block.id,
      ordinal: block.ordinal,
      sourceHash: block.imageAssetId
        ? assetHashById.get(block.imageAssetId) ?? sha256(block.content)
        : sha256(block.content),
      ...(block.imageAssetId ? { assetId: block.imageAssetId } : {}),
    }));
  return {
    blockManifest,
    assetManifest,
    blockManifestHash: hashJson(blockManifest),
    assetManifestHash: hashJson(assetManifest),
  };
}

export function buildGenerationFingerprint(input: {
  workspaceId: string;
  noteId: string;
  noteVersionId: string;
  titleSnapshot: string;
  sourceContentHash: string;
  blockManifestHash: string;
  assetManifestHash: string;
}): string {
  return hashJson({
    contract: "card-generation-fingerprint-v2",
    ...input,
  });
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * 将 run status/stage 映射到用户可见四阶段（计划 §12）。
 *
 * 四阶段：preparing | generating | checking | publishing
 */
function mapToShellStage(runStatus: string, runStage: string): string {
  switch (runStatus) {
    case SupervisorRunStatus.QUEUED:
    case SupervisorRunStatus.PREPARING:
      return SupervisorShellStage.PREPARING;
    case SupervisorRunStatus.RUNNING:
      return SupervisorShellStage.GENERATING;
    case SupervisorRunStatus.VALIDATING:
      return SupervisorShellStage.CHECKING;
    case SupervisorRunStatus.PUBLISHING:
      return SupervisorShellStage.PUBLISHING;
    default:
      break;
  }
  if (runStage === "publish" || runStage === "complete") {
    return SupervisorShellStage.PUBLISHING;
  }
  return SupervisorShellStage.GENERATING;
}

async function toRunView(
  tx: ApiTransaction,
  run: GenerationRunRow,
): Promise<CardGenerationRunView> {
  const version = await tx.query.noteVersions.findFirst({
    columns: { versionNo: true },
    where: and(
      eq(noteVersions.id, run.noteVersionId),
      eq(noteVersions.workspaceId, run.workspaceId),
    ),
  });
  if (!version) {
    throw new CardGenerationServiceError("source_snapshot_missing", 409, "生成快照已不存在");
  }

  const warnings: CardGenerationRunView["warnings"] = [];
  const failedCheckpoints = run.status === SupervisorRunStatus.NEEDS_ATTENTION
    ? await tx.query.cardGenerationUnits.findMany({
        where: and(
          eq(cardGenerationUnits.workspaceId, run.workspaceId),
          eq(cardGenerationUnits.runId, run.id),
          inArray(cardGenerationUnits.status, ["terminal_failed", "retryable_failed"]),
        ),
        orderBy: [asc(cardGenerationUnits.ordinal)],
      })
    : [];
  if (failedCheckpoints.length > 0) {
    warnings.push({
      code: "generation_units_failed",
      details: {
        units: failedCheckpoints.map((unit) => ({
          unitId: unit.id,
          kind: unit.kind,
          ordinal: unit.ordinal,
          status: unit.status,
          errorCode: unit.errorCode,
        })),
      },
    });
  }

  const latestNoteFence = run.status === SupervisorRunStatus.NEEDS_ATTENTION
    ? await tx.query.notes.findFirst({
        columns: {
          cardGenerationEpoch: true,
          latestGenerationRunId: true,
        },
        where: and(
          eq(notes.id, run.noteId),
          eq(notes.workspaceId, run.workspaceId),
        ),
      })
    : null;

  const terminal = TERMINAL_STATUSES.includes(run.status as (typeof TERMINAL_STATUSES)[number]);
  const latestRun =
    latestNoteFence?.cardGenerationEpoch === run.generationEpoch
    && latestNoteFence.latestGenerationRunId === run.id;
  const retryCompatible = true;

  const shellStage = mapToShellStage(run.status, run.stage);

  const retryable =
    run.status === SupervisorRunStatus.NEEDS_ATTENTION
    && run.retryable
    && latestRun
    && retryCompatible
    // 错误码级兜底：即使 DB 中 retryable 为 true，预算耗尽/确定性门禁等
    // 明确不可恢复的错误也不展示"重试"（与 worker 写入侧使用同一判定）。
    && isRunErrorRetryable(run.errorCode);
  const progressComplete =
    run.status === SupervisorRunStatus.SUCCEEDED
    || run.status === SupervisorRunStatus.PARTIAL_READY;
  const result = run.resultCardId || run.resultCardSetId
    ? { cardId: run.resultCardId, cardSetId: run.resultCardSetId }
    : null;

  // 真实进度/覆盖率的唯一来源是 supervisor 持久化的六层 coverageReport
  //（prepare/deck-draft/specialist-persist/publish 各阶段都会刷新）。
  // 旧的 completedUnits/requiredUnits/sourceCoverageBps 计数器已不再被写入，
  // 不再作为进度数据源。
  const coverageReport = (run.coverageReport ?? {}) as Record<string, unknown>;

  // E2 阶段一：当 feature flag 开启时，聚合生成质量报告
  const qualityReport = isFeedbackCollectionEnabled()
    ? buildQualityReport(run, coverageReport, failedCheckpoints)
    : null;
  const fraction = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const explicitDecisionCoverage = fraction(coverageReport.explicitDecisionCoverage);
  const bundleAssignmentCoverage = fraction(coverageReport.bundleAssignmentCoverage);
  const bundleDecisions = Array.isArray(coverageReport.bundleDecisions)
    ? (coverageReport.bundleDecisions as Array<{ decisionStatus?: string }>)
    : [];
  const decidedBundles = bundleDecisions.filter(
    (d) => d?.decisionStatus === "candidate_emitted"
      || d?.decisionStatus === "no_learnable_fact",
  ).length;
  // Supervisor 把图片折叠进 source bundle（由 vision specialist 处理），
  // 不在 run 行单独记录图片完成数。图片覆盖率用 bundle 分配覆盖率作为代理：
  // 它是 coverageReport 里同时覆盖文本与图片 bundle 的真实指标。
  const hasImages = run.requiredImages > 0;
  const imageCoverageBps = hasImages
    ? bundleAssignmentCoverage != null
      ? Math.round(bundleAssignmentCoverage * 10000)
      : null
    : 10_000;

  return {
    runId: run.id,
    noteId: run.noteId,
    noteVersionId: run.noteVersionId,
    status: run.status,
    stage: run.stage,
    stateVersion: run.stateVersion,
    sequence: Math.max(0, run.nextEventSequence - 1),
    engineMode: SUPERVISOR_AGENT_ENGINE_MODE,
    shellVersion: SUPERVISOR_SHELL_VERSION,
    sourceSnapshot: {
      noteVersionId: run.noteVersionId,
      versionNo: version.versionNo,
      contentHash: run.sourceContentHash,
    },
    progress: {
      completed: explicitDecisionCoverage != null
        ? Math.round(explicitDecisionCoverage * 100)
        : progressComplete ? 100 : 0,
      total: 100,
      unit: "percent",
    },
    shellStage,
    coverage: {
      sourceUnitsCompleted: decidedBundles,
      sourceUnitsTotal: bundleDecisions.length,
      imagesCompleted: hasImages && bundleAssignmentCoverage != null
        ? Math.round(bundleAssignmentCoverage * run.requiredImages)
        : 0,
      imagesTotal: run.requiredImages,
      sourceCoverageBps: explicitDecisionCoverage != null
        ? Math.round(explicitDecisionCoverage * 10000)
        : null,
      imageCoverageBps,
    },
    coverageReport: (run.coverageReport as Record<string, unknown> | null) ?? null,
    providerCapabilityFingerprint: run.providerCapabilityFingerprint ?? null,
    warnings,
    actions: {
      retryable,
      restartable:
        run.status === SupervisorRunStatus.NEEDS_ATTENTION
        && latestRun,
      cancellable: CANCELLABLE_STATUSES.has(run.status),
    },
    result,
    error: run.errorCode ? { code: run.errorCode, retryable } : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: terminal || run.finishedAt ? iso(run.finishedAt) : null,
    qualityReport,
    metrics: await buildRunMetrics(tx, run),
  };
}

async function getRunRowForWorkspace(
  tx: ApiTransaction,
  runId: string,
  workspaceId: string,
): Promise<GenerationRunRow | null> {
  return await tx.query.cardGenerationRuns.findFirst({
    where: and(
      eq(cardGenerationRuns.id, runId),
      eq(cardGenerationRuns.workspaceId, workspaceId),
    ),
  }) ?? null;
}

/**
 * Phase C（设计 §5.4）：聚合 run 的真实计数。
 *
 * 字段与真实存储的映射（勿按组名猜列）：
 * - `bundles`：`card_generation_source_bundles`；planned=assignmentStatus 'pending'、
 *   assigned=非 pending、decided=decisionStatus 非 'pending'、required=required。
 * - `childTasks`：`card_generation_units.status` 全量枚举中
 *   completed≈succeeded、failed≈retryable_failed|terminal_failed、
 *   running≈running|agent_running|waiting_child|verifying。
 * - `candidates`：`candidateKind` ∈ {extracted, canonical}；
 *   eligible≈validationStatus 'accepted'、rejected≈'excluded'（coverage-ledger 的
 *   candidateSurvivalCoverage 是比例非计数，无法直接映射成条数）。
 * - `draft`：`card_generation_drafts` 最大 draftVersion + 产出 unit 的 kind。
 * - `critic`：最新 `card_generation_quality_reports`（按 createdAt desc）。
 * - `verify`：`verify:*` tool_result 事件的 safePayload.checks。
 * - `semanticIndex.mode`：`runs.embeddingProfileVersion`（SupervisorProgress 的
 *   semanticIndexMode 的持久化代理）；status 暂无列，留 null。
 * - `usageTokens`：`runs.usageSummary.{inputTokens, outputTokens}` 之和。
 */
async function buildRunMetrics(
  tx: ApiTransaction,
  run: GenerationRunRow,
): Promise<CardGenerationRunMetrics> {
  const { workspaceId, id: runId } = run;

  const [bundles] = await tx
    .select({
      planned: count(sql`case when ${cardGenerationSourceBundles.assignmentStatus} = 'pending' then 1 end`),
      assigned: count(sql`case when ${cardGenerationSourceBundles.assignmentStatus} <> 'pending' then 1 end`),
      decided: count(sql`case when ${cardGenerationSourceBundles.decisionStatus} <> 'pending' then 1 end`),
      required: count(sql`case when ${cardGenerationSourceBundles.required} then 1 end`),
    })
    .from(cardGenerationSourceBundles)
    .where(and(
      eq(cardGenerationSourceBundles.workspaceId, workspaceId),
      eq(cardGenerationSourceBundles.runId, runId),
    ));

  const [childTasks] = await tx
    .select({
      pending: count(sql`case when ${cardGenerationUnits.status} = 'pending' then 1 end`),
      running: count(sql`case when ${cardGenerationUnits.status} in ('running', 'agent_running', 'waiting_child', 'verifying') then 1 end`),
      completed: count(sql`case when ${cardGenerationUnits.status} = 'succeeded' then 1 end`),
      failed: count(sql`case when ${cardGenerationUnits.status} in ('retryable_failed', 'terminal_failed') then 1 end`),
    })
    .from(cardGenerationUnits)
    .where(and(
      eq(cardGenerationUnits.workspaceId, workspaceId),
      eq(cardGenerationUnits.runId, runId),
    ));

  const [candidates] = await tx
    .select({
      extracted: count(sql`case when ${cardGenerationCandidates.candidateKind} = 'extracted' then 1 end`),
      canonical: count(sql`case when ${cardGenerationCandidates.candidateKind} = 'canonical' then 1 end`),
      eligible: count(sql`case when ${cardGenerationCandidates.validationStatus} = 'accepted' then 1 end`),
      rejected: count(sql`case when ${cardGenerationCandidates.validationStatus} = 'excluded' then 1 end`),
    })
    .from(cardGenerationCandidates)
    .where(and(
      eq(cardGenerationCandidates.workspaceId, workspaceId),
      eq(cardGenerationCandidates.runId, runId),
    ));

  const latestDraft = await tx.query.cardGenerationDrafts.findFirst({
    columns: { draftVersion: true, producedByUnitId: true },
    where: and(
      eq(cardGenerationDrafts.workspaceId, workspaceId),
      eq(cardGenerationDrafts.runId, runId),
    ),
    orderBy: [desc(cardGenerationDrafts.draftVersion)],
  });
  let producedByRole: string | null = null;
  if (latestDraft) {
    const producer = await tx.query.cardGenerationUnits.findFirst({
      columns: { kind: true },
      where: eq(cardGenerationUnits.id, latestDraft.producedByUnitId),
    });
    producedByRole = producer?.kind ?? null;
  }

  const latestReport = await tx.query.cardGenerationQualityReports.findFirst({
    columns: { criticStatus: true, hardIssues: true, softIssues: true },
    where: and(
      eq(cardGenerationQualityReports.workspaceId, workspaceId),
      eq(cardGenerationQualityReports.runId, runId),
    ),
    orderBy: [desc(cardGenerationQualityReports.createdAt)],
  });

  // verify 计数只存在于 `verify:*` tool_result 事件的 safePayload.checks。
  const verifyEvent = await tx.query.cardGenerationAgentEvents.findFirst({
    columns: { safePayload: true },
    where: and(
      eq(cardGenerationAgentEvents.workspaceId, workspaceId),
      eq(cardGenerationAgentEvents.runId, runId),
      eq(cardGenerationAgentEvents.eventType, "tool_result"),
      like(cardGenerationAgentEvents.eventKey, "verify:%"),
    ),
    orderBy: [desc(cardGenerationAgentEvents.createdAt)],
  });
  let verify: CardGenerationRunMetrics["verify"] = null;
  if (verifyEvent) {
    const checks = Array.isArray(verifyEvent.safePayload.checks)
      ? verifyEvent.safePayload.checks as Array<{ passed?: unknown }>
      : [];
    if (checks.length > 0) {
      verify = {
        passedChecks: checks.filter((c) => c.passed === true).length,
        totalChecks: checks.length,
      };
    }
  }

  const usage = (run.usageSummary ?? {}) as Record<string, unknown>;
  const usageTokens = (typeof usage.inputTokens === "number" ? usage.inputTokens : 0)
    + (typeof usage.outputTokens === "number" ? usage.outputTokens : 0);

  return {
    bundles: {
      planned: bundles?.planned ?? 0,
      assigned: bundles?.assigned ?? 0,
      decided: bundles?.decided ?? 0,
      required: bundles?.required ?? 0,
    },
    childTasks: {
      pending: childTasks?.pending ?? 0,
      running: childTasks?.running ?? 0,
      completed: childTasks?.completed ?? 0,
      failed: childTasks?.failed ?? 0,
    },
    candidates: {
      extracted: candidates?.extracted ?? 0,
      canonical: candidates?.canonical ?? 0,
      eligible: candidates?.eligible ?? 0,
      rejected: candidates?.rejected ?? 0,
    },
    draft: {
      version: latestDraft?.draftVersion ?? 0,
      producedByRole,
    },
    critic: {
      status: latestReport?.criticStatus ?? null,
      hardIssues: Array.isArray(latestReport?.hardIssues) ? latestReport.hardIssues.length : 0,
      softIssues: Array.isArray(latestReport?.softIssues) ? latestReport.softIssues.length : 0,
    },
    verify,
    semanticIndex: {
      mode: run.embeddingProfileVersion ?? null,
      status: null,
    },
    usageTokens: usageTokens > 0 ? usageTokens : null,
  };
}

function assertPendingQuota(pendingCount: number): void {
  if (pendingCount >= MAX_PENDING_JOBS_PER_WORKSPACE) {
    throw new CardGenerationServiceError(
      "job_quota_exceeded",
      429,
      "当前后台任务较多，请稍后重试",
    );
  }
}

/**
 * E2 阶段一（计划 §2.9）：构建生成质量报告。
 *
 * 从 run 状态、覆盖率、失败检查点中聚合质量信号。
 * 只采集不干预——不改变生成行为，只用于展示和诊断。
 */
function buildQualityReport(
  run: GenerationRunRow,
  coverageReport: Record<string, unknown>,
  failedCheckpoints: Array<{ id: string; kind: string; ordinal: number | null; status: string; errorCode: string | null }>,
): GenerationQualityReport {
  const signals: GenerationQualityReport["signals"] = [];
  const nowISO = new Date().toISOString();

  // 信号 1：run 处于 NEEDS_ATTENTION 状态
  if (run.status === SupervisorRunStatus.NEEDS_ATTENTION) {
    signals.push({
      issueType: "needs_attention",
      description: `生成任务需要处理${run.errorCode ? `（错误：${run.errorCode}）` : ""}`,
      severity: "critical",
      detectedAt: nowISO,
    });
  }

  // 信号 2：覆盖率低于阈值（六层账本）
  const explicitDecisionCoverage = typeof coverageReport.explicitDecisionCoverage === "number"
    && Number.isFinite(coverageReport.explicitDecisionCoverage)
    ? coverageReport.explicitDecisionCoverage as number
    : null;
  if (explicitDecisionCoverage !== null && explicitDecisionCoverage < 0.6) {
    signals.push({
      issueType: "low_coverage",
      description: `显式决策覆盖率 ${(explicitDecisionCoverage * 100).toFixed(1)}%，低于阈值 60%`,
      severity: "warning",
      detectedAt: nowISO,
    });
  }

  // 信号 3：失败的检查点
  if (failedCheckpoints.length > 0) {
    signals.push({
      issueType: "generation_units_failed",
      description: `${failedCheckpoints.length} 个生成检查点失败`,
      severity: "warning",
      detectedAt: nowISO,
    });
  }

  // 信号 4：run 被 superseded（被更新请求取代）
  if (run.status === SupervisorRunStatus.SUPERSEDED) {
    signals.push({
      issueType: "superseded",
      description: "此任务已被更新的生成请求取代",
      severity: "info",
      detectedAt: nowISO,
    });
  }

  const criticalCount = signals.filter((s) => s.severity === "critical").length;
  const warningCount = signals.filter((s) => s.severity === "warning").length;
  const infoCount = signals.filter((s) => s.severity === "info").length;

  return {
    signals,
    summary: {
      totalSignals: signals.length,
      criticalCount,
      warningCount,
      infoCount,
    },
  };
}

export async function createCardGenerationRun(
  context: { workspaceId: string; userId: string },
  input: CreateCardGenerationRunInput & { oldCardId?: string },
): Promise<CardGenerationRunAccepted> {
  return withWorkspaceTransaction(context, async (tx) => {
    // §26 C8：V1 旧 writer 停写门禁。V2 启用（CARD_GENERATION_V2_ENABLED=true）
    // 且未显式开启 V1 writer（CARD_GENERATION_V1_WRITER_ENABLED=true）时，
    // V1 生成一律拒绝（fail closed）——防双 writer 与旧 schema 反写
    // （C39：cutover 后只 pause/forward-fix，不反写旧 schema）。
    if (isCardGenerationV2Enabled() && !isCardGenerationV1WriterEnabled()) {
      throw new CardGenerationServiceError(
        "v1_writer_disabled",
        409,
        "V1 卡片生成已停写（C8 cutover）；请改用 V2 生成路径",
      );
    }
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);

    const replay = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.requestIdempotencyKey, input.idempotencyKey),
      ),
    });
    if (replay) {
      if (replay.noteVersionId !== input.noteVersionId || replay.requestedBy !== context.userId) {
        throw new CardGenerationServiceError(
          "idempotency_key_reused",
          409,
          "幂等键已被另一请求使用",
        );
      }
      try {
        const replayView = await toRunView(tx, replay);
        return {
          runId: replay.id,
          status: replay.status,
          sourceSnapshot: replayView.sourceSnapshot,
          canContinueEditing: true,
        };
      } catch {
        return {
          runId: replay.id,
          status: replay.status,
          sourceSnapshot: null,
          canContinueEditing: false,
        };
      }
    }

    const candidateVersion = await tx.query.noteVersions.findFirst({
      columns: { id: true, noteId: true },
      where: and(
        eq(noteVersions.id, input.noteVersionId),
        eq(noteVersions.workspaceId, context.workspaceId),
      ),
    });
    if (!candidateVersion) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }

    const [note] = await tx
      .select()
      .from(notes)
      .where(and(
        eq(notes.id, candidateVersion.noteId),
        eq(notes.workspaceId, context.workspaceId),
        sql`${notes.deletedAt} IS NULL`,
      ))
      .for("update");
    if (!note) {
      throw new CardGenerationServiceError("note_not_found", 404, "笔记不存在");
    }

    const [version] = await tx
      .select()
      .from(noteVersions)
      .where(and(
        eq(noteVersions.id, input.noteVersionId),
        eq(noteVersions.noteId, note.id),
        eq(noteVersions.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!version) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }

    const blocks = await tx.query.noteBlocks.findMany({
      where: and(
        eq(noteBlocks.versionId, version.id),
        eq(noteBlocks.workspaceId, context.workspaceId),
      ),
      orderBy: [asc(noteBlocks.ordinal)],
    });
    if (blocks.length === 0) {
      throw new CardGenerationServiceError("empty_note", 422, "笔记没有可生成的内容");
    }

    const imageAssetIds = [...new Set(blocks
      .filter((block) => block.type === "image" && block.imageAssetId)
      .map((block) => block.imageAssetId!))];
    const imageAssets = imageAssetIds.length > 0
      ? await tx.query.noteImageAssets.findMany({
          where: and(
            eq(noteImageAssets.workspaceId, context.workspaceId),
            inArray(noteImageAssets.id, imageAssetIds),
          ),
        })
      : [];
    const activeImageAssets = imageAssets.filter((asset) => asset.status === "ready" && !asset.deletedAt);
    const assetHashById = new Map(activeImageAssets.map((asset) => [asset.id, asset.sha256]));
    const imageBlocks = blocks.filter((block) => block.type === "image");
    if (imageBlocks.some((block) => !block.imageAssetId || !assetHashById.has(block.imageAssetId))) {
      throw new CardGenerationServiceError(
        "image_asset_unresolved",
        422,
        "笔记包含尚未注册为图片资产的图片，请重新上传后再生成",
      );
    }
    const manifests = buildGenerationManifests(blocks, assetHashById);
    const textSourceChars = blocks
      .filter((block) => block.type !== "image")
      .reduce((total, block) => total + block.content.length, 0);

    const executionMode = "supervisor_agent_v1";

    // P0-01 阶段A-4 + P1-12：为 supervisor_agent_v1 解析并冻结 provider 快照。
    // v0.6 单一配置源重构：平台解析完全收敛到 config/ai-platforms.json，
    // 不再查 personal BYOK 或 workspace.aiProvider。
    const resolvedProviderName = resolveSystemProviderForCapability("agent_turn");

    // B1-B3 迁移遗漏修复：快照额外冻结系统 agent_turn 平台的配置平台 ID
    //（config/ai-platforms.json 的 platform id，如 "morbuke"；无配置文件时为 provider type）。
    // 用于 worker 侧平台漂移检测：config 平台在 run 创建后变化时能发现，
    // 而不只是 provider type/model（type 可能不变、仅平台实例切换）。
    const systemAgentTurnPlatform = resolveSystemPlatform("agent_turn");
    const systemAgentTurnPlatformId = systemAgentTurnPlatform?.platformId ?? null;

    if (
      resolvedProviderName === "mock"
      && process.env.NODE_ENV === "production"
      && process.env.ALLOW_MOCK_IN_PRODUCTION !== "true"
    ) {
      throw new CardGenerationServiceError(
        "mock_provider_blocked_in_production",
        422,
        "当前工作区的 AI 模型配置为 Mock，无法在生产环境中生成学习卡。请在设置中配置真实的 AI 模型。",
      );
    }

    if (
      blocks.length > 2000
      || textSourceChars > 500_000
      || manifests.assetManifest.length > 30
    ) {
      throw new CardGenerationServiceError(
        "input_limit_exceeded",
        422,
        "生成输入超出产品配额，请拆分笔记后重试",
      );
    }
    const generationFingerprint = buildGenerationFingerprint({
      workspaceId: context.workspaceId,
      noteId: note.id,
      noteVersionId: version.id,
      titleSnapshot: note.title,
      sourceContentHash: version.contentHash,
      blockManifestHash: manifests.blockManifestHash,
      assetManifestHash: manifests.assetManifestHash,
    });

    // Check for active (non-terminal) run with same fingerprint
    const activeNonTerminal = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.noteVersionId, version.id),
        eq(cardGenerationRuns.generationFingerprint, generationFingerprint),
      ),
    });
    if (activeNonTerminal && !TERMINAL_STATUSES.includes(activeNonTerminal.status as (typeof TERMINAL_STATUSES)[number])) {
      const activeView = await toRunView(tx, activeNonTerminal);
      return {
        runId: activeNonTerminal.id,
        status: activeNonTerminal.status,
        sourceSnapshot: activeView.sourceSnapshot,
        canContinueEditing: true,
      };
    }

    // B1（计划 §2.4）：同内容跳过与结果复用。
    // 在活跃 run 复用之后、配额检查之前，查询同 fingerprint 的 succeeded run。
    // 仅命中同 noteVersionId（内容一旦变化 fingerprint 自然不同）；不跨 workspace。
    // force=true 时跳过此检查。
    if (!input.force) {
      const succeededRun = await tx.query.cardGenerationRuns.findFirst({
        where: and(
          eq(cardGenerationRuns.workspaceId, context.workspaceId),
          eq(cardGenerationRuns.noteVersionId, version.id),
          eq(cardGenerationRuns.generationFingerprint, generationFingerprint),
          eq(cardGenerationRuns.status, SupervisorRunStatus.SUCCEEDED),
        ),
        orderBy: [desc(cardGenerationRuns.createdAt)],
      });
      if (succeededRun) {
        try {
          const reuseView = await toRunView(tx, succeededRun);
          return {
            runId: succeededRun.id,
            status: succeededRun.status,
            sourceSnapshot: reuseView.sourceSnapshot,
            canContinueEditing: true,
            reused: true,
          };
        } catch {
          // 如果 toRunView 失败（如源快照已不存在），继续创建新 run
        }
      }
    }

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.status, JobStatus.PENDING),
      ));
    assertPendingQuota(Number(pendingRows[0]?.count ?? 0));

    const now = new Date();
    if (!version.sealedAt) {
      await tx
        .update(noteVersions)
        .set({ sealedAt: now, sealedReason: "card_generation" })
        .where(and(
          eq(noteVersions.id, version.id),
          eq(noteVersions.workspaceId, context.workspaceId),
          sql`${noteVersions.sealedAt} IS NULL`,
        ));
    }

    const generationEpoch = note.cardGenerationEpoch + 1;
    const [run] = await tx
      .insert(cardGenerationRuns)
      .values({
        workspaceId: context.workspaceId,
        noteId: note.id,
        noteVersionId: version.id,
        requestedBy: context.userId,
        requestIdempotencyKey: input.idempotencyKey,
        generationFingerprint,
        generationEpoch,
        supersedesRunId: note.latestGenerationRunId,
        titleSnapshot: note.title,
        sourceContentHash: version.contentHash,
        blockManifestHash: manifests.blockManifestHash,
        assetManifestHash: manifests.assetManifestHash,
        blockManifest: manifests.blockManifest,
        assetManifest: manifests.assetManifest,
        providerSnapshot: {
          executionMode,
          ...(resolvedProviderName ? { providerName: resolvedProviderName } : {}),
          ...(systemAgentTurnPlatformId ? { platformId: systemAgentTurnPlatformId } : {}),
          capabilityPolicy: "conservative-32k-v1",
          ...(input.oldCardId ? { oldCardId: input.oldCardId } : {}),
          ...(input.feedbackSummary ? { feedbackSummary: input.feedbackSummary } : {}),
        },
        governancePolicyVersion: "workspace-policy-snapshot-v1",
        status: SupervisorRunStatus.QUEUED,
        stage: CardGenerationStage.QUEUED,
        stateVersion: 1,
        nextEventSequence: 2,
        retryable: true,
        requiredUnits: 0,
        completedUnits: 0,
        requiredImages: imageAssetIds.length,
        completedImages: 0,
        sourceCoverageBps: 0,
        imageCoverageBps: imageAssetIds.length === 0 ? 10_000 : 0,
        coverageReport: { measurement: "planned", plannerVersion: null },
      })
      .returning();

    await tx
      .update(notes)
      .set({
        cardGenerationEpoch: generationEpoch,
        latestGenerationRunId: run.id,
        updatedAt: now,
      })
      .where(and(eq(notes.id, note.id), eq(notes.workspaceId, context.workspaceId)));

    // §26 C0/C8：V1 旧 writer 命中探针（sidecar，不阻塞 V1 运行）。
    // C8 Gate 检查观察窗口 hit=0 后方可停写 V1；fast/planned/fallback 为
    // worker 内部路由细分，API 入口统一记 supervisor 命中。
    await recordLegacyWriterHit(tx, {
      runId: run.id,
      workspaceId: context.workspaceId,
      writerKind: "v1_supervisor",
      hitAt: now.toISOString(),
      note: "V1 supervisor run created (C8 probe)",
    });

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: 1,
      stage: CardGenerationStage.SNAPSHOT,
      state: SupervisorRunStatus.QUEUED,
      completed: manifests.blockManifest.length,
      total: manifests.blockManifest.length,
      unit: "blocks",
      messageCode: "source_snapshot_sealed",
      safeDetails: {
        versionNo: version.versionNo,
        blockCount: manifests.blockManifest.length,
        imageCount: imageAssetIds.length,
      },
      createdAt: now,
    });

    // Supervisor Agent v1 路径（计划 §5.1, §5.2）：
    // 创建 prepare unit 和 execute_card_agent_turn job
    const [prepareUnit] = await tx
      .insert(cardGenerationUnits)
      .values({
        workspaceId: context.workspaceId,
        runId: run.id,
        kind: AgentUnitKind.PREPARE,
        level: 0,
        ordinal: 0,
        unitKey: `prepare:${run.generationFingerprint}`,
        required: true,
        inputManifest: {
          density: input.density,
        },
        inputHash: run.generationFingerprint,
        tokenEstimate: 0,
        status: "pending",
        scheduledAt: now,
      })
      .returning();
    await tx
      .insert(jobs)
      .values({
        type: JobType.EXECUTE_CARD_AGENT_TURN,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        payload: {
          noteVersionId: version.id,
          generationRunId: run.id,
          agentUnitId: prepareUnit.id,
          turnNo: 0,
          inputHash: run.generationFingerprint,
          userId: context.userId,
        },
        status: JobStatus.PENDING,
        generationRunId: run.id,
        generationUnitId: prepareUnit.id,
        stage: CardGenerationStage.SNAPSHOT,
        priority: 80,
        resourceClass: JobResourceClass.CARD_FOREGROUND,
        idempotencyKey: `generation-run:${run.id}:prepare:0`,
      })
      .returning();

    await tx
      .update(cardGenerationRuns)
      .set({ updatedAt: now })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ));

    return {
      runId: run.id,
      status: run.status,
      sourceSnapshot: {
        noteVersionId: version.id,
        versionNo: version.versionNo,
        contentHash: version.contentHash,
      },
      canContinueEditing: true,
    };
  });
}

export async function getCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    return run ? toRunView(tx, run) : null;
  });
}

export async function getLatestCardGenerationRun(
  context: { workspaceId: string; userId: string },
  noteVersionId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    const version = await tx.query.noteVersions.findFirst({
      columns: { id: true },
      where: and(
        eq(noteVersions.id, noteVersionId),
        eq(noteVersions.workspaceId, context.workspaceId),
      ),
    });
    if (!version) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }
    const run = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.noteVersionId, noteVersionId),
      ),
      orderBy: [desc(cardGenerationRuns.generationEpoch)],
    });
    return run ? toRunView(tx, run) : null;
  });
}

export async function listCardGenerationEvents(
  context: { workspaceId: string; userId: string },
  runId: string,
  after: number,
) {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    if (!run) return null;
    const rows = await tx.query.cardGenerationEvents.findMany({
      where: and(
        eq(cardGenerationEvents.workspaceId, context.workspaceId),
        eq(cardGenerationEvents.runId, runId),
        sql`${cardGenerationEvents.sequence} > ${after}`,
      ),
      orderBy: [asc(cardGenerationEvents.sequence)],
      limit: 200,
    });
    return {
      items: rows.map((event) => ({
        sequence: event.sequence,
        stage: event.stage,
        state: event.state,
        completed: event.completed,
        total: event.total,
        unit: event.unit,
        messageCode: event.messageCode,
        safeDetails: event.safeDetails,
        createdAt: event.createdAt.toISOString(),
      })),
      nextSequence: rows.at(-1)?.sequence ?? after,
    };
  });
}

/**
 * 列出 Supervisor Agent v1 的 Agent 事件（计划 §9.3，设计 §5.2）。
 *
 * 分页契约（向后兼容）：
 * - 不传 `since`/`limit` 时返回最旧 200 条（与旧行为一致），并补充
 *   `nextCursor`/`hasMore` 两个新字段。
 * - `since` 为 `(createdAt, id)` 复合游标（base64 编码的 `ISO时间:id`），
 *   语义为"返回严格晚于此游标的事件"。
 * - 返回新增 `eventKey`（事件唯一键，前端去重/恢复锚点；旧字段
 *   `messageCode` 保留兼容）、`unitId/parentUnitId/childUnitId`（子代理树）、
 *   `attemptNo/toolVersion/errorCode`，以及可选 `usage`（`includeUsage=1`）。
 */
export async function listCardGenerationAgentEvents(
  context: { workspaceId: string; userId: string },
  runId: string,
  opts: { since?: string; limit?: number; includeUsage?: boolean } = {},
) {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    if (!run) return null;
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 200)));

    const cursor = opts.since ? decodeCursor(opts.since) : null;
    const afterFilter = cursor
      ? or(
          gt(cardGenerationAgentEvents.createdAt, new Date(cursor.timestamp)),
          and(
            eq(cardGenerationAgentEvents.createdAt, new Date(cursor.timestamp)),
            gt(cardGenerationAgentEvents.id, cursor.id),
          ),
        )
      : undefined;

    // 多取一条判断是否还有后续页。
    const rows = await tx.query.cardGenerationAgentEvents.findMany({
      where: and(
        eq(cardGenerationAgentEvents.workspaceId, context.workspaceId),
        eq(cardGenerationAgentEvents.runId, runId),
        afterFilter,
      ),
      orderBy: [
        asc(cardGenerationAgentEvents.createdAt),
        asc(cardGenerationAgentEvents.id),
      ],
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    // 2026-08-11：契约统一——响应字段 events → items（其余端点分页均用 items）
    return {
      items: page.map((event) => {
        const base = {
          id: event.id,
          eventKey: event.eventKey,
          eventType: event.eventType,
          agentRole: event.agentRole,
          turnNo: event.turnNo,
          attemptNo: event.attemptNo,
          toolName: event.toolName,
          toolVersion: event.toolVersion,
          unitId: event.unitId,
          parentUnitId: event.parentUnitId,
          childUnitId: event.childUnitId,
          errorCode: event.errorCode,
          // 兼容旧字段名：现状响应用 messageCode 承载 eventKey。
          messageCode: event.eventKey,
          safePayload: event.safePayload,
          createdAt: event.createdAt.toISOString(),
        };
        if (opts.includeUsage) {
          return { ...base, usage: event.usage };
        }
        return base;
      }),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  });
}

export async function cancelCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, runId),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ))
      .orderBy(asc(jobs.id))
      .for("update");
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);
    const [run] = await tx
      .select()
      .from(cardGenerationRuns)
      .where(and(
        eq(cardGenerationRuns.id, runId),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!run) return null;
    if (!CANCELLABLE_STATUSES.has(run.status)) return toRunView(tx, run);

    const now = new Date();
    const [updated] = await tx
      .update(cardGenerationRuns)
      .set({
        status: SupervisorRunStatus.CANCELLED,
        stage: CardGenerationStage.COMPLETE,
        stateVersion: run.stateVersion + 1,
        nextEventSequence: run.nextEventSequence + 1,
        errorCode: "user_cancelled",
        retryable: false,
        cancelRequestedAt: now,
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.stateVersion, run.stateVersion),
      ))
      .returning();

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: run.nextEventSequence,
      stage: CardGenerationStage.COMPLETE,
      state: SupervisorRunStatus.CANCELLED,
      completed: 0,
      total: 1,
      unit: "run",
      messageCode: "user_cancelled",
      safeDetails: {},
      createdAt: now,
    });

    await tx
      .update(jobs)
      .set({
        status: JobStatus.DEAD,
        lastError: "generation_cancelled",
        leaseToken: null,
        finishedAt: now,
      })
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, run.id),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ));

    await tx
      .update(cardGenerationUnits)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        eq(cardGenerationUnits.runId, run.id),
        sql`${cardGenerationUnits.status} NOT IN ('succeeded', 'cancelled', 'superseded')`,
      ));

    return toRunView(tx, updated);
  });
}

export async function retryCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);
    const [run] = await tx
      .select()
      .from(cardGenerationRuns)
      .where(and(
        eq(cardGenerationRuns.id, runId),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!run) return null;
    if (run.status !== SupervisorRunStatus.NEEDS_ATTENTION || !run.retryable) {
      throw new CardGenerationServiceError("run_not_retryable", 409, "当前任务不可重试");
    }
    // 错误码级兜底：预算耗尽/确定性门禁等明确不可恢复的错误直接拒绝重试，
    // 避免用户点击后再次进入"重试 → 再次失败"的无效循环。
    if (!isRunErrorRetryable(run.errorCode)) {
      throw new CardGenerationServiceError("run_not_retryable", 409, "当前任务不可重试");
    }

    const [note] = await tx
      .select({
        epoch: notes.cardGenerationEpoch,
        latestRunId: notes.latestGenerationRunId,
      })
      .from(notes)
      .where(and(eq(notes.id, run.noteId), eq(notes.workspaceId, context.workspaceId)))
      .for("update");
    if (!note || note.epoch !== run.generationEpoch || note.latestRunId !== run.id) {
      throw new CardGenerationServiceError("stale_generation_epoch", 409, "该任务已被更新请求取代");
    }

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(eq(jobs.workspaceId, context.workspaceId), eq(jobs.status, JobStatus.PENDING)));
    const pendingCount = Number(pendingRows[0]?.count ?? 0);
    assertPendingQuota(pendingCount);

    // Supervisor Agent v1 checkpoint 恢复协议。
    // BUG-104（同 evidence-persist.ts）：drizzle 的 sql 模板把 Date 参数原样
    // 交给 postgres.js，postgres.js 使用 Date.toString() 序列化，产生
    // "Thu Aug 06 2026 ..." 格式而非 ISO 8601，导致 PostgreSQL 无法解析。
    // 必须使用 toISOString() 显式序列化。
    const staleRunningThreshold = new Date(Date.now() - 120_000).toISOString();
    // 检查点丢失回退时，若恢复的 supervisor 已 completed，需清空其 cursor 重新决策。
    let resetCursorForFallback = false;
    let failedAgentUnits = await tx
      .select()
      .from(cardGenerationUnits)
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        eq(cardGenerationUnits.runId, run.id),
        inArray(cardGenerationUnits.status, [
          "terminal_failed",
          "retryable_failed",
          "pending",
          "running",
        ]),
        sql`(
          ${cardGenerationUnits.status} NOT IN ('pending', 'running')
          OR ${cardGenerationUnits.scheduledAt} IS NULL
          OR ${cardGenerationUnits.scheduledAt} < ${staleRunningThreshold}
        )`,
      ))
      .orderBy(
        sql`CASE ${cardGenerationUnits.status}
          WHEN 'terminal_failed' THEN 0
          WHEN 'retryable_failed' THEN 1
          WHEN 'running' THEN 2
          ELSE 3
        END`,
        asc(cardGenerationUnits.ordinal),
      )
      .for("update");

    if (failedAgentUnits.length === 0) {
      // 检查点丢失回退（legacy 数据 / 极端状态）：没有任何 failed/stale checkpoint 存活。
      // 典型场景是历史 run——早期 reconciler 会把 needs_attention run 下的非终态 unit
      // 一律取消，导致 run 是 needs_attention 但 unit 全是 cancelled，重试无检查点。
      // 此时恢复顶层 supervisor unit（kind=agent_run 且无 parent）作为检查点，
      // 让 run 从已完成的 PREPARE 状态重新进入 agent 阶段。
      // 新代码不会再产生这种状态（reconciler 保留 needs_attention 检查点、失败 unit
      // 显式标记 terminal_failed），此回退只用于兜底历史数据。
      const supervisorUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(cardGenerationUnits.workspaceId, context.workspaceId),
          eq(cardGenerationUnits.runId, run.id),
          eq(cardGenerationUnits.kind, AgentUnitKind.AGENT_RUN),
          isNull(cardGenerationUnits.parentUnitId),
        ),
        orderBy: [asc(cardGenerationUnits.ordinal)],
      });
      if (!supervisorUnit) {
        throw new CardGenerationServiceError(
          "generation_checkpoint_missing",
          409,
          "没有可恢复的生成检查点",
        );
      }
      failedAgentUnits = [supervisorUnit];
      // 若该 supervisor 已 succeeded（agent 阶段已走完，run 在 VERIFY/PUBLISH 才失败），
      // 其 session cursor 处于 completed 状态，直接重跑会立刻再次 needs_attention。
      // 清空 cursor 让它从 agent 阶段重新决策（候选/账本从 DB 重建，幂等安全）。
      resetCursorForFallback = supervisorUnit.status === "succeeded";
    }

    const now = new Date();
    const nextStateVersion = run.stateVersion + 1;

    await tx
      .update(cardGenerationUnits)
      .set({
        status: "pending",
        scheduledAt: null,
        finishedAt: null,
        errorCode: null,
        updatedAt: now,
      })
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        inArray(cardGenerationUnits.id, failedAgentUnits.map((u) => u.id)),
      ));

    if (resetCursorForFallback) {
      // 回退恢复的 supervisor 已 completed：清空 session cursor（置空对象，
      // fromDbRow 会重建为初始状态），让其在重跑时从 agent 阶段重新决策。
      await tx
        .update(cardGenerationUnits)
        .set({ cursorJson: {}, updatedAt: now })
        .where(and(
          eq(cardGenerationUnits.workspaceId, context.workspaceId),
          eq(cardGenerationUnits.id, failedAgentUnits[0]!.id),
        ));
    }

    const primaryUnit = failedAgentUnits[0]!;
    await tx
      .insert(jobs)
      .values({
        type: JobType.EXECUTE_CARD_AGENT_TURN,
        workspaceId: context.workspaceId,
        requestedBy: context.userId,
        payload: {
          noteVersionId: run.noteVersionId,
          generationRunId: run.id,
          agentUnitId: primaryUnit.id,
          turnNo: 0,
          inputHash: run.generationFingerprint,
          userId: context.userId,
        },
        status: JobStatus.PENDING,
        generationRunId: run.id,
        generationUnitId: primaryUnit.id,
        stage: CardGenerationStage.SNAPSHOT,
        priority: 80,
        resourceClass: JobResourceClass.CARD_FOREGROUND,
        idempotencyKey: `generation-run:${run.id}:retry:${nextStateVersion}`,
      })
      .returning();

    const [updated] = await tx
      .update(cardGenerationRuns)
      .set({
        status: SupervisorRunStatus.RUNNING,
        stage: CardGenerationStage.SNAPSHOT,
        stateVersion: nextStateVersion,
        nextEventSequence: run.nextEventSequence + 1,
        errorCode: null,
        retryable: true,
        updatedAt: now,
        finishedAt: null,
      })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.stateVersion, run.stateVersion),
      ))
      .returning();

    await tx
      .update(cardGenerationUnits)
      .set({ scheduledAt: now, updatedAt: now })
      .where(and(
        eq(cardGenerationUnits.id, primaryUnit.id),
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
      ));

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: run.nextEventSequence,
      stage: CardGenerationStage.SNAPSHOT,
      state: SupervisorRunStatus.RUNNING,
      completed: 0,
      total: 1,
      unit: "agent_unit",
      messageCode: "supervisor_checkpoint_retry_queued",
      safeDetails: {
        retriedUnitCount: failedAgentUnits.length,
        primaryUnitId: primaryUnit.id,
        primaryUnitKind: primaryUnit.kind,
        engineMode: "supervisor_agent_v1",
      },
      createdAt: now,
    });

    await tx
      .update(cardGenerationRuns)
      .set({ updatedAt: now })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ));

    return toRunView(tx, updated);
  });
}

export async function getGenerationRunStatus(
  context: { workspaceId: string; userId: string },
  runId: string,
) {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    if (!run) return null;
    let fallbackCardId: string | null = run.resultCardId;
    let generatedVersionId: string | null = run.resultCardId ? run.noteVersionId : null;
    if (!fallbackCardId) {
      const [card] = await tx
        .select({ id: learningCards.id, noteVersionId: learningCards.noteVersionId })
        .from(learningCards)
        .innerJoin(noteVersions, eq(noteVersions.id, learningCards.noteVersionId))
        .where(and(
          eq(learningCards.workspaceId, context.workspaceId),
          eq(learningCards.status, "active"),
          eq(noteVersions.noteId, run.noteId),
        ))
        .orderBy(desc(learningCards.createdAt))
        .limit(1);
      fallbackCardId = card?.id ?? null;
      generatedVersionId = card?.noteVersionId ?? null;
    }
    const [latestJob] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, run.id),
      ))
      .orderBy(desc(jobs.scheduledAt))
      .limit(1);
    return {
      state: run.status === SupervisorRunStatus.SUCCEEDED ? "generated" as const : "generating" as const,
      cardId: fallbackCardId,
      jobId: latestJob?.id ?? null,
      generatedVersionId,
      runId: run.id,
    };
  });
}
