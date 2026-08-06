/**
 * QUAL-02/PERF-04 拆分：Supervisor 自动回退逻辑。
 *
 * P0-01 修复（2026-08-03）：
 * 移除了所有生成语义内容的自动回退（auto-delegate、auto-deck-draft）。
 * 确定性代码只允许做调度、分页、幂等恢复和错误归类，不能替代模型做语义决策。
 *
 * 保留的纯调度回退（不生成 claim、标题、摘要或支撑结论）：
 * 2. 有 Draft 但无 Quality Report → 自动 request_grounding_review（调度）
 * 3. 有 Quality Report (passed) 但 deterministicStatus=pending → 自动 validate_draft（调度）
 * 4. 验证通过但未请求 Verification → 自动 request_verification（调度）
 *
 * 移除的语义回退：
 * 0. 有未分配 bundle → 自动 delegate_specialist（语义：选择角色）
 * 1. 有候选但无 Draft → 自动 submit_deck_draft（语义：生成标题/摘要）
 *
 * 当管道状态无法通过纯调度推进时（如无候选、无 Draft 且 Supervisor 未调用工具），
 * 返回 needs_attention / protocol_error。
 *
 * P0-1 重构（2026-08-06）：
 * 将纯决策逻辑提取为 `computeSupervisorAutoFallback`（无 DB 依赖，可单测），
 * `maybeInjectSupervisorAutoFallback` 只保留副作用（Agent Event 写入）。
 * 场景矩阵（P0-1 验收）：
 *   A. 模型未调用工具（toolCalls.length === 0 && nextAction === "needs_attention"）
 *   B. 模型过早请求 Verification（调用 request_verification，含错误 draftHash，BUG-94）
 *   C. 只读工具自旋（连续只读 turn ≥ 3 且无推进）
 */

import type { AgentJobPayload } from "./types.ts";
import type { CandidateLedger } from "./candidate-ledger.ts";
import type { CoverageLedger } from "./coverage-ledger.ts";
import { appendAgentEvent } from "./specialist-persist.ts";
import { logger } from "../lib/logger.ts";

// ─── 运行上下文中需要的类型别名 ────────────────────────────────────

/** run 详情行类型（从 card-supervisor-agent.ts 传递） */
interface RunDetailRow {
  titleSnapshot: string | null;
  density: string | null;
}

/** draft 行类型（简化版） */
interface DraftRow {
  id: string;
  contentHash: string;
  draftVersion: number;
}

/** report 行类型（简化版） */
interface ReportRow {
  criticStatus: string;
  deterministicStatus: string;
}

/** 自动回退输入参数 */
export interface SupervisorAutoFallbackInput {
  payload: AgentJobPayload;
  workspaceId: string;
  candidateLedger: CandidateLedger;
  coverageLedger: CoverageLedger;
  latestDraft: DraftRow | null;
  latestReport: ReportRow | null;
  runDetail: RunDetailRow;
  /** 自旋检测信息（可选，缺省视为 0） */
  spinInfo?: {
    /** 连续只调用只读工具且无推进的 turn 数 */
    consecutiveReadOnlyTurns: number;
  };
  /** 当前 outcome */
  outcome: {
    state: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    content: string | null;
    nextAction: string;
    error?: string | undefined;
  };
}

/** 自动回退输出（修改后的 outcome） */
export interface SupervisorAutoFallbackOutput {
  state: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  content: string | null;
  nextAction: string;
  error?: string | undefined;
}

/** 触发原因 allowlist（审计落库用） */
export type SupervisorAutoFallbackTriggerReason =
  | "supervisor_no_tool_calls_auto_progress"
  | "supervisor_model_verification_redirect"
  | "supervisor_read_only_spin_detected";

/** 纯决策输出：触发与否 + 注入计划 + 最终 outcome */
export interface SupervisorAutoFallbackDecision {
  /** 是否触发自动回退（未触发时 outcome 即原样） */
  triggered: boolean;
  /** 触发原因（未触发时为 null） */
  triggerReason: SupervisorAutoFallbackTriggerReason | null;
  /** 需要注入的工具调用（未触发或进入 needs_attention 时为空数组） */
  injectedTools: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** 注入后的 nextAction */
  nextAction: string;
  /** 回退后的 outcome（未触发时为原 outcome） */
  outcome: SupervisorAutoFallbackOutput;
}

/**
 * 纯决策函数：从管道当前状态计算 Supervisor 自动回退方案。
 *
 * 无 DB / 外部副作用（仅结构化日志），可在单测中直接覆盖场景 A/B/C。
 */
