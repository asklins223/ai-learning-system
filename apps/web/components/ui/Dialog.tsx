"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";

/**
 * Dialog — 通用模态对话框基础组件。
 *
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §9.9
 * - 带遮罩
 * - 打开后 focus trap
 * - Esc 始终执行安全的取消/关闭
 * - 打开时背景 inert 并锁定背景滚动
 * - 关闭后恢复触发点焦点
 * - 手机端宽度为视口减 32px
 */

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 底部操作区 */
  footer?: ReactNode;
  /** 对话框宽度，默认 520px */
  width?: string;
  /** 额外 className */
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = "520px",
  className = "",
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  // 打开时锁定滚动；焦点记录与恢复由 useFocusTrap 统一处理。
  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [open]);

  // Focus trap
  useModalIsolation(dialogRef, open && mounted);
  useFocusTrap(dialogRef, open && mounted);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="dialog-backdrop" onClick={handleClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog ${className}`}
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          <button
            type="button"
            className="dialog-close"
            onClick={handleClose}
            aria-label="关闭对话框"
          >
            <Icon.X className="h-4 w-4" />
          </button>
        </header>

        {/* Body */}
        <div className="dialog-body">{children}</div>

        {/* Footer */}
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
