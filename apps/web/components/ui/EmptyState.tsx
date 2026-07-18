import { ReactNode } from "react";
import type { StatusTone } from "@/lib/status-map";

/**
 * 空状态 — 规范 §9.11 EmptyState。
 *
 * 必须回答：
 * - 为什么这里是空的。
 * - 用户下一步是什么。
 *
 * 每个空状态最多一个主要操作。
 */
const TONE_BG: Record<StatusTone, string> = {
  success: "bg-success-soft",
  evidence: "bg-evidence-soft",
  warning: "bg-warning-soft",
  danger: "bg-danger-soft",
  running: "bg-running-soft",
  muted: "bg-surface-soft",
  neutral: "bg-paper",
};

export function EmptyState({
  title,
  description,
  action,
  icon,
  tone = "neutral",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      {icon && (
        <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${TONE_BG[tone]} text-2xl`}>
          {icon}
        </div>
      )}
      <div className="max-w-md">
        <p className="text-base font-semibold text-ink">{title}</p>
        {description && <p className="mt-1.5 text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
