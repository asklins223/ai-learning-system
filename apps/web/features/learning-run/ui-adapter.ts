/**
 * LearningRun wire ↔ UI 适配层（P3 生产接线）。
 *
 * 服务端 wire contract（@ailearn/shared LearningRunPublicV1）与 UI 快照
 * （features/learning-run/contracts.ts 的 LearningRunPublicV1，带文案 label
 * 字段）之间的纯函数映射。UI 意图（LearningRunUiIntentV1）映射为 wire 动作
 * 或提交计划；P4 结构化交互与未支持路径返回 null（fail closed，绝不伪造）。
 */

import type {
  LearningRunActionV1,
  LearningRunPublicV1 as WireRunV1,
  SubmitTaskArtifactV1,
  TaskInteractionV1 as WireInteractionV1,
} from "@ailearn/shared";
import type {
  LearningRunPublicV1 as UiRunV1,
  LearningRunUiIntentV1,
  LearningTaskDraftV1 as UiDraftV1,
  LearningTaskInteractionV1 as UiInteractionV1,
} from "./contracts";

const ORIGIN_LABELS: Record<string, string> = {
  card: "学习卡",
  review: "到期复习",
  star_map: "理解星图",
  today: "今日学习",
  onboarding: "首次引导",
};

/** gapFacets（intent 标识）→ 中文可读文案（结果页"仍需巩固"展示用）。 */
const INTENT_LABELS: Record<string, string> = {
  recall: "回忆",
  paraphrase: "转述",
  explain: "解释",
  example: "举例",
  apply: "应用",
  boundary: "边界",
  procedure: "步骤",
  relate: "关联",
  repair: "补强",
};

const PHASE_LABELS: Record<string, string> = {
  preparing: "正在准备",
  active: "开始作答",
  assessing: "正在独立评估",
  checkpoint: "需要你的决定",
  committing: "正在写入学习结果",
  paused: "已暂停",
  completed: "本轮完成",
  ended: "已结束",
  skipped: "已跳过",
  cancelled: "已取消",
  stale: "已过期",
  recoverable_error: "可恢复的故障",
};

export function originLabel(run: WireRunV1): string {
  return ORIGIN_LABELS[run.origin.kind] ?? "学习运行";
}

export function returnLabel(run: WireRunV1): string {
  switch (run.returnTarget.kind) {
    case "card": return "返回学习卡";
    case "review": return "返回复习队列";
    case "star_map": return "返回理解星图";
    case "today": return "返回今日学习";
    case "onboarding": return "返回学习首页";
  }
}

/** 将 ISO 日期字符串格式化为中文可读日期（如 "8月20日"）。 */
function formatDueDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return iso;
  }
}

export function phaseLabel(run: WireRunV1): string {
  if (run.phase === "active") {
    return `${run.activeSecondsUsed}/${run.plannedActiveSeconds} 秒`;
  }
  return PHASE_LABELS[run.phase] ?? run.phase;
}

/** wire interaction → UI interaction（补 UI 渲染所需的默认展示参数）。 */
function adaptInteraction(interaction: WireInteractionV1): UiInteractionV1 {
  if (interaction.kind === "voice_teachback") {
    return { kind: "voice_teachback", maxSeconds: interaction.maxSeconds, language: "zh-CN", availability: "available" };
  }
  return interaction as UiInteractionV1;
}

