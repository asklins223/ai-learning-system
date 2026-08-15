"use client";

/**
 * 笔记工具抽屉里的学习卡生成入口。
 *
 * 面板以「是否产生学习价值」为主线，不再把运行状态包装成装饰性结果卡。
 * 真实进度、受限结果和失败入口都保留，但只在相关状态出现。
 */

import type { CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import type { StatusTone } from "@/lib/status-map";
import type { GenerationResolutionAction, FailedGenerationUnit } from "./note-editor-types";
import {
  generationStageLabel,
  isActiveGenerationRun,
} from "./note-editor-utils";
import { GenerationPhaseRail } from "./GenerationPhaseRail";

export interface GenerationPanelProps {
  visualState: "idle" | "generating" | "success" | "partial" | "attention" | "stale" | "status-error";
  heading: string;
  pres: { label: string; tone: StatusTone };
  button: { label: string; disabled: boolean; onClick: () => void };
  isOwner: boolean;
  currentVersionNo: number;
  generationVersionNo: number | null;
  generatedVersionId: string | null;
  genState: string;
  genMessage: string | null;
  failureHeading: string;
  hasConflict: boolean;
  hasWritableContent: boolean;
  generatedIsCurrent: boolean;
  hasGeneratedResult: boolean;
  generatedCardHref: string;
  generationRun: CardGenerationRunView | null;
  generationPartialReady: boolean;
  generationNeedsAttention: boolean;
  generationResolutionAction: GenerationResolutionAction;
  failedGenerationUnits: FailedGenerationUnit[];
  cancellingGeneration: boolean;
  generationLocked: boolean;
  onOpenFailureDialog: () => void;
  onCancelGeneration: () => void;
  onOpenActivity?: () => void;

  // ── V2（方案 20 §19.1）：价值优先生成入口（flag 门控） ──
  v2Enabled?: boolean;
  onGenerateV2?: () => void;
}

function panelKicker(
  visualState: GenerationPanelProps["visualState"],
  isOwner: boolean,
): string {
  if (!isOwner) return "学习入口";
  if (visualState === "generating") return "价值筛选进行中";
  if (visualState === "success") return "本版学习产出";
  if (visualState === "partial") return "受限结果";
  if (visualState === "attention") return "质量保护";
  if (visualState === "stale") return "笔记已有更新";
  if (visualState === "status-error") return "状态同步";
  return "从笔记到学习卡";
}

function panelLead(
  visualState: GenerationPanelProps["visualState"],
  isOwner: boolean,
  generatedVersionId: string | null,
  hasConflict: boolean,
  hasWritableContent: boolean,
): { title: string; copy: string; icon: "sparkle" | "check" | "warn" | "lock" } {
  if (!isOwner) {
    return generatedVersionId
      ? { title: "已有学习内容可以使用", copy: "你可以直接进入学习卡库，不会修改原笔记。", icon: "check" }
      : { title: "这篇笔记还没有学习卡", copy: "生成属于内容管理操作，需要由工作区所有者发起。", icon: "lock" };
  }
  if (visualState === "generating") {
    return { title: "正在提炼这版笔记", copy: "后台会依次设计问题、核对原文并发布结果。", icon: "sparkle" };
  }
  if (visualState === "success") {
    return { title: "这版笔记的学习卡已就绪", copy: "结果已经通过原文证据与学习价值检查。", icon: "check" };
  }
  if (visualState === "partial") {
    return { title: "只保留了可以确认的部分", copy: "有疑问的素材没有被静默写入完整学习卡。", icon: "warn" };
  }
  if (visualState === "attention") {
    return { title: "质量保护暂停了发布", copy: "先处理失败素材，系统不会用不完整内容凑卡。", icon: "warn" };
  }
  if (visualState === "status-error") {
    return { title: "暂时无法确认任务状态", copy: "笔记仍可正常编辑，后台会继续尝试同步。", icon: "warn" };
  }
  if (visualState === "stale") {
    return { title: "当前学习卡来自较早版本", copy: "可以为最新内容重新生成；旧卡不会被覆盖。", icon: "sparkle" };
  }
  if (hasConflict) {
    return { title: "先解决笔记版本冲突", copy: "确认要保留的内容后，才能建立可靠的生成来源。", icon: "warn" };
  }
  if (!hasWritableContent) {
    return { title: "还没有足够的笔记内容", copy: "写下一段概念、推理或实践要点后再试。", icon: "sparkle" };
  }
  return {
    title: "把关键理解变成可练习的问题",
    copy: "生成结果会绑定当前保存版本，后续编辑不会悄悄改变已有卡片。",
    icon: "sparkle",
  };
}

function LeadIcon({ name }: { name: "sparkle" | "check" | "warn" | "lock" }) {
  if (name === "check") return <Icon.Check />;
  if (name === "warn") return <Icon.Warn />;
  if (name === "lock") return <Icon.Lock />;
  return <Icon.Sparkle />;
}

export function GenerationPanel({
  visualState,
  heading,
  pres,
  button,
  isOwner,
  currentVersionNo,
  generationVersionNo,
  generatedVersionId,
  genState,
  failureHeading,
  hasConflict,
  hasWritableContent,
  generatedIsCurrent,
  hasGeneratedResult,
  generatedCardHref,
  generationRun,
  generationPartialReady,
  generationNeedsAttention,
  generationResolutionAction,
  failedGenerationUnits,
  cancellingGeneration,
  generationLocked,
  onOpenFailureDialog,
  onCancelGeneration,
  onOpenActivity,
  v2Enabled = false,
  onGenerateV2,
}: GenerationPanelProps) {
  const lead = panelLead(
    visualState,
    isOwner,
    generatedVersionId,
    hasConflict,
    hasWritableContent,
  );
  const activeRun = !!generationRun && isActiveGenerationRun(generationRun.status);
  const sourceVersion = generationVersionNo ?? generationRun?.sourceSnapshot.versionNo ?? currentVersionNo;

  return (
    <section
      className="note-editor-panel note-editor-generation-panel lcgp-panel"
      data-generation-state={visualState}
    >
      <header className="note-editor-panel-header lcgp-header">
        <div>
          <span className="note-editor-panel-kicker">{panelKicker(visualState, isOwner)}</span>
          <h2>{heading}</h2>
        </div>
        <StatusChip tone={pres.tone} size="sm">{pres.label}</StatusChip>
      </header>

      <div className="note-editor-panel-body lcgp-body" aria-busy={visualState === "generating"}>
        <section className="lcgp-lead" data-tone={visualState}>
          <span className="lcgp-lead-icon" aria-hidden="true"><LeadIcon name={lead.icon} /></span>
          <div>
            <strong>{lead.title}</strong>
            <p>{lead.copy}</p>
          </div>
        </section>

        <div className="lcgp-contract" aria-label="学习卡生成原则">
          <div><Icon.Lock aria-hidden="true" /><span><strong>版本固定</strong><small>结果不漂移</small></span></div>
          <div><Icon.Quote aria-hidden="true" /><span><strong>原文核对</strong><small>答案可追溯</small></span></div>
          <div><Icon.Refresh aria-hidden="true" /><span><strong>后台运行</strong><small>可继续编辑</small></span></div>
        </div>

        {generationRun && (
          <section
            className="note-editor-generation-progress lcgp-progress"
            data-run-status={generationRun.status}
            aria-label="学习卡生成任务进度"
          >
            <div className="note-editor-generation-progress-heading lcgp-progress-heading">
              <div>
                <span>{generationLocked
                  ? "正在固定当前版本"
                  : generationStageLabel(generationRun.stage, generationRun.status, generationRun.shellStage)}</span>
                <small>基于 v{sourceVersion}</small>
              </div>
              <strong>{activeRun ? "进行中" : "已结束"}</strong>
            </div>

            {activeRun && <GenerationPhaseRail run={generationRun} compact />}

            <dl className="note-editor-generation-coverage lcgp-facts">
              <div><dt>来源版本</dt><dd>v{sourceVersion}</dd></div>
              <div><dt>当前阶段</dt><dd>{generationStageLabel(generationRun.stage, generationRun.status, generationRun.shellStage)}</dd></div>
            </dl>

            {generationPartialReady && (
              <div className="note-editor-generation-partial lcgp-callout" role="status">
                <span aria-hidden="true"><Icon.Warn /></span>
                <div>
                  <strong>部分结果已生成</strong>
                  <span>部分结果不会替换已有完整学习卡，也不会进入验证或复习流程。</span>
                  {hasGeneratedResult && (
                    <a className="note-editor-generation-result-link" href={generatedCardHref}>
                      查看部分结果 <Icon.Arrow aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            )}

            {generationRun.warnings.some((warning) => warning.code === "coverage_unmeasured") && (
              <p className="note-editor-generation-warning">兼容任务暂时无法测量完整证据覆盖。</p>
            )}
            {generationRun.warnings.some((warning) => warning.code === "image_pipeline_not_active") && (
              <p className="note-editor-generation-warning">这次任务没有解析图片，图片内容不会进入结果。</p>
            )}

            {generationNeedsAttention && isOwner && (
              <div className="note-editor-generation-actions" aria-busy={generationResolutionAction !== null}>
                <div className="lcgp-attention-copy">
                  <strong>{failureHeading}</strong>
                  <span>失败素材不会被自动忽略。</span>
                </div>
                <button type="button" onClick={onOpenFailureDialog}>
                  {generationResolutionAction === "retrying"
                    ? "正在重试失败检查点…"
                    : generationResolutionAction === "restarting"
                      ? "正在按当前设置重新生成…"
                      : `处理失败素材${failedGenerationUnits.length > 0 ? `（${failedGenerationUnits.length}）` : ""}`}
                </button>
              </div>
            )}

            {activeRun && (
              <div className="lcgp-run-actions">
                {onOpenActivity && (
                  <button type="button" className="note-editor-generation-activity" onClick={onOpenActivity}>
                    查看生成过程
                  </button>
                )}
                {generationRun.actions.cancellable && (
                  <button
                    type="button"
                    className="note-editor-generation-cancel"
                    onClick={onCancelGeneration}
                    disabled={cancellingGeneration}
                  >
                    {cancellingGeneration ? "正在取消…" : "取消本次生成"}
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <button
          type="button"
          className="note-editor-generate-button lcgp-primary"
          data-generation-state={visualState}
          onClick={button.onClick}
          disabled={button.disabled}
          aria-busy={genState === "generating"}
        >
          {visualState === "success"
            ? <Icon.Check aria-hidden="true" />
            : visualState === "partial" || visualState === "attention"
              ? <Icon.Warn aria-hidden="true" />
              : <Icon.Sparkle aria-hidden="true" />}
          <span>{button.label}</span>
          {!button.disabled && <Icon.Arrow aria-hidden="true" />}
        </button>

        {v2Enabled && onGenerateV2 && (
          <button
            type="button"
            className="note-editor-generate-button lcgp-v2"
            data-generation-state={visualState}
            onClick={onGenerateV2}
            disabled={visualState === "generating"}
            title="价值优先生成：可能建议 0 张卡（方案 20）"
          >
            <Icon.Sparkle aria-hidden="true" />
            <span>价值优先生成</span>
          </button>
        )}

        <p className="note-editor-generation-footnote lcgp-footnote">
          {!isOwner
            ? "成员只使用已有学习内容，不会修改笔记或生成设置。"
            : visualState === "success"
              ? `已绑定 v${sourceVersion}；继续编辑不会覆盖现有学习卡。`
              : visualState === "partial"
                ? "部分结果是独立受限产物，完整学习卡及其学习进度保持不变。"
                : visualState === "attention"
                  ? "未完成质量检查前，不会发布新的完整学习卡。"
                  : visualState === "stale"
                    ? "重新生成会基于最新保存版本，已有学习结果仍会保留。"
                    : generatedIsCurrent
                      ? "结果与当前保存版本一致。"
                      : "学习卡绑定生成时的保存版本，后续修改不会覆盖旧结果。"}
        </p>
      </div>
    </section>
  );
}