export function computeSupervisorAutoFallback(
  input: SupervisorAutoFallbackInput,
): SupervisorAutoFallbackDecision {
  const { payload, candidateLedger, coverageLedger, latestDraft, latestReport, runDetail, outcome } = input;
  const spinInfo = input.spinInfo ?? { consecutiveReadOnlyTurns: 0 };

  // 场景 A：模型未调用工具
  const isNoToolCallScenario =
    outcome.toolCalls.length === 0 && outcome.nextAction === "needs_attention";

  // 场景 B：模型调用 request_verification（BUG-94）
  // 无论前置条件是否满足，只要模型调用了 request_verification，
  // 都由自动回退替换为使用正确 draftHash 的版本。
  // 原因：模型（如 DashScope deepseek-v4-flash）经常使用错误的 draftHash
  // （如 "mock_draft_hash"），导致 request_verification 工具找不到 draft 而失败，
  // R19 覆盖 nextAction="continue"，形成死循环。
  const hasModelVerification =
    outcome.toolCalls.some((tc) => tc.name === "request_verification");

  // 场景 C：只读工具自旋（P1-15 修复，根因 A）
  // 模型连续 N 个 turn 只调用只读工具（read_candidate_ledger 等）且无推进，
  // 说明模型无法做出语义决策（典型：CAS 失败后反复重读 ledger）。
  // 达到阈值后由确定性代码根据管道状态强制推进，而不是让模型自选。
  const isReadOnlySpinScenario = spinInfo.consecutiveReadOnlyTurns >= 3;

  if (!isNoToolCallScenario && !hasModelVerification && !isReadOnlySpinScenario) {
    return {
      triggered: false,
      triggerReason: null,
      injectedTools: [],
      nextAction: outcome.nextAction,
      outcome,
    };
  }

  const triggerReason: SupervisorAutoFallbackTriggerReason = isNoToolCallScenario
    ? "supervisor_no_tool_calls_auto_progress"
    : hasModelVerification
      ? "supervisor_model_verification_redirect"
      : "supervisor_read_only_spin_detected";

  logger.info(
    {
      runId: payload.generationRunId,
      turnNo: payload.turnNo,
      candidateCount: candidateLedger.getActiveCandidates().length,
      hasDraft: !!latestDraft,
      hasReport: !!latestReport,
      unassignedBundles: coverageLedger.getUnassignedBundles().length,
      triggerReason,
    },
    "Supervisor 自动回退触发：检查管道状态",
  );

  // activeCandidates 和 unassignedBundles 已在 P0-01 修复中移除，
  // 因为它们只被 auto-delegate 和 auto-deck-draft 使用。
  const autoToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let autoNextAction = "continue";

  // P0-01 修复：移除了 auto-delegate 和 auto-deck-draft 步骤。
  // 这些步骤生成语义内容（选择角色、生成标题/摘要），属于确定性代码
  // 替代模型做语义决策。现在只保留纯调度步骤（request_critic、validate、verify）。
  //
  // 0. 有未分配 bundle → 不再自动 delegate_specialist（语义决策：选择角色）
  //    当 Supervisor 未调用工具且有未分配 bundle 时，进入 needs_attention。
  // 1. 有候选但无 Draft → 不再自动 submit_deck_draft（语义决策：生成标题/摘要）
  //    当有候选但 Supervisor 未创建 Draft 时，进入 needs_attention。

  // 2. 有 Draft 但无 Quality Report → 自动 request_grounding_review（纯调度）
  if (latestDraft && !latestReport) {
    autoToolCalls.push({
      id: `auto-request-critic-${payload.turnNo}`,
      name: "request_grounding_review",
      arguments: {
        draftHash: latestDraft.contentHash,
      },
    });
    autoNextAction = "wait_for_children";
    logger.info(
      { runId: payload.generationRunId, draftHash: latestDraft.contentHash },
      "Supervisor 自动回退：注入 request_grounding_review",
    );
  }
  // 3. 有 Quality Report (passed) 但 deterministicStatus="pending" → 自动 validate_draft
  // 只在尚未验证时注入。如果 deterministicStatus="failed"，说明验证已失败，
  // 无法通过重试修复，不应继续注入 validate_draft（BUG-94 循环根因）。
  else if (latestDraft && latestReport && latestReport.criticStatus === "passed" && latestReport.deterministicStatus === "pending") {
    autoToolCalls.push({
      id: `auto-validate-${payload.turnNo}`,
      name: "validate_draft",
      arguments: {
        draftHash: latestDraft.contentHash,
      },
    });
    logger.info(
      { runId: payload.generationRunId, draftHash: latestDraft.contentHash },
      "Supervisor 自动回退：注入 validate_draft",
    );
  }
  // 4. 验证通过但未请求 Verification → 自动 request_verification
  else if (latestDraft && latestReport && latestReport.criticStatus === "passed" && latestReport.deterministicStatus === "passed") {
    autoToolCalls.push({
      id: `auto-verify-${payload.turnNo}`,
      name: "request_verification",
      arguments: {
        draftHash: latestDraft.contentHash,
      },
    });
    autoNextAction = "complete";
    logger.info(
      { runId: payload.generationRunId, draftHash: latestDraft.contentHash },
      "Supervisor 自动回退：注入 request_verification",
    );
  }
  // 场景 C 特有：模型自旋且无 Draft → 机械组装 Draft 强制推进
  // P0-01 禁止一般场景的 auto-submit_deck_draft（语义决策）。
  // 但自旋场景（read_candidate_ledger 反复无推进）说明模型无法推进到 compose，
  // 若不做机械 Draft，管道必然卡死至预算耗尽。
  // 机械 Draft 用候选 claim 作为卡片内容（不生成新语义），
  // 后续仍走强制 Critic → validate → verify 门禁，质量由确定性门禁保证。
  else if (isReadOnlySpinScenario && !latestDraft) {
    const active = candidateLedger.getActiveCandidates();
    if (active.length > 0) {
      const cards = active.map((c, index) => ({
        draftCardId: `auto-card-${index}`,
        title: c.claim.slice(0, 60),
        summary: c.claim,
        candidateIds: [c.candidateId],
        primarySupportCandidateId: c.candidateId,
        ordinal: index,
        primarySection: c.sectionKey || undefined,
        groupKey: c.groupKey ?? undefined,
        learningObjective: `理解：${c.claim.slice(0, 40)}`,
        isOverview: index === 0,
      }));
      autoToolCalls.push({
        id: `auto-draft-${payload.turnNo}`,
        name: "submit_deck_draft",
        arguments: {
          baseLedgerHash: candidateLedger.getHash(),
          draft: {
            deckTitle: runDetail.titleSnapshot ?? "学习卡",
            deckSummary: "由候选 claim 机械组装，等待 Critic 审查",
            density: (runDetail.density as "overview" | "standard" | "complete") ?? "standard",
            cardBudget: cards.length,
            cards,
          },
        },
      });
      autoNextAction = "continue";
      logger.warn(
        {
          runId: payload.generationRunId,
          turnNo: payload.turnNo,
          cardCount: cards.length,
          triggerReason,
        },
        "Supervisor 自旋：机械组装 Draft 强制推进（候选 claim 直接作为卡片）",
      );
    }
  }

  if (autoToolCalls.length === 0) {
    // P0-01 修复：管道状态无法通过纯调度推进，进入 needs_attention。
    // 这包括：
    // - Supervisor 未调用工具且有未分配 bundle（需要模型决定委派）
    // - Supervisor 未调用工具且有候选但无 Draft（需要模型创建 Draft）
    // - Supervisor 调用 request_verification 但管道未就绪且无法自动推进
    // - deterministicStatus="failed" 无法修复
    logger.warn(
      { runId: payload.generationRunId, turnNo: payload.turnNo, triggerReason },
      "Supervisor 自动回退：管道状态无法通过纯调度推进，进入 needs_attention (protocol_error)",
    );
    return {
      triggered: true,
      triggerReason,
      injectedTools: [],
      nextAction: "needs_attention",
      outcome: {
        state: "needs_attention",
        toolCalls: [],
        content: null,
        nextAction: "needs_attention",
        error: "protocol_error: supervisor failed to make semantic decisions (no auto-fallback for delegate/draft)",
      },
    };
  }

  return {
    triggered: true,
    triggerReason,
    injectedTools: autoToolCalls,
    nextAction: autoNextAction,
    outcome: {
      state: "running",
      toolCalls: autoToolCalls,
      content: null,
      nextAction: autoNextAction,
      error: undefined,
    },
  };
}

