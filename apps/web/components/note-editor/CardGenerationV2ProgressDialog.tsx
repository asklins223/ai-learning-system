"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icons";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import "@/app/styles/card-generation-v2.css";

export type V2ProgressStatus = "progress" | "ready" | "error";

export interface CardGenerationV2ProgressDialogProps {
  open: boolean;
  runId: string;
  status: V2ProgressStatus;
  runStatus?: string;
  runStage?: string;
  error?: string | null;
  onClose: () => void;
  onReady: (runId: string) => void;
  /** error 态下重新发起生成（清空 v2Run 并回到设置弹窗）。 */
  onRetry?: () => void;
}

const STATUS_ORDER = [
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "review_ready",
];

const STATUS_LABELS: Record<string, string> = {
  queued: "排队等待",
  source_sealing: "封存来源版本",
  planning: "判断什么值得练",
  authoring: "设计回忆线索",
  checking: "核对答案与来源",
  review_ready: "准备候选审核",
  failed: "生成失败",
  cancelled: "已取消",
};

export function CardGenerationV2ProgressDialog({
  open,
  runId,
  status,
  runStatus,
  runStage,
  error,
  onClose,
  onReady,
  onRetry,
}: CardGenerationV2ProgressDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentStatus = runStatus ?? (status === "ready" ? "review_ready" : "planning");
  const activeIndex = STATUS_ORDER.indexOf(currentStatus);
  const currentLabel = STATUS_LABELS[currentStatus] ?? currentStatus ?? "处理中";

  const active = open && mounted;
  useModalIsolation(dialogRef, active);
  useFocusTrap(dialogRef, active);
  useBodyScrollLock(active);

  if (!active) return null;

  return createPortal(
    <div
      className="candidate-edit-overlay card-v2-settings-overlay"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="学习卡生成过程"
    >
      <div className="candidate-edit-dialog card-v2-progress-dialog">
        <header>
          <div>
            <p>LEARNING CARD V2</p>
            <h2>{status === "ready" ? "候选审核已就绪" : "正在整理学习目标"}</h2>
            <span>只留下值得以后回忆的内容</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <Icon.Close />
          </button>
        </header>
        <div className="card-v2-progress-dialog__body">
          <section className="card-v2-progress-demo" aria-labelledby="card-v2-progress-title">
            <header>
              <div className="card-v2-progress-demo__symbol">
                {status === "ready" ? <Icon.Check /> : <Icon.Sparkle />}
              </div>
              <div>
                <p>{status === "ready" ? "生成完成" : "正在整理学习目标"}</p>
                <h2 id="card-v2-progress-title">
                  {status === "ready"
                    ? "候选审核已经准备好了"
                    : "只留下值得以后回忆的内容"}
                </h2>
                <span>基于当前笔记版本 · 可以关闭窗口继续编辑</span>
              </div>
            </header>
            {status !== "error" && (
              <ol className="card-v2-progress-demo__steps">
                {STATUS_ORDER.map((step, index) => {
                  const done = activeIndex >= 0 && index < activeIndex;
                  const active = activeIndex === index;
                  const label = STATUS_LABELS[step] ?? step;
                  return (
                    <li data-state={done ? "done" : active ? "active" : "waiting"} key={step}>
                      <span>{done ? <Icon.Check /> : index + 1}</span>
                      <p><strong>{label}</strong><small>{active ? "正在进行" : done ? "已完成" : "等待中"}</small></p>
                    </li>
                  );
                })}
              </ol>
            )}
            {status === "error" ? (
              <div className="card-v2-progress-dialog__error" role="alert">
                <Icon.Warn />
                <p>{error ?? "生成过程加载失败。"}</p>
              </div>
            ) : (
              <div className="card-v2-progress-demo__working">
                <span className="card-v2-progress-demo__pulse" aria-hidden="true" />
                <p>
                  <strong>
                    {status === "ready"
                      ? "候选审核已就绪"
                      : `正在${currentLabel}`}
                  </strong>
                  <small>
                    {status === "ready"
                      ? "可以进入候选审核，确认要启用的学习卡。"
                      : runStage || "后台正在处理，可以继续编辑"}
                  </small>
                </p>
              </div>
            )}
            <footer>
              <p><Icon.Lock />笔记版本已封存，生成过程不会读取你之后的修改。</p>
              {status === "ready" ? (
                <button
                  type="button"
                  className="card-v2-button card-v2-button--primary"
                  onClick={() => onReady(runId)}
                >
                  <Icon.Play />进入候选审核
                </button>
              ) : status === "error" ? (
                <div className="card-v2-progress-dialog__error-actions">
                  <button
                    type="button"
                    className="card-v2-button card-v2-button--quiet"
                    onClick={onClose}
                  >
                    关闭
                  </button>
                  {onRetry && (
                    <button
                      type="button"
                      className="card-v2-button card-v2-button--primary"
                      onClick={onRetry}
                    >
                      <Icon.Refresh />重新生成
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="card-v2-button card-v2-button--quiet"
                  onClick={onClose}
                >
                  后台继续
                </button>
              )}
            </footer>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
