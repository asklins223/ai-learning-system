/**
 * QUAL-02/PERF-04 拆分（第九轮）：AGENT_RUN 阶段上下文加载逻辑。
 *
 * 此模块从 card-supervisor-agent.ts 的 executeAgentRunPhase 中提取
 * 上下文加载步骤（步骤 1-11），包括：
 * - 从数据库加载 unit、run、session、budget
 * - 加载 source bundles 并重建 CoverageLedger
 * - 加载候选和候选证据并重建 CandidateLedger
 * - 加载 agent events、draft、quality report
 * - 构建 provider、runtime 和 context input
 *
 * 提取后 executeAgentRunPhase 专注于角色分发和工具执行，
 * 减少约 380 行代码。
 */

import { and, eq, inArray, desc } from "drizzle-orm";
import {
  AgentRole,
  AgentUnitKind,
  createDefaultRunBudget,
  sanitizeOperationalError,
  BundleAssignmentStatus,
  BundleDecisionStatus,
  CandidateKind,
  CognitiveType,
  CandidateImportance,
  type ProviderCapability,
} from "@ailearn/shared";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { AgentSession } from "./session.ts";
import { BudgetTracker, type BudgetUsage } from "./budget.ts";
import { ContextBuilder, type ContextBuilderInput, type StableContextCacheLike } from "./context-builder.ts";
import { buildAgentExecutionSummary } from "./event-summary.ts";
import { StableContextCache } from "./stable-context-cache.ts";
import {
  CoverageLedger,
  initLedgerFromBundlePlan,
} from "./coverage-ledger.ts";
import { CandidateLedger } from "./candidate-ledger.ts";
import { toolRegistry } from "./tool-registry.ts";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderConfigForName, type AIGovernanceContext } from "../lib/governance.ts";
import { buildCapabilityBundle, type CapabilityBundle } from "../lib/capability-bundle.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";
import type { JobPayload } from "../handlers/index.ts";

// 保留 AgentUnitKind 导入用于类型参考
void AgentUnitKind;

/** 上下文加载结果 */
export interface AgentRunPhaseContext {
  unit: typeof schema.cardGenerationUnits.$inferSelect;
  runDetail: typeof schema.cardGenerationRuns.$inferSelect;
  session: AgentSession;
  budgetTracker: BudgetTracker;
  sourceBundles: typeof schema.cardGenerationSourceBundles.$inferSelect[];
  coverageLedger: CoverageLedger;
  candidateLedger: CandidateLedger;
  latestDraft: typeof schema.cardGenerationDrafts.$inferSelect | null;
  latestReport: typeof schema.cardGenerationQualityReports.$inferSelect | null;
  agentEvents: typeof schema.cardGenerationAgentEvents.$inferSelect[];
  contextBuilder: ContextBuilder;
  provider: AIProvider | null;
  providerCapability: ProviderCapability;
  runtime: import("./runtime.ts").AgentRuntime;
  contextInput: ContextBuilderInput;
  /** Governance context used to build the provider/bundle.
   *  Exposed so downstream code (e.g. embedding provider creation) can reuse
   *  the pre-resolved configuration instead of doing a separate DB query. */
  govCtx: AIGovernanceContext | null;
}

/**
 * P4-1:runId 前缀隔离的稳定上下文缓存适配器(单例;按 runId 自动分区,
 * LRU 有界由 StableContextCache 保障,防跨 run 混用)。
 */
const p4StableCacheSingleton = new StableContextCache(512);
function p4StableContextCacheFor(runId: string): StableContextCacheLike {
  return {
    get(key) {
      return p4StableCacheSingleton.get(`${runId}:${key}`)?.value ?? null;
    },
    set(key, value) {
      p4StableCacheSingleton.set(`${runId}:${key}`, value, `hash-${value.length}`, Date.now());
    },
  };
}

/**
 * PERF-34: 按 runId 缓存稳定上下文适配器 + ContextBuilder（含 ContextPacker）。
 *
 * loadAgentRunPhaseContext 每个 turn 都会新建 ContextBuilder。provider 能力
 * 在 run 内被冻结（providerSnapshot），因此 token 预算/工具 schema 稳定段在
 * run 内不变，ContextBuilder 可安全跨 turn 复用。缓存有界（简单 LRU 淘汰），
 * 防止 worker 长时间运行处理大量 run 时无界增长。
 */
