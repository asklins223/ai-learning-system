"use client";

/**
 * 学习卡生成进度弹窗（设计稿"暖纸编辑主题"重构）。
 *
 * 用户可见的生成进度载体：
 * - 保存/入队握手期：保留 orbit 动画（.ne-generation-* 视觉）。
 * - 生成中（flag 开启）：暖纸主题大弹窗——header（eyebrow + editorial
 *   标题 + 状态 chip + 关闭）、overview（总体进度 + 运行时间 + 四阶段
 *   stepper）、双栏（执行记录时间线 + 运行概览侧栏）、footer（取消 / 继续编辑）。
 * - flag 关闭：保留原步骤条 + 覆盖率路径。
 *
 * 使用 forwardRef 转发内部 dialog 元素 ref，供父组件模态钩子使用。
 */

import { forwardRef, useEffect, useRef, useState } from "react";
import type { CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import type { GenerationPhase } from "./note-editor-types";
import {
  advanceEta,
  generationStageLabel,
  generationProgressLabel,
  isActiveGenerationRun,
  measuredCoverageLabel,
  measuredGenerationPercent,
  shellStageStepStates,
} from "./note-editor-utils";
import type { EtaSample } from "./note-editor-utils";
import { GenerationPhaseRail } from "./GenerationPhaseRail";
import { GenerationRunSummary } from "./GenerationRunSummary";
import { AgentStreamList } from "./AgentStreamList";
import { useGenerationActivity } from "./useGenerationActivity";

export interface GenerationOverlayProps {
  /** 是否为模态活动状态（保存+入队握手期间为 true） */
  active: boolean;
  /** 当前生成阶段 */
  phase: GenerationPhase;
  /** 弹窗标题 */
  title: string;
  /** 弹窗描述 */
  description: string;
  /** 生成运行视图（null 表示尚未开始） */
  run: CardGenerationRunView | null;
  /** 实时生成消息 */
  message: string | null;
  /** 关闭弹窗（隐藏进度，继续编辑） */
  onDismiss: () => void;
  /** B1：表示此 run 是复用的已有 succeeded run */
  reused?: boolean;
  /** B1：强制重新生成回调 */
  onForceRegenerate?: () => void;
  /** Phase B/C：Agent 活动流特性开关 */
  activityEnabled?: boolean;
  /** Phase B/C：取消当前生成 */
  onCancel?: () => void;
  /** Phase B/C：是否正在取消 */
  cancelling?: boolean;
  /** Phase B/C：瞬时同步失败回调 */
  onTransientError?: (message: string) => void;
}

/** 每秒刷新的已运行秒数。 */
function useElapsedSeconds(startedAt: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!startedAt) return 0;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function currentTaskMeta(run: CardGenerationRunView): string {
  const stage = run.shellStage ?? run.stage;
  const extracted = run.metrics?.candidates.extracted ?? 0;
  if (stage === "preparing") return "正在准备素材";
  if (stage === "checking") return "正在验证支撑与覆盖";
  if (stage === "publishing") return "正在发布卡组";
  if (extracted > 0) return `已提取 ${extracted} 个候选`;
  return "正在提炼候选卡片";
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
    // C1: 当 shellStage 可用时使用四阶段步骤条（flag 关闭路径）
    const hasShellStage = !!run?.shellStage;
    const stepStates = hasShellStage
      ? shellStageStepStates(run!.shellStage!)
      : null;

    // C1: 覆盖率信息（flag 关闭路径）
    const coverage = run?.coverage;
    const hasCoverage = !!coverage && coverage.sourceUnitsTotal > 0;
    const sourceCoveragePct = coverage?.sourceCoverageBps != null
      ? coverage.sourceCoverageBps / 100
      : null;
    const imageCoveragePct = coverage?.imageCoverageBps != null
      ? coverage.imageCoverageBps / 100
      : null;
    const hasImageCoverage = !!coverage && coverage.imagesTotal > 0;

    const isActive = !!run && isActiveGenerationRun(run.status);
    const showActivityPanel = activityEnabled && isActive && phase !== "saving" && !reused;

    // Phase B/C：活动流数据（仅活动面板渲染时轮询）
    const { events, loading, error } = useGenerationActivity({
      enabled: showActivityPanel,
      open: showActivityPanel,
      runId: run?.runId ?? null,
      active: isActive,
      onTransientError,
    });

    // 运行时间（活动流视图）
    // startedAt 后端可能缺失（supervisor 引擎未写 started_at），回退到
    // createdAt 保证"已运行"始终有值。进度用真实 metrics 推导（§4）。
    const elapsedSeconds = useElapsedSeconds(run?.startedAt ?? run?.createdAt);
    // 进度条单调递增：真实计数可能因任务扩增而回落（childTasks 分母变大），
    // 展示上保持"已到过的最大进度"不后退。run 切换时重置峰值。
    const peakPercentRef = useRef(0);
    const percentRunIdRef = useRef<string | null>(null);
    const etaSampleRef = useRef<EtaSample | null>(null);
    const etaRateRef = useRef<number | null>(null);
    const measured = run ? measuredGenerationPercent(run) : 0;
    if (percentRunIdRef.current !== (run?.runId ?? null)) {
      percentRunIdRef.current = run?.runId ?? null;
      peakPercentRef.current = 0;
      etaSampleRef.current = null;
      etaRateRef.current = null;
    }
    if (measured > peakPercentRef.current) peakPercentRef.current = measured;
    const percent = peakPercentRef.current;
    // 预计剩余：按进度推进速率（advanceEta）估算，避免 percent 停在
    // 粗粒度台阶时单点外推随 elapsed 单调膨胀（"越等越多"）。
    const eta = advanceEta(percent, elapsedSeconds, etaSampleRef.current, etaRateRef.current);
    etaSampleRef.current = eta.sample;
    etaRateRef.current = eta.rate;
    const remainingSeconds = eta.remainingSeconds;

    const kicker = phase === "saving"
      ? "正在封存生成快照"
      : showActivityPanel
        ? "AGENT 活动流"
        : "正在生成学习卡";

    return (
      <div
        className={showActivityPanel ? "gen-progress" : "ne-generation-overlay"}
        role="presentation"
        data-modal={active || undefined}
      >
        {showActivityPanel && run ? (
          /* ── 活动流视图（暖纸编辑主题） ─────────────────────────────── */
          <div
            ref={ref}
            className="gen-progress-dialog"
            role="dialog"
            aria-modal={active ? "true" : "false"}
            aria-labelledby="ne-generation-title"
            aria-describedby="ne-generation-description"
          >
            <header className="gen-progress-header">
              <div>
                <p className="gen-progress-eyebrow">
                  <span className="gen-progress-pulse" aria-hidden="true" />
                  Agent 活动流
                </p>
                <h1 className="gen-progress-title" id="ne-generation-title">{title}</h1>
                <p className="gen-progress-subtitle" id="ne-generation-description">{description}</p>
              </div>
              <div className="gen-progress-header-actions">
                <span className="gen-progress-status-chip">
                  <span aria-hidden="true">●</span>
                  运行中
                </span>
                <button
                  type="button"
                  className="gen-progress-close"
                  aria-label="关闭弹窗"
                  onClick={onDismiss}
                >
                  ✕
                </button>
              </div>
            </header>

            <section className="gen-progress-overview" aria-label="总体进度">
              <div className="gen-progress-overview-top">
                <div>
                  <div className="gen-progress-copy">
                    <span className="gen-progress-copy-title">总体进度</span>
                    <span className="gen-progress-percent">{percent}%</span>
                    <span className="gen-progress-meta">当前：{currentTaskMeta(run)}</span>
                  </div>
                  <div
                    className="gen-progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`总体进度 ${percent}%`}
                  >
                    <div className="gen-progress-bar" style={{ width: `${percent}%` }} />
                  </div>
                </div>
                <div className="gen-progress-timing" aria-label="运行时间">
                  <span>已运行<strong>{formatDuration(elapsedSeconds)}</strong></span>
                  <span>预计剩余<strong>
                    {percent > 0 && remainingSeconds != null
                      ? `约 ${formatDuration(remainingSeconds)}`
                      : "计算中…"}
                  </strong></span>
                </div>
              </div>
              <GenerationPhaseRail run={run} />
            </section>

            <section className="gen-progress-content">
              <section className="gen-progress-activity" aria-labelledby="gen-activity-title">
                <div className="gen-progress-panel-header">
                  <div>
                    <h2 className="gen-progress-panel-title" id="gen-activity-title">执行记录</h2>
                    <p className="gen-progress-panel-hint">按执行顺序展示当前阶段进度</p>
                  </div>
                </div>
                <AgentStreamList events={events} loading={loading} error={error} initiallyExpanded />
              </section>
              <aside className="gen-progress-side" aria-labelledby="gen-overview-title">
                <div className="gen-progress-panel-header">
                  <div>
                    <h2 className="gen-progress-panel-title" id="gen-overview-title">运行概览</h2>
                    <p className="gen-progress-panel-hint">用用户能理解的结果解释当前状态</p>
                  </div>
                </div>
                <GenerationRunSummary run={run} latestEvent={events.at(-1) ?? null} />
              </aside>
            </section>

            <footer className="gen-progress-footer">
              <p className="gen-progress-footer-note">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                关闭弹窗不会中断生成，完成后会通知你。
              </p>
              <div className="gen-progress-footer-actions">
                {run.actions.cancellable && (
                  <button
                    type="button"
                    className="gen-progress-cancel"
                    onClick={onCancel}
                    disabled={cancelling}
                  >
                    {cancelling ? "正在取消…" : "取消生成"}
                  </button>
                )}
                <button type="button" className="gen-progress-dismiss" onClick={onDismiss}>
                  后台运行，继续编辑
                </button>
              </div>
            </footer>
          </div>
        ) : (
          /* ── 握手期 / reused / flag 关闭路径（原有视觉） ───────────── */
          <div
            ref={ref}
            className="ne-generation-dialog"
            role="dialog"
            aria-modal={active ? "true" : "false"}
            aria-labelledby="ne-generation-title"
            aria-describedby="ne-generation-description"
          >
            <p className="ne-generation-kicker">{kicker}</p>

            {reused ? (
              <>
                <div className="ne-generation-visual" aria-hidden="true">
                  <span className="ne-generation-orbit ne-generation-orbit--outer" />
                  <span className="ne-generation-orbit ne-generation-orbit--inner" />
                  <span className="ne-generation-card ne-generation-card--back" />
                  <span className="ne-generation-card ne-generation-card--middle" />
                  <span className="ne-generation-card ne-generation-card--front">
                    <Icon.Sparkle />
                  </span>
                </div>
                <div className="ne-generation-reused">
                  <p className="ne-generation-reused-text">
                    <Icon.Sparkle aria-hidden="true" />
                    内容未变，已复用上次结果。如需重新生成，请点击下方按钮。
                  </p>
                  <div className="ne-generation-reused-actions">
                    {onForceRegenerate && (
                      <button
                        type="button"
                        className="ne-generation-force-regenerate"
                        onClick={onForceRegenerate}
                      >
                        强制重新生成
                      </button>
                    )}
                    <button
                      type="button"
                      className="ne-generation-dismiss"
                      onClick={onDismiss}
                    >
                      查看已有结果
                    </button>
                  </div>
                </div>
              </>
            ) : phase === "saving" ? (
              <>
                <div className="ne-generation-visual" aria-hidden="true">
                  <span className="ne-generation-orbit ne-generation-orbit--outer" />
                  <span className="ne-generation-orbit ne-generation-orbit--inner" />
                  <span className="ne-generation-card ne-generation-card--back" />
                  <span className="ne-generation-card ne-generation-card--middle" />
                  <span className="ne-generation-card ne-generation-card--front">
                    <Icon.Sparkle />
                  </span>
                </div>
                <div className="ne-generation-copy">
                  <h2 id="ne-generation-title">{title}</h2>
                  <p id="ne-generation-description">{description}</p>
                </div>
                <p className="ne-generation-lock-note">
                  <Icon.Lock aria-hidden="true" />
                  仅在保存并封存当前版本期间暂停编辑；任务接受后立即恢复。
                </p>
              </>
            ) : (
              <>
                <div className="ne-generation-copy">
                  <h2 id="ne-generation-title">{title}</h2>
                  <p id="ne-generation-description">{description}</p>
                </div>

                {hasShellStage && stepStates ? (
                  <ol className="ne-generation-steps ne-generation-steps--four" aria-label="生成进度" data-shell-stage={run?.shellStage}>
                    <li data-state={stepStates.prepare}>
                      <span>1</span>
                      <div><strong>准备素材</strong><small>建立文章结构</small></div>
                    </li>
                    <li data-state={stepStates.agentRun}>
                      <span>2</span>
                      <div><strong>提炼卡片</strong><small>多角色协作生成</small></div>
                    </li>
                    <li data-state={stepStates.verify}>
                      <span>3</span>
                      <div><strong>引用校验</strong><small>验证支撑与覆盖</small></div>
                    </li>
                    <li data-state={stepStates.publish}>
                      <span>4</span>
                      <div><strong>发布卡组</strong><small>写入学习卡</small></div>
                    </li>
                  </ol>
                ) : (
                  <ol className="ne-generation-steps" aria-label="生成进度">
                    <li data-state="done">
                      <span>1</span>
                      <div><strong>保存版本</strong><small>封存本次完整内容</small></div>
                    </li>
                    <li data-state={phase === "queued" || phase === "running" ? "active" : "done"}>
                      <span>2</span>
                      <div><strong>准备材料</strong><small>建立文章结构</small></div>
                    </li>
                    <li data-state={phase === "running" ? "active" : "upcoming"}>
                      <span>3</span>
                      <div><strong>提炼卡片</strong><small>后台生成，可继续编辑</small></div>
                    </li>
                  </ol>
                )}

                {run && (
                  <div className="ne-generation-progress">
                    {(!hasShellStage || !hasCoverage) && (
                      <>
                        <div className="ne-generation-progress-bar" aria-hidden="true">
                          <div
                            className="ne-generation-progress-fill"
                            style={{
                              width: `${run.progress.total > 0
                                ? Math.round((run.progress.completed / run.progress.total) * 100)
                                : 0}%`,
                            }}
                          />
                        </div>
                        <p className="ne-generation-progress-text">
                          {run.progress.total > 0
                            ? generationProgressLabel(run.progress)
                            : generationStageLabel(run.stage, run.status, run.shellStage)}
                        </p>
                      </>
                    )}
                    {hasCoverage && (
                      <div className="ne-generation-coverage" role="status" aria-label="覆盖率">
                        <div className="ne-generation-coverage-row">
                          <span className="ne-generation-coverage-label">文本覆盖</span>
                          <span className="ne-generation-coverage-value">
                            {measuredCoverageLabel(
                              coverage!.sourceUnitsCompleted,
                              coverage!.sourceUnitsTotal,
                              coverage!.sourceCoverageBps,
                            )}
                          </span>
                        </div>
                        {sourceCoveragePct !== null && (
                          <div className="ne-generation-coverage-bar" aria-hidden="true">
                            <div
                              className="ne-generation-coverage-fill"
                              style={{ width: `${sourceCoveragePct}%` }}
                            />
                          </div>
                        )}
                        {hasImageCoverage && (
                          <div className="ne-generation-coverage-row ne-generation-coverage-row--image">
                            <span className="ne-generation-coverage-label">图片覆盖</span>
                            <span className="ne-generation-coverage-value">
                              {measuredCoverageLabel(
                                coverage!.imagesCompleted,
                                coverage!.imagesTotal,
                                coverage!.imageCoverageBps,
                              )}
                            </span>
                          </div>
                        )}
                        {hasImageCoverage && imageCoveragePct !== null && (
                          <div className="ne-generation-coverage-bar" aria-hidden="true">
                            <div
                              className="ne-generation-coverage-fill ne-generation-coverage-fill--image"
                              style={{ width: `${imageCoveragePct}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="ne-generation-live" role="status" aria-live="polite" aria-atomic="true">
                  <span className="ne-generation-live-dot" aria-hidden="true" />
                  <p>{message ?? "任务正在进行，请保持页面打开。"}</p>
                </div>
                <button
                  type="button"
                  className="ne-generation-dismiss"
                  onClick={onDismiss}
                >
                  继续编辑，后台生成中
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);