/** wire 快照 → UI 快照（纯函数；无 label 来源时用保守文案）。 */
export function adaptRunToUi(run: WireRunV1): UiRunV1 {
  const task = run.activeTask;
  return {
    runId: run.runId,
    origin: run.origin.kind,
    originLabel: originLabel(run),
    returnLabel: returnLabel(run),
    keyPointTitle: task?.targetSummary ?? "",
    keyPointContext: `${originLabel(run)} · ${run.target.keyPointId.slice(0, 8)}`,
    phase: run.phase,
    timeBudgetSeconds: run.timeBudgetSeconds,
    plannedActiveSeconds: run.plannedActiveSeconds,
    activeSecondsUsed: run.activeSecondsUsed,
    progressLabel: phaseLabel(run),
    activeTask: task
      ? {
          taskId: task.taskId,
          sequence: task.sequence,
          intent: task.intent,
          purpose: task.activeVariant.purpose,
          title: task.targetSummary,
          prompt: task.prompt,
          targetSummary: task.targetSummary,
          interaction: adaptInteraction(task.activeVariant.interaction),
          alternatives: task.availableAlternatives.map((alt) => ({
            alternativeId: alt.alternativeId,
            label: alt.family === "voice" ? "用说的方式" : alt.family === "text" ? "用写的方式" : "换一种操作",
            detail: alt.family === "voice" ? "口头回答后确认转写" : alt.family === "text" ? "写下你的回答" : "结构化操作",
            interactionKind: alt.family === "voice" ? "voice_teachback" : alt.family === "text" ? "text_response" : "ordering",
            trustCeiling: alt.maximumPurpose === "formal" ? "mastery_eligible" : "facet_eligible",
          })),
          trustCeiling: task.activeVariant.templateTrustCeiling,
          estimatedActiveSeconds: task.activeVariant.estimatedActiveSeconds,
          // 2026-08-16（实机验证修复）：hint 透传——hook 在 hint_revealed 后
          // 把提示文本合并进 wire task（TaskChrome 据此渲染提示卡）。
          hint: (task as { hint?: string }).hint,
          status: task.status,
          revision: task.revision,
        }
      : null,
    activeAssessment: run.activeAssessment
      ? {
          assessmentId: run.activeAssessment.assessmentId,
          status: run.activeAssessment.status,
          statusDetail: run.activeAssessment.status === "queued"
            ? "已排队"
            : run.activeAssessment.status === "running"
              ? "评估中"
              : run.activeAssessment.status === "completed"
                ? "评估完成，正在确认学习记录与复习安排"
                : run.activeAssessment.status === "failed"
                  ? "评估未完成，正在等待重试"
                  : "处理中",
        }
      : null,
    checkpoint: run.checkpoint
      ? {
          kind: run.checkpoint.kind,
          title: run.checkpoint.kind === "partial" ? "已证明一部分" : run.checkpoint.kind === "not_assessable" ? "这次无法评估" : "已跳过该题",
          detail: run.checkpoint.kind === "not_assessable"
            ? "0 学习副作用；你可以换一种方式，或直接结束本轮。"
            : "你可以继续证明剩余部分，或按现有证据结算。",
          primaryAction: run.checkpoint.kind === "not_assessable"
            ? (run.checkpoint.allowedFollowupIds?.[0] ? "重新作答一次" : "结束本轮")
            : (run.checkpoint.allowedFollowupIds?.[0] ? "用 30 秒补上缺失点" : "结算"),
        }
      : null,
    failure: run.failure
      ? {
          stage: run.failure.stage,
          title: run.failure.stage === "prepare" ? "准备失败" : run.failure.stage === "assessment" ? "评估失败" : "写入失败",
          detail: run.failure.code,
          retryLabel: run.failure.retryable ? "重试" : "结束本轮",
        }
      : null,
    result: run.result
      ? {
          outcome: run.result.outcome,
          eyebrow: "本轮结果",
          // 2026-08-16（实机验证修复）：兜底不再是 outcome 原值——此前
          // practice_completed/skipped 等会直接把英文状态码当标题渲染。
          title: run.result.outcome === "demonstrated"
            ? "证明了这项理解"
            : run.result.outcome === "partial"
              ? "证明了其中一部分"
              : run.result.outcome === "needs_repair"
                ? "这次没有完全证明"
                : run.result.outcome === "not_assessable"
                  ? "这次无法评估"
                  : run.result.outcome === "declared_unable"
                    ? "已记录：本次还不会"
                    : run.result.outcome === "practice_completed"
                      ? "本轮练习完成"
                      : run.result.outcome === "skipped"
                        ? "本轮已跳过"
                        : run.result.outcome,
          // 2026-08-16（实机验证修复）：gapFacets 是 intent 标识——映射为中文
          // 可读文案（此前直接拼原始英文如 "explain"）。
          summary: run.result.gapFacets.length > 0
            ? `仍需巩固：${run.result.gapFacets.map((f) => INTENT_LABELS[f as keyof typeof INTENT_LABELS] ?? f).join("、")}`
            : "",
          demonstratedFacets: run.result.demonstratedFacets,
          gapFacets: run.result.gapFacets,
          scheduleImpact: run.result.scheduleImpact.kind === "created"
            ? { kind: "created", dueLabel: formatDueDate(run.result.scheduleImpact.dueAt), explanation: "已安排下一次复习" }
            : run.result.scheduleImpact.kind === "rescheduled"
              ? { kind: "rescheduled", dueLabel: formatDueDate(run.result.scheduleImpact.dueAt), explanation: "复习时间已更新" }
              : { kind: "none", explanation: "本次不改变复习安排" },
          nextStep: "返回后继续",
        }
      : null,
    revision: run.revision,
  };
}

export type UiIntentPlan =
  | { kind: "action"; action: LearningRunActionV1 }
  | { kind: "submit"; request: Omit<SubmitTaskArtifactV1, "runRevision" | "taskRevision" | "idempotencyKey"> }
  | { kind: "navigate_back" }
  | { kind: "none" };

