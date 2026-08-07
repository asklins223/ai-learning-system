import type { EventSummaryEntry } from "./context-builder.ts";

/**
 * P4-5: Agent Execution Summary 回灌(实施计划 §5.4)。
 *
 * 模型上下文**不再默认加载 200 条原始 Event**;改为加载聚合摘要
 * AgentExecutionSummary(completed/failed tool calls、child tasks、latest decision),
 * 诊断时按需读取原始 Event。
 *
 * 纯函数:输入原始 events,输出摘要。
 */

export interface AgentExecutionSummary {
  completedToolCalls: number;
  failedToolCalls: number;
  childTasks: Array<{ taskId: string; status: string; createdAt: string }>;
  latestDecision: {
    eventKey: string;
    createdAt: string;
    summary: string;
  } | null;
  /** 是否发生截断(超出保留上限只保留最近 N 条时的标记) */
  truncated: boolean;
}

/** 摘要保留的原始事件上限(超出只统计、不逐条进摘要) */
export const EXECUTION_SUMMARY_EVENT_CAP = 200;

/** 从原始 events 构建摘要(纯函数) */
export function buildAgentExecutionSummary(events: EventSummaryEntry[]): AgentExecutionSummary {
  const truncated = events.length > EXECUTION_SUMMARY_EVENT_CAP;

  let completedToolCalls = 0;
  let failedToolCalls = 0;
  const childTasks: AgentExecutionSummary["childTasks"] = [];
  let latestDecision: AgentExecutionSummary["latestDecision"] = null;

  for (const e of events) {
    if (e.eventType === "tool_result") {
      const success = e.safeDetails?.success === true;
      if (success) completedToolCalls += 1;
      else failedToolCalls += 1;
    } else if (e.eventType === "child_task_created") {
      childTasks.push({
        taskId: String(e.safeDetails?.taskId ?? "unknown"),
        status: String(e.safeDetails?.status ?? "pending"),
        createdAt: e.createdAt,
      });
    } else if (e.eventType === "decision" || e.eventType === "latest_decision") {
      // 保留最新一条决策(时间靠后覆盖)
      latestDecision = {
        eventKey: String(e.safeDetails?.eventKey ?? ""),
        createdAt: e.createdAt,
        summary: String(e.safeDetails?.summary ?? ""),
      };
    }
  }

  return {
    completedToolCalls,
    failedToolCalls,
    childTasks,
    latestDecision,
    truncated,
  };
}

/** 摘要的紧凑文本表示(供 context 注入,默认替代原始 200 条) */
export function formatAgentExecutionSummary(summary: AgentExecutionSummary): string {
  const lines: string[] = [];
  lines.push(`已完成工具调用: ${summary.completedToolCalls};失败工具调用: ${summary.failedToolCalls}`);
  if (summary.childTasks.length > 0) {
    lines.push(
      `子任务: ${summary.childTasks
        .slice(0, 20)
        .map((t) => `${t.taskId}(${t.status})`)
        .join(", ")}${summary.childTasks.length > 20 ? ` 等 ${summary.childTasks.length} 个` : ""}`,
    );
  }
  if (summary.latestDecision) {
    lines.push(`最新决策: ${summary.latestDecision.summary}(${summary.latestDecision.createdAt})`);
  }
  if (summary.truncated) {
    lines.push("(事件超出摘要上限,按需读取原始 Event)");
  }
  return lines.join("\n");
}
