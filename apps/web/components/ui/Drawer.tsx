"use client";

import { useEffect, useRef, useCallback, ReactNode } from "react";
import { Icon } from "./icons";
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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useModalIsolation(drawerRef, open);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // Focus trap
      if (e.key === "Tab" && drawerRef.current) {
        const focusable = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
          ),
        ).filter((element) => element.offsetParent !== null && !element.closest("[inert]"));
        if (focusable.length === 0) {
          e.preventDefault();
          drawerRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement;
    window.addEventListener("keydown", handleKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // 初始焦点：优先关闭按钮，其次第一个可交互元素，最后聚焦 drawer 本身。
    requestAnimationFrame(() => {
      const closeBtn = drawerRef.current?.querySelector<HTMLElement>(
        "[aria-label='关闭抽屉']",
      );
      const firstInteractive = drawerRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
      );
      (closeBtn ?? firstInteractive ?? drawerRef.current)?.focus();
    });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  const isRight = side === "right";

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
