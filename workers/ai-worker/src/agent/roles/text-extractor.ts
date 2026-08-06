/**
 * Text Extractor 专家 Agent（计划 §4.3, §W4）
 *
 * 处理定义、原理、条件、因果、比较、例外和 procedure。
 *
 * 职责：
 * - 读取分配给自己的 bundles
 * - 搜索关联证据帮助理解上下文
 * - 记录候选知识点或 no-candidate 决策
 * - 完成任务
 *
 * 不变量（G4, §6.2）：
 * - 只能写自己 assigned bundles 的候选
 * - 不能修改其他候选、Draft 或 Quality Report
 * - 每个 claim 必须自包含、原子、可验证
 * - evidence refIds 必须在 allowlist 中
 */

import type { AgentRole, AgentTurnResult } from "@ailearn/shared";
import type { AgentRuntime } from "../runtime.ts";
import { initAgentTurn, handleTurnFailure, maybeReThrowRetryableProviderError } from "../runtime.ts";
import type { AgentSession } from "../session.ts";
import type { BudgetTracker } from "../budget.ts";
import type { ContextBuilder } from "../context-builder.ts";
import { buildExtractorSystemPrompt } from "./supervisor-policy.ts";
import { logger } from "../../lib/logger.ts";
import { extractJsonFromText } from "../../lib/providers/json-response.ts";

/** Extractor 执行配置 */
export interface ExtractorConfig {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 角色 */
  role: AgentRole;
  /** 分配的 bundle IDs */
  bundleIds: string[];
}

/**
 * 执行一次 Extractor turn。
 *
 * Extractor 读取 assigned bundles，提取候选，记录决策。
 */
export async function executeExtractorTurn(
  runtime: AgentRuntime,
  session: AgentSession,
  budgetTracker: BudgetTracker,
  contextBuilder: ContextBuilder,
  config: ExtractorConfig,
  assignedBundles: Array<{
    bundleId: string;
    sectionPath: string[];
    evidenceUnits: Array<{
      refId: string;
      kind: string;
      text: string;
      contextOnly: boolean;
    }>;
  }>,
  signal?: AbortSignal,
): Promise<ExtractorTurnOutcome> {
  const role = config.role as AgentRole;

  // 验证角色合法性
  if (role !== "text_extractor" && role !== "code_extractor" && role !== "vision_specialist") {
    throw new Error(`非法的 Extractor 角色: ${role}`);
  }

  // QUAL-35: 使用共享的初始化函数替代重复的 3 步初始化
  const turnCtx = initAgentTurn(session, budgetTracker, config, role);

  const systemPrompt = buildExtractorSystemPrompt(role);

  let result;
  try {
    const turnRequest = contextBuilder.buildExtractorTurn(
      role,
      assignedBundles,
      systemPrompt,
    );

    logger.debug(
      { runId: config.runId, role, turnNo: turnCtx.turnNo, bundleCount: assignedBundles.length },
      "Extractor turn 开始",
    );

    result = await runtime.executeTurn(turnRequest, turnCtx, signal);
  } catch (err) {
    // QUAL-35: 使用共享的错误处理函数
    // P1-08: InputOverContextError 也会在此被捕获
    // BUG-94: 可重试 provider 错误（502/429/408/5xx）re-throw，走队列重投
    maybeReThrowRetryableProviderError(err);
    handleTurnFailure(budgetTracker, session, role);
    return {
      state: "failed",
      error: err instanceof Error ? err.message : String(err),
      candidates: [],
      noCandidates: [],
    };
  }

  budgetTracker.settleProviderCall(role, result.usage);
  session.recordProviderCall(result.usage, result.providerRequestId);

  // 解析结果（包含 content JSON 回退 + 自动候选生成回退）
  const outcome = parseExtractorResult(result, config, assignedBundles);

  // 如果调用了 complete_agent_task，标记完成
  const hasComplete = result.toolCalls.some((c) => c.name === "complete_agent_task");
  if (hasComplete) {
    session.complete();
    outcome.state = "completed";
  }

  logger.debug(
    {
      runId: config.runId,
      role,
      turnNo: turnCtx.turnNo,
      candidateCount: outcome.candidates.length,
      noCandidateCount: outcome.noCandidates.length,
      toolCallCount: result.toolCalls.length,
      hasContent: !!result.content,
      autoFallback: outcome.candidates.length > 0 && result.toolCalls.length === 0,
    },
    "Extractor turn 完成",
  );

  return outcome;
}

