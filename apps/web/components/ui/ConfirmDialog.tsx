"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icons";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "archive" | "default";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "default",
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onCancel();
    };
    window.addEventListener("keydown", onKey);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = originalOverflow;
    };
  }, [open, onCancel, loading]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // F-029: 焦点陷阱
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation(dialogRef, open && mounted);
  useFocusTrap(dialogRef, open && mounted);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={() => !loading && onCancel()}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
        className="confirm-dialog"
      >
        <div className={`confirm-icon-wrap ${variant}`}>
          {variant === "danger" ? (
            <Icon.Trash aria-hidden="true" />
          ) : variant === "archive" ? (
            <Icon.Archive aria-hidden="true" />
          ) : (
            <Icon.Warn aria-hidden="true" />
          )}
        </div>

        <h3 id={titleId} className="confirm-title">{title}</h3>
        <p id={messageId} className="confirm-message">{message}</p>

        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn-cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-btn ${variant === "danger" ? "confirm-btn-danger" : "confirm-btn-primary"}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
