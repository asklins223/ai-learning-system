/**
 * QUAL-02/PERF-04 拆分：PREPARE 阶段执行逻辑。
 *
 * 此模块从 card-supervisor-agent.ts 中提取 PREPARE 阶段的完整执行逻辑，
 * 包括 run 详情加载、note blocks 加载、provider capability 构建、
 * executePrepare 调用、evidence 持久化以及 unit/run 状态更新。
 *
 * 确定性阶段，不调用模型。调用 executePrepare 模块执行封存、证据规划、预算冻结。
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  SupervisorRunStatus,
  GenerationExecutionMode,
  isFastPathEnabled,
  isRunInFastBucket,
  isPlannedPathEnabled,
  isRunInPlannedBucket,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import {
  assertJobLease,
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import type { JobPayload } from "../handlers/index.ts";
import { executePrepare } from "./prepare.ts";
import { persistEvidenceAndBundles, persistEvidenceEmbeddings } from "./evidence-persist.ts";
import { appendAgentEvent } from "./specialist-persist.ts";
import { checkIncrementalReuse } from "./incremental-reuse.ts";
import {
  createFastExtractUnit,
  createPlanUnit,
  createSupervisorUnit,
  createNextTurnJob,
} from "./unit-helpers.ts";
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "./types.ts";
import { createProvider, createEmbeddingProvider, type AIProvider } from "../lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderConfigForName, type AIGovernanceContext } from "../lib/governance.ts";
import { buildCapabilityBundle, type CapabilityBundle } from "../lib/capability-bundle.ts";
import { computeComplexityRoute } from "./complexity-router.ts";

/**
 * PREPARE 阶段执行（计划 §5.1, §W3）。
 *
 * 确定性阶段，不调用模型。
 * 调用 executePrepare 模块执行封存、证据规划、预算冻结。
 */
