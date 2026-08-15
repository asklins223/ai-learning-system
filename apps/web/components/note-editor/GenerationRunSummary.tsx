"use client";

/**
 * 生成结果摘要。
 *
 * 默认只展示用户真正关心的三件事：现在做到哪里、筛出了什么、质量是否
 * 可靠。引擎与 run id 被收进诊断详情，不再和学习价值争夺首屏注意力。
 */

import { useId, useState } from "react";
import type { AgentEventView, CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { agentEventRowText } from "./agent-event-text";

export interface GenerationRunSummaryProps {
  run: CardGenerationRunView;
  /** 最新代理事件，只用于安全的用户态文案映射。 */
  latestEvent?: AgentEventView | null;
}

export function currentGenerationTask(
  run: CardGenerationRunView,
  latestEvent: AgentEventView | null,
): { title: string; copy: string } {
  if (latestEvent) {
    const view = agentEventRowText(latestEvent);
    const inProgress = view.status === "running";
    return {
      title: inProgress ? `正在${view.text}` : view.text,
      copy: view.roleLabel
        ? `${view.roleLabel} · ${inProgress ? "执行中" : "已完成"}`
        : "处理记录实时更新",
    };
  }

  const stage = run.shellStage ?? run.stage;
  if (stage === "queued") {
    return { title: "等待开始", copy: "任务已经接受，可以返回笔记继续编辑。" };
  }
  if (stage === "preparing") {
    return { title: "正在理解这篇笔记", copy: "先辨认结构和重点，不按段落机械拆卡。" };
  }
  if (stage === "checking" || stage === "validating") {
    return { title: "正在检查结果质量", copy: "核对证据、答案和当前生成规则。" };
  }
  if (stage === "publishing") {
    return { title: "正在整理最终结果", copy: "只保存通过质量筛选的学习内容。" };
  }
  if (stage === "generating" || stage === "running") {
    return { title: "正在设计可回忆的问题", copy: "把关键理解转成需要主动思考才能回答的提问。" };
  }
  return { title: "正在生成学习卡", copy: "结果会根据内容价值决定数量，可能一张也不生成。" };
}

function evidenceLabel(run: CardGenerationRunView): string {
  const coverage = run.coverage;
  if (coverage.sourceUnitsTotal <= 0) return "等待检查";
  if (coverage.sourceUnitsCompleted >= coverage.sourceUnitsTotal) return "已完成原文核对";
  return "正在核对";
}

export function GenerationRunSummary({ run, latestEvent = null }: GenerationRunSummaryProps) {
  const [techOpen, setTechOpen] = useState(false);
  const techId = useId();
  const metrics = run.metrics;
  const task = currentGenerationTask(run, latestEvent);
  const rejected = metrics?.candidates.rejected ?? null;
  const blockingIssues = metrics?.critic.hardIssues ?? 0;

  return (
    <div className="lcg-run-summary">
      <section className="lcg-current-task" aria-labelledby="lcg-current-task-title">
        <span className="lcg-current-task-icon" aria-hidden="true"><Icon.Sparkle /></span>
        <div>
          <p>当前正在做</p>
          <h3 id="lcg-current-task-title">{task.title}</h3>
          <span>{task.copy}</span>
        </div>
      </section>

      <section className="lcg-quality-ledger" aria-label="质量检查">
        <div>
          <span className="lcg-quality-icon" data-tone="success" aria-hidden="true"><Icon.Quote /></span>
          <span><strong>原文证据</strong><small>{evidenceLabel(run)}</small></span>
        </div>
        <div>
          <span className="lcg-quality-icon" data-tone={rejected && rejected > 0 ? "success" : "neutral"} aria-hidden="true"><Icon.Filter /></span>
          <span><strong>质量筛选</strong><small>{rejected && rejected > 0 ? "已执行去重与质量过滤" : "持续检查中"}</small></span>
        </div>
        <div>
          <span className="lcg-quality-icon" data-tone={blockingIssues > 0 ? "warning" : "success"} aria-hidden="true">
            {blockingIssues > 0 ? <Icon.Warn /> : <Icon.Check />}
          </span>
          <span><strong>阻塞问题</strong><small>{blockingIssues > 0 ? "发现需要处理的问题" : "暂未发现"}</small></span>
        </div>
      </section>

      <button
        type="button"
        className="lcg-diagnostic-toggle"
        aria-expanded={techOpen}
        aria-controls={techId}
        onClick={() => setTechOpen((open) => !open)}
      >
        <span>运行诊断</span>
        <Icon.Chevron aria-hidden="true" />
      </button>
      <div className="lcg-diagnostic" id={techId} hidden={!techOpen}>
        <dl>
          <div><dt>来源版本</dt><dd>v{run.sourceSnapshot.versionNo}</dd></div>
          <div><dt>引擎</dt><dd>{run.engineMode}</dd></div>
          <div><dt>任务</dt><dd>{run.runId}</dd></div>
          <div><dt>状态序号</dt><dd>{run.stateVersion}</dd></div>
        </dl>
      </div>
    </div>
  );
}