/** Extractor turn 结果 */
export interface ExtractorTurnOutcome {
  /** 状态 */
  state: "running" | "completed" | "failed";
  /** 提取的候选 */
  candidates: ExtractedCandidate[];
  /** no-candidate 决策 */
  noCandidates: NoCandidateDecision[];
  /** 错误信息 */
  error?: string;
}

/** 提取的候选 */
export interface ExtractedCandidate {
  /** 局部 ID */
  localId: string;
  /** P1-09: 所属 bundle ID（强制必填） */
  bundleId: string;
  /** claim */
  claim: string;
  /** 主题 */
  topic: string;
  /** 认知类型 */
  cognitiveType: "concept" | "comparison" | "causal" | "procedure" | "boundary" | "code" | "formula";
  /** 重要度 */
  importance: "core" | "supporting" | "detail";
  /** P1-11: 难度 */
  difficulty?: "basic" | "intermediate" | "advanced";
  /** 证据 refIds */
  evidenceRefIds: string[];
  /** 关联 hints */
  relationHints?: Array<{
    type: "supports" | "contrasts" | "depends_on";
    localTargetId: string;
  }>;
}

/** no-candidate 决策 */
export interface NoCandidateDecision {
  /** bundle ID */
  bundleId: string;
  /** 原因 */
  reason: "metadata" | "duplicate" | "example_only" | "decorative" | "no_learnable_fact";
}

/**
 * 解析 Extractor 的 turn 结果。
 *
 * 二级解析策略：
 * 1. 优先从 native tool calls 中提取候选和 no-candidate 决策
 * 2. 如果没有 tool calls，尝试从 content 中解析 JSON（模型可能返回 JSON 而非 tool calls）
 *
 * P0-01 修复（2026-08-03）：
 * 移除了原来的第三级「自动候选生成」fallback。该 fallback 从证据文本前 200 字
 * 制造 claim，把 `concept + core` 候选注入管道，属于确定性代码替代模型做语义决策。
 * 现在当模型既未调用工具也未返回可解析 JSON 时，返回空结果（state: "failed"），
 * 由上层 Handler 将 unit 标记为 needs_attention / protocol_error。
 * 确定性代码只允许做调度、分页、幂等恢复和错误归类，不能替代模型做语义决策。
 */