interface P4RunBuilderEntry {
  optionsKey: string;
  adapter: StableContextCacheLike;
  builder: ContextBuilder;
}
const p4RunBuilderCache = new Map<string, P4RunBuilderEntry>();
const P4_RUN_BUILDER_CACHE_MAX = 128;
function p4RunBuilderCacheGet(runId: string): P4RunBuilderEntry | undefined {
  const entry = p4RunBuilderCache.get(runId);
  if (entry) {
    // LRU: 重新插入到末尾
    p4RunBuilderCache.delete(runId);
    p4RunBuilderCache.set(runId, entry);
  }
  return entry;
}
function p4RunBuilderCacheSet(runId: string, entry: P4RunBuilderEntry): void {
  if (p4RunBuilderCache.size >= P4_RUN_BUILDER_CACHE_MAX) {
    const oldest = p4RunBuilderCache.keys().next().value;
    if (oldest !== undefined) p4RunBuilderCache.delete(oldest);
  }
  p4RunBuilderCache.set(runId, entry);
}
/** 获取（或创建）某 run 的稳定缓存适配器 + ContextBuilder，跨 turn 复用。 */
function getOrCreateRunContextBuilder(
  runId: string,
  options: {
    contextWindowTokens: number;
    reservedOutputTokens: number;
    maxOutputTokens: number;
  },
): { adapter: StableContextCacheLike; builder: ContextBuilder } {
  const optionsKey = `${options.contextWindowTokens}:${options.reservedOutputTokens}:${options.maxOutputTokens}`;
  const existing = p4RunBuilderCacheGet(runId);
  if (existing && existing.optionsKey === optionsKey) {
    return { adapter: existing.adapter, builder: existing.builder };
  }
  const adapter = p4StableContextCacheFor(runId);
  const builder = new ContextBuilder(toolRegistry, options, adapter);
  p4RunBuilderCacheSet(runId, { optionsKey, adapter, builder });
  return { adapter, builder };
}

/**
 * 加载 AGENT_RUN 阶段所需的全部上下文。
 *
 * 包括从数据库重建 AgentSession、BudgetTracker、CoverageLedger、
 * CandidateLedger，以及构建 provider、runtime 和 context input。
 *
 * 返回 null 表示应中止执行（unit 不存在、run 不存在或预算耗尽）。
 * 返回 "needs_attention" 字符串表示需要标记为 needs_attention。
 */
