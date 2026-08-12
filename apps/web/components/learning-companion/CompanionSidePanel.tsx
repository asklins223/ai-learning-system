"use client";

/**
 * 任务 05-5：伴星侧板 / 移动端底部面板（§5.4.2）。
 *
 * - **可收起**：标题栏关闭按钮 + Esc 关闭；`open` 由父组件控制
 *   （关闭 → 父组件销毁短 TTL context，§5.4.4）；
 * - **关闭后焦点回到原触发位置**：打开瞬间记录触发元素（`restoreFocusRef`
 *   或当前 activeElement），关闭时 focus 回（验收「焦点恢复正确」）；
 * - **live region 只播报必要状态**：仅面板打开/关闭两条必要播报，
 *   不重复播报面板内容，不产生冗余 live region 噪音（§13.4）；
 * - **非模态**（`aria-modal="false"`）：不阻塞页面主内容操作，键盘用户
 *   可继续在页面内导航；不自动聚焦面板，不劫持 Tab 序；
 * - **移动端**：`mobileBottomSheet` → 底部面板（可收起）；桌面 → 右侧侧板。
 *
 * 组件是纯 UI + props 回调：内容与动作经 `children` / `onClose` 注入，
 * 本组件不直接调用服务端（与 04-6 组件风格一致）。
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/ui/icons";

export interface CompanionSidePanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /**
   * 触发元素（召唤按钮）；关闭后焦点恢复到这里。
   * 缺省时记录打开瞬间的 `document.activeElement`（即触发位置）。
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** true → 移动端底部面板；false → 桌面右侧侧板 */
  mobileBottomSheet?: boolean;
  children: ReactNode;
}

export function CompanionSidePanel({
  open,
  onClose,
  title = "学习伴星",
  restoreFocusRef,
  mobileBottomSheet = false,
  children,
}: CompanionSidePanelProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [liveMessage, setLiveMessage] = useState("");

  // 打开时记录触发位置；关闭后焦点回原触发位置（验收：焦点恢复正确）。
  // 从未打开过（初始 mount open=false）时不播报"已关闭"也不做焦点恢复。
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const active = document.activeElement;
      triggerRef.current =
        restoreFocusRef?.current ??
        (active instanceof HTMLElement ? active : null);
      setLiveMessage(`${title}已打开`);
    } else {
      if (!wasOpenRef.current) return;
      const trigger = triggerRef.current;
      if (trigger !== null && document.contains(trigger)) {
        trigger.focus({ preventScroll: true });
      }
      triggerRef.current = null;
      setLiveMessage(`${title}已关闭`);
    }
  }, [open, restoreFocusRef, title]);

  // Esc 收起面板
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <>
      {/* live region 只播报必要状态（§13.4 / §5.4.2）：不重复播报面板内容 */}
      <p aria-live="polite" className="sr-only" data-ui="lc-live-region">
        {liveMessage}
      </p>

      {open && (
        <aside
          role="dialog"
          aria-modal="false"
          aria-label={title}
          data-ui="lc-companion-panel"
          className={
            mobileBottomSheet
              ? "fixed inset-x-0 bottom-0 z-20 flex max-h-[80dvh] flex-col rounded-t-card border border-border bg-surface shadow-lg"
              : "fixed top-0 right-0 z-20 flex h-full w-[min(420px,100vw)] flex-col border-l border-border bg-surface shadow-lg"
          }
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-ink">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭伴星面板"
              className="inline-flex size-11 items-center justify-center rounded-full text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
            >
              <Icon.X className="size-4" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
        </aside>
      )}
    </>
  );
}