function parseExtractorResult(
  result: AgentTurnResult,
  config: ExtractorConfig,
  assignedBundles: Array<{
    bundleId: string;
    sectionPath: string[];
    evidenceUnits: Array<{
      refId: string;
      kind: string;
      text: string;
      contextOnly: boolean;
    }>;
  }>,
): ExtractorTurnOutcome {
  const candidates: ExtractedCandidate[] = [];
  const noCandidates: NoCandidateDecision[] = [];

  // P1-09: 构建 assigned bundleId 集合，用于验证候选的 bundleId
  const assignedBundleIdSet = new Set(assignedBundles.map((b) => b.bundleId));

  // P1-09: 验证候选的 bundleId 非空且属于 assigned bundles，且至少有一个 evidenceRefId。
  // Zod schema 在 tool call 路径已强制这些约束，但 content JSON 回退路径绕过了 Zod 校验。
  function isValidCandidate(c: ExtractedCandidate): boolean {
    if (!c.bundleId || c.bundleId.trim().length === 0) {
      logger.warn(
        { runId: config.runId, localId: c.localId, reason: "empty_bundle_id" },
        "P1-09: 回退解析拒绝候选（bundleId 为空）",
      );
      return false;
    }
    if (!assignedBundleIdSet.has(c.bundleId)) {
      logger.warn(
        { runId: config.runId, localId: c.localId, bundleId: c.bundleId, reason: "bundle_not_assigned" },
        "P1-09: 回退解析拒绝候选（bundleId 不属于 assigned bundles）",
      );
      return false;
    }
    if (!c.evidenceRefIds || c.evidenceRefIds.length === 0) {
      logger.warn(
        { runId: config.runId, localId: c.localId, bundleId: c.bundleId, reason: "no_evidence_refs" },
        "P1-09: 回退解析拒绝候选（无证据引用）",
      );
      return false;
    }
    return true;
  }

  // ─── 1. 从 native tool calls 解析 ───────────────────────────────────
  for (const call of result.toolCalls) {
    if (call.name === "record_extraction_decisions") {
      const args = call.arguments as Record<string, unknown>;

      // 解析候选
      if (Array.isArray(args.candidates)) {
        for (const c of args.candidates as Record<string, unknown>[]) {
          candidates.push({
            localId: String(c.localId ?? ""),
            bundleId: String(c.bundleId ?? ""),
            claim: String(c.claim ?? ""),
            topic: String(c.topic ?? ""),
            cognitiveType: (c.cognitiveType as ExtractedCandidate["cognitiveType"]) ?? "concept",
            importance: (c.importance as ExtractedCandidate["importance"]) ?? "supporting",
            difficulty: (c.difficulty as ExtractedCandidate["difficulty"]) ?? "intermediate",
            evidenceRefIds: Array.isArray(c.evidenceRefIds)
              ? (c.evidenceRefIds as string[])
              : [],
            relationHints: Array.isArray(c.relationHints)
              ? (c.relationHints as ExtractedCandidate["relationHints"])
              : undefined,
          });
        }
      }

      // 解析 no-candidate
      if (Array.isArray(args.noCandidate)) {
        for (const nc of args.noCandidate as Record<string, unknown>[]) {
          noCandidates.push({
            bundleId: String(nc.bundleId ?? ""),
            reason: (nc.reason as NoCandidateDecision["reason"]) ?? "no_learnable_fact",
          });
        }
      }
    }
  }

  // 如果从 tool calls 中成功提取了结果，直接返回
  if (candidates.length > 0 || noCandidates.length > 0) {
    // P1-09: 过滤掉无效候选（bundleId 为空/不属于 assigned bundles/无证据引用）
    const validCandidates = candidates.filter(isValidCandidate);
    if (validCandidates.length < candidates.length) {
      logger.warn(
        { runId: config.runId, originalCount: candidates.length, validCount: validCandidates.length },
        "P1-09: tool call 解析路径过滤了无效候选",
      );
    }
    return { state: "running", candidates: validCandidates, noCandidates };
  }

  // ─── 2. 从 content 中解析 JSON（回退） ─────────────────────────────
  //
  // 模型可能不调用 tool calls 而是在 content 中返回 JSON。
  // 尝试解析 content 中的 JSON，查找 candidates/noCandidate 字段。
  if (result.content) {
    try {
      const parsed = extractJsonFromText(result.content) as Record<string, unknown>;

      // 尝试从 JSON 中提取 candidates
      if (Array.isArray(parsed.candidates)) {
        for (const c of parsed.candidates as Record<string, unknown>[]) {
          candidates.push({
            localId: String(c.localId ?? `c${candidates.length + 1}`),
            bundleId: String(c.bundleId ?? ""),
            claim: String(c.claim ?? ""),
            topic: String(c.topic ?? ""),
            cognitiveType: (c.cognitiveType as ExtractedCandidate["cognitiveType"]) ?? "concept",
            importance: (c.importance as ExtractedCandidate["importance"]) ?? "supporting",
            difficulty: (c.difficulty as ExtractedCandidate["difficulty"]) ?? "intermediate",
            evidenceRefIds: Array.isArray(c.evidenceRefIds)
              ? (c.evidenceRefIds as string[])
              : [],
            relationHints: Array.isArray(c.relationHints)
              ? (c.relationHints as ExtractedCandidate["relationHints"])
              : undefined,
          });
        }
      }

      // 尝试从 JSON 中提取 noCandidate
      if (Array.isArray(parsed.noCandidate)) {
        for (const nc of parsed.noCandidate as Record<string, unknown>[]) {
          noCandidates.push({
            bundleId: String(nc.bundleId ?? ""),
            reason: (nc.reason as NoCandidateDecision["reason"]) ?? "no_learnable_fact",
          });
        }
      }

      // 也尝试从嵌套的 record_extraction_decisions 结构中提取
      if (Array.isArray(parsed.toolCalls)) {
        for (const tc of parsed.toolCalls as Record<string, unknown>[]) {
          if (String(tc.name ?? "") === "record_extraction_decisions") {
            const tcArgs = (tc.arguments ?? {}) as Record<string, unknown>;
            if (Array.isArray(tcArgs.candidates)) {
              for (const c of tcArgs.candidates as Record<string, unknown>[]) {
                candidates.push({
                  localId: String(c.localId ?? `c${candidates.length + 1}`),
                  bundleId: String(c.bundleId ?? ""),
                  claim: String(c.claim ?? ""),
                  topic: String(c.topic ?? ""),
                  cognitiveType: (c.cognitiveType as ExtractedCandidate["cognitiveType"]) ?? "concept",
                  importance: (c.importance as ExtractedCandidate["importance"]) ?? "supporting",
                  difficulty: (c.difficulty as ExtractedCandidate["difficulty"]) ?? "intermediate",
                  evidenceRefIds: Array.isArray(c.evidenceRefIds)
                    ? (c.evidenceRefIds as string[])
                    : [],
                });
              }
            }
            if (Array.isArray(tcArgs.noCandidate)) {
              for (const nc of tcArgs.noCandidate as Record<string, unknown>[]) {
                noCandidates.push({
                  bundleId: String(nc.bundleId ?? ""),
                  reason: (nc.reason as NoCandidateDecision["reason"]) ?? "no_learnable_fact",
                });
              }
            }
          }
        }
      }

      if (candidates.length > 0 || noCandidates.length > 0) {
        // P1-09: 过滤掉无效候选（bundleId 为空/不属于 assigned bundles/无证据引用）
        const validCandidates = candidates.filter(isValidCandidate);
        if (validCandidates.length < candidates.length) {
          logger.warn(
            { runId: config.runId, originalCount: candidates.length, validCount: validCandidates.length },
            "P1-09: content JSON 回退解析路径过滤了无效候选",
          );
        }
        if (validCandidates.length === 0 && noCandidates.length === 0) {
          // 过滤后无有效候选也无 no-candidate 决策，视为协议失败
          return { state: "failed", candidates: [], noCandidates: [] };
        }
        logger.info(
          { runId: config.runId, candidateCount: validCandidates.length, noCandidateCount: noCandidates.length },
          "Extractor 从 content JSON 回退解析中提取到结果",
        );
        return { state: "running", candidates: validCandidates, noCandidates };
      }
    } catch {
      // content 不是有效 JSON，继续到自动回退
    }
  }

  // ─── P0-01：移除自动候选生成 fallback ────────────────────────────────
  //
  // 原来的第三级 fallback 从证据文本前 200 字制造 claim，把 concept + core
  // 候选注入管道。这属于确定性代码替代模型做语义决策，会产出劣质内容并
  // 被发布为 succeeded。现已移除。
  //
  // 当模型既未调用工具也未返回可解析 JSON 时，返回空结果（state: "failed"）。
  // 上层 Handler 会将此视为 protocol_error 并进入 needs_attention。
  //
  // 确定性代码只允许做调度、分页、幂等恢复和错误归类。
  if (candidates.length === 0 && noCandidates.length === 0) {
    logger.warn(
      {
        runId: config.runId,
        role: config.role,
        toolCallCount: result.toolCalls.length,
        hasContent: !!result.content,
        bundleCount: assignedBundles.length,
      },
      "Extractor 模型未调用工具也未返回可解析 JSON，协议失败（不再自动生成候选）",
    );
    return { state: "failed", candidates: [], noCandidates: [] };
  }

  return { state: "running", candidates, noCandidates };
}