export async function loadAgentRunPhaseContext(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
): Promise<AgentRunPhaseContext | { abort: true; reason: string } | null> {
  const role = runContext.agentRole ?? "generation_supervisor";

  // PERF-13 修复：并行加载 unit 和 run 信息（两者无数据依赖关系）
  const [unitResult, runResult] = await Promise.all([
    db
      .select()
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ))
      .limit(1),
    db
      .select()
      .from(schema.cardGenerationRuns)
      .where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ))
      .limit(1),
  ]);
  const unit = unitResult[0];
  if (!unit) {
    return null;
  }
  const runDetail = runResult[0];
  if (!runDetail) {
    return null;
  }

  // 2. 从 DB 重建 AgentSession
  const session = AgentSession.fromDbRow({
    id: unit.id,
    runId: unit.runId,
    inputManifest: (unit.inputManifest as Record<string, unknown>) ?? {},
    cursorJson: (unit.cursorJson as Record<string, unknown>) ?? null,
    usageJson: (unit.usageJson as Record<string, unknown>) ?? null,
    attempts: unit.attempts ?? 0,
    status: unit.status,
  });

  // 3. 构建 BudgetTracker
  const budgetTracker = new BudgetTracker(
    runDetail.budgetSnapshot ?? createDefaultRunBudget(),
  );

  // 恢复已有的使用量（从 run 的 usage_summary 中恢复）
  // 修复前：每次 turn 重新创建 BudgetTracker，usage 从零开始，
  // 导致已用 provider calls 和 token 不被计入，可能超出 hard cap。
  if (runDetail.usageSummary) {
    budgetTracker.restoreUsage(runDetail.usageSummary as Partial<BudgetUsage>);
  }

  // 检查预算和截止时间
  if (budgetTracker.isDeadlineExceeded()) {
    return { abort: true, reason: "budget_exhausted" };
  }
  if (!budgetTracker.canMakeProviderCall()) {
    return { abort: true, reason: "budget_exhausted" };
  }

  // PERF-27: 将相互独立的 DB 加载并行化（source bundles / candidates / agent
  // events / latest draft / 子任务 / 已完成子任务），减少每个 turn 的串行往返。
  const [sourceBundles, candidates, agentEvents, latestDraft, childUnits, completedChildUnits] = await Promise.all([
    db
      .select()
      .from(schema.cardGenerationSourceBundles)
      .where(and(
        eq(schema.cardGenerationSourceBundles.runId, payload.generationRunId),
        eq(schema.cardGenerationSourceBundles.workspaceId, job.workspaceId),
      ))
      .orderBy(schema.cardGenerationSourceBundles.bundleOrdinal),
    db
      .select()
      .from(schema.cardGenerationCandidates)
      .where(and(
        eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
        eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
      )),
    db
      .select()
      .from(schema.cardGenerationAgentEvents)
      .where(and(
        eq(schema.cardGenerationAgentEvents.runId, payload.generationRunId),
        eq(schema.cardGenerationAgentEvents.workspaceId, job.workspaceId),
      ))
      .orderBy(schema.cardGenerationAgentEvents.createdAt)
      .limit(200),
    db
      .select()
      .from(schema.cardGenerationDrafts)
      .where(and(
        eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
        eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
      ))
      .orderBy(desc(schema.cardGenerationDrafts.draftVersion))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: schema.cardGenerationUnits.id,
        status: schema.cardGenerationUnits.status,
        inputManifest: schema.cardGenerationUnits.inputManifest,
      })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.runId, payload.generationRunId),
        eq(schema.cardGenerationUnits.parentUnitId, payload.agentUnitId),
        inArray(schema.cardGenerationUnits.status, ["pending", "waiting_child", "running"]),
      )),
    db
      .select({
        id: schema.cardGenerationUnits.id,
        status: schema.cardGenerationUnits.status,
        inputManifest: schema.cardGenerationUnits.inputManifest,
        artifactHash: schema.cardGenerationUnits.artifactHash,
      })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.runId, payload.generationRunId),
        eq(schema.cardGenerationUnits.parentUnitId, payload.agentUnitId),
        eq(schema.cardGenerationUnits.status, "succeeded"),
      ))
      .orderBy(desc(schema.cardGenerationUnits.updatedAt))
      .limit(30),
  ]);

  // 重建 CoverageLedger
  const coverageLedger = new CoverageLedger();
  initLedgerFromBundlePlan(coverageLedger, sourceBundles.map((b) => ({
    bundleId: b.bundleKey,
    ordinal: b.bundleOrdinal,
    required: b.required,
  })));
  // 恢复分配和决策状态
  for (const b of sourceBundles) {
    if (b.assignmentStatus && b.assignmentStatus !== "pending") {
      coverageLedger.updateAssignment(b.bundleKey, b.assignmentStatus as BundleAssignmentStatus, b.assignedAgentUnitId);
    }
    if (b.decisionStatus && b.decisionStatus !== "pending") {
      coverageLedger.updateDecision(b.bundleKey, b.decisionStatus as BundleDecisionStatus, b.decisionReason);
    }
  }

  // QUAL-33 修复：从 DB 恢复每 bundle 的持久化候选计数
  // 替代 R28 中的硬编码 candidateCount=1 方案，使用实际持久化的值
  for (const b of sourceBundles) {
    if (b.candidateCount > 0) {
      coverageLedger.updateCandidateCount(b.bundleKey, b.candidateCount);
    }
  }

  // 5. 加载候选 ledger —— candidates 已在上方并行批次中加载。

  // R17 修复：从 card_generation_candidate_evidence 表加载候选的证据引用
  //（依赖 candidates）与 Quality Report（依赖 latestDraft）并行加载。
  const candidateIds = candidates.map((c) => c.id);
  const [candidateEvidenceRows, latestReport] = await Promise.all([
    candidateIds.length > 0
      ? db
          .select({
            candidateId: schema.cardGenerationCandidateEvidence.candidateId,
            evidenceSpanId: schema.cardGenerationCandidateEvidence.evidenceSpanId,
            imageEvidenceUnitId: schema.cardGenerationCandidateEvidence.imageEvidenceUnitId,
            sourceKind: schema.cardGenerationCandidateEvidence.sourceKind,
            ordinal: schema.cardGenerationCandidateEvidence.ordinal,
          })
          .from(schema.cardGenerationCandidateEvidence)
          .where(and(
            eq(schema.cardGenerationCandidateEvidence.workspaceId, job.workspaceId),
            eq(schema.cardGenerationCandidateEvidence.runId, payload.generationRunId),
            inArray(schema.cardGenerationCandidateEvidence.candidateId, candidateIds),
          ))
          .orderBy(schema.cardGenerationCandidateEvidence.ordinal)
      : Promise.resolve([]),
    latestDraft
      ? db
          .select()
          .from(schema.cardGenerationQualityReports)
          .where(and(
            eq(schema.cardGenerationQualityReports.draftId, latestDraft.id),
            eq(schema.cardGenerationQualityReports.workspaceId, job.workspaceId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  // 构建候选 ID 到 evidenceRefIds 的映射
  const candidateEvidenceMap = new Map<string, string[]>();
  for (const ce of candidateEvidenceRows) {
    const refId = ce.evidenceSpanId ?? ce.imageEvidenceUnitId;
    if (refId) {
      const existing = candidateEvidenceMap.get(ce.candidateId) ?? [];
      existing.push(refId);
      candidateEvidenceMap.set(ce.candidateId, existing);
    }
  }

  const candidateLedger = new CandidateLedger();
  candidateLedger.init(candidates.map((c) => ({
    candidateId: c.id,
    candidateKind: c.candidateKind as CandidateKind ?? "extracted",
    bundleId: ((c as Record<string, unknown>).bundleId as string | null) ?? null,
    claim: c.claim ?? "",
    topic: c.topic ?? "",
    cognitiveType: c.cognitiveType as CognitiveType ?? "concept",
    importance: c.importance as CandidateImportance ?? "supporting",
    sectionKey: c.sectionKey ?? "",
    evidenceRefIds: candidateEvidenceMap.get(c.id) ?? [],
    validationStatus: c.validationStatus ?? "pending",
    originUnitId: c.unitId ?? "",
    // P1-14 fix: must read actual DB values, not hardcode null/[].
    // Hardcoding causes hash mismatch between Critic (in-memory ledger) and
    // VERIFY (DB-computed hash) when candidates have been excluded or have
    // derived candidate IDs from merge/split operations.
    exclusionReason: c.exclusionReason ?? null,
    groupKey: (c.groupKey as string) ?? null,
    derivedCandidateIds: (c.derivedCandidateIds as string[]) ?? [],
  })));

  // Agent events / latestDraft / latestReport 已在上方 PERF-27 并行批次中加载。

  // 9-10. 构建 provider 和 runtime（先创建 provider，再创建 context builder）
  // P1-12 修复：后续 turn 只能重建同一 provider 快照；配置变化只影响新 run。
  // providerSnapshot 在 PREPARE 阶段冻结，后续 turn 必须使用同一快照。
  let provider: AIProvider | null;
  let govCtxForVision: AIGovernanceContext | null = null;
  try {
    const snap = runDetail.providerSnapshot as Record<string, unknown> ?? {};
    const providerName = (snap.providerName as string) ?? undefined;
    const providerConfig = (snap.config as Record<string, unknown>) ?? undefined;
    if (providerName) {
      // P1-12: API 层冻结了 providerName，但 providerConfig（含 apiKey 等敏感信息）
      // 仍需从 workspace 治理上下文解析。如果 snapshot 中有 config 则直接使用，
      // 否则从治理上下文获取 config，但始终使用 snapshot 冻结的 providerName。
      if (providerConfig && Object.keys(providerConfig).length > 0) {
        provider = await createProvider(providerName, providerConfig);
        // 即使 snapshot 有 config，也需解析 governance 获取 vision 平台配置
        govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
      } else {
        govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
        if (govCtxForVision.providerName.toLowerCase() !== providerName.toLowerCase()) {
          // 迁移遗漏修复：治理上下文解析出的 config 属于「当前」provider，不能配 snapshot 名
          //（会跨 provider 混配，如用 dashscope 的 baseUrl 建 openai_compatible）。
          // 名字不一致时按 snapshot 名重新解析配置；解析不到时 createProvider 会抛错中止。
          logger.warn(
            {
              runId: payload.generationRunId,
              snapshotProvider: providerName,
              governanceProvider: govCtxForVision.providerName.toLowerCase(),
            },
            "providerSnapshot 与治理上下文不一致，按 snapshot 名重新解析配置",
          );
          provider = await createProvider(providerName, resolveProviderConfigForName(providerName));
        } else {
          provider = await createProvider(providerName, govCtxForVision.providerConfig);
        }
      }
    } else {
      // P1-12 修复：providerSnapshot 缺失 providerName 是数据完整性问题。
      // 记录警告并回退到当前 workspace 配置（仅向后兼容）。
      logger.warn(
        { runId: payload.generationRunId, hasSnapshot: !!runDetail.providerSnapshot },
        "providerSnapshot 缺失 providerName，回退到 workspace 配置（可能导致 provider 不一致）",
      );
      govCtxForVision = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy ?? null);
      provider = await createProvider(govCtxForVision.providerName, govCtxForVision.providerConfig);
    }
    // R5: CompositeAIProvider removed — multi-platform vision routing is
    // handled by CapabilityBundle (buildCapabilityBundle).
  } catch (err) {
    logger.error(
      { runId: payload.generationRunId, error: sanitizeOperationalError(err) },
      "无法获取 provider",
    );
    return { abort: true, reason: "provider_unavailable" };
  }

  // P1-12 修复：验证 provider capability fingerprint 一致性。
  // 如果 run 已冻结 fingerprint，后续 turn 必须使用同一 fingerprint。
  const expectedFingerprint = runDetail.providerCapabilityFingerprint;
  if (expectedFingerprint && provider) {
    const actualFingerprint = provider.getCapabilities?.()?.fingerprint;
    if (actualFingerprint && actualFingerprint !== expectedFingerprint) {
      logger.error(
        {
          runId: payload.generationRunId,
          expectedFingerprint,
          actualFingerprint,
        },
        "Provider fingerprint 不匹配：run 冻结的快照与当前 provider 不一致",
      );
      return { abort: true, reason: "provider_fingerprint_mismatch" };
    }
  }

  // B1-B3 迁移遗漏修复：平台漂移告警（仅 warning，不中止）。
  // run 创建时冻结的系统 agent_turn 配置平台 ID 与当前 config/ai-platforms.json 不一致时，
  // 说明配置平台在 run 创建后被切换（provider type 可能没变，但平台实例/baseUrl 变了）。
  // 仅当 snapshot 的 providerName 类型与当前配置平台类型一致时检查（个人/workspace 用
  // 不同类型覆盖时跳过，避免误报）。
  const snapPlatformId = (runDetail.providerSnapshot as Record<string, unknown> | null)?.platformId as string | undefined;
  const snapshotProviderName = (runDetail.providerSnapshot as Record<string, unknown> | null)?.providerName as string | undefined;
  if (snapPlatformId && snapshotProviderName) {
    const currentAgentTurnPlatform = resolveSystemPlatform("agent_turn");
    if (
      currentAgentTurnPlatform
      && currentAgentTurnPlatform.type.toLowerCase() === snapshotProviderName.toLowerCase()
      && currentAgentTurnPlatform.platformId
      && currentAgentTurnPlatform.platformId !== snapPlatformId
    ) {
      logger.warn(
        {
          runId: payload.generationRunId,
          snapshotPlatformId: snapPlatformId,
          currentPlatformId: currentAgentTurnPlatform.platformId,
        },
        "agent_turn 配置平台已变化：run 冻结的 platformId 与当前 config/ai-platforms.json 不一致（provider type 未变但平台实例切换）",
      );
    }
  }

  // R49 修复：使用 provider 的 capability 而非硬编码 toolMode
  const providerCapability = provider?.getCapabilities?.() ?? {
    providerId: ((runDetail.providerSnapshot as Record<string, unknown>)?.providerName as string) ?? "unknown",
    modelId: ((runDetail.providerSnapshot as Record<string, unknown>)?.model as string) ?? "unknown",
    visionModelId: ((runDetail.providerSnapshot as Record<string, unknown>)?.visionModel as string) ?? "unknown",
    toolMode: "native_tools" as const,
    contextWindowTokens: 65_536,
    reservedOutputTokens: 16_384,
    maxInputTokens: 49_152,
    maxOutputTokens: 16_384,
    fingerprint: ((runDetail.providerSnapshot as Record<string, unknown>)?.providerName as string) ?? "unknown",
  };

  // 使用 provider 实际 capability 构建 context builder（而非从 providerSnapshot 读取不存在的字段）
  // P4-1 接线:注入稳定上下文缓存(runId 前缀隔离;工具 schema 稳定段跨 turn 复用,
  // 不再每 turn 重建;key 维度含 runId+role,与 stableContextCacheKey 语义一致)
  // PERF-34:跨 turn 复用 run 级 ContextBuilder/ContextPacker，避免每 turn 重建。
  const { builder: contextBuilder } = getOrCreateRunContextBuilder(payload.generationRunId, {
    contextWindowTokens: providerCapability.contextWindowTokens,
    reservedOutputTokens: providerCapability.reservedOutputTokens,
    maxOutputTokens: providerCapability.maxOutputTokens,
  });

  const { AgentRuntime } = await import("./runtime.ts");

  // R5: Build a CapabilityBundle from the governance context.
  // bundle is the sole path for AgentRuntime — the provider field has been removed.
  // The bundle enables capability-specific routing (agent_turn, text_generation, vision).
  let bundle: CapabilityBundle | undefined;
  if (govCtxForVision) {
    try {
      const built = await buildCapabilityBundle(govCtxForVision);
      bundle = built ?? undefined;
    } catch {
      // Fall back to old provider path
      bundle = undefined;
    }
  }

  // R3 fix: Verify vision provider fingerprint when vision uses a separate platform.
  // The main provider's fingerprint includes its own visionModelId, but when the
  // bundle's vision provider is on a different platform, the main fingerprint
  // doesn't cover vision config changes. This check catches vision-only drift
  // (e.g. system vision platform config changed between PREPARE and RUN).
  if (bundle && expectedFingerprint) {
    const snap = runDetail.providerSnapshot as Record<string, unknown> | null;
    const expectedVisionFingerprint = snap?.visionFingerprint as string | undefined;
    if (expectedVisionFingerprint) {
      const visionCap = (bundle.vision as unknown as { getCapabilities?: () => ProviderCapability }).getCapabilities?.();
      const actualVisionFingerprint = visionCap?.fingerprint;
      if (actualVisionFingerprint && actualVisionFingerprint !== expectedVisionFingerprint) {
        logger.error(
          {
            runId: payload.generationRunId,
            expectedVisionFingerprint,
            actualVisionFingerprint,
          },
          "Vision provider fingerprint 不匹配：run 冻结的 vision 快照与当前 vision provider 不一致",
        );
        return { abort: true, reason: "provider_fingerprint_mismatch" };
      }
    }
  }

  if (!provider) {
    logger.error(
      { runId: payload.generationRunId },
      "provider is null after resolution — aborting",
    );
    return { abort: true, reason: "provider_unavailable" };
  }

  // R5: bundle is the sole path for AgentRuntime — provider field has been removed.
  // If bundle construction failed, we cannot create an AgentRuntime.
  if (!bundle) {
    logger.error(
      { runId: payload.generationRunId },
      "CapabilityBundle is null after resolution — aborting",
    );
    return { abort: true, reason: "provider_unavailable" };
  }

  const runtime = new AgentRuntime({
    bundle,
    toolMode: providerCapability.toolMode,
    maxTransportRetries: 3,
    // P1-09: 传入 contextWindowTokens 用于请求级 Token Hard Check
    contextWindowTokens: providerCapability.contextWindowTokens,
  });

  // 11. 构建 context input
  // R45/R46/R47/R48 修复：从 DB 加载 hard issues、pending tasks、task results 和 card count
  const hardIssuesFromReport = latestReport
    ? ((latestReport.hardIssues as Array<Record<string, unknown>>) ?? []).map((h) => ({
        code: String(h.code ?? "unknown"),
        candidateId: h.candidateId ? String(h.candidateId) : undefined,
        patchable: Boolean(h.patchable ?? false),
      }))
    : [];

  // R46: 子任务状态已在上方 PERF-27 并行批次中加载（childUnits）。
  const pendingTasksFromDb = childUnits.map((u) => ({
    taskId: u.id,
    role: (((u.inputManifest as Record<string, unknown>)?.agentRole as string) ?? "unknown") as AgentRole,
  }));

  // R48: 已完成的子任务摘要已在上方 PERF-27 并行批次中加载（completedChildUnits）。
  const taskResultsFromDb = completedChildUnits.map((u) => ({
    taskId: u.id,
    role: (((u.inputManifest as Record<string, unknown>)?.agentRole as string) ?? "unknown") as AgentRole,
    status: u.status,
    outputHash: u.artifactHash ?? null,
    outputSummary: null as Record<string, unknown> | null,
    errorCode: null,
  }));

  // R47: 从 draft contentJson 计算实际 card count
  const draftCardCount = latestDraft
    ? ((latestDraft.contentJson as Record<string, unknown>)?.cards as unknown[])?.length ?? 0
    : 0;

  const coverageSnapshot = coverageLedger.getSnapshot();
  // P4-5:Agent 事件摘要条目(events 原始列表与 executionSummary 共用)
  const eventSummaryEntries = agentEvents.map((e) => ({
    eventType: e.eventType,
    agentRole: e.agentRole,
    turnNo: e.turnNo,
    toolName: e.toolName,
    safeDetails: (e.safePayload as Record<string, unknown>) ?? {},
    createdAt: e.createdAt?.toISOString() ?? "",
  }));
  const contextInput = {
    role: role as AgentRole,
    manifest: {
      noteTitle: runDetail.titleSnapshot ?? "",
      density: ((unit.inputManifest as Record<string, unknown>)?.density as "overview" | "standard" | "complete") ?? "standard",
      budgetSummary: {
        providerCallsUsed: budgetTracker.getUsage().providerCalls,
        providerCallsMax: budgetTracker.getBudget().maxProviderCalls,
        turnsUsed: session.getState().turnNo,
        // 预算口径（2026-08-04）：角色级 maxTurns 仅常量保留、不作执行检查，
        // 此字段仅作为信息展示给模型参考，不是硬限制（见 plan §9-1）。
        turnsMax: budgetTracker.getBudget().roles[role as AgentRole]?.maxTurns ?? 16,
        deadline: budgetTracker.getBudget().runDeadline,
      },
      coverageSummary: {
        bundlesAssigned: coverageSnapshot.assignedBundles,
        bundlesDecided: coverageSnapshot.decidedBundles,
        bundlesRequired: coverageSnapshot.requiredBundles,
        candidatesExtracted: coverageSnapshot.totalCandidates,
        candidatesCanonical: coverageSnapshot.canonicalCandidates,
      },
      sourceSummary: {
        totalBlocks: sourceBundles.length,
        totalImages: 0,
        totalTokens: sourceBundles.reduce((sum, b) => sum + (b.tokenEstimate ?? 0), 0),
      },
    },
    candidates: candidateLedger.getActiveCandidates().map((c) => ({
      candidateId: c.candidateId,
      claim: c.claim,
      topic: c.topic,
      importance: c.importance,
      cognitiveType: c.cognitiveType,
      sectionKey: c.sectionKey,
      candidateKind: c.candidateKind,
      evidenceRefIds: c.evidenceRefIds,
      validationStatus: c.validationStatus,
    })),
    taskResults: taskResultsFromDb,
    // P4-5 接线:同一批 events 同时生成原始列表与聚合摘要,
    // 模型上下文默认加载摘要,诊断时按需读原始(审计缺口修复)
    events: eventSummaryEntries,
    executionSummary: buildAgentExecutionSummary(eventSummaryEntries),
    draft: latestDraft
      ? {
          draftVersion: latestDraft.draftVersion,
          contentHash: latestDraft.contentHash,
          deckTitle: latestDraft.deckTitle,
          deckSummary: latestDraft.deckSummary,
          density: latestDraft.density,
          cardCount: draftCardCount,
        }
      : null,
    qualityReport: latestReport
      ? {
          draftHash: latestReport.draftHash,
          criticStatus: latestReport.criticStatus,
          deterministicStatus: latestReport.deterministicStatus,
          hardIssueCount: (latestReport.hardIssues as unknown[])?.length ?? 0,
          softIssueCount: (latestReport.softIssues as unknown[])?.length ?? 0,
        }
      : null,
    hardIssues: hardIssuesFromReport,
    pendingTasks: pendingTasksFromDb,
  };

  return {
    unit,
    runDetail,
    session,
    budgetTracker,
    sourceBundles,
    coverageLedger,
    candidateLedger,
    latestDraft,
    latestReport,
    agentEvents,
    contextBuilder,
    provider,
    providerCapability,
    runtime,
    contextInput,
    govCtx: govCtxForVision,
  };
}
