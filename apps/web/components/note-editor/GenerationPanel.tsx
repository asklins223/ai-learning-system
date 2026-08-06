"use client";

/**
 * PERF-04 拆分（第九轮）：学习卡生成面板组件。
 *
 * 从 NoteEditor.tsx 的 renderGenerationPanel 函数提取为独立组件。
 * 展示生成状态、进度、覆盖率、失败入口和操作按钮。
 * 在抽屉的"文档工具"视图中渲染。
 */

import type { CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import type { StatusTone } from "@/lib/status-map";
import type {
  GenerationResolutionAction,
  FailedGenerationUnit,
} from "./note-editor-types";
import {
  isActiveGenerationRun,
  generationStageLabel,
  generationProgressLabel,
  measuredCoverageLabel,
} from "./note-editor-utils";

export interface GenerationPanelProps {
  /** 生成视觉状态 */
  visualState: "idle" | "generating" | "success" | "partial" | "attention" | "stale" | "status-error";
  /** 生成标题 */
  heading: string;
  /** 状态标签展示 */
  pres: { label: string; tone: StatusTone };
  /** 生成按钮配置 */
  button: { label: string; disabled: boolean; onClick: () => void };
  /** 是否为工作区所有者 */
  isOwner: boolean;
  /** 当前版本号 */
  currentVersionNo: number;
  /** 生成版本号 */
  generationVersionNo: number | null;
  /** 已生成版本 ID */
  generatedVersionId: string | null;
  /** 生成状态 */
  genState: string;
  /** 生成消息 */
  genMessage: string | null;
  /** 失败标题 */
  failureHeading: string;
  /** 是否有冲突 */
  hasConflict: boolean;
  /** 是否有可写内容 */
  hasWritableContent: boolean;
  /** 已生成结果是否对应当前版本 */
  generatedIsCurrent: boolean;
  /** 是否有已生成结果 */
  hasGeneratedResult: boolean;
  /** 已生成卡片的链接 */
  generatedCardHref: string;
  /** 生成运行视图 */
  generationRun: CardGenerationRunView | null;
  /** 是否处于部分就绪状态 */
  generationPartialReady: boolean;
  /** 是否需要处理失败素材 */
  generationNeedsAttention: boolean;
  /** 当前分辨动作 */
  generationResolutionAction: GenerationResolutionAction;
  /** 失败单元列表 */
  failedGenerationUnits: FailedGenerationUnit[];
  /** 是否正在取消生成 */
  cancellingGeneration: boolean;
  /** 是否因生成锁定 */
  generationLocked: boolean;
  /** 打开失败处理弹窗 */
  onOpenFailureDialog: () => void;
  /** 取消生成 */
  onCancelGeneration: () => void;
  /**
   * Phase B/C：打开 Agent 活动流控制台。
   * 由 NoteEditor 仅在 flag 开启且处于生成中时传入；缺省为 undefined。
   */
  onOpenActivity?: () => void;
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
  genMessage,
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
  onOpenFailureDialog,
  onCancelGeneration,
  onOpenActivity,
}: GenerationPanelProps) {
  return (
    <section
      className="note-editor-panel note-editor-generation-panel"
      data-generation-state={visualState}
    >
      <header className="note-editor-panel-header">
        <div>
          <span className="note-editor-panel-kicker">
            {!isOwner
              ? "成员学习入口"
              : visualState === "status-error"
                ? "状态同步"
              : visualState === "partial"
                ? "受限学习产出"
              : visualState === "attention"
                ? "严格覆盖保护"
              : visualState === "success"
                ? "学习产出"
              : visualState === "stale"
                ? "内容有更新"
                : "从笔记提炼"}
          </span>
          <h2>
            {heading}
          </h2>
        </div>
        <StatusChip tone={pres.tone} size="sm">
          {pres.label}
        </StatusChip>
      </header>
      <div
        className="note-editor-panel-body"
        aria-busy={visualState === "generating"}
      >
        <div
          className="note-editor-generation-result"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="note-editor-generation-orbit" aria-hidden="true">
            {visualState === "success"
              ? <Icon.Check />
              : visualState === "partial" || visualState === "attention" || visualState === "status-error"
                ? <Icon.Warn />
              : visualState === "generating"
                ? <Icon.Refresh />
                : <Icon.Sparkle />}
          </div>
          <div>
            <strong>
              {!isOwner
                ? generatedVersionId
                  ? "已有学习卡可以查看"
                  : "等待所有者生成学习卡"
                : visualState === "status-error"
                  ? "暂时无法确认任务状态"
                : visualState === "partial"
                  ? "已生成明确标记的部分结果"
                : visualState === "attention"
                  ? failureHeading
                : visualState === "success"
                  ? "学习卡已经生成"
                : visualState === "generating"
                  ? "正在提炼关键理解"
                : visualState === "stale"
                    ? "笔记内容已有更新"
                    : hasConflict
                      ? "先解决内容冲突"
                      : !hasWritableContent
                        ? "等待有效内容"
                        : "从当前版本生成"}
            </strong>
            <span>
              {!isOwner
                ? generatedVersionId
                  ? `基于 v${generationVersionNo ?? currentVersionNo}`
                  : `当前保存版本 v${currentVersionNo}`
                : visualState === "partial"
                  ? `基于 v${generationVersionNo ?? currentVersionNo} · 未替换完整学习卡`
                : visualState === "attention"
                  ? `基于 v${generationVersionNo ?? currentVersionNo} · 等待你的选择`
                : visualState === "success"
                  ? `基于 v${generationVersionNo ?? currentVersionNo} · 已绑定此版本`
                : visualState === "generating"
                  ? `正在处理 v${generationVersionNo ?? currentVersionNo}`
                    : visualState === "stale"
                      ? `上一张卡片基于 v${generationVersionNo ?? "—"}`
                      : `当前保存版本 v${currentVersionNo}`}
            </span>
          </div>
        </div>
        <p className="note-editor-generation-copy">
          {!isOwner
            ? generatedVersionId
              ? "你可以前往学习卡库继续阅读、验证和复习。"
              : "生成学习卡属于内容管理操作，请联系工作区所有者。"
            : visualState === "partial"
              ? genMessage ?? "部分结果仅包含成功处理的素材，不会替换已有完整学习卡，也不会进入验证或复习流程。"
            : visualState === "attention"
              ? "严格模式已停止发布，不会静默忽略失败素材。可以重试失败检查点；若无法重试，也可以按当前设置重新生成。"
            : genState === "generating" || genState === "checking" || genState === "status-error"
              ? genMessage ?? (generationVersionNo
                ? `正在基于 v${generationVersionNo} 提炼关键理解；你可以继续编辑。`
                : "正在确认学习卡任务状态；编辑器仍可正常使用。")
              : generatedIsCurrent
                ? "已加入学习卡库，可以立即开始验证与复习。"
                : generatedVersionId
                  ? "正文已有新版本，可以为最新内容生成一张新的学习卡。"
                  : hasConflict
                    ? "自动保存已暂停。选择保留本地或服务器版本后即可继续生成。"
                    : !hasWritableContent
                      ? "写下一段概念、摘录或推理，再从保存版本提炼学习卡。"
                      : "先保存当前笔记，再从这个不可变版本生成学习卡。"}
        </p>
        {generationRun && (
          <div
            className="note-editor-generation-progress"
            data-run-status={generationRun.status}
            aria-label="学习卡生成任务进度"
          >
            <div className="note-editor-generation-progress-heading">
              <span>{generationStageLabel(generationRun.stage, generationRun.status, generationRun.shellStage)}</span>
              <strong>
                {/* R13（D6）：total=0 时避免 "等待首个进度" 伪读数 */}
                {generationRun.progress.total > 0
                  ? generationProgressLabel(generationRun.progress)
                  : "准备中…"}
              </strong>
            </div>
            {generationRun.progress.total > 0 && (
              <progress
                max={generationRun.progress.total}
                value={Math.min(generationRun.progress.completed, generationRun.progress.total)}
                aria-label={generationProgressLabel(generationRun.progress)}
              />
            )}
            <dl className="note-editor-generation-coverage">
              {/* R9（D4）：total=0 时不渲染，避免 "0/0 · 0%" 泄漏 */}
              {generationRun.coverage.sourceUnitsTotal > 0 && (
                <div>
                  <dt>正文单元</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.sourceUnitsCompleted,
                    generationRun.coverage.sourceUnitsTotal,
                    generationRun.coverage.sourceCoverageBps,
                  )}</dd>
                </div>
              )}
              {generationRun.coverage.imagesTotal > 0 && (
                <div>
                  <dt>{generationPartialReady ? "图片（实际覆盖）" : "图片"}</dt>
                  <dd>{measuredCoverageLabel(
                    generationRun.coverage.imagesCompleted,
                    generationRun.coverage.imagesTotal,
                    generationRun.coverage.imageCoverageBps,
                  )}</dd>
                </div>
              )}
            </dl>
            {generationPartialReady && (
              <div className="note-editor-generation-partial" role="status">
                <strong>
                  部分结果已生成
                </strong>
                <span>
                  部分结果不会替换已有完整学习卡，也不会进入验证或复习流程。
                </span>
                {hasGeneratedResult && (
                  <a
                    className="note-editor-generation-result-link"
                    href={generatedCardHref}
                  >
                    查看部分结果
                    <Icon.Arrow aria-hidden="true" />
                  </a>
                )}
              </div>
            )}
            {/* 失败明细与处理动作已迁移到独立弹窗(ne-genfail-dialog)，
                抽屉里只保留状态与入口,不再承载失败处理流程。 */}
            {generationRun.warnings.some((warning) => warning.code === "coverage_unmeasured") && (
              <p className="note-editor-generation-warning">
                当前兼容任务尚未测量完整覆盖率。
              </p>
            )}
            {generationRun.warnings.some((warning) => warning.code === "image_pipeline_not_active") && (
              <p className="note-editor-generation-warning">
                当前兼容任务没有启用图片解析，图片内容不会进入结果。
              </p>
            )}
            {generationNeedsAttention && isOwner && (
              <div
                className="note-editor-generation-actions"
                aria-busy={generationResolutionAction !== null}
              >
                <button
                  type="button"
                  onClick={onOpenFailureDialog}
                >
                  {generationResolutionAction === "retrying"
                    ? "正在重试失败检查点…"
                    : generationResolutionAction === "restarting"
                      ? "正在按当前设置重新生成…"
                      : `处理失败素材${failedGenerationUnits.length > 0 ? `（${failedGenerationUnits.length}）` : ""}`}
                </button>
              </div>
            )}
            {isActiveGenerationRun(generationRun.status) && onOpenActivity && (
              <button
                type="button"
                className="note-editor-generation-activity"
                onClick={onOpenActivity}
              >
                查看生成过程
              </button>
            )}
            {isActiveGenerationRun(generationRun.status) && generationRun.actions.cancellable && (
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
        <button
          type="button"
          className="note-editor-generate-button"
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
        <p className="note-editor-generation-footnote">
          {!isOwner
            ? "成员可以使用已有学习内容，但不会修改原笔记。"
            : visualState === "status-error"
              ? "任务状态暂不可用；编辑器仍可正常编辑，稍后会自动重试确认。"
            : visualState === "partial"
              ? "部分结果是独立的受限产物；完整学习卡及其复习状态保持不变。"
            : visualState === "attention"
              ? "未得到你的明确确认前，失败图片不会被自动排除。"
            : visualState === "success"
              ? "继续编辑不会覆盖这张卡。"
              : visualState === "stale"
                ? "重新生成会新增学习卡，不会覆盖旧卡。"
                : "学习卡绑定生成时的保存版本，后续修改不会覆盖旧卡。"}
        </p>
      </div>
    </section>
  );
}
