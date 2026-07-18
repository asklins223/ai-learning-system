"use client";

import {
  useCallback,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";
import { useTheme } from "@/components/ThemeProvider";

type ThemeToggleSize = "sm" | "md";

export interface ThemeToggleProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children" | "onClick" | "type"> {
  size?: ThemeToggleSize;
}

/**
 * ThemeToggle — 全站唯一的日夜切换控件。
 *
 * 组件负责主题状态、无障碍语义与圆形扩散动画；调用方只负责摆放位置。
 */
export function ThemeToggle({
  className = "",
  size = "sm",
  disabled,
  ...buttonProps
}: ThemeToggleProps) {
  const { theme, toggleTheme, isTransitioning, mounted } = useTheme();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    if (!mounted || isTransitioning) return;

    const button = buttonRef.current;
    const rect = button?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 40;
    const y = rect ? rect.top + rect.height / 2 : 40;
    toggleTheme({ x, y });
  }, [isTransitioning, mounted, toggleTheme]);

  const isDay = theme === "day";
  const label = isDay ? "切换到夜间模式" : "切换到日间模式";

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type="button"
      className={`celestial-toggle theme-toggle theme-toggle--${size} ${className} ${theme}`.trim()}
      onClick={handleClick}
      aria-label={label}
      aria-pressed={!isDay}
      title={label}
      disabled={disabled || !mounted || isTransitioning}
    >
      <span className="celestial-aura" aria-hidden="true" />
      <span className="celestial-scene" aria-hidden="true">
        <span className="celestial-face day-face">
          <span className="mini-sun" />
          <span className="mini-cloud cloud-a" />
          <span className="mini-cloud cloud-b" />
        </span>
        <span className="celestial-face night-face">
          <span className="mini-moon" />
          <span className="mini-star star-a" />
          <span className="mini-star star-b" />
          <span className="mini-star star-c" />
        </span>
      </span>
    </button>
  );
}
