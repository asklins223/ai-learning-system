"use client";

/**
 * 运行概览侧栏（设计稿"暖纸编辑主题"）。
 *
 * - 当前任务卡：阶段描述 + mini 进度
 * - 阶段统计：候选 / 已完成 / 运行中
 * - 质量状态：原文证据覆盖 / 重复候选 / 阻塞性错误
 * - 技术详情：可折叠的 engine / unit 计数 / model activity / trace id
 *
 * 所有数值来自 run 视图（coverage）与 metrics（真实计数）。
 */

import { useState } from "react";
import type { AgentEventView, CardGenerationRunView } from "@/lib/api";
import { agentEventRowText } from "./agent-event-text";

export interface GenerationRunSummaryProps {
  run: CardGenerationRunView;
  /** 最新代理事件（用于让"当前任务"随活动流实时变化） */
  latestEvent?: AgentEventView | null;
}

/**
 * 当前任务描述：优先用最新代理事件实时反映"正在做什么"，
 * 让概览卡片不再停留在单一阶段文案；无事件时回退到阶段文案。
 */
export function currentGenerationTask(
  run: CardGenerationRunView,
  latestEvent: AgentEventView | null,
): { title: string; copy: string } {
  if (latestEvent) {
    const view = agentEventRowText(latestEvent);
    const inProgress = view.status === "running";
    const title = `${inProgress ? "正在" : ""}${view.text}`;
    const role = view.roleLabel;
    const copy = role
      ? `${role} · ${inProgress ? "执行中" : "已完成"}`
      : "代理活动实时更新";
    return { title, copy };
  }
  const stage = run.shellStage ?? run.stage;
  if (stage === "preparing") {
    return { title: "正在建立文章结构", copy: "把封存的笔记内容规划为可处理的素材单元。" };
  }
  if (stage === "checking") {
    return { title: "正在验证支撑与覆盖", copy: "逐条核对候选卡片的原文证据与引用完整性。" };
  }
  if (stage === "publishing") {
    return { title: "正在发布学习卡", copy: "把校验通过的草稿写入学习卡库。" };
  }
  if (stage === "generating") {
    return { title: "正在提炼关键理解", copy: "识别关键概念、关系与可验证的学习要点。" };
  }
  return { title: "生成学习卡", copy: "后台代理正在协作生成。" };
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens == null || tokens <= 0) return "—";
  if (tokens >= 1000) return `≈ ${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `≈ ${tokens} tokens`;
}

export function GenerationRunSummary({ run, latestEvent = null }: GenerationRunSummaryProps) {
  const [techOpen, setTechOpen] = useState(false);
  const metrics = run.metrics;
  const coverage = run.coverage;

  const task = currentGenerationTask(run, latestEvent);

  const miniPct = coverage.sourceCoverageBps != null
    ? Math.max(0, Math.min(100, Math.round(coverage.sourceCoverageBps / 100)))
    : 0;

  const coverageValue = coverage.sourceCoverageBps != null
    ? `${coverage.sourceUnitsCompleted}/${coverage.sourceUnitsTotal}`
    : "待测量";

  const alerts: string[] = [];
  if (metrics && metrics.candidates.rejected > 0) {
    alerts.push(`重复 / 无效候选：已排除 ${metrics.candidates.rejected} 条`);
  }
  if (metrics && metrics.critic.hardIssues > 0) {
    alerts.push(`阻塞性问题：${metrics.critic.hardIssues} 个`);
  }

  const engineLabel: Record<string, string> = {
    supervisor_agent_v1: "supervisor_agent_v1",
  };

  return (
    <div className="gen-progress-side-content">
      {/* 当前任务 */}
      <div className="gen-current-card">
        <div className="gen-current-label">当前任务</div>
        <div className="gen-current-title">{task.title}</div>
        <p className="gen-current-copy">{task.copy}</p>
        <div className="gen-mini-progress" aria-label={`当前任务完成 ${miniPct}%`}>
          <span style={{ width: `${miniPct}%` }} />
        </div>
      </div>

      {/* 阶段统计 */}
      <div className="gen-stats" aria-label="阶段统计">
        <div className="gen-stat">
          <div className="gen-stat-label">候选</div>
          <div className="gen-stat-value">{metrics?.candidates.extracted ?? 0}</div>
        </div>
        <div className="gen-stat">
          <div className="gen-stat-label">已完成</div>
          <div className="gen-stat-value">{metrics?.childTasks.completed ?? 0}</div>
        </div>
        <div className="gen-stat">
          <div className="gen-stat-label">运行中</div>
          <div className="gen-stat-value">{metrics?.childTasks.running ?? 0}</div>
        </div>
      </div>

      {/* 质量状态 */}
      <div className="gen-section-title">质量状态</div>
      <div className="gen-summary-list">
        <div className="gen-summary-row">
          <span>原文证据覆盖</span>
          <strong>{coverageValue}</strong>
        </div>
        {alerts.map((alert) => (
          <div key={alert} className="gen-alert">{alert}</div>
        ))}
      </div>

      {/* 技术详情（可折叠） */}
      <button
        type="button"
        className="gen-tech-toggle"
        aria-expanded={techOpen}
        aria-controls="gen-tech-details"
        onClick={() => setTechOpen((open) => !open)}
      >
        <span>技术详情</span>
        <span aria-hidden="true">{techOpen ? "⌃" : "⌄"}</span>
      </button>
      <div className={`gen-tech-details${techOpen ? " is-open" : ""}`} id="gen-tech-details">
        engine: {engineLabel[run.engineMode] ?? run.engineMode}<br />
        {metrics
          ? `completed: ${metrics.childTasks.completed} / running: ${metrics.childTasks.running} / queued: ${metrics.childTasks.pending}`
          : "units: —"}<br />
        model activity: {formatTokens(metrics?.usageTokens)}<br />
        trace id: {run.runId}
      </div>
    </div>
  );
}
