"use client";

import { memo, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type {
  LearningRunPublicV1,
  LearningRunUiIntentV1,
  LearningTaskDraftV1,
} from "../contracts";
import { TaskRenderer } from "../renderers/TaskRenderer";
import { AssessmentProgress } from "./AssessmentProgress";
import { ResultView } from "./ResultView";
import { RunHeader } from "./RunHeader";
import { TaskChrome } from "./TaskChrome";

type LearningRunPlayerProps = {
  run: LearningRunPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
  drafts?: Record<string, LearningTaskDraftV1>;
  onDraftChange?: (taskId: string, draft: LearningTaskDraftV1) => void;
};

export function LearningRunPlayer({ run, onIntent, drafts, onDraftChange }: LearningRunPlayerProps) {
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [hintWarningOpen, setHintWarningOpen] = useState(false);

  return (
    <section className="learning-run-player" data-phase={run.phase} data-origin={run.origin}>
      <RunHeader run={run} onIntent={onIntent} />
      <div className="learning-run-live-region" role="status" aria-live="polite">
        {run.progressLabel}
      </div>

      <div className="learning-run-player__body">
        <div className="learning-run-context-line">
          <div>
            <span>{run.keyPointContext}</span>
            <strong>{run.keyPointTitle}</strong>
          </div>
          <div className="learning-run-budget" aria-label={`本轮规划 ${run.plannedActiveSeconds} 秒`}>
            <span style={{ "--learning-run-progress": `${Math.min(100, Math.round((run.activeSecondsUsed / Math.max(1, run.plannedActiveSeconds)) * 100))}%` } as React.CSSProperties} />
            <small>{run.progressLabel}</small>
          </div>
        </div>

        {renderPhase(run, onIntent, {
          alternativesOpen,
          setAlternativesOpen,
          setHintWarningOpen,
          drafts,
          onDraftChange,
        })}
      </div>

      <ConfirmDialog
        open={hintWarningOpen}
        title="查看提示后，本题只记为练习"
        message="你仍然可以完成这道题，但它不会升级正式掌握状态，也不会改变复习时间。"
        confirmLabel="降为练习并查看"
        cancelLabel="先不看"
        onCancel={() => setHintWarningOpen(false)}
        onConfirm={() => {
          setHintWarningOpen(false);
          onIntent({ kind: "request_hint", level: 1 });
        }}
      />
    </section>
  );
}

function renderPhase(
  run: LearningRunPublicV1,
  onIntent: (intent: LearningRunUiIntentV1) => void,
  controls: {
    alternativesOpen: boolean;
    setAlternativesOpen: (open: boolean) => void;
    setHintWarningOpen: (open: boolean) => void;
    drafts?: Record<string, LearningTaskDraftV1>;
    onDraftChange?: (taskId: string, draft: LearningTaskDraftV1) => void;
  },
) {
  switch (run.phase) {
    case "active":
      return run.activeTask ? (
        // F#7（🟠4）：active 分支在本组件内联。activeTask 恒定（同 taskId），
        // 把当前任务的 draft 切片 + 稳定 onDraftChange 传给 memo 化的
        // ActiveTaskView，使击键只重渲对应任务 renderer，不连带到
        // RunHeader/TaskChrome/control rail。
        <ActiveTaskView
          run={run}
          onIntent={onIntent}
          alternativesOpen={controls.alternativesOpen}
          setAlternativesOpen={controls.setAlternativesOpen}
          setHintWarningOpen={controls.setHintWarningOpen}
          draft={controls.drafts?.[run.activeTask.taskId]}
          onDraftChange={controls.onDraftChange}
        />
      ) : (
        <GenericState title="当前动作还没有准备好" detail="可以返回来源页面，学习状态不会发生变化。" />
      );
    case "preparing":
      return (
        <section className="learning-run-state-card is-preparing" aria-labelledby="learning-run-preparing-title">
          <div className="learning-run-preparing-mark" aria-hidden="true"><Icon.Sparkle2 /><span /></div>
          <span className="learning-run-state-eyebrow">正在冻结本轮任务</span>
          <h1 id="learning-run-preparing-title">先为这一个要点选择最合适的动作</h1>
          <p>系统正在核对目标、复习授权和你可用的作答方式。你可以随时离开，不会创建空白学习记录。</p>
          <div className="learning-run-preparing-lines" aria-hidden="true"><i /><i /><i /></div>
          <button className="learning-run-button is-secondary" type="button" onClick={() => onIntent({ kind: "back" })}>先返回</button>
        </section>
      );
    case "assessing":
    case "committing":
      return <AssessmentProgress run={run} onIntent={onIntent} />;
    case "checkpoint":
      return <CheckpointView run={run} onIntent={onIntent} />;
    case "paused":
      return (
        <StateActionCard
          tone="neutral"
          icon={<PauseLargeIcon />}
          eyebrow="进度已保留"
          title="这轮学习已经暂停"
          detail="当前题目、作答方式和未提交草稿会留在这里。暂停不算跳过，也不会改变掌握状态。"
          primaryLabel="继续本轮"
          primaryIntent={{ kind: "resume" }}
          secondaryLabel={run.returnLabel}
          secondaryIntent={{ kind: "back" }}
          onIntent={onIntent}
        />
      );
    case "recoverable_error":
      return (
        <StateActionCard
          tone="danger"
          icon={<Icon.Refresh aria-hidden="true" />}
          eyebrow={`${failureStageLabel(run.failure?.stage)}出现问题`}
          title={run.failure?.title ?? "这次处理暂时没有完成"}
          detail={run.failure?.detail ?? "没有生成新的学习结论或调度变化。"}
          primaryLabel={run.failure?.retryLabel ?? "重试"}
          primaryIntent={{ kind: "retry" }}
          secondaryLabel="安全结束"
          secondaryIntent={{ kind: "end" }}
          onIntent={onIntent}
        />
      );
    case "stale":
      return (
        <StateActionCard
          tone="warning"
          icon={<Icon.Refresh aria-hidden="true" />}
          eyebrow="旧任务没有继续执行"
          title="内容或复习状态已经发生变化"
          detail="为避免把旧题答案写进新状态，这次运行已安全过期。需要使用最新内容重新开始。"
          primaryLabel="基于最新内容重新开始"
          primaryIntent={{ kind: "create_fresh_run" }}
          secondaryLabel={run.returnLabel}
          secondaryIntent={{ kind: "back" }}
          onIntent={onIntent}
        />
      );
    case "completed":
      return run.result ? <ResultView run={run} onIntent={onIntent} /> : <GenericState title="结果尚未就绪" detail="没有可展示的最终结算。" />;
    case "ended":
      return <TerminalState title="本轮已结束" detail="未提交的内容没有形成学习证据，已确认的历史结果仍然保留。" run={run} onIntent={onIntent} />;
    case "skipped":
      return <TerminalState title="本轮已跳过" detail="这只表示现在不想做，不会被记录成不会。" run={run} onIntent={onIntent} />;
    case "cancelled":
      return <TerminalState title="本轮已取消" detail="运行时已经停止，没有新增理解或复习副作用。" run={run} onIntent={onIntent} />;
  }
}

type ActiveTaskViewProps = {
  run: LearningRunPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
  alternativesOpen: boolean;
  setAlternativesOpen: (open: boolean) => void;
  setHintWarningOpen: (open: boolean) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (taskId: string, draft: LearningTaskDraftV1) => void;
};

// F#7（🟠4）：memo 化 + per-slot draft 切片隔离。props 中 setState 回调稳定、
// onIntent 由上层 useCallback 稳定、draft 仅当"本任务"的草稿变化才变引用，
// 故击键/恢复其它任务草稿/snapshot 未变的 2s 轮询均不会重渲本组件。
const ActiveTaskView = memo(function ActiveTaskView({ run, onIntent, alternativesOpen, setAlternativesOpen, setHintWarningOpen, draft, onDraftChange }: ActiveTaskViewProps) {
  const task = run.activeTask;
  if (!task) return null;

  return (
    <div className="learning-run-task-layout">
      <article className="learning-run-task-paper">
        <TaskChrome task={task} />
        <TaskRenderer
          key={task.taskId}
          task={task}
          onIntent={onIntent}
          draft={draft}
          onDraftChange={(nextDraft) => onDraftChange?.(task.taskId, nextDraft)}
        />
      </article>

      <aside className="learning-run-control-rail" aria-label="本轮操作">
        <div className="learning-run-control-rail__primary">
          <button
            className="learning-run-rail-action"
            type="button"
            aria-expanded={alternativesOpen}
            onClick={() => setAlternativesOpen(!alternativesOpen)}
          >
            <span className="learning-run-rail-action__icon"><Icon.Switch aria-hidden="true" /></span>
            <span><strong>换个方式</strong><small>切换不会产生负面记录</small></span>
            <Icon.Chevron aria-hidden="true" />
          </button>
          {alternativesOpen ? (
            <div className="learning-run-alternatives">
              {task.alternatives.map((alternative) => (
                <button
                  type="button"
                  key={alternative.alternativeId}
                  onClick={() => {
                    setAlternativesOpen(false);
                    onIntent({ kind: "switch_variant", alternativeId: alternative.alternativeId });
                  }}
                >
                  <strong>{alternative.label}</strong>
                  <span>{alternative.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
          <button className="learning-run-rail-action" type="button" onClick={() => setHintWarningOpen(true)}>
            <span className="learning-run-rail-action__icon"><Icon.Sparkle aria-hidden="true" /></span>
            <span><strong>给我一点提示</strong><small>查看后本题只记为练习</small></span>
            <Icon.Chevron aria-hidden="true" />
          </button>
        </div>

        <div className="learning-run-control-rail__autonomy">
          <p>现在不想继续？</p>
          <button type="button" onClick={() => onIntent({ kind: "skip_task" })}>
            <Icon.Arrow aria-hidden="true" />
            <span><strong>先跳过</strong><small>不评价，也不改变复习</small></span>
          </button>
          <button type="button" onClick={() => onIntent({ kind: "declare_unable" })}>
            <Icon.AlertCircle aria-hidden="true" />
            <span><strong>我确实不会</strong><small>只记录当前选择，不承诺自动改期</small></span>
          </button>
        </div>
      </aside>
    </div>
  );
});

function CheckpointView({ run, onIntent }: { run: LearningRunPublicV1; onIntent: (intent: LearningRunUiIntentV1) => void }) {
  const checkpoint = run.checkpoint;
  if (!checkpoint) return <GenericState title="正在整理当前进度" detail="可以安全返回，不会生成错误结果。" />;
  return (
    <StateActionCard
      tone={checkpoint.kind === "not_assessable" ? "neutral" : "warning"}
      icon={checkpoint.kind === "not_assessable" ? <Icon.AlertCircle aria-hidden="true" /> : <Icon.Target aria-hidden="true" />}
      eyebrow={checkpoint.kind === "not_assessable" ? "没有形成可评估证据" : "这一轮可以在这里停下"}
      title={checkpoint.title}
      detail={checkpoint.detail}
      primaryLabel={checkpoint.primaryAction}
      primaryIntent={{ kind: "checkpoint_primary" }}
      secondaryLabel="按当前结果结束"
      secondaryIntent={{ kind: "finish_checkpoint" }}
      onIntent={onIntent}
    />
  );
}

function StateActionCard({
  tone,
  icon,
  eyebrow,
  title,
  detail,
  primaryLabel,
  primaryIntent,
  secondaryLabel,
  secondaryIntent,
  onIntent,
}: {
  tone: "neutral" | "warning" | "danger";
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  detail: string;
  primaryLabel: string;
  primaryIntent: LearningRunUiIntentV1;
  secondaryLabel: string;
  secondaryIntent: LearningRunUiIntentV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
}) {
  return (
    <section className={`learning-run-state-card is-${tone}`}>
      <span className="learning-run-state-card__icon" aria-hidden="true">{icon}</span>
      <span className="learning-run-state-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      <div className="learning-run-state-card__actions">
        <button className="learning-run-button is-primary" type="button" onClick={() => onIntent(primaryIntent)}>{primaryLabel}</button>
        <button className="learning-run-button is-secondary" type="button" onClick={() => onIntent(secondaryIntent)}>{secondaryLabel}</button>
      </div>
    </section>
  );
}

function TerminalState({ title, detail, run, onIntent }: { title: string; detail: string; run: LearningRunPublicV1; onIntent: (intent: LearningRunUiIntentV1) => void }) {
  return (
    <StateActionCard
      tone="neutral"
      icon={<Icon.Archive aria-hidden="true" />}
      eyebrow="没有新的学习副作用"
      title={title}
      detail={detail}
      primaryLabel={run.returnLabel}
      primaryIntent={{ kind: "back" }}
      secondaryLabel="基于最新状态重新开始"
      secondaryIntent={{ kind: "create_fresh_run" }}
      onIntent={onIntent}
    />
  );
}

function GenericState({ title, detail }: { title: string; detail: string }) {
  return <section className="learning-run-state-card is-neutral"><h1>{title}</h1><p>{detail}</p></section>;
}

function PauseLargeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>;
}

function failureStageLabel(stage: LearningRunPublicV1["failure"] extends infer _T ? "prepare" | "assessment" | "commit" | undefined : never): string {
  if (stage === "prepare") return "任务准备";
  if (stage === "commit") return "结果确认";
  return "独立评估";
}
