/**
 * Repair 修复 Agent（计划 §4.7, §W5）
 *
 * 整 run 最多创建一个 Repair task。
 * 只能根据 Critic hard issues 提交 typed patch。
 *
 * 修复操作类型（计划 §4.7）：
 * - rewrite claim/title/summary
 * - remove unrelated evidence
 * - split/merge/move candidate
 * - restore incorrectly excluded candidate
 * - adjust primary support、group 或 ordinal
 *
 * 不变量（G7, §4.7）：
 * - 禁止"重新生成全部"
 * - Repair 后产生新 draftHash，旧 Quality Report 失效
 * - 必须重新调用 Critic
 * - 整 run 最多一次 Repair
 */

import type {
  AgentTurnResult,
  AgentTurnRequest,
  DraftPatch,
  CriticIssue,
} from "@ailearn/shared";
import {
  DraftPatchType,
} from "@ailearn/shared";
import type { AgentRuntime } from "./runtime.ts";
import { initAgentTurn, handleTurnFailure, maybeReThrowRetryableProviderError } from "./runtime.ts";
import type { AgentSession } from "./session.ts";
import type { BudgetTracker } from "./budget.ts";
import type { ContextBuilder } from "./context-builder.ts";
import { buildRepairerSystemPrompt } from "./roles/supervisor-policy.ts";
import { logger } from "../lib/logger.ts";

/** Repair 执行配置 */
export interface RepairConfig {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 要修复的 draft hash */
  draftHash: string;
  /** 要修复的 issue IDs */
  issueIds: string[];
  /** 当前修复次数（必须为 0） */
  repairCount: number;
}

