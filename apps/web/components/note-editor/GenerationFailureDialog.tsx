"use client";

/**
 * PERF-04 拆分（第九轮）：生成失败素材处理弹窗。
 *
 * 从 NoteEditor.tsx 提取的独立弹窗组件。
 * 当生成任务进入 needs_attention 状态时自动弹出，列出全部失败检查点
 * （图片 + 文本分片），提供重试、重新生成等操作。
 *
 * 使用 forwardRef 转发内部 dialog 元素的 ref，供父组件的
 * useFocusTrap / useModalIsolation 钩子使用。
 */

import { forwardRef } from "react";
import type { CardGenerationRunView } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import type { FailedGenerationUnit } from "./note-editor-types";
import {
  measuredCoverageLabel,
  generationFailedUnitName,
  generationUnitErrorLabel,
} from "./note-editor-utils";

export interface GenerationFailureDialogProps {
  /** 弹窗是否处于活动模态状态 */
  active: boolean;
  /** 当前生成运行视图 */
  generationRun: CardGenerationRunView;
  /** 全部失败单元列表 */
  failedGenerationUnits: FailedGenerationUnit[];
  /** 失败图片子列表（用于计算图片序号） */
  failedGenerationImages: FailedGenerationUnit[];
  /** 失败标题 */
  failureHeading: string;
  /** 当前版本号 */
  currentVersionNo: number;
  /** 生成版本号 */
  generationVersionNo: number | null;
  /** 分辨操作错误信息 */
  resolutionError: string | null;
  /** 当前分辨动作 */
  resolutionAction: "retrying" | "restarting" | null;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 重试失败检查点 */
  onRetry: () => void;
  /** 重新生成 */
  onRestart: () => void;
}

export const GenerationFailureDialog = forwardRef<HTMLDivElement, GenerationFailureDialogProps>(
  function GenerationFailureDialog({
    active,
    generationRun,
    failedGenerationUnits,
    failedGenerationImages,
    failureHeading,
    currentVersionNo,
    generationVersionNo,
    resolutionError,
    resolutionAction,
    onClose,
    onRetry,
    onRestart,
  }, ref) {
    return (
      <div className="ne-genfail-overlay" role="presentation">
        <div
          ref={ref}
          className="ne-genfail-dialog"
          role="dialog"
          aria-modal={active ? "true" : "false"}
          aria-labelledby="ne-genfail-title"
          tabIndex={-1}
        >
          <header className="ne-genfail-header">
            <span className="ne-genfail-icon" aria-hidden="true"><Icon.Warn /></span>
            <div className="ne-genfail-heading">
              <h3 id="ne-genfail-title">{failureHeading}</h3>
              <p>
                基于 v{generationVersionNo ?? currentVersionNo} · 严格模式已停止发布，
                已完成的素材全部保留，可从失败检查点继续。
              </p>
            </div>
            <button
              type="button"
              className="ne-genfail-close"
              onClick={onClose}
              aria-label="稍后处理"
            >
              <Icon.X />
            </button>
          </header>
          <div className="ne-genfail-body">
            <dl className="ne-genfail-coverage">
              <div>
                <dt>正文单元</dt>
                <dd>{measuredCoverageLabel(
                  generationRun.coverage.sourceUnitsCompleted,
                  generationRun.coverage.sourceUnitsTotal,
                  generationRun.coverage.sourceCoverageBps,
                )}</dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd>{measuredCoverageLabel(
                  generationRun.coverage.imagesCompleted,
                  generationRun.coverage.imagesTotal,
                  generationRun.coverage.imageCoverageBps,
                )}</dd>
              </div>
            </dl>
            {failedGenerationUnits.length > 0 ? (
              <ul className="ne-genfail-list" aria-label="失败检查点列表">
                {failedGenerationUnits.map((unit) => {
                  const imageIndex = unit.kind === "image"
                    ? failedGenerationImages.findIndex((image) => image.unitId === unit.unitId) + 1
                    : null;
                  return (
                    <li key={unit.unitId} data-unit-kind={unit.kind}>
                      <span>{generationFailedUnitName(unit, imageIndex)}</span>
                      <small>{generationUnitErrorLabel(unit.errorCode)}</small>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="ne-genfail-empty">
                {generationRun.error?.code === "scheduler_capacity"
                  ? "后台任务槽位暂时不足，稍后重试即可从当前进度继续。"
                  : generationRun.error?.code === "no_learnable_candidate"
                    ? "已处理全部素材，但没有提炼出可以成卡的知识点。可以充实笔记内容后重新生成。"
                    : "没有失败明细可展示，可以直接重试失败检查点。"}
              </p>
            )}
            {resolutionError && (
              <p className="ne-genfail-error" role="alert">{resolutionError}</p>
            )}
            <p className="ne-genfail-note">
              未得到你的明确确认前，失败素材不会被静默排除；部分结果也不会替换已有完整学习卡。
            </p>
          </div>
          <footer className="ne-genfail-footer">
            <button
              type="button"
              className="ne-btn ne-btn--secondary ne-genfail-later"
              onClick={onClose}
            >
              稍后处理
            </button>
            {generationRun.actions.retryable && (
              <button
                type="button"
                className="ne-btn ne-btn--primary"
                onClick={onRetry}
                disabled={resolutionAction !== null}
              >
                {resolutionAction === "retrying"
                  ? "正在重试失败检查点…"
                  : failedGenerationUnits.length > 1
                    ? `重试全部 ${failedGenerationUnits.length} 个失败检查点`
                    : "重试失败检查点"}
              </button>
            )}
            {generationRun.actions.restartable && !generationRun.actions.retryable && (
              <button
                type="button"
                className="ne-btn ne-btn--primary"
                onClick={onRestart}
                disabled={resolutionAction !== null}
              >
                {resolutionAction === "restarting"
                  ? "正在创建新任务…"
                  : "按当前 AI 设置重新生成"}
              </button>
            )}
          </footer>
        </div>
      </div>
    );
  },
);
