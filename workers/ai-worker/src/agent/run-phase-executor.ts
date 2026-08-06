/**
 * A1 拆分（计划 §2.1）：executeAgentRunPhase 巨型函数拆分为 5 个独立函数。
 *
 * 拆分后的函数（共享 TurnExecutionContext 类型）：
 * - buildTurnContext: 上下文装配（对应原 :393-417）
 * - executeProviderCall: 角色分发 + provider 调用（一次 attempt 最多一次 provider 请求）
 * - processToolResults: 工具副作用执行 + 幂等（对应原 :1438-1478）
 * - persistTurnResult: 会话/usage/事件事务持久化（对应原 :1519-1558）
 * - scheduleNextTurn: 下一 turn 调度（对应原 :1561-1650）
 *
 * 约束：纯机械拆分，不改变任何执行语义。
 * 保留四条原子性约束：
 * ① 一次 attempt 最多一次 provider 请求
 * ② 工具副作用以 toolCallId 幂等
 * ③ lease fence 覆盖所有写事务
 * ④ waiting_child CAS 语义不变
 *
 * 无函数超过 300 行。
 */

import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { hashJson } from "../lib/card-generation-pipeline-utils.ts";
import {
  AgentRole,
  sanitizeOperationalError,
  RunBudget,
  type QualityReport,
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
import {
  executeSupervisorTurn,
  shouldContinueLoop,
} from "./roles/supervisor-loop.ts";
import { executeExtractorTurn } from "./roles/text-extractor.ts";
import { executeDeckComposerTurn } from "./roles/deck-composer.ts";
import { executeCriticTurn, type CriticConfig } from "./critic.ts";
import { executeRepairTurn } from "./repair.ts";
import {
  splitBundlesIntoPages,
  splitCandidatesIntoBatches,
  isInputOverContextErrorMessage,
  type ExtractorBundle,
  type CriticCandidateEntry,
} from "./durable-pagination.ts";
import { executeToolCall, type ToolExecutionContext, type ToolCallRequest } from "./tools/executor.ts";
import { scheduleCriticForDraft } from "./tools/quality.ts";
import { autoProgressAfterChildUnit } from "./pipeline-auto-progress.ts";
import type { EvidenceEmbeddingProvider } from "./tools/evidence.ts";
import type { RerankProvider } from "./reranker.ts";
import { createEmbeddingProvider } from "../lib/ai-provider.ts";
import { maybeReThrowRetryableProviderError } from "./runtime.ts";
import {
  appendAgentEvent,
  loadAssignedBundles,
  persistQualityReport,
  persistExtractionResults,
  persistRepairPatches,
  resumeParentSupervisorIfNeeded,
  reconcileStuckSupervisors,
} from "./specialist-persist.ts";
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "./types.ts";
import {
  persistSessionState,
  createVerifyUnit,
  createNextTurnJob,
} from "./unit-helpers.ts";
import { loadAgentRunPhaseContext, type AgentRunPhaseContext } from "./run-phase-context.ts";
import { maybeInjectSupervisorAutoFallback } from "./supervisor-auto-fallback.ts";

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/** 统一 turn outcome 结构（从各角色执行器返回） */
interface UnifiedTurnOutcome {
  state: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  content: string | null;
  nextAction: string;
  error?: string;
}

/**
 * TurnExecutionContext：贯穿拆分后 5 个函数的共享上下文类型。
 *
 * 由 buildTurnContext 创建，后续函数读取和扩展其中的字段。
 * outcome 字段在 executeProviderCall 后填充。
 * childTaskIds / verification* 字段在 processToolResults 后填充。
 */
export interface TurnExecutionContext {
  job: JobPayload;
  payload: AgentJobPayload;
  runContext: Extract<RunContext, { kind: "active" }>;
  lease: JobLeaseContext;
  role: string;
  phaseCtx: AgentRunPhaseContext;
  outcome: UnifiedTurnOutcome;
  childTaskIds: string[];
  verificationRequested: boolean;
  verificationSucceeded: boolean;
}

/** executeProviderCall 的返回类型 */
type ProviderCallResult =
  | { kind: "outcome"; outcome: UnifiedTurnOutcome }
  | { kind: "needs_attention"; reason: string };

// ─── countConsecutiveReadOnlySupervisorTurns（从 card-supervisor-agent.ts 迁移） ──

/**
 * 计算 Supervisor 连续"只读工具自旋"的 turn 数（P1-15 修复，根因 A）。
 *
 * 定义：一个 turn 若只调用了只读工具（无副作用）且不产生推进
 * （未提交 draft、未请求 critic/verify、未 apply 操作、未委派），
 * 视为自旋 turn。从当前 turn 往前数连续的自旋 turn 数。
 *
 * 用途：达到阈值（≥3）时触发 auto-fallback 的场景 C，
 * 强制推进状态机，避免模型反复 read_candidate_ledger 直到预算耗尽。
 *
 * @param agentEvents 本 run 已加载的 agent events（不含当前 turn 的 tool_request）
 * @param currentTurnNo 当前 turn 编号
 * @param currentTurnToolCalls 当前 turn 模型提议的工具调用（尚未执行）
 */
export function countConsecutiveReadOnlySupervisorTurns(
  agentEvents: Array<{ turnNo: number | null; toolName: string | null; eventType: string; agentRole: string | null }>,
  currentTurnNo: number,
  currentTurnToolCalls: Array<{ name: string }>,
): number {
  const readOnlyTools = new Set([
    "get_run_manifest",
    "read_agent_task_results",
    "search_related_evidence",
    "read_candidate_ledger",
    "read_quality_report",
    "validate_draft",
  ]);

  const toolsByTurn = new Map<number, Set<string>>();
  for (const ev of agentEvents) {
    if (ev.agentRole !== "generation_supervisor" || ev.eventType !== "tool_request" || !ev.toolName || ev.turnNo == null) {
      continue;
    }
    if (!toolsByTurn.has(ev.turnNo)) {
      toolsByTurn.set(ev.turnNo, new Set());
    }
    toolsByTurn.get(ev.turnNo)!.add(ev.toolName);
  }

  if (currentTurnToolCalls.length > 0) {
    if (!toolsByTurn.has(currentTurnNo)) {
      toolsByTurn.set(currentTurnNo, new Set());
    }
    for (const tc of currentTurnToolCalls) {
      toolsByTurn.get(currentTurnNo)!.add(tc.name);
    }
  }

  let consecutive = 0;
  let turn = currentTurnNo;
  while (turn >= 1) {
    const tools = toolsByTurn.get(turn);
    if (!tools || tools.size === 0) break;
    let allReadOnly = true;
    for (const name of tools) {
      if (!readOnlyTools.has(name)) {
        allReadOnly = false;
        break;
      }
    }
    if (!allReadOnly) break;
    consecutive += 1;
    turn -= 1;
  }
  return consecutive;
}

// ─── 1. buildTurnContext ──────────────────────────────────────────────────

/**
 * 上下文装配（对应原 :378-417）。
 *
 * 加载 AGENT_RUN 阶段所需的全部上下文（unit、run、session、budget、ledgers 等），
 * 构建 TurnExecutionContext 供后续函数使用。
 *
 * 返回 null 表示应返回 needs_attention（unit/run 不存在）。
 * 返回 { earlyReturn } 表示应直接返回该结果。
 */
export async function buildTurnContext(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<TurnExecutionContext | { earlyReturn: AgentTurnExecutionResult }> {
  const role = runContext.agentRole ?? "generation_supervisor";

  logger.info(
    {
      runId: payload.generationRunId,
      unitId: payload.agentUnitId,
      turnNo: payload.turnNo,
      role,
    },
    "AGENT_RUN 阶段执行",
  );

  await assertJobLease(lease);

  const ctx = await loadAgentRunPhaseContext(job, payload, runContext);
  if (!ctx) {
    return { earlyReturn: { kind: "needs_attention", reason: "agent unit 或 run 不存在" } };
  }
  if ("abort" in ctx) {
    return { earlyReturn: { kind: "needs_attention", reason: ctx.reason } };
  }

  return {
    job,
    payload,
    runContext,
    lease,
    role,
    phaseCtx: ctx,
    outcome: undefined as unknown as UnifiedTurnOutcome,
    childTaskIds: [],
    verificationRequested: false,
    verificationSucceeded: false,
  };
}

// ─── 2. executeProviderCall ───────────────────────────────────────────────

/**
 * 角色分发 + provider 调用（对应原 :420-1377）。
 *
 * 按 role 分发到对应的角色执行器，封装"一次 attempt 最多一次 provider 请求"。
 * 可重试 provider 错误（502/429/408/5xx）re-throw（:1370 语义）。
 * 非 retryable 错误持久化 session 后返回 needs_attention。
 */
export async function executeProviderCall(
  turnCtx: TurnExecutionContext,
): Promise<ProviderCallResult> {
  const { role, payload, job, phaseCtx } = turnCtx;
  const { session } = phaseCtx;

  try {
    let outcome: UnifiedTurnOutcome;

    if (role === "generation_supervisor") {
      outcome = await executeSupervisorProviderCall(turnCtx);
    } else if (role === "text_extractor" || role === "code_extractor" || role === "vision_specialist") {
      outcome = await executeExtractorProviderCall(turnCtx);
    } else if (role === "deck_composer") {
      outcome = await executeDeckComposerProviderCall(turnCtx);
    } else if (role === "grounding_critic") {
      outcome = await executeCriticProviderCall(turnCtx);
    } else if (role === "repairer") {
      outcome = await executeRepairerProviderCall(turnCtx);
    } else {
      logger.error({ runId: payload.generationRunId, role }, "未知 Agent 角色");
      return { kind: "needs_attention", reason: `unknown_role: ${role}` };
    }

    return { kind: "outcome", outcome };
  } catch (err) {
    logger.error(
      { runId: payload.generationRunId, error: sanitizeOperationalError(err) },
      "Agent turn 执行失败",
    );
    maybeReThrowRetryableProviderError(err);
    await persistSessionState(job, payload, session, turnCtx.lease);
    return {
      kind: "needs_attention",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 2a. executeSupervisorProviderCall ────────────────────────────────────

/** Supervisor 角色的 provider 调用（对应原 :444-539）。 */
async function executeSupervisorProviderCall(turnCtx: TurnExecutionContext): Promise<UnifiedTurnOutcome> {
  const { payload, job, runContext, phaseCtx } = turnCtx;
  const { session, budgetTracker, contextBuilder, coverageLedger, candidateLedger,
    latestDraft, latestReport, runDetail, providerCapability, runtime, contextInput } = phaseCtx;

  // R44 修复：从 DB 加载 repairCount
  const repairUnitKey = `agent:repairer:${payload.generationRunId}`;
  const [existingRepairUnit] = await db
    .select({ id: schema.cardGenerationUnits.id })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.unitKey, repairUnitKey),
    ))
    .limit(1);
  const persistedRepairCount = existingRepairUnit ? 1 : 0;

  const supervisorCtx = {
    runtime,
    session,
    budgetTracker,
    contextBuilder,
    coverageLedger,
    candidateLedger,
    state: "init" as const,
    turnNo: payload.turnNo,
    delegatedTaskIds: [],
    completedTaskIds: [],
    currentDraftHash: latestDraft?.contentHash ?? null,
    criticReportHash: null,
    repairCount: persistedRepairCount,
  };

  const supervisorConfig = {
    runId: payload.generationRunId,
    agentUnitId: payload.agentUnitId,
    workspaceId: job.workspaceId,
    noteVersionId: runContext.noteVersionId,
    noteTitle: runDetail.titleSnapshot ?? "",
    density: ((runDetail as Record<string, unknown>).density ?? "standard") as "overview" | "standard" | "complete",
    budget: budgetTracker.getBudget() as RunBudget,
    providerCapability,
  };

  if (!shouldContinueLoop(supervisorCtx, budgetTracker)) {
    await persistSessionState(job, payload, session, turnCtx.lease);
    return { state: "needs_attention", toolCalls: [], content: null, nextAction: "needs_attention", error: "budget_exhausted" };
  }

  const supOutcome = await executeSupervisorTurn(
    supervisorCtx,
    supervisorConfig,
    contextInput,
    job.signal,
  );
  let outcome: UnifiedTurnOutcome = {
    state: supOutcome.state,
    toolCalls: supOutcome.toolCalls,
    content: supOutcome.content,
    nextAction: supOutcome.nextAction,
    error: supOutcome.error,
  };

  outcome = await maybeInjectSupervisorAutoFallback({
    payload,
    workspaceId: job.workspaceId,
    candidateLedger,
    coverageLedger,
    latestDraft: latestDraft ? {
      id: latestDraft.id,
      contentHash: latestDraft.contentHash,
      draftVersion: latestDraft.draftVersion,
    } : null,
    latestReport: latestReport ? {
      criticStatus: latestReport.criticStatus,
      deterministicStatus: latestReport.deterministicStatus,
    } : null,
    runDetail: {
      titleSnapshot: runDetail.titleSnapshot ?? null,
      density: (runDetail as Record<string, unknown>).density as string | null ?? "standard",
    },
    spinInfo: {
      consecutiveReadOnlyTurns: countConsecutiveReadOnlySupervisorTurns(
        phaseCtx.agentEvents,
        payload.turnNo,
        outcome.toolCalls,
      ),
    },
    outcome,
  });

  return outcome;
}

// ─── 2b. executeExtractorProviderCall ─────────────────────────────────────

/** Extractor 角色的 provider 调用（对应原 :540-763）。 */
async function executeExtractorProviderCall(turnCtx: TurnExecutionContext): Promise<UnifiedTurnOutcome> {
  const { payload, job, phaseCtx, role } = turnCtx;
  const { session, budgetTracker, contextBuilder, unit, providerCapability, runtime } = phaseCtx;

  const extractorConfig = {
    runId: payload.generationRunId,
    agentUnitId: payload.agentUnitId,
    role: role as AgentRole,
    bundleIds: [],
  };

  const inputManifest = (unit.inputManifest as Record<string, unknown>) ?? {};
  const assignedBundleIds = (inputManifest.bundleIds as string[]) ?? [];

  const assignedBundles = await loadAssignedBundles(
    payload.generationRunId,
    job.workspaceId,
    assignedBundleIds,
  );

  const extOutcome = await executeExtractorTurn(
    runtime, session, budgetTracker, contextBuilder,
    extractorConfig, assignedBundles, job.signal,
  );

  // P1-08: Durable Pagination
  let allCandidates = extOutcome.candidates;
  let allNoCandidates = extOutcome.noCandidates;
  let extractorError = extOutcome.error;
  let extractorState = extOutcome.state;

  if (extOutcome.state === "failed" && isInputOverContextErrorMessage(extOutcome.error)) {
    logger.info(
      { runId: payload.generationRunId, unitId: payload.agentUnitId, role, bundleCount: assignedBundles.length, originalError: extOutcome.error },
      "P1-08: Extractor 触发 input_over_context，启动 durable pagination",
    );

    const availableTokens = providerCapability.contextWindowTokens - 2_048 - providerCapability.maxOutputTokens;
    const maxTokensPerPage = Math.max(2_000, Math.floor(availableTokens * 0.6));
    const pages = splitBundlesIntoPages(assignedBundles as ExtractorBundle[], maxTokensPerPage);

    logger.info(
      { runId: payload.generationRunId, unitId: payload.agentUnitId, originalBundleCount: assignedBundles.length, pageCount: pages.length, maxTokensPerPage },
      "P1-08: Extractor bundles 已分页，开始逐页执行",
    );

    allCandidates = [];
    allNoCandidates = [];
    extractorError = undefined;
    extractorState = "completed";

    for (const page of pages) {
      if (job.signal?.aborted) { extractorState = "failed"; extractorError = "aborted"; break; }
      if (!budgetTracker.canMakeProviderCall()) {
        logger.warn({ runId: payload.generationRunId, pageIndex: page.pageIndex, totalPages: page.totalPages }, "P1-08: 预算耗尽，Extractor 分页中断");
        extractorState = "failed"; extractorError = "budget_exhausted_during_pagination"; break;
      }

      const pageOutcome = await executeExtractorTurn(
        runtime, session, budgetTracker, contextBuilder,
        extractorConfig, page.bundles, job.signal,
      );

      if (pageOutcome.state === "failed") {
        logger.warn({ runId: payload.generationRunId, pageIndex: page.pageIndex, totalPages: page.totalPages, error: pageOutcome.error }, "P1-08: Extractor 单页执行失败，继续其他页");
        if (!isInputOverContextErrorMessage(pageOutcome.error)) { extractorState = "failed"; extractorError = pageOutcome.error; break; }
        logger.error({ runId: payload.generationRunId, pageIndex: page.pageIndex, bundleIds: page.bundles.map((b) => b.bundleId) }, "P1-08: 单页仍 over-context，单个 bundle 太大，跳过该页");
        extractorState = "failed";
        extractorError = `single_bundle_over_context: ${page.bundles.map((b) => b.bundleId).join(",")}`;
        continue;
      }

      allCandidates.push(...pageOutcome.candidates);
      allNoCandidates.push(...pageOutcome.noCandidates);

      await appendAgentEvent({
        workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
        eventKey: `pagination:${payload.agentUnitId}:${payload.turnNo}:page_${page.pageIndex}`,
        eventType: "pagination_event", agentRole: role, turnNo: payload.turnNo,
        toolName: "record_extraction_decisions",
        safePayload: { pageIndex: page.pageIndex, totalPages: page.totalPages, bundleCount: page.bundles.length, candidateCount: pageOutcome.candidates.length, noCandidateCount: pageOutcome.noCandidates.length },
      });
    }
  }

  const hasExtractionResults = allCandidates.length > 0 || allNoCandidates.length > 0;

  if (hasExtractionResults) {
    await persistExtractionResults(
      job.workspaceId, payload.generationRunId, payload.agentUnitId,
      turnCtx.runContext.noteVersionId, allCandidates, allNoCandidates, assignedBundleIds,
    );
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:record_extraction_decisions`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "record_extraction_decisions",
      safePayload: {
        success: true, candidateCount: allCandidates.length, noCandidateCount: allNoCandidates.length,
        autoGenerated: allCandidates.some((c) => c.localId.startsWith("auto-")),
        paginated: allCandidates.length > 0 || allNoCandidates.length > 0
          ? (extOutcome.state === "failed" && isInputOverContextErrorMessage(extOutcome.error)) : false,
      },
    });
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:complete_agent_task`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "complete_agent_task",
      safePayload: { success: true, autoCompleted: true, reason: "extraction_decisions_recorded" },
    });
    session.complete();
  }

  return {
    state: (hasExtractionResults || extractorState === "completed") ? "completed" : extractorState,
    toolCalls: [], content: null,
    nextAction: (hasExtractionResults || extractorState === "completed") ? "complete" : "continue",
    error: extractorError,
  };
}