/** UI 意图 → wire 调用计划（P3 只支持 text/voice/declared_unable 与基础动作）。 */
export function planUiIntent(run: WireRunV1, intent: LearningRunUiIntentV1): UiIntentPlan {
  const task = run.activeTask;
  switch (intent.kind) {
    case "back":
    case "leave_while_waiting":
      return { kind: "navigate_back" };
    case "create_fresh_run":
      return { kind: "navigate_back" }; // 返回来源后由入口重建（§6.5 不自动连播）。
    case "pause":
      return { kind: "action", action: { kind: "pause" } };
    case "resume":
      return { kind: "action", action: { kind: "resume" } };
    case "end":
      return {
        kind: "action",
        action: { kind: "end", abandonLockedEvidence: run.phase === "assessing" || run.phase === "committing" },
      };
    case "retry":
      if (run.failure?.stage === "assessment" && run.activeAssessment) {
        return { kind: "action", action: { kind: "retry_assessment", assessmentId: run.activeAssessment.assessmentId } };
      }
      if (run.failure?.stage === "commit") return { kind: "action", action: { kind: "retry_commit" } };
      return { kind: "action", action: { kind: "retry_prepare" } };
    case "switch_variant":
      return { kind: "action", action: { kind: "switch_variant", alternativeId: intent.alternativeId } };
    case "request_hint":
      return { kind: "action", action: { kind: "request_hint", level: intent.level ?? 1 } };
    case "skip_task":
      if (!task) return { kind: "none" };
      return { kind: "action", action: { kind: "skip_task", taskId: task.taskId } };
    case "declare_unable":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
        },
      };
    case "submit_text":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: { kind: "text", text: intent.text },
        },
      };
    case "submit_voice":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: {
            kind: "voice",
            confirmedTranscript: intent.transcript,
            // §7.5：correction method 透传（none/re_recorded/manual_text_edit）。
            ...(intent.correctionMethod ? { correctionMethod: intent.correctionMethod } : {}),
          },
        },
      };
    case "checkpoint_primary":
      // §6.2/§13.2：主按钮在服务端预授权 followup 时优先激活补充任务
      // （partial → 微修补；not_assessable → 重新作答）。
      if (run.checkpoint?.kind === "not_assessable") {
        const followup = run.checkpoint.allowedFollowupIds?.[0];
        if (followup) return { kind: "action", action: { kind: "activate_followup", followupId: followup } };
        return { kind: "action", action: { kind: "finish_without_commit" } };
      }
      if (run.checkpoint?.kind === "partial") {
        const followup = run.checkpoint.allowedFollowupIds?.[0];
        if (followup) return { kind: "action", action: { kind: "activate_followup", followupId: followup } };
        return { kind: "action", action: { kind: "finish_current_evidence" } };
      }
      return { kind: "none" };
    case "finish_checkpoint":
      // "按当前结果结束"：明确的收尾语义，绝不触发补充任务。
      if (run.checkpoint?.kind === "not_assessable") {
        return { kind: "action", action: { kind: "finish_without_commit" } };
      }
      if (run.checkpoint?.kind === "partial") {
        return { kind: "action", action: { kind: "finish_current_evidence" } };
      }
      return { kind: "none" };
    case "submit_ordering":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: { kind: "ordering", orderedTokenIds: intent.orderedTokenIds, interactionRefs: [] },
        },
      };
    case "submit_relation":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: {
            kind: "relation",
            edges: [{ fromNodeId: intent.fromNodeId, toNodeId: intent.toNodeId, edgeKind: intent.edgeKind as never }],
            interactionRefs: [],
          },
        },
      };
    case "submit_structured_bundle":
      // §5.3/§12.3：一次原子提交 bundle Artifact（两个 part 全部完成后）。
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: {
            kind: "structured_bundle",
            // wire 合同 tuple（1-2 part）；组件保证全部 part 完成后提交。
            partAnswers: intent.partAnswers as never,
            interactionRefs: [],
          },
        },
      };
    case "submit_repair":
      return {
        kind: "submit",
        request: {
          version: 1,
          variantId: task?.activeVariant.variantId ?? "",
          variantRevision: task?.activeVariant.revision ?? 1,
          inputSchemaHash: task?.activeVariant.inputSchemaHash ?? "",
          payload: {
            kind: "repair",
            operations: [{ op: "replace", elementId: intent.elementId, replacementOptionId: intent.replacementOptionId }],
            interactionRefs: [],
          },
        },
      };
    case "submit_choice_with_rationale":
    case "submit_scenario":
      // §7.7：choice/scenario 不突破 V1 上限（planner 不生成），fail closed。
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/** UI 草稿（renderer 层）→ wire draft payload（learningDraftPayloadSchema）。
 *
 * 方案 16 §13.1：wire 契约以 shared/learning-run-contracts.ts 为准。
 * text/voice/ordering/relation/repair 直接映射；choice/scenario P4 上限外
 * （planner 不生成），返回 null 由调用方跳过保存（fail closed）。
 */
