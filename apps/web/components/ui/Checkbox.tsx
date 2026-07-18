"use client";

import { forwardRef, type InputHTMLAttributes, useId } from "react";

/**
 * Checkbox — 统一复选框，必须使用真实 input 与可点击 label。
 *
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §9.3 / §15.3
 * - Checkbox 必须使用真实 input 与可点击 label
 * - 触控目标至少 44 × 44px
 * - 通过 id 关联 label
 */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** 复选框标签 */
  label: string;
  /** 错误信息 */
  error?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, error, className = "", id: externalId, ...rest }, ref) {
    const autoId = useId();
    const inputId = externalId ?? autoId;
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className={`checkbox-field ${error ? "checkbox-field--error" : ""} ${className}`}>
        <div className="checkbox-control">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            className="checkbox-input"
            aria-describedby={errorId}
            aria-invalid={error ? true : undefined}
            {...rest}
          />
          <label htmlFor={inputId} className="checkbox-label">
            <span className="checkbox-visual" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 7l3 3 6-6" />
              </svg>
            </span>
            <span className="checkbox-text">{label}</span>
          </label>
        </div>
        {error && (
          <p id={errorId} className="checkbox-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