// ─── 2c. executeDeckComposerProviderCall ──────────────────────────────────

/** Deck Composer 角色的 provider 调用（对应原 :764-863）。 */
async function executeDeckComposerProviderCall(turnCtx: TurnExecutionContext): Promise<UnifiedTurnOutcome> {
  const { payload, job, phaseCtx, role } = turnCtx;
  const { session, budgetTracker, contextBuilder, runDetail, candidateLedger, runtime } = phaseCtx;

  const composerDensity = ((runDetail as Record<string, unknown>).density ?? "standard") as "overview" | "standard" | "complete";
  const composerConfig = {
    runId: payload.generationRunId,
    agentUnitId: payload.agentUnitId,
    density: composerDensity,
    cardBudget: composerDensity === "overview" ? 10 : composerDensity === "complete" ? 40 : 20,
  };

  const candidateSummary = JSON.stringify(
    candidateLedger.getActiveCandidates().map((c) => ({
      id: c.candidateId, claim: c.claim, importance: c.importance, cognitiveType: c.cognitiveType,
    })),
  );

  const composerOutcome = await executeDeckComposerTurn(
    runtime, session, budgetTracker, contextBuilder,
    composerConfig, candidateSummary, job.signal,
  );

  const effectiveProposal = composerOutcome.proposal;

  if (effectiveProposal) {
    await db.update(schema.cardGenerationUnits).set({
      artifactJson: effectiveProposal as unknown as Record<string, unknown>,
      artifactHash: createHash("sha256").update(JSON.stringify(effectiveProposal), "utf8").digest("hex"),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:submit_deck_proposal`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "submit_deck_proposal",
      safePayload: { success: true, cardCount: effectiveProposal.cards.length, deckTitle: effectiveProposal.deckTitle, autoGenerated: !composerOutcome.proposal },
    });
  }

  const hasComposerResult = !!effectiveProposal;
  if (hasComposerResult && composerOutcome.state !== "completed") {
    session.complete();
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:complete_agent_task`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "complete_agent_task",
      safePayload: { success: true, autoCompleted: true, reason: "proposal_submitted" },
    });
  }

  return {
    state: (hasComposerResult || composerOutcome.state === "completed") ? "completed" : composerOutcome.state,
    toolCalls: [], content: null,
    nextAction: (hasComposerResult || composerOutcome.state === "completed") ? "complete" : "continue",
    error: composerOutcome.error,
  };
}

