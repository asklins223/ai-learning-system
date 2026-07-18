import { ReactNode } from "react";
import type { StatusTone } from "@/lib/status-map";

/**
 * 状态 chip — 全站统一的状态标签组件。
 *
 * 使用 `data-tone` 属性 + CSS 规则驱动视觉，
 * 与 status-map.ts 的 StatusTone 完全对齐。
 *
 * 规则：
 * - 必须配合文字，不单靠颜色传达状态。
 * - 圆角统一 pill。
 * - tone 必须来自 statusMap 或 TONE_CSS_MAP 的 StatusTone 枚举。
 */
export type { StatusTone };

export function StatusChip({
  tone = "neutral",
  children,
  dot = false,
  size = "md",
}: {
  tone?: StatusTone;
  children: ReactNode;
  dot?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={`status-chip ${size === "sm" ? "status-chip--sm" : ""}`}
      data-tone={tone}
    >
      {dot && <span className="status-chip__dot" aria-hidden />}
      {children}
    </span>
  );
}