/** Repair turn 结果 */
export interface RepairTurnOutcome {
  /** 状态 */
  state: "running" | "completed" | "failed";
  /** 提交的 patch 列表 */
  patches: DraftPatch[];
  /** 基础 draft hash */
  baseDraftHash: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 验证 Repair 请求的合法性。
 *
 * 不变量（§4.7）：
 * - repairCount 必须为 0
 * - issueIds 不能为空
 * - 所有 issue 必须是 patchable 的 hard issue
 */
export function validateRepairRequest(
  config: RepairConfig,
  hardIssues: CriticIssue[],
): void {
  if (config.repairCount > 0) {
    throw new RepairError(
      `整 run 最多一次 Repair，当前 repairCount=${config.repairCount}`,
      "repair_limit_exceeded",
    );
  }

  if (config.issueIds.length === 0) {
    throw new RepairError("必须指定至少一个 issue ID", "empty_issues");
  }

  // 验证所有 issue 都是 patchable 的 hard issue
  for (const issueId of config.issueIds) {
    const issue = hardIssues.find((i) => i.code === issueId);
    if (!issue) {
      throw new RepairError(
        `issue ${issueId} 不在 hard issues 列表中`,
        "issue_not_found",
      );
    }
    if (!issue.patchable) {
      throw new RepairError(
        `issue ${issueId} 不可修复（patchable=false）`,
        "issue_not_patchable",
      );
    }
  }
}

/**
 * 执行一次 Repair turn。
 *
 * Repairer 只读指定 issues/draft，提交 typed patch proposal。
 *
 * 修复（2026-08-06）：Repairer 改为自包含 + 有界重试。
 * 原实现只传 issue IDs、允许模型调用 read_issues/read_draft，但 Repairer 是
 * 单次 provider turn——工具调用既不执行也不回传结果，模型反复调只读工具永远
 * 拿不到数据 → 空转直到 budget_exhausted。
 * 现在：把完整 issues（含 candidateId/cardDraftId）、draft、candidates（含 claim）
 * 内联进用户消息（模型实测会直接 submit_draft_patch），并从工具 allowlist 移除
 * read_issues/read_draft。若模型仍输出无 patch 的回复，追加一条纠正消息重试一次
 * （有界），仍失败则返回 failed，避免无限循环。
 */
export async function executeRepairTurn(
  runtime: AgentRuntime,
  session: AgentSession,
  budgetTracker: BudgetTracker,
  contextBuilder: ContextBuilder,
  config: RepairConfig,
  repairData: {
    issues: Array<Record<string, unknown>>;
    draft: Record<string, unknown> | null;
    candidates: Array<Record<string, unknown>>;
  },
  signal?: AbortSignal,
): Promise<RepairTurnOutcome> {
  const role = "repairer";

  // QUAL-35: 使用共享的初始化函数替代重复的 3 步初始化
  const turnCtx = initAgentTurn(session, budgetTracker, config, role);

  const systemPrompt = buildRepairerSystemPrompt();

  // 构建消息：合并为单个 user 消息避免多个连续 user 消息导致模型困惑
  const content = JSON.stringify({
    type: "repair_data",
    draftHash: config.draftHash,
    issueIds: config.issueIds,
    issues: repairData.issues,
    draft: repairData.draft,
    candidates: repairData.candidates,
  });

  const messages: AgentTurnRequest["messages"] = [
    { role: "user", content },
  ];

  logger.debug(
    { runId: config.runId, draftHash: config.draftHash, issueCount: config.issueIds.length, turnNo: turnCtx.turnNo },
    "Repair turn 开始",
  );

  const toolSchemas = contextBuilder.getToolSchemas(role);

  // 有界重试：最多 2 次 provider 调用。第一次正常提交 patch；若模型输出无 patch
  // 的回复（prose 或误调工具），追加纠正消息再试一次。
  for (let attempt = 0; attempt < 2; attempt++) {
    const turnRequest: AgentTurnRequest = {
      role,
      systemPrompt,
      messages,
      tools: toolSchemas,
      // Repairer 输出 submit_draft_patch 包含多个 patch 的 JSON
      maxTokens: 6_144,
      temperature: 0.3,
    };

    let result: AgentTurnResult;
    try {
      result = await runtime.executeTurn(turnRequest, turnCtx, signal);
    } catch (err) {
      // QUAL-35: 使用共享的错误处理函数
      // BUG-94: 可重试 provider 错误（502/429/408/5xx）re-throw，走队列重投
      maybeReThrowRetryableProviderError(err);
      handleTurnFailure(budgetTracker, session, role);
      return {
        state: "failed",
        patches: [],
        baseDraftHash: config.draftHash,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    budgetTracker.settleProviderCall(role, result.usage);
    session.recordProviderCall(result.usage, result.providerRequestId);

    // 解析结果
    const outcome = parseRepairResult(result, config);

    // 如果调用了 complete_agent_task，标记完成
    const hasComplete = result.toolCalls.some((c) => c.name === "complete_agent_task");

    // 有实际 patch 才算完成（2026-08-11 修复）：模型只调 complete_agent_task
    // 却未提交任何 patch 时，不得当作"空修复成功"推进——与 critic 路径
    // report=null → failed 对称，走下方重试/失败路径。
    if (outcome.patches.length > 0) {
      if (hasComplete) {
        session.complete();
        outcome.state = "completed";
      }
      logger.debug(
        { runId: config.runId, patchCount: outcome.patches.length, turnNo: turnCtx.turnNo, attempt },
        "Repair turn 完成",
      );
      return outcome;
    }

    // 未提交 patch：若还有重试机会，追加纠正消息重试
    if (attempt === 0) {
      logger.warn(
        { runId: config.runId, turnNo: turnCtx.turnNo, toolCalls: result.toolCalls.map((c) => c.name) },
        "Repairer 未提交 submit_draft_patch，追加纠正消息重试",
      );
      messages.push({
        role: "user",
        content: "提示：你尚未提交 submit_draft_patch。所有 issues、draft、candidates 已包含在上一条消息中。请立即调用 submit_draft_patch 提交修复 patch，不要输出文字，不要调用其他工具。",
      });
      continue;
    }

    // 重试后仍失败
    logger.warn(
      { runId: config.runId, turnNo: turnCtx.turnNo },
      "Repairer 两次尝试均未提交 patch，判定修复失败",
    );
    return {
      state: "failed",
      patches: [],
      baseDraftHash: config.draftHash,
      error: "repairer 未提交 submit_draft_patch",
    };
  }

  return {
    state: "failed",
    patches: [],
    baseDraftHash: config.draftHash,
    error: "repairer 未提交 submit_draft_patch",
  };
}

/**
 * 解析 Repair 的 turn 结果。
 */
function parseRepairResult(
  result: AgentTurnResult,
  config: RepairConfig,
): RepairTurnOutcome {
  const patches: DraftPatch[] = [];

  for (const call of result.toolCalls) {
    if (call.name === "submit_draft_patch") {
      const args = call.arguments as Record<string, unknown>;
      const baseDraftHash = String(args.baseDraftHash ?? config.draftHash);

      if (Array.isArray(args.patches)) {
        for (const p of args.patches as Record<string, unknown>[]) {
          patches.push(parsePatch(p, baseDraftHash));
        }
      }
    }
  }

  return {
    state: "running",
    patches,
    baseDraftHash: config.draftHash,
  };
}

/** 解析单个 patch */
// 2026-08-11：DraftPatch.type 白名单——此前 `data.type as DraftPatch["type"]`
// 直接透传，非法 type（模型幻觉输出）落进 persistRepairPatches 的 default 分支
// 被静默跳过（仅 warn），同一 hard issue 反复出现 → 修复死循环。
// 改为在解析层尽早失败：非白名单 type 抛错，repair turn 走失败路径，不伪成功。
const VALID_PATCH_TYPES = new Set<string>(Object.values(DraftPatchType));

function parsePatch(
  data: Record<string, unknown>,
  baseDraftHash: string,
): DraftPatch {
  // BUG-18: 原代码使用 `void baseDraftHash` 直接丢弃参数，
  // 导致返回的 patch 对象不包含 baseDraftHash，调用方无法验证
  // patch 是否基于正确的 draft 版本。现在将其附加到返回对象中。
  const rawType = data.type;
  if (typeof rawType !== "string" || !VALID_PATCH_TYPES.has(rawType)) {
    throw new Error(
      `submit_draft_patch: 非法 patch type ${JSON.stringify(rawType)}（允许：${[...VALID_PATCH_TYPES].join(", ")}）`,
    );
  }
  // newOrdinal 只接受有限数值；NaN/Infinity/非数值会写坏卡片排序，置 undefined 丢弃
  const rawOrdinal = data.newOrdinal;
  const newOrdinal = rawOrdinal === undefined
    ? undefined
    : Number.isFinite(Number(rawOrdinal))
      ? Number(rawOrdinal)
      : undefined;
  return {
    type: rawType as DraftPatch["type"],
    issueIds: Array.isArray(data.issueIds) ? (data.issueIds as string[]) : [],
    candidateId: data.candidateId ? String(data.candidateId) : undefined,
    cardDraftId: data.cardDraftId ? String(data.cardDraftId) : undefined,
    targetCardDraftId: data.targetCardDraftId ? String(data.targetCardDraftId) : undefined,
    newClaim: data.newClaim ? String(data.newClaim) : undefined,
    newTitle: data.newTitle ? String(data.newTitle) : undefined,
    newSummary: data.newSummary ? String(data.newSummary) : undefined,
    newGroupKey: data.newGroupKey ? String(data.newGroupKey) : undefined,
    newOrdinal,
    newPrimarySupportCandidateId: data.newPrimarySupportCandidateId
      ? String(data.newPrimarySupportCandidateId)
      : undefined,
    removedEvidenceRefIds: Array.isArray(data.removedEvidenceRefIds)
      ? (data.removedEvidenceRefIds as string[])
      : undefined,
    // BUG-18: 保留 baseDraftHash 供应用 patch 时验证版本一致性
    baseDraftHash,
  } as DraftPatch;
}

/** Repair 错误 */
export class RepairError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "RepairError";
    this.code = code;
  }
}
