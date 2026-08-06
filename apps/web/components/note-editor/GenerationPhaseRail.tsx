"use client";

/**
 * 生成阶段 stepper（设计稿"暖纸编辑主题"）。
 *
 * 阶段仍由 `shellStage` 推导（graph-plan §9.1），角色名不进入阶段栏。
 * 每步展示真实计数（来自 run.metrics / coverage），不是百分比。
 */

import type { CardGenerationRunView } from "@/lib/api";
import { shellStageStepStates } from "./note-editor-utils";

export interface GenerationPhaseRailProps {
  run: CardGenerationRunView;
}

export function GenerationPhaseRail({ run }: GenerationPhaseRailProps) {
  const states = shellStageStepStates(run.shellStage);
  const metrics = run.metrics;

  // 准备素材：bundles 总数 + 语义索引模式
  let prepareDesc = "等待建立文章结构";
  if (metrics && metrics.bundles.required > 0) {
    prepareDesc = `已建立 ${metrics.bundles.required} 个文本单元`;
  }

  // 提炼卡片：child tasks / candidates 计数
  let agentDesc = "多角色协作生成";
  if (metrics) {
    const child = metrics.childTasks;
    if (child.completed > 0 || child.running > 0) {
      agentDesc = `${child.completed}/${Math.max(child.completed + child.running + child.pending, 1)} 任务完成`;
    } else if (metrics.candidates.extracted > 0) {
      agentDesc = `已提取 ${metrics.candidates.extracted} 个候选`;
    }
  }

  // 引用校验：critic 状态 + verify
  let verifyDesc = "等待验证支撑";
  if (metrics) {
    if (metrics.critic.status === "passed") {
      verifyDesc = "支撑校验通过";
    } else if (metrics.critic.status === "failed") {
      verifyDesc = `待处理 · 硬 ${metrics.critic.hardIssues} / 软 ${metrics.critic.softIssues}`;
    } else if (metrics.verify) {
      verifyDesc = `校验 ${metrics.verify.passedChecks}/${metrics.verify.totalChecks}`;
    }
  }

  // 发布卡组：draft 版本
  let publishDesc = "生成草稿并保存";
  if (metrics && metrics.draft.version > 0) {
    publishDesc = `草稿 v${metrics.draft.version}`;
  }

  const steps = [
    {
      state: states.prepare,
      index: states.prepare === "done" ? "✓" : "1",
      name: "准备素材",
      desc: prepareDesc,
    },
    {
      state: states.agentRun,
      index: states.agentRun === "done" ? "✓" : "2",
      name: "提炼卡片",
      desc: agentDesc,
    },
    {
      state: states.verify,
      index: states.verify === "done" ? "✓" : "3",
      name: "引用校验",
      desc: verifyDesc,
    },
    {
      state: states.publish,
      index: states.publish === "done" ? "✓" : "4",
      name: "发布卡组",
      desc: publishDesc,
    },
  ];

  return (
    <ol className="gen-progress-stepper" aria-label="生成进度" data-shell-stage={run.shellStage ?? undefined}>
      {steps.map((step) => (
        <li
          key={step.name}
          className="gen-progress-step"
          data-state={step.state}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <span className="gen-progress-step-index" aria-hidden="true">{step.index}</span>
          <div>
            <strong className="gen-progress-step-name">{step.name}</strong>
            <p className="gen-progress-step-desc">{step.desc}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