/**
 * Supervisor 自动回退：从管道当前状态注入合成 tool calls。
 *
 * 两种触发场景：
 * A. 模型未调用工具 (toolCalls.length === 0 && nextAction === "needs_attention")
 * B. 模型跳过管道步骤，过早调用 request_verification 但无 Draft
 * C. 只读工具自旋（连续只读 turn ≥ 3 且无推进）
 *
 * 返回修改后的 outcome（如果触发回退）或原样返回（如果未触发）。
 */
export async function maybeInjectSupervisorAutoFallback(
  input: SupervisorAutoFallbackInput,
): Promise<SupervisorAutoFallbackOutput> {
  const decision = computeSupervisorAutoFallback(input);
  if (!decision.triggered) {
    return decision.outcome;
  }

  const { payload, workspaceId } = input;

  // 记录自动回退 event（仅当有注入工具时；进入 needs_attention 不记录）
  if (decision.injectedTools.length > 0 && decision.triggerReason) {
    await appendAgentEvent({
      workspaceId,
      runId: payload.generationRunId,
      unitId: payload.agentUnitId,
      eventKey: `auto_fallback:${payload.agentUnitId}:${payload.turnNo}`,
      eventType: "tool_request",
      agentRole: "generation_supervisor",
      turnNo: payload.turnNo,
      toolName: decision.injectedTools[0]!.name,
      safePayload: {
        autoGenerated: true,
        injectedTools: decision.injectedTools.map((tc) => tc.name),
        reason: decision.triggerReason,
      },
    });
  }

  return decision.outcome;
}
