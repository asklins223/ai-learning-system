"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

/**
 * Input — 统一文本输入框。
 *
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §9.4
 * - 高度 40px，移动端至少 44px
 * - 背景 --color-surface-raised，边框 --color-border-strong
 * - Focus: 2px 实线 + 3px 低透明 ring
 * - Placeholder 使用 tertiary 文本色
 * - 错误不把整个输入区染成红色
 */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 错误状态标记 */
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ error, className = "", ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`text-input ${error ? "text-input--error" : ""} ${className}`}
        aria-invalid={error || undefined}
        {...rest}
      />
    );
  },
);
