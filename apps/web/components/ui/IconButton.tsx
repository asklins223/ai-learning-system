import { ButtonHTMLAttributes } from "react";

/**
 * IconButton — 规范 §5.9 / §9.6。
 *
 * - 线宽 1.5–1.75px，尺寸 16 / 20 / 24px
 * - 透明背景，hover 浮起
 * - 必须有 aria-label
 */
export function IconButton({
  icon: IconComp,
  label,
  size = 20,
  className = "",
  ...props
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  size?: 16 | 20 | 24;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-btn ${className}`}
      aria-label={label}
      {...props}
    >
      <IconComp className={`h-${size / 4} w-${size / 4}`} />
    </button>
  );
}
