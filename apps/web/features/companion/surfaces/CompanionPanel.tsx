"use client";

import { useEffect, useRef } from "react";
import type { CompanionPanelModel } from "../runtime/surface-model";
import { CompanionAvatar } from "@/components/learning-companion/CompanionAvatar";
import { Icon } from "@/components/ui/icons";

export interface CompanionPanelProps {
  model: CompanionPanelModel;
  onClose: () => void;
  onAction: (actionId: string) => void;
}

export function CompanionPanel({ model, onClose, onAction }: CompanionPanelProps) {
  const panelRef = useRef<HTMLElement>(null);

  // 键盘可达性：Esc 关闭（与 CompanionSidePanel 行为一致）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={model.title}
      data-ui="companion-v2-panel"
      className="fixed inset-x-0 bottom-[var(--mobile-nav-inset)] z-30 flex max-h-[72dvh] flex-col rounded-t-card border border-border bg-surface shadow-lg sm:inset-y-0 sm:bottom-auto sm:left-auto sm:right-0 sm:h-full sm:max-h-none sm:w-[min(400px,100vw)] sm:rounded-none sm:border-b-0 sm:border-l"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {/* 装饰性角色头像：读屏不重复朗读，标题已在 aria-label 中表达 */}
          <CompanionAvatar state="dormant" size={48} showLabel={false} aria-hidden="true" ariaLabel="" />
          <h2 className="text-sm font-medium text-ink">{model.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭伴星"
          className="inline-flex size-11 items-center justify-center rounded-full text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <Icon.X aria-hidden="true" className="size-5" />
        </button>
      </header>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <p className="text-sm leading-6 text-ink">{model.body}</p>
        <div className="flex flex-wrap gap-2">
          {model.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action.id)}
              className={action.id === "dismiss" ? "btn btn-secondary" : "btn btn-primary"}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
