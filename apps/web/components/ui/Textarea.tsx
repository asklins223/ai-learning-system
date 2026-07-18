"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";

/**
 * Textarea — 统一多行文本输入。
 *
 * - Textarea 可调整高度时不得破坏容器
 * - 错误不把整个输入区染成红色
 */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 错误状态标记 */
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ error, className = "", ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={`text-input text-area ${error ? "text-input--error" : ""} ${className}`}
        aria-invalid={error || undefined}
        {...rest}
      />
    );
  },
);