export function adaptDraftToWire(
  draft: UiDraftV1,
): { kind: string; payload: unknown } | null {
  switch (draft.kind) {
    case "text_response":
      return { kind: "text", payload: { kind: "text", text: draft.text } };
    case "voice_teachback":
      return {
        kind: "voice",
        payload: { kind: "voice", unconfirmedTranscript: draft.transcript },
      };
    case "ordering":
      return {
        kind: "ordering",
        payload: { kind: "ordering", orderedTokenIds: draft.orderedTokenIds, interactionRefs: [] },
      };
    case "repair":
      if (!draft.elementId || !draft.replacementOptionId) return null;
      return {
        kind: "repair",
        payload: {
          kind: "repair",
          operations: [{ op: "replace", elementId: draft.elementId, replacementOptionId: draft.replacementOptionId }],
          interactionRefs: [],
        },
      };
    case "relation":
      if (!draft.fromNodeId || !draft.toNodeId || !draft.edgeKind) return null;
      return {
        kind: "relation",
        payload: {
          kind: "relation",
          edges: [{ fromNodeId: draft.fromNodeId, toNodeId: draft.toNodeId, edgeKind: draft.edgeKind }],
          interactionRefs: [],
        },
      };
    case "structured_bundle":
      // §12.7：bundle 部分完成只存 draft；全部 part 完成后由组件一次提交。
      return {
        kind: "structured_bundle",
        payload: {
          kind: "structured_bundle",
          partAnswers: draft.partAnswers,
          interactionRefs: [],
        },
      };
    // P4 上限外（planner 不生成）：fail closed，不向 wire 层持久化 UI 草稿。
    case "choice_with_rationale":
    case "scenario":
      return null;
    default:
      return null;
  }
}

/** wire draft payload → UI 草稿（恢复方向的逆映射；未知形状 fail closed 返回 null）。 */
export function adaptWireDraftToUi(payload: unknown): UiDraftV1 | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = payload as { kind?: unknown };
  if (candidate.kind === "structured_bundle") {
    // §12.7：bundle 部分完成草稿（partAnswers 可缺 part；提交才要求完整）。
    const partAnswers = (payload as { partAnswers?: unknown }).partAnswers;
    if (!Array.isArray(partAnswers)) return null;
    return {
      kind: "structured_bundle",
      partAnswers: partAnswers as Array<
        | { kind: "ordering"; orderedTokenIds: string[] }
        | { kind: "relation"; edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }> }
        | { kind: "repair"; operations: Array<{ op: string; elementId: string; replacementOptionId: string }> }
      >,
    };
  }
  if (candidate.kind === "text") {
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? { kind: "text_response", text } : null;
  }
  if (candidate.kind === "voice") {
    const transcript = (payload as { unconfirmedTranscript?: unknown }).unconfirmedTranscript;
    return typeof transcript === "string"
      ? { kind: "voice_teachback", transcript }
      : null;
  }
  if (candidate.kind === "ordering") {
    const orderedTokenIds = (payload as { orderedTokenIds?: unknown }).orderedTokenIds;
    return Array.isArray(orderedTokenIds) && orderedTokenIds.every((id) => typeof id === "string")
      ? { kind: "ordering", orderedTokenIds: orderedTokenIds as string[] }
      : null;
  }
  if (candidate.kind === "repair") {
    const operations = (payload as { operations?: unknown }).operations;
    const first = Array.isArray(operations) ? (operations[0] as { op?: unknown; elementId?: unknown; replacementOptionId?: unknown } | undefined) : undefined;
    if (first?.op === "replace" && typeof first.elementId === "string" && typeof first.replacementOptionId === "string") {
      return { kind: "repair", elementId: first.elementId, replacementOptionId: first.replacementOptionId };
    }
    return null;
  }
  if (candidate.kind === "relation") {
    const edges = (payload as { edges?: unknown }).edges;
    const first = Array.isArray(edges) ? (edges[0] as { fromNodeId?: unknown; toNodeId?: unknown; edgeKind?: unknown } | undefined) : undefined;
    if (first && typeof first.fromNodeId === "string" && typeof first.toNodeId === "string" && typeof first.edgeKind === "string") {
      return { kind: "relation", fromNodeId: first.fromNodeId, toNodeId: first.toNodeId, edgeKind: first.edgeKind };
    }
    return null;
  }
  // 结构化 wire payload 无对应 UI 草稿形状（P4 上限外）：fail closed。
  return null;
}