// ─── 2d. executeCriticProviderCall ────────────────────────────────────────

/** Critic 角色的 provider 调用（对应原 :864-1258）。 */
async function executeCriticProviderCall(turnCtx: TurnExecutionContext): Promise<UnifiedTurnOutcome> {
  const { payload, job, runContext, phaseCtx, role } = turnCtx;
  const { session, budgetTracker, contextBuilder, unit, candidateLedger, sourceBundles,
    latestDraft, providerCapability, runtime } = phaseCtx;

  const inputManifest = (unit.inputManifest as Record<string, unknown>) ?? {};
  const taskSpec = (inputManifest.taskSpec as Record<string, unknown>) ?? {};
  const draftHash = String(taskSpec.draftHash ?? latestDraft?.contentHash ?? "");

  const sourceLedgerHash = hashJson(sourceBundles.map((b) => ({
    bundleKey: b.bundleKey, inputHash: b.inputHash, decisionStatus: b.decisionStatus,
  })));

  const criticConfig: CriticConfig = {
    runId: payload.generationRunId, agentUnitId: payload.agentUnitId,
    draftHash, candidatePoolHash: candidateLedger.getHash(), sourceLedgerHash,
  };

  const criticDraft = latestDraft;
  const draftContent = criticDraft ? JSON.stringify(criticDraft.contentJson) : "{}";
  const candidatesContent = JSON.stringify(candidateLedger.getActiveCandidates());

  // 加载文本证据（R44 修复：移除 .limit(100) 截断）
  const evidenceRows = await db
    .select({ span: schema.noteEvidenceSpans, block: schema.noteBlocks })
    .from(schema.noteEvidenceSpans)
    .innerJoin(schema.noteBlocks, eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id))
    .where(and(
      eq(schema.noteEvidenceSpans.workspaceId, job.workspaceId),
      eq(schema.noteEvidenceSpans.noteVersionId, runContext.noteVersionId),
    ));

  // R66 修复：加载图片证据
  const imageBlockAssetIds = (await db
    .select({ imageAssetId: schema.noteBlocks.imageAssetId })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.versionId, runContext.noteVersionId)))
    .map((b) => b.imageAssetId)
    .filter((id): id is string => id !== null);

  const imageEvidenceRows = imageBlockAssetIds.length > 0
    ? await db.select().from(schema.noteImageEvidenceUnits)
        .where(and(
          eq(schema.noteImageEvidenceUnits.workspaceId, job.workspaceId),
          inArray(schema.noteImageEvidenceUnits.imageAssetId, imageBlockAssetIds),
        ))
    : [];

  const textEvidence = evidenceRows.map((row) => {
    const span = row.span;
    const block = row.block;
    const blockContent = block.content ?? "";
    const recoveredText = blockContent.slice(span.charStart, span.charEnd);
    const recoveredHash = createHash("sha256").update(recoveredText, "utf8").digest("hex");
    if (recoveredText && span.textHash && recoveredHash !== span.textHash) {
      logger.warn({ spanId: span.id, unitKey: span.unitKey, expected: span.textHash, actual: recoveredHash }, "Critic evidence textHash 验证失败");
      return { refId: span.id, text: span.unitKey ?? "[hash_mismatch]", unitKey: span.unitKey, sourceKind: "text_span" };
    }
    return { refId: span.id, text: recoveredText || span.unitKey, unitKey: span.unitKey, sourceKind: "text_span" };
  });

  const imageEvidence = imageEvidenceRows.map((img) => ({
    refId: img.id, text: img.text ?? img.unitKey ?? "", unitKey: img.unitKey, sourceKind: "image_evidence",
  }));

  const evidenceContent = JSON.stringify([...textEvidence, ...imageEvidence]);

  const criticOutcome = await executeCriticTurn(
    runtime, session, budgetTracker, contextBuilder,
    criticConfig, draftContent, candidatesContent, evidenceContent, job.signal,
  );

  // P1-08: Durable Pagination for Critic
  let effectiveReport: QualityReport | null = criticOutcome.report;
  let criticError: string | undefined = criticOutcome.error;
  let criticState: "running" | "completed" | "failed" = criticOutcome.state;

  if (criticOutcome.state === "failed" && isInputOverContextErrorMessage(criticOutcome.error)) {
    const paginationResult = await executeCriticPagination(
      turnCtx, criticConfig, draftContent, draftHash, sourceLedgerHash,
      textEvidence, imageEvidence, providerCapability,
    );
    effectiveReport = paginationResult.effectiveReport;
    criticError = paginationResult.criticError;
    criticState = paginationResult.criticState;
  }

  if (effectiveReport && criticDraft) {
    await persistQualityReport(job.workspaceId, payload.generationRunId, criticDraft.id, effectiveReport);
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:submit_quality_report`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "submit_quality_report",
      safePayload: {
        success: true, criticStatus: effectiveReport.criticStatus,
        hardIssueCount: effectiveReport.hardIssues?.length ?? 0,
        softIssueCount: effectiveReport.softIssues?.length ?? 0,
        autoGenerated: !criticOutcome.report && !!effectiveReport,
      },
    });
  }

  const hasCriticResult = !!effectiveReport;
  if (hasCriticResult && criticState !== "completed") {
    session.complete();
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:complete_agent_task`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "complete_agent_task",
      safePayload: { success: true, autoCompleted: true, reason: "quality_report_submitted" },
    });
  }

  return {
    state: (hasCriticResult || criticState === "completed") ? "completed" : criticState,
    toolCalls: [], content: null,
    nextAction: (hasCriticResult || criticState === "completed") ? "complete" : "continue",
    error: criticError,
  };
}

