"use client";

/**
 * 学习卡生成工作台。
 *
 * 它不是 Agent 调试控制台：首屏只回答「现在做到哪」「为什么值得等」
 * 和「最终会留下什么」。安全活动流仍可按需展开，供排查与建立信任。
 */

import { forwardRef, useEffect, useId, useRef, useState } from "react";
import type { CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import type { GenerationPhase } from "./note-editor-types";
import { isActiveGenerationRun } from "./note-editor-utils";
import { GenerationPhaseRail, generationPhasePosition } from "./GenerationPhaseRail";
import { GenerationRunSummary } from "./GenerationRunSummary";
import { AgentStreamList } from "./AgentStreamList";
import { useGenerationActivity } from "./useGenerationActivity";

export interface GenerationOverlayProps {
  active: boolean;
  phase: GenerationPhase;
  title: string;
  description: string;
  run: CardGenerationRunView | null;
  message: string | null;
  onDismiss: () => void;
  reused?: boolean;
  onForceRegenerate?: () => void;
  activityEnabled?: boolean;
  onCancel?: () => void;
  cancelling?: boolean;
  onTransientError?: (message: string) => void;
}

type WorkbenchTone = "active" | "success" | "warning" | "danger" | "neutral";

function useElapsedSeconds(startedAt: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  // FN8：只在"显示的秒数"变化时才 setState——每 1s 无条件 setNow 会让
  // overlay 在秒数未变（毫秒级相位）时也整棵重渲。用 ref 记住上一个秒数。
  const lastSecondRef = useRef<number>(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const tick = Date.now();
      const second = Math.floor(tick / 1000);
      if (second === lastSecondRef.current) return;
      lastSecondRef.current = second;
      setNow(tick);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!startedAt) return 0;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
}

function workbenchState(
  run: CardGenerationRunView | null,
  phase: GenerationPhase,
  reused: boolean,
): { label: string; tone: WorkbenchTone; eyebrow: string } {
  if (reused) return { label: "已复用", tone: "success", eyebrow: "内容没有变化" };
  if (phase === "saving" && !run) return { label: "正在保存", tone: "active", eyebrow: "固定本次来源" };
  if (!run) return { label: "准备中", tone: "neutral", eyebrow: "学习卡生成" };
  if (isActiveGenerationRun(run.status)) {
    return { label: "后台运行", tone: "active", eyebrow: `第 ${generationPhasePosition(run)} / 4 阶段` };
  }
  if (run.status === "succeeded") return { label: "已完成", tone: "success", eyebrow: "筛选完成" };
  if (run.status === "partial_ready") return { label: "部分完成", tone: "warning", eyebrow: "可用结果已保留" };
  if (run.status === "needs_attention") return { label: "需要处理", tone: "warning", eyebrow: "质量保护已暂停发布" };
  if (run.status === "failed" || run.status === "terminal_failed") {
    return { label: "未完成", tone: "danger", eyebrow: "生成遇到问题" };
  }
  return { label: "已停止", tone: "neutral", eyebrow: "本次生成已结束" };
}

function activeTaskLabel(run: CardGenerationRunView): string {
  const stage = run.shellStage ?? run.stage;
  if (stage === "queued") return "任务已接受，等待处理";
  if (stage === "preparing") return "正在理解笔记结构";
  if (stage === "generating" || stage === "running") return "正在把关键理解设计成问题";
  if (stage === "checking" || stage === "validating") return "正在核对答案、来源与质量规则";
  if (stage === "publishing") return "正在保存通过筛选的结果";
  return "正在处理学习卡";
}

function outcomeCopy(run: CardGenerationRunView | null): {
  title: string;
  copy: string;
  icon: "check" | "warn" | "sparkle";
} {
  if (!run || isActiveGenerationRun(run.status)) {
    return {
      title: "先提炼关键理解，再检查可靠性",
      copy: "本次结果会绑定当前笔记版本，完成后直接进入学习卡库。",
      icon: "sparkle",
    };
  }
  if (run.status === "succeeded") {
    return {
      title: "学习卡已经发布",
      copy: "结果已写入学习卡库，可以从卡片列表继续查看和学习。",
      icon: "check",
    };
  }
  if (run.status === "partial_ready") {
    return {
      title: "只保留了可确认的部分",
      copy: "有疑问的素材没有被静默发布；现有完整学习卡也不会被替换。",
      icon: "warn",
    };
  }
  if (run.status === "needs_attention") {
    return {
      title: "质量保护阻止了发布",
      copy: "需要先处理失败素材，系统不会用不完整内容凑出学习卡。",
      icon: "warn",
    };
  }
  return {
    title: "本次没有产生可用结果",
    copy: "原笔记和已有学习卡都没有受到影响，可以稍后重试。",
    icon: "warn",
  };
}

export const GenerationOverlay = forwardRef<HTMLDivElement, GenerationOverlayProps>(
  function GenerationOverlay({
    active,
    phase,
    title,
    description,
    run,
    message,
    onDismiss,
    reused = false,
    onForceRegenerate,
    activityEnabled = false,
    onCancel,
    cancelling = false,
    onTransientError,
  }, ref) {
    const [detailsOpen, setDetailsOpen] = useState(false);
    const detailsId = useId();
    const isActive = !!run && isActiveGenerationRun(run.status);
    const showActivityPanel = activityEnabled && isActive && phase !== "saving" && !reused;

    const { events, loading, error } = useGenerationActivity({
      enabled: showActivityPanel && detailsOpen,
      open: showActivityPanel && detailsOpen,
      runId: run?.runId ?? null,
      active: isActive,
      onTransientError,
    });

    const elapsedSeconds = useElapsedSeconds(run?.startedAt ?? run?.createdAt);
    const state = workbenchState(run, phase, reused);
    const outcome = outcomeCopy(run);

    return (
      <div
        className="ne-generation-overlay lcg-overlay"
        role="presentation"
        data-modal={active || undefined}
        data-tone={state.tone}
      >
        <div
          ref={ref}
          className="ne-generation-dialog lcg-dialog"
          role="dialog"
          aria-modal={active ? "true" : "false"}
          aria-labelledby="ne-generation-title"
          aria-describedby="ne-generation-description"
        >
          <header className="lcg-header">
            <div className="lcg-brand">
              <span className="lcg-brand-mark" aria-hidden="true"><Icon.Card /></span>
              <span>
                <strong>学习卡工坊</strong>
                <small>基于保存版本</small>
              </span>
            </div>
            <div className="lcg-header-actions">
              <span className="lcg-status" data-tone={state.tone}>
                <span aria-hidden="true" />
                {state.label}
              </span>
              {!active && (
                <button
                  type="button"
                  className="lcg-icon-button"
                  aria-label={isActive ? "最小化生成进度" : "关闭生成结果"}
                  onClick={onDismiss}
                >
                  <Icon.Close />
                </button>
              )}
            </div>
          </header>

          <div className="lcg-scroll">
            <section className="lcg-hero" data-tone={state.tone}>
              <div className="lcg-hero-copy">
                <p>{state.eyebrow}</p>
                <h1 id="ne-generation-title">{title}</h1>
                <span id="ne-generation-description">{description}</span>
              </div>
              <div className="lcg-hero-meta" aria-label="本次生成信息">
                <div><span>来源</span><strong>v{run?.sourceSnapshot.versionNo ?? "—"}</strong></div>
                <div><span>已运行</span><strong>{run ? formatElapsed(elapsedSeconds) : "刚刚"}</strong></div>
              </div>
            </section>

            {reused ? (
              <section className="ne-generation-reused lcg-reused" role="status">
                <span className="lcg-outcome-icon" data-tone="success" aria-hidden="true"><Icon.Check /></span>
                <div>
                  <h2>内容未变，已复用上次结果</h2>
                  <p className="ne-generation-reused-text">没有重复消耗生成时间；已有学习进度也会保持不变。</p>
                </div>
                <div className="ne-generation-reused-actions">
                  {onForceRegenerate && (
                    <button type="button" className="ne-generation-force-regenerate" onClick={onForceRegenerate}>
                      强制重新生成
                    </button>
                  )}
                  <button type="button" className="lcg-primary-action" onClick={onDismiss}>查看已有结果</button>
                </div>
              </section>
            ) : phase === "saving" && !run ? (
              <section className="lcg-handshake" role="status" aria-live="polite">
                <span className="lcg-handshake-icon" aria-hidden="true"><Icon.Lock /></span>
                <div>
                  <h2>正在固定这一刻的笔记</h2>
                  <p>只在保存并创建不可变来源时短暂暂停编辑；任务被接受后就会自动恢复。</p>
                </div>
                <span className="lcg-indicator" aria-hidden="true"><i /><i /><i /></span>
              </section>
            ) : run ? (
              <>
                <section className="lcg-now" aria-labelledby="lcg-progress-title" role="status">
                  <span className="lcg-now-icon" aria-hidden="true"><Icon.Refresh /></span>
                  <div>
                    <p id="lcg-progress-title">{activeTaskLabel(run)}</p>
                    <span>基于 v{run.sourceSnapshot.versionNo} 处理；当前处于第 {generationPhasePosition(run)} / 4 阶段。</span>
                  </div>
                </section>

                <GenerationPhaseRail run={run} />

                <section className="lcg-outcome" data-tone={state.tone}>
                  <span className="lcg-outcome-icon" data-tone={state.tone} aria-hidden="true">
                    {outcome.icon === "check" ? <Icon.Check /> : outcome.icon === "warn" ? <Icon.Warn /> : <Icon.Sparkle />}
                  </span>
                  <div className="lcg-outcome-copy">
                    <p>这次生成会留下什么</p>
                    <h2>{outcome.title}</h2>
                    <span>{outcome.copy}</span>
                  </div>
                </section>

                <section className="lcg-principles" aria-label="生成原则">
                  <div><Icon.Bolt aria-hidden="true" /><span><strong>关键理解</strong><small>围绕笔记重点提炼</small></span></div>
                  <div><Icon.Quote aria-hidden="true" /><span><strong>原文支撑</strong><small>答案与来源持续核对</small></span></div>
                  <div><Icon.Refresh aria-hidden="true" /><span><strong>后台运行</strong><small>最小化后可继续编辑</small></span></div>
                </section>

                <section className="lcg-details-shell">
                  <button
                    type="button"
                    className="lcg-details-toggle"
                    aria-expanded={detailsOpen}
                    aria-controls={detailsId}
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    <span>
                      <strong>处理详情</strong>
                      <small>查看质量账本与安全活动记录</small>
                    </span>
                    <Icon.Chevron aria-hidden="true" />
                  </button>
                  <div className="lcg-details" id={detailsId} hidden={!detailsOpen}>
                    <GenerationRunSummary run={run} latestEvent={events.at(-1) ?? null} />
                    {showActivityPanel && (
                      <section className="lcg-activity" aria-labelledby="lcg-activity-title">
                        <header>
                          <h2 id="lcg-activity-title">处理记录</h2>
                          <p>只展示阶段、状态与计数，不展示模型内部推理。</p>
                        </header>
                        <AgentStreamList events={events} loading={loading} error={error} initiallyExpanded />
                      </section>
                    )}
                  </div>
                </section>
              </>
            ) : (
              <section className="lcg-handshake" role="status">
                <span className="lcg-handshake-icon" aria-hidden="true"><Icon.Sparkle /></span>
                <div><h2>正在建立生成任务</h2><p>{message ?? "准备好之后会自动开始。"}</p></div>
              </section>
            )}
          </div>

          {!reused && (
            <footer className="lcg-footer">
              <p>
                {active
                  ? "正在安全保存来源，通常只需几秒。"
                  : isActive
                    ? "最小化不会中断生成，完成后仍会保留结果。"
                    : "原笔记始终保持不变。"}
              </p>
              <div>
                {isActive && run?.actions.cancellable && (
                  <button
                    type="button"
                    className="lcg-cancel-action"
                    onClick={onCancel}
                    disabled={cancelling}
                  >
                    {cancelling ? "正在取消…" : "取消本次生成"}
                  </button>
                )}
                {!active && (
                  <button type="button" className="lcg-primary-action" onClick={onDismiss}>
                    {isActive ? "最小化，继续编辑" : "返回笔记"}
                  </button>
                )}
              </div>
            </footer>
          )}
        </div>
      </div>
    );
  },
);
