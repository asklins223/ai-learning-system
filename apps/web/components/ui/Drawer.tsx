"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";

/**
 * Drawer — 侧边滑出面板基础组件。
 *
 *
 * 支持：
 * - 从右侧或底部滑出
 * - Focus trap（Tab/Shift+Tab 限制在 Drawer 内）
 * - Escape 关闭并恢复焦点
 * - 打开时锁定 body 滚动
 * - backdrop 点击关闭
 * - 标题 + 关闭按钮
 * - safe area 感知
 */

export type DrawerSide = "right" | "bottom";

interface DrawerProps {
  id?: string;
  open: boolean;
  onClose: () => void;
  title?: string;
  side?: DrawerSide;
  width?: string;       // right drawer 宽度，默认 480px
  maxHeight?: string;   // bottom drawer 最大高度，默认 90dvh
  children: ReactNode;
  footer?: ReactNode;
  /** 点击 backdrop 是否关闭，默认 true */
  closeOnBackdrop?: boolean;
}

export function Drawer({
  id,
  open,
  onClose,
  title,
  side = "right",
  width = "480px",
  maxHeight = "90dvh",
  children,
  footer,
  closeOnBackdrop = true,
}: DrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useModalIsolation(drawerRef, open);
  useFocusTrap(drawerRef, open);
  useBodyScrollLock(open);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="drawer-backdrop"
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        id={id}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "抽屉面板"}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`drawer drawer--${side}`}
        style={{ "--drawer-width": width, "--drawer-max-height": maxHeight } as React.CSSProperties}
      >
        {/* Header */}
        {title && (
          <header className="drawer-header">
            <h2 className="drawer-title">{title}</h2>
            <button
              type="button"
              className="drawer-close"
              onClick={onClose}
              aria-label="关闭抽屉"
            >
              <Icon.X className="h-4 w-4" />
            </button>
          </header>
        )}

        {/* Body */}
        <div className="drawer-body">{children}</div>

        {/* Footer */}
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </div>
    </div>
  );
}
