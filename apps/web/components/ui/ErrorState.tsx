import { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * 错误状态 — 规范 §9.11 ErrorState。
 *
 * 必须提供：
 * - 简短原因。
 * - 可行的重试或返回。
 *
 * 已加载成功的部分不得一起消失。
 */
export function ErrorState({
  title = "加载失败",
  description,
  action,
  onRetry,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center" role="alert">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-danger-soft">
        <Icon.Warn className="h-5 w-5 text-danger" />
      </div>
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {action ?? (onRetry && (
        <button
          type="button"
          className="btn-ghost mt-1"
          onClick={onRetry}
        >
          重试加载
        </button>
      ))}
    </div>
  );
}
