"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";
import { Icon } from "./icons";

/**
 * Select — 统一下拉选择框。
 *
 * - 高度 40px，移动端至少 44px
 * - 背景 --color-surface-raised，边框 --color-border-strong
 * - Focus: 2px 实线 + 3px 低透明 ring
 */

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** 错误状态标记 */
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ error, className = "", children, ...rest }, ref) {
    return (
      <div className={`select-wrap ${error ? "select-wrap--error" : ""}`}>
        <select
          ref={ref}
          className={`text-input select-input ${error ? "text-input--error" : ""} ${className}`}
          aria-invalid={error || undefined}
          {...rest}
        >
          {children}
        </select>
        <Icon.Chevron className="select-arrow" />
      </div>
    );
  },
);
