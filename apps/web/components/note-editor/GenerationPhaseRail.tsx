"use client";

/**
 * 学习卡生成阶段轨道。
 *
 * 轨道只呈现后端真实 shellStage；旧 run 没有 shellStage 时才从 stage
 * 做一对一回退。阶段名称面向学习价值，而计数仍全部来自 run 聚合视图。
 */

import type { CardGenerationRunView } from "@/lib/api";
import { shellStageStepStates } from "./note-editor-utils";

export interface GenerationPhaseRailProps {
  run: CardGenerationRunView;
  /** 抽屉等窄容器使用紧凑形态。 */
  compact?: boolean;
}

type PhaseKey = "preparing" | "generating" | "checking" | "publishing";

function normalizedShellStage(run: CardGenerationRunView): PhaseKey | null {
  const stage = run.shellStage ?? run.stage;
  if (stage === "queued" || stage === "preparing" || stage === "snapshot") return "preparing";
  if (stage === "running" || stage === "generating") return "generating";
  if (stage === "validating" || stage === "checking") return "checking";
  if (stage === "publishing" || stage === "complete") return "publishing";
  return null;
}

export function generationPhasePosition(run: CardGenerationRunView): number {
  const key = normalizedShellStage(run);
  if (key === "preparing") return 1;
  if (key === "generating") return 2;
  if (key === "checking") return 3;
  if (key === "publishing") return 4;
  return 1;
}

export function GenerationPhaseRail({ run, compact = false }: GenerationPhaseRailProps) {
  const stage = normalizedShellStage(run);
  const states = shellStageStepStates(stage);

  const steps = [
    {
      key: "prepare",
      state: states.prepare,
      name: "理解素材",
      desc: `读取 v${run.sourceSnapshot.versionNo} 的结构与重点`,
    },
    {
      key: "generate",
      state: states.agentRun,
      name: "设计提问",
      desc: "把关键理解转成可练习的问题",
    },
    {
      key: "check",
      state: states.verify,
      name: "核对依据",
      desc: "检查答案、来源与质量规则",
    },
    {
      key: "publish",
      state: states.publish,
      name: "发布结果",
      desc: "写入当前学习卡库",
    },
  ] as const;

  return (
    <ol
      className="lcg-phase-rail"
      aria-label="学习卡生成阶段"
      data-compact={compact || undefined}
      data-shell-stage={stage ?? undefined}
    >
      {steps.map((step, index) => (
        <li
          key={step.key}
          className="lcg-phase"
          data-state={step.state}
          aria-current={step.state === "active" ? "step" : undefined}
        >
          <span className="lcg-phase-marker" aria-hidden="true">
            {step.state === "done" ? "✓" : index + 1}
          </span>
          <span className="lcg-phase-copy">
            <strong>{step.name}</strong>
            {!compact && <small>{step.desc}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