// ─── 2d-i. executeCriticPagination（Critic 分页辅助） ─────────────────────

/** Critic durable pagination（对应原 :992-1195）。 */
async function executeCriticPagination(
  turnCtx: TurnExecutionContext,
  criticConfig: CriticConfig,
  draftContent: string,
  draftHash: string,
  sourceLedgerHash: string,
  textEvidence: Array<{ refId: string; text: string; unitKey: string; sourceKind: string }>,
  imageEvidence: Array<{ refId: string; text: string; unitKey: string; sourceKind: string }>,
  providerCapability: { contextWindowTokens: number; maxOutputTokens: number },
): Promise<{
  effectiveReport: QualityReport | null;
  criticError: string | undefined;
  criticState: "running" | "completed" | "failed";
}> {
  const { payload, job, role, phaseCtx } = turnCtx;
  const { session, budgetTracker, contextBuilder, candidateLedger, runtime } = phaseCtx;

  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId, draftHash, originalError: "input_over_context" },
    "P1-08: Critic 触发 input_over_context，启动 durable pagination",
  );

  const activeCandidates = candidateLedger.getActiveCandidates();
  const candidateEntries: CriticCandidateEntry[] = activeCandidates.map((c) => ({
    candidateId: c.candidateId, claim: c.claim, topic: c.topic,
    cognitiveType: c.cognitiveType, importance: c.importance,
    bundleId: c.bundleId, evidenceRefIds: c.evidenceRefIds,
  }));

  const availableTokens = providerCapability.contextWindowTokens - 2_048 - providerCapability.maxOutputTokens;
  const maxTokensPerBatch = Math.max(2_000, Math.floor(availableTokens * 0.4));
  const batches = splitCandidatesIntoBatches(candidateEntries, maxTokensPerBatch);

  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId, candidateCount: candidateEntries.length, batchCount: batches.length, maxTokensPerBatch },
    "P1-08: Critic candidates 已分批，开始逐批审查",
  );

  const allVerdicts: Array<{ candidateId: string; verdict: string; supportingEvidenceRefIds: string[]; reasonCode: string }> = [];
  const allHardIssues: Array<Record<string, unknown>> = [];
  const allSoftIssues: Array<Record<string, unknown>> = [];
  let allBatchesPassed = true;
  let criticError: string | undefined = undefined;
  let criticState: "running" | "completed" | "failed" = "completed";

  for (const batch of batches) {
    if (job.signal?.aborted) { criticState = "failed"; criticError = "aborted"; break; }
    if (!budgetTracker.canMakeProviderCall()) {
      logger.warn({ runId: payload.generationRunId, batchIndex: batch.batchIndex, totalBatches: batch.totalBatches }, "P1-08: 预算耗尽，Critic 分批中断");
      criticState = "failed"; criticError = "budget_exhausted_during_pagination"; break;
    }

    const batchCandidatesContent = JSON.stringify(batch.candidates);
    const batchEvidenceRefIds = new Set(batch.candidates.flatMap((c) => c.evidenceRefIds));
    const allEvidence = [...textEvidence, ...imageEvidence];
    const batchEvidenceContent = JSON.stringify(allEvidence.filter((e) => batchEvidenceRefIds.has(e.refId)));

    const batchOutcome = await executeCriticTurn(
      runtime, session, budgetTracker, contextBuilder,
      criticConfig, draftContent, batchCandidatesContent, batchEvidenceContent, job.signal,
    );

    if (batchOutcome.state === "failed") {
      logger.warn({ runId: payload.generationRunId, batchIndex: batch.batchIndex, totalBatches: batch.totalBatches, error: batchOutcome.error }, "P1-08: Critic 单批执行失败");
      if (!isInputOverContextErrorMessage(batchOutcome.error)) { criticState = "failed"; criticError = batchOutcome.error; break; }
      allBatchesPassed = false; continue;
    }

    if (batchOutcome.report) {
      allVerdicts.push(...batchOutcome.report.perClaimVerdicts);
      allHardIssues.push(...(batchOutcome.report.hardIssues as unknown[] as Record<string, unknown>[]));
      allSoftIssues.push(...(batchOutcome.report.softIssues as unknown[] as Record<string, unknown>[]));
      if (batchOutcome.report.criticStatus !== "passed") { allBatchesPassed = false; }
    } else {
      allBatchesPassed = false;
    }

    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `pagination:${payload.agentUnitId}:${payload.turnNo}:batch_${batch.batchIndex}`,
      eventType: "pagination_event", agentRole: role, turnNo: payload.turnNo,
      toolName: "submit_quality_report",
      safePayload: { batchIndex: batch.batchIndex, totalBatches: batch.totalBatches, candidateCount: batch.candidates.length, verdictCount: batchOutcome.report?.perClaimVerdicts.length ?? 0 },
    });
  }

  let effectiveReport: QualityReport | null;
  if (allVerdicts.length > 0) {
    const draftCandidateIds = candidateEntries.map((c) => c.candidateId);
    const verdictCandidateIds = new Set(allVerdicts.map((v) => v.candidateId));
    const missingVerdicts = draftCandidateIds.filter((id) => !verdictCandidateIds.has(id));

    if (missingVerdicts.length > 0) {
      for (const missingId of missingVerdicts) {
        allVerdicts.push({ candidateId: missingId, verdict: "unsupported", supportingEvidenceRefIds: [], reasonCode: "missing_verdict_in_pagination" });
      }
      allHardIssues.push({ code: "missing_verdict_in_pagination", severity: "hard", evidenceRefIds: [], patchable: false });
      allBatchesPassed = false;
    }

    effectiveReport = {
      draftHash, candidatePoolHash: candidateLedger.getHash(), sourceLedgerHash,
      criticVersion: "critic-v1", verifierVersion: "verifier-v1",
      hardIssues: allHardIssues as never, softIssues: allSoftIssues as never,
      perClaimVerdicts: allVerdicts as never,
      metrics: { paginated: true, batchCount: batches.length },
      criticStatus: allBatchesPassed && allHardIssues.length === 0 ? "passed" : "failed",
      deterministicStatus: "pending" as const,
    };
  } else {
    effectiveReport = null;
    criticState = "failed";
    criticError = "all_critic_batches_failed";
  }

  return { effectiveReport, criticError, criticState };
}

