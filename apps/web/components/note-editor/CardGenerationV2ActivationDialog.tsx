"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icons";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import type { CardActivationReceiptV2 } from "@ailearn/shared";
import "@/app/styles/card-generation-v2.css";

export interface CardGenerationV2ActivationDialogProps {
  open: boolean;
  hasExposure: boolean;
  receipt: CardActivationReceiptV2;
  noteId: string;
  onClose: () => void;
}

export function CardGenerationV2ActivationDialog({
  open,
  hasExposure,
  receipt,
  noteId,
  onClose,
}: CardGenerationV2ActivationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const active = open && mounted;
  useModalIsolation(dialogRef, active);
  useFocusTrap(dialogRef, active);
  useBodyScrollLock(active);

  if (!active) return null;

  const first = receipt.mappings[0];
  const cardHref = first
    ? `/learning-cards/${encodeURIComponent(first.cardId)}`
    : `/notes/${encodeURIComponent(noteId)}`;
  const count = receipt.mappings.length;

  return createPortal(
    <div
      className="candidate-edit-overlay card-v2-settings-overlay"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="启用反馈"
    >
      <div className="candidate-edit-dialog card-v2-activation-dialog">
        <header>
          <div>
            <p>LEARNING CARD V2</p>
            <h2>启用反馈</h2>
            <span>学习卡已启用，可以开始第一次验证。</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <Icon.Close />
          </button>
        </header>
        <div className="card-v2-activation-dialog__body">
          <section className="activation-result" aria-labelledby="activation-result-title">
            <p className="activation-result__eyebrow">{count} 张学习卡已启用</p>
            <div className="activation-result__heading">
              <div className="activation-result__seal"><Icon.Check /></div>
              <h2 id="activation-result-title">
                {hasExposure ? "内容已保存，先从练习开始" : "现在可以开始第一次验证"}
              </h2>
            </div>
            <p>
              {hasExposure
                ? "你刚刚查看了候选答案，本次会作为练习；到可验证时系统会提醒你。"
                : "你还没有查看答案。完成一次可信验证后，系统才会安排后续复习。"}
            </p>
            <div className="activation-result__facts">
              <span><strong>{count}</strong>张已启用</span>
              <span><strong>0</strong>个复习安排</span>
              <span><strong>1</strong>次首次验证待完成</span>
            </div>
            <footer>
              <button type="button" className="card-v2-button card-v2-button--quiet" onClick={onClose}>稍后再说</button>
              <a className="card-v2-button card-v2-button--primary" href={cardHref}>
                <Icon.Play />用三分钟开始验证
              </a>
            </footer>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