export async function executePreparePhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId },
    "PREPARE 阶段执行",
  );

  await assertJobLease(lease);

  // 加载 run 详细信息
  const [runDetail] = await db
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);

  if (!runDetail) {
    return { kind: "needs_attention", reason: "run 不存在" };
  }

  // 加载 noteVersion 的 blocks（note_blocks 使用 versionId 而非 noteVersionId）
  const blocks = await db
    .select()
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.versionId, runContext.noteVersionId))
    .orderBy(schema.noteBlocks.ordinal);

  // 加载 image evidence units（通过 blocks 的 imageAssetId 关联，note_image_evidence_units 无 noteVersionId 列）
  const imageAssetIds = blocks
    .filter((b) => b.imageAssetId)
    .map((b) => b.imageAssetId!);
  const imageEvidenceUnits = imageAssetIds.length > 0
    ? await db
        .select()
        .from(schema.noteImageEvidenceUnits)
        .where(inArray(schema.noteImageEvidenceUnits.imageAssetId, imageAssetIds))
    : [];

  // P2-1：Complexity Router（先统计不切换）。
  // 依据内容特征确定性判定执行模式，仅落库（execution_mode / routing_reason），
  // 不改变实际执行路径——现状仍走 Full Supervisor。
  // review should-fix:formula 检测排除 code 块(代码中 $VAR/$1 会误判 has_formula)。
  // density 从当前 prepare unit 的 inputManifest 读取(runs 表无 density 列)。
  const [prepareUnitRow] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ))
    .limit(1);
  const requestDensity = ((prepareUnitRow?.inputManifest as Record<string, unknown> | null)?.density as "overview" | "standard" | "complete" | undefined) ?? "standard";
  const routeDecision = computeComplexityRoute({
    density: requestDensity,
    blockCount: blocks.length,
    imageCount: blocks.filter((b) => b.type === "image").length,
    formulaCount: blocks.filter((b) => b.type !== "code" && /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/.test(b.content)).length,
    codeCount: blocks.filter((b) => b.type === "code").length,
    totalChars: blocks.reduce((sum, b) => sum + b.content.length, 0),
  });
  logger.info(
    { runId: payload.generationRunId, mode: routeDecision.mode, routingReason: routeDecision.routingReason },
    "P2-1: Complexity Router 判定完成（只统计不切换）",
  );

  // 构建 provider capability
  // 修复 D4/D6（第5轮）：原代码硬编码 contextWindowTokens=128000 等值，
  // 且引用不存在的 runDetail.providerModel 列。
  // 修复后：优先通过 provider.getCapabilities() 获取，回退到 providerSnapshot 中的信息。
  let prepareProvider: AIProvider | null;
  let resolvedProviderName: string | null = null;
  let govCtxForVision: AIGovernanceContext | null = null;
  try {
    const snap = runDetail.providerSnapshot as Record<string, unknown> ?? {};
    const providerName = (snap.providerName as string) ?? undefined;
    const providerConfig = (snap.config as Record<string, unknown>) ?? undefined;
    if (providerName) {
      resolvedProviderName = providerName.toLowerCase();
      // P1-12: API 层冻结了 providerName，但 providerConfig（含 apiKey 等敏感信息）
      // 仍需从 workspace 治理上下文解析。API 不应处理敏感凭据。
      // 如果 snapshot 中有 config 则直接使用（向后兼容），否则从治理上下文获取 config。
      if (providerConfig && Object.keys(providerConfig).length > 0) {
        prepareProvider = await createProvider(providerName, providerConfig);
        // 即使 snapshot 有 config，也需解析 governance 获取 vision BYOK 配置
        govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
      } else {
        govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
        // 迁移遗漏修复：名字不一致时，治理上下文的 config 属于「当前」provider，不能配 snapshot 名
        //（会跨 provider 混配）。按 snapshot 名重新解析配置。
        if (govCtxForVision.providerName.toLowerCase() !== resolvedProviderName) {
          logger.warn(
            {
              runId: payload.generationRunId,
              snapshotProvider: resolvedProviderName,
              governanceProvider: govCtxForVision.providerName.toLowerCase(),
            },
            "providerSnapshot 与治理上下文不一致，按 snapshot 名重新解析配置",
          );
          prepareProvider = await createProvider(providerName, resolveProviderConfigForName(providerName));
        } else {
          prepareProvider = await createProvider(providerName, govCtxForVision.providerConfig);
        }
      }
    } else {
      // BUG-11 fix: Use resolveAIGovernanceContext instead of resolveProviderSelection
      // to get provider + governance in a single workspace query, ensuring the
      // provider selection is based on the same workspace snapshot as any
      // governance check.
      govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
      resolvedProviderName = govCtxForVision.providerName.toLowerCase();
      prepareProvider = await createProvider(govCtxForVision.providerName, govCtxForVision.providerConfig);
    }
    // R5: CompositeAIProvider removed — multi-platform vision routing is
    // handled by CapabilityBundle (buildCapabilityBundle). The text provider
    // alone is sufficient for executeAgentTurn in the agent flow.
  } catch {
    prepareProvider = null;
  }

  // R2: Try to build a CapabilityBundle from the governance context.
  // If successful, use bundle.capability as the provider capability snapshot.
  // This is preferred over prepareProvider?.getCapabilities?.() because the
  // bundle is built from the factory registry, which is the future path.
  // Falls back to prepareProvider?.getCapabilities?.() if bundle is not available.
  let bundle: CapabilityBundle | undefined;
  if (govCtxForVision) {
    try {
      const built = await buildCapabilityBundle(govCtxForVision);
      bundle = built ?? undefined;
    } catch {
      bundle = undefined;
    }
  }

  // R3 fix: Extract vision provider fingerprint for drift detection.
  // When vision uses a separate platform (different from the text/agent provider),
  // the main provider's fingerprint doesn't cover vision config changes.
  // Store the vision fingerprint in providerSnapshot so RUN phase can verify it.
  const visionFingerprint = bundle?.vision
    ? (bundle.vision as unknown as { getCapabilities?: () => import("@ailearn/shared").ProviderCapability }).getCapabilities?.()?.fingerprint
    : undefined;

  // P0-01 阶段A-4：阻止生产环境使用 Mock provider 发布卡片。
  // Mock provider 会产生劣质内容并通过 fail-open 门禁，
  // 不应在生产环境中作为生成引擎使用。
  // 允许通过 ALLOW_MOCK_IN_PRODUCTION=true 覆盖（如 E2E 测试）。
  if (
    resolvedProviderName === "mock"
    && process.env.NODE_ENV === "production"
    && process.env.ALLOW_MOCK_IN_PRODUCTION !== "true"
  ) {
    logger.error(
      { runId: payload.generationRunId, providerName: resolvedProviderName },
      "Mock provider 被阻止在生产环境中使用",
    );
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: "mock_provider_blocked_in_production",
        retryable: false,
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    });
    return { kind: "needs_attention", reason: "mock_provider_blocked_in_production" };
  }
  // ARCH-03 fix: Use conservative defaults instead of hardcoding 128000.
  // Try to read contextWindowTokens from providerSnapshot.capability if
  // available; otherwise use a safe conservative value (32768) that works
  // for most models. The previous code hardcoded 128000 which is too
  // optimistic for models with smaller context windows (e.g. 32K).
  const snapshotCap = (runDetail.providerSnapshot as Record<string, unknown>)?.capability as Record<string, unknown> | undefined;
  const fallbackContextWindow = (snapshotCap?.contextWindowTokens as number | undefined) ?? 65_536;
  const fallbackReservedOutput = 16_384;
  const providerCapability = bundle?.capability
    ?? prepareProvider?.getCapabilities?.()
    ?? {
    providerId: ((runDetail.providerSnapshot as Record<string, unknown>)?.providerName as string) ?? "unknown",
    modelId: ((runDetail.providerSnapshot as Record<string, unknown>)?.model as string) ?? "unknown",
    visionModelId: ((runDetail.providerSnapshot as Record<string, unknown>)?.visionModel as string) ?? "unknown",
    toolMode: "native_tools" as const,
    contextWindowTokens: fallbackContextWindow,
    reservedOutputTokens: fallbackReservedOutput,
    maxInputTokens: fallbackContextWindow - fallbackReservedOutput,
    maxOutputTokens: 16_384,
    fingerprint: ((runDetail.providerSnapshot as Record<string, unknown>)?.providerName as string) ?? "unknown",
  };

  // 调用 executePrepare
  const prepareResult = executePrepare({
    runId: payload.generationRunId,
    workspaceId: job.workspaceId,
    noteVersionId: runContext.noteVersionId,
    noteTitle: runDetail.titleSnapshot ?? "",
    // density 从 prepare unit 的 inputManifest 读取（requestDensity，105-116 行），
    // 不再用 runs 表不存在的 density 列（恒 "standard" 的旧逻辑）。
    density: requestDensity,
    blocks: blocks.map((b) => ({
      id: b.id,
      ordinal: b.ordinal,
      type: b.type,
      content: b.content ?? "",
    })),
    imageEvidenceUnits: imageEvidenceUnits.map((u) => ({
      id: u.id,
      blockId: (u as Record<string, unknown>).blockId as string ?? "",
      blockOrdinal: 0,
      sectionPath: [],
      sourceHash: (u as Record<string, unknown>).textHash as string ?? "",
      text: u.text ?? "",
      tokenEstimate: 0,
    })),
    providerCapability,
  });

  if (!prepareResult.ok) {
    // PREPARE 失败，标记 needs_attention
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: prepareResult.failureReason ?? "prepare_failed",
        retryable: false,
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    });
    return { kind: "needs_attention", reason: prepareResult.failureReason ?? "prepare_failed" };
  }

  // 持久化 evidence spans 和 source bundles 到 DB（计划 §G2, §9.4）
  // QUAL-17 修复：将 190+ 行持久化逻辑提取到 agent/evidence-persist.ts，
  // 降低主 handler 复杂度，使逻辑可独立测试。
  // 幂等设计：重复执行不会报错（onConflictDoNothing + 回查已有 span）。
  const now = new Date();
  const refMap = await persistEvidenceAndBundles({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    noteVersionId: runContext.noteVersionId,
    evidence: prepareResult.evidence,
    bundlePlan: prepareResult.bundlePlan,
    now,
  });

  // G8 派生索引：为 text_span evidence 生成 embedding（SiliconFlow bge-m3）。
  // 同步生成，失败不阻断 run（embedding 缺失只影响检索质量，不影响 coverage/发布）。
  await persistEvidenceEmbeddings({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    noteVersionId: runContext.noteVersionId,
    evidence: prepareResult.evidence,
    refIdToSpanId: refMap.refIdToSpanId,
    provider: await createEmbeddingProvider(job.requestedBy ?? undefined, govCtxForVision),
    now,
  });

  // 更新 run 和 unit
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    const ts = new Date();

    // 更新 prepare unit 为 succeeded
    await tx.update(schema.cardGenerationUnits).set({
      status: "succeeded",
      finishedAt: ts,
      updatedAt: ts,
      cursorJson: {
        bundleCount: prepareResult.bundlePlan.bundles.length,
        coverageSnapshot: prepareResult.coverageSnapshot,
      },
    }).where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));

    // 更新 run 状态为 running，写入 budget/engine 信息
    // R3 fix: Also store vision fingerprint in providerSnapshot for drift detection.
    const existingSnapshot = (runDetail.providerSnapshot as Record<string, unknown> | null) ?? {};
    // P5-4 接入:Note Version Diff(增量复用数据源;真实版本迭代场景生效,
    // 无上一版本 → hasPrevious=false 走全量路径)
    let incremental: Record<string, unknown> | null = null;
    try {
      const inc = await checkIncrementalReuse(job.workspaceId, payload.generationRunId);
      if (inc.hasPrevious) {
        incremental = inc as unknown as Record<string, unknown>;
        logger.info(
          { runId: payload.generationRunId, changedSpans: inc.changedSpanCount, reuseRatio: inc.reuseRatio },
          "P5: Note 版本增量检查(上一版本存在,可复用未变化 span)",
        );
      }
    } catch (err) {
      // 增量检查失败不阻塞生成(降级全量)
      logger.warn({ err }, "P5: 增量检查失败,降级全量");
    }
    const updatedSnapshot = {
      ...existingSnapshot,
      ...(visionFingerprint ? { visionFingerprint } : {}),
      ...(incremental ? { incremental } : {}),
    };
    await tx.update(schema.cardGenerationRuns).set({
      status: SupervisorRunStatus.RUNNING,
      engineMode: prepareResult.engineInfo.engineMode,
      // P2-1：Router 落库（只统计不切换）——判定结果写入 execution_mode/routing_reason
      executionMode: routeDecision.mode,
      routingReason: routeDecision.routingReason,
      shellVersion: prepareResult.engineInfo.shellVersion,
      supervisorPolicyVersion: prepareResult.engineInfo.supervisorPolicyVersion,
      toolSchemaVersion: prepareResult.engineInfo.toolSchemaVersion,
      plannerVersion: prepareResult.engineInfo.plannerVersion,
      verifierVersion: prepareResult.engineInfo.verifierVersion,
      retrievalPolicyVersion: prepareResult.engineInfo.retrievalPolicyVersion,
      embeddingProfileVersion: prepareResult.engineInfo.embeddingProfileVersion,
      resultContractVersion: prepareResult.engineInfo.resultContractVersion,
      providerCapabilityFingerprint: prepareResult.engineInfo.providerFingerprint,
      ...(visionFingerprint ? { providerSnapshot: updatedSnapshot } : {}),
      budgetSnapshot: prepareResult.budget,
      coverageReport: prepareResult.coverageSnapshot.report,
      updatedAt: ts,
    }).where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ));
  });

  // 创建 Supervisor agent_run unit 和对应的 job
  // R31 修复：传递实际请求的 density，不再在 createSupervisorUnit 中硬编码 "standard"。
  const prepareDensity = requestDensity;

  // P2 接线:Router 判定 fast 且灰度开启 → 创建 FAST_EXTRACT unit(不再走 Full Supervisor)。
  // 默认关闭(fail-closed,§12.2);开启后按 FAST_PATH_ROLLOUT_PERCENT 分桶。
  if (
    routeDecision.mode === GenerationExecutionMode.FAST_TWO_STAGE_V1
    && isFastPathEnabled()
    && isRunInFastBucket(payload.generationRunId)
  ) {
    const fastUnitId = await createFastExtractUnit(job, payload, prepareDensity);
    await createNextTurnJob(job, payload.generationRunId, fastUnitId, 1);
    logger.info(
      { runId: payload.generationRunId, mode: routeDecision.mode, unitId: fastUnitId },
      "P2 接线: Router 分发到 FAST_EXTRACT(Fast 两阶段)",
    );
  } else if (
    routeDecision.mode === GenerationExecutionMode.ADAPTIVE_PLANNED_V1
    && isPlannedPathEnabled()
    && isRunInPlannedBucket(payload.generationRunId)
  ) {
    // P3 接线:Initial Plan 生成(plan 落库);Specialist DAG 调度为后续里程碑
    const planUnitId = await createPlanUnit(job, payload);
    await createNextTurnJob(job, payload.generationRunId, planUnitId, 1);
    logger.info(
      { runId: payload.generationRunId, mode: routeDecision.mode, unitId: planUnitId },
      "P3 接线: Router 分发到 PLAN_GENERATION(Initial Plan)",
    );
  } else {
    const supervisorUnitId = await createSupervisorUnit(job, payload, runContext, prepareDensity);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    logger.info(
      { runId: payload.generationRunId, mode: routeDecision.mode, unitId: supervisorUnitId },
      "P2 接线: 继续 Full Supervisor(灰度关闭或 Router 非 Fast)",
    );
  }

  // 记录 Agent event
  await appendAgentEvent({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    unitId: payload.agentUnitId,
    eventKey: `prepare:complete:${payload.agentUnitId}`,
    eventType: "turn_completed",
    agentRole: null,
    turnNo: 0,
    safePayload: {
      bundleCount: prepareResult.bundlePlan.bundles.length,
      coverage: prepareResult.coverageSnapshot.report,
    },
  });

  return { kind: "continue", nextTurnNo: 1 };
}