// ─── 2e. executeRepairerProviderCall ──────────────────────────────────────

/** Repairer 角色的 provider 调用（对应原 :1259-1344）。 */
async function executeRepairerProviderCall(turnCtx: TurnExecutionContext): Promise<UnifiedTurnOutcome> {
  const { payload, job, phaseCtx, role } = turnCtx;
  const { session, budgetTracker, contextBuilder, unit, latestDraft, latestReport, candidateLedger, runtime } = phaseCtx;

  const inputManifest = (unit.inputManifest as Record<string, unknown>) ?? {};
  const taskSpec = (inputManifest.taskSpec as Record<string, unknown>) ?? {};
  const draftHash = String(taskSpec.draftHash ?? latestDraft?.contentHash ?? "");
  const issueIds = (taskSpec.issueIds as string[]) ?? [];

  const repairConfig = {
    runId: payload.generationRunId, agentUnitId: payload.agentUnitId,
    draftHash, issueIds, repairCount: 0,
  };

  const repairDraft = latestDraft;
  const draftContent = repairDraft
    ? (repairDraft.contentJson as Record<string, unknown> ?? {})
    : null;

  // 把完整 hard issues（含 candidateId/cardDraftId）传给 Repairer，而不是只有 issue IDs。
  // 原实现只传 JSON.stringify(issueIds)，Repairer 拿不到"哪个卡片/哪个候选"的定位信息，
  // 只能反复调用 read_issues 空转。现在从 quality report 取出完整 issues 内联给模型。
  const allHardIssues = latestReport
    ? ((latestReport.hardIssues as unknown as Array<Record<string, unknown>>) ?? [])
    : [];
  const requestedIssues = issueIds.length > 0
    ? allHardIssues.filter((i) => issueIds.includes(String(i.code)))
    : allHardIssues;

  // 把 draft 引用的候选 claims 内联给 Repairer（atomicity_violation 需要改写成原子 claim）。
  const draftCandidateIds = new Set<string>();
  if (draftContent) {
    const cards = Array.isArray(draftContent.cards) ? (draftContent.cards as Array<Record<string, unknown>>) : [];
    for (const card of cards) {
      const ids = Array.isArray(card.candidateIds) ? (card.candidateIds as string[]) : [];
      for (const id of ids) draftCandidateIds.add(id);
    }
  }
  const candidates = candidateLedger
    ? candidateLedger.getAllCandidates()
        .filter((c) => draftCandidateIds.has(c.candidateId))
        .map((c) => ({
          candidateId: c.candidateId,
          claim: c.claim,
          topic: c.topic,
          cognitiveType: c.cognitiveType,
          importance: c.importance,
          sectionKey: c.sectionKey,
        }))
    : [];

  const repairOutcome = await executeRepairTurn(
    runtime, session, budgetTracker, contextBuilder,
    repairConfig,
    { issues: requestedIssues, draft: draftContent, candidates },
    job.signal,
  );

  if (repairOutcome.patches.length > 0 && repairDraft) {
    await persistRepairPatches(
      job.workspaceId, payload.generationRunId, payload.agentUnitId,
      repairOutcome.patches, repairDraft.id,
    );
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:submit_draft_patch`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "submit_draft_patch",
      safePayload: { success: true, patchCount: repairOutcome.patches.length },
    });
  }

  const hasRepairResult = repairOutcome.patches.length > 0;
  if (hasRepairResult && repairOutcome.state !== "completed") {
    session.complete();
    await appendAgentEvent({
      workspaceId: job.workspaceId, runId: payload.generationRunId, unitId: payload.agentUnitId,
      eventKey: `tool_result:${payload.agentUnitId}:${payload.turnNo}:complete_agent_task`,
      eventType: "tool_result", agentRole: role, turnNo: payload.turnNo,
      toolName: "complete_agent_task",
      safePayload: { success: true, autoCompleted: true, reason: "patches_submitted" },
    });
  }

  return {
    state: (hasRepairResult || repairOutcome.state === "completed") ? "completed" : repairOutcome.state,
    toolCalls: [], content: null,
    nextAction: (hasRepairResult || repairOutcome.state === "completed") ? "complete" : "continue",
    error: repairOutcome.error,
  };
}

// ─── 3. processToolResults ────────────────────────────────────────────────

/**
 * 工具副作用执行 + 幂等（对应原 :1379-1511）。
 *
 * 在事务外逐个执行 Supervisor 返回的 tool calls。
 * 权限验证、幂等检查（toolCallId 唯一键）、执行副作用、记录事件。
 */
export async function processToolResults(turnCtx: TurnExecutionContext): Promise<void> {
  const { job, payload, runContext, phaseCtx, role, outcome } = turnCtx;
  const { budgetTracker, coverageLedger, candidateLedger, provider, govCtx } = phaseCtx;

  const toolExecCtx: ToolExecutionContext = {
    runId: payload.generationRunId,
    workspaceId: job.workspaceId,
    noteVersionId: runContext.noteVersionId,
    noteId: runContext.noteId,
    agentUnitId: payload.agentUnitId,
    turnNo: payload.turnNo,
    role: role as AgentRole,
    budgetTracker,
    coverageLedger,
    candidateLedger,
    requestedBy: job.requestedBy ?? "system",
    signal: job.signal,
    ...(await (async () => {
      const EVIDENCE_TOOLS = new Set(["search_related_evidence", "ensure_semantic_index"]);
      const needsEvidence = outcome.toolCalls.some((tc) => EVIDENCE_TOOLS.has(tc.name));
      if (!needsEvidence) return {};

      const standalone = await createEmbeddingProvider(job.requestedBy ?? undefined, govCtx);
      const embeddingProvider = standalone
        ? standalone as unknown as EvidenceEmbeddingProvider
        : (provider && typeof (provider as unknown as Record<string, unknown>).embed === "function"
          ? provider as unknown as EvidenceEmbeddingProvider
          : undefined);

      const rerankProvider = standalone
        && typeof (standalone as unknown as Record<string, unknown>).rerank === "function"
        ? standalone as unknown as RerankProvider
        : undefined;

      return { embeddingProvider, rerankProvider };
    })()),
  };

  const childTaskIds: string[] = [];
  let verificationRequested = false;
  let verificationSucceeded = false;
  // P1-1：本 turn 是否由系统自动创建了 Critic(需强制 wait_for_children)
  let autoCreatedCritic = false;

  for (const toolCall of outcome.toolCalls) {
    const toolRequest: ToolCallRequest = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments as Record<string, unknown>,
    };

    const toolResult = await executeToolCall(toolRequest, toolExecCtx);

    if (toolCall.name === "delegate_specialist" && toolResult.success) {
      const result = toolResult.result as { childTaskId?: string } | null;
      if (result?.childTaskId) childTaskIds.push(result.childTaskId);
    }
    // P1-1：Draft Created → 系统自动创建 Critic Unit。
    // 不再依赖模型在下一 turn 调用 request_grounding_review。
    // scheduleCriticForDraft 幂等：模型后续/auto-fallback 重复请求会命中已存在 unit。
    if (toolCall.name === "submit_deck_draft" && toolResult.success) {
      const result = toolResult.result as { draftId?: string; contentHash?: string } | null;
      if (result?.draftId && result?.contentHash) {
        const scheduled = await scheduleCriticForDraft({
          workspaceId: job.workspaceId,
          runId: payload.generationRunId,
          agentUnitId: payload.agentUnitId,
          requestedBy: job.requestedBy ?? "system",
          draftId: result.draftId,
          draftHash: result.contentHash,
          budgetTracker,
        });
        if (scheduled && !scheduled.alreadyCompleted) {
          childTaskIds.push(scheduled.criticTaskId);
          autoCreatedCritic = true;
          logger.info(
            { runId: payload.generationRunId, draftId: result.draftId, criticTaskId: scheduled.criticTaskId },
            "P1-1: submit_deck_draft 成功后系统自动创建 Critic",
          );
        }
      }
    }
    if (toolCall.name === "request_grounding_review" && toolResult.success) {
      const result = toolResult.result as { criticTaskId?: string; alreadyCompleted?: boolean } | null;
      if (result?.criticTaskId && !result.alreadyCompleted) childTaskIds.push(result.criticTaskId);
    }
    if (toolCall.name === "request_repair" && toolResult.success) {
      const result = toolResult.result as { repairTaskId?: string } | null;
      if (result?.repairTaskId) childTaskIds.push(result.repairTaskId);
    }
    if (toolCall.name === "request_verification") {
      verificationRequested = true;
      if (toolResult.success) verificationSucceeded = true;
    }
  }

  // R19 修复：request_verification 失败时不进入 VERIFY
  if (verificationRequested && !verificationSucceeded) {
    logger.warn(
      { runId: payload.generationRunId, turnNo: payload.turnNo },
      "request_verification 工具执行失败，Supervisor 继续循环而非进入 VERIFY",
    );
    outcome.nextAction = "continue";
  }

  // P0-06 修复：wait_for_children 但无子任务时继续循环
  if (outcome.nextAction === "wait_for_children" && childTaskIds.length === 0) {
    logger.warn(
      { runId: payload.generationRunId, turnNo: payload.turnNo, toolCallCount: outcome.toolCalls.length },
      "Supervisor 试图等待子任务但无子任务被创建（工具执行可能失败），继续循环",
    );
    outcome.nextAction = "continue";
  }

  // P1-1：submit_deck_draft 成功且系统自动创建了 Critic → 强制等待子任务。
  // supervisor-loop 的 hasAsyncChild 只识别 delegate/request_grounding_review/
  // request_repair，submit_deck_draft 不在其中，因此这里显式覆盖为 wait_for_children，
  // 使本 turn 结束时 unit 置 waiting_child，Critic 完成后由 resume 恢复。
  if (autoCreatedCritic && childTaskIds.length > 0 && outcome.nextAction !== "wait_for_children") {
    logger.warn(
      { runId: payload.generationRunId, turnNo: payload.turnNo, prevNextAction: outcome.nextAction },
      "P1-1: submit_deck_draft 自动创建 Critic，覆盖 nextAction 为 wait_for_children",
    );
    outcome.nextAction = "wait_for_children";
  }

  logger.info(
    { runId: payload.generationRunId, turnNo: payload.turnNo, toolCallCount: outcome.toolCalls.length, childTaskIds },
    "Agent tool calls 执行完成",
  );

  turnCtx.childTaskIds = childTaskIds;
  turnCtx.verificationRequested = verificationRequested;
  turnCtx.verificationSucceeded = verificationSucceeded;
}

// ─── 4. persistTurnResult ─────────────────────────────────────────────────

/**
 * 会话/usage/事件事务持久化（对应原 :1513-1558）。
 *
 * 在 lease-fenced 事务中更新 unit cursor/usage、run usageSummary，
 * 并记录 turn_completed 事件。
 */
export async function persistTurnResult(turnCtx: TurnExecutionContext): Promise<void> {
  const { job, payload, phaseCtx, role, outcome, childTaskIds } = turnCtx;
  const { session, budgetTracker } = phaseCtx;

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, turnCtx.lease);
    const turnTs = new Date();

    await tx.update(schema.cardGenerationUnits).set({
      cursorJson: session.toCursorJson(),
      usageJson: session.toUsageJson(),
      updatedAt: turnTs,
    }).where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));

    await tx.update(schema.cardGenerationRuns).set({
      usageSummary: budgetTracker.serializeUsage(),
      updatedAt: turnTs,
    }).where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ));

    await tx.insert(schema.cardGenerationAgentEvents).values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      unitId: payload.agentUnitId,
      eventKey: `turn:${payload.agentUnitId}:${payload.turnNo}`,
      eventType: "turn_completed",
      agentRole: role,
      turnNo: payload.turnNo,
      safePayload: {
        finishReason: outcome.state,
        toolCallCount: outcome.toolCalls.length,
        nextAction: outcome.nextAction,
        childTaskIds,
      },
    }).onConflictDoNothing();
  });
}

// ─── 5. scheduleNextTurn ──────────────────────────────────────────────────

/**
 * 下一 turn 调度（对应原 :1561-1650）。
 *
 * 根据 outcome.nextAction 决定下一步：
 * - continue: 创建下一 turn job
 * - wait_for_children: 设置 waiting_child 状态
 * - complete: Supervisor → 创建 verify unit；子 Agent → 恢复父 Supervisor
 * - needs_attention / retry_or_fail / default: 返回 needs_attention
 */
export async function scheduleNextTurn(
  turnCtx: TurnExecutionContext,
): Promise<AgentTurnExecutionResult> {
  const { job, payload, runContext, phaseCtx, role, outcome, childTaskIds } = turnCtx;
  const { session } = phaseCtx;

  switch (outcome.nextAction) {
    case "continue":
      await createNextTurnJob(job, payload.generationRunId, payload.agentUnitId, payload.turnNo + 1);
      return { kind: "continue", nextTurnNo: payload.turnNo + 1 };

    case "wait_for_children": {
      logger.info(
        { runId: payload.generationRunId, toolCalls: outcome.toolCalls.length, childTaskIds },
        "Supervisor 等待子任务",
      );
      session.waitForChildren(childTaskIds);
      // R18 修复：将 unit status 设置为 "waiting_child"
      await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, turnCtx.lease);
        const waitTs = new Date();
        await tx.update(schema.cardGenerationUnits).set({
          status: "waiting_child",
          cursorJson: session.toCursorJson(),
          usageJson: session.toUsageJson(),
          updatedAt: waitTs,
        }).where(and(
          eq(schema.cardGenerationUnits.id, payload.agentUnitId),
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        ));
      });
      return { kind: "wait_for_children", childTaskIds };
    }

    case "complete": {
      if (role === "generation_supervisor") {
        logger.info({ runId: payload.generationRunId }, "Supervisor 完成，进入 VERIFY");
        const verifyUnitId = await createVerifyUnit(job, payload, runContext);
        await createNextTurnJob(job, payload.generationRunId, verifyUnitId, payload.turnNo + 1);
        return { kind: "continue", nextTurnNo: payload.turnNo + 1 };
      } else {
        logger.info(
          { runId: payload.generationRunId, role, unitId: payload.agentUnitId },
          "子 Agent 完成，恢复父 Supervisor",
        );
        await withJobTransaction(job, async (tx) => {
          await lockJobLease(tx, turnCtx.lease);
          const now = new Date();
          await tx.update(schema.cardGenerationUnits).set({
            status: "succeeded",
            finishedAt: now,
            updatedAt: now,
          }).where(and(
            eq(schema.cardGenerationUnits.id, payload.agentUnitId),
            eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          ));
        });
        // P1-2/P1-3：子 Agent 完成后系统自动推进（Critic passed → VERIFY；
        // 新 draft 未评审 → 自动重新 Critic）。返回 true 表示已由系统推进，
        // 无需走 resume 恢复 parent。
        const autoProgressed = await autoProgressAfterChildUnit({
          job,
          runId: payload.generationRunId,
          childUnitId: payload.agentUnitId,
        });
        if (!autoProgressed) {
          await resumeParentSupervisorIfNeeded(job.workspaceId, payload.agentUnitId, job.requestedBy ?? null);
        }
        void reconcileStuckSupervisors(job.workspaceId).catch(() => {});
        return { kind: "complete" };
      }
    }

    case "needs_attention":
      return { kind: "needs_attention", reason: outcome.error ?? "supervisor_needs_attention" };

    case "retry_or_fail":
      return { kind: "needs_attention", reason: outcome.error ?? "supervisor_failed" };

    default:
      return { kind: "needs_attention", reason: `unknown_action: ${outcome.nextAction}` };
  }
}

// ─── 编排入口：executeAgentRunPhase ───────────────────────────────────────

/**
 * AGENT_RUN 阶段执行（计划 §5.2, §W4）。
 *
 * 编排 5 个拆分函数：
 * 1. buildTurnContext — 上下文装配
 * 2. executeProviderCall — 角色分发 + provider 调用
 * 3. processToolResults — 工具副作用执行
 * 4. persistTurnResult — 会话/usage/事件持久化
 * 5. scheduleNextTurn — 下一 turn 调度
 *
 * 一次 attempt 最多一次 provider 请求（计划 §5.3）。
 */
export async function executeAgentRunPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  // 1. 上下文装配
  const built = await buildTurnContext(job, payload, runContext, lease);
  if ("earlyReturn" in built) {
    return built.earlyReturn;
  }
  const turnCtx = built;

  // 2. 角色分发 + provider 调用
  const callResult = await executeProviderCall(turnCtx);
  if (callResult.kind === "needs_attention") {
    return { kind: "needs_attention", reason: callResult.reason };
  }
  turnCtx.outcome = callResult.outcome;

  // 3. 工具副作用执行
  await processToolResults(turnCtx);

  // 4. 会话/usage/事件持久化
  await persistTurnResult(turnCtx);

  // 5. 下一 turn 调度
  return await scheduleNextTurn(turnCtx);
}
