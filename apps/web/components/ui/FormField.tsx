"use client";

import { type ReactNode, useId } from "react";
import { Icon } from "./icons";

/**
 * FormField — 表单字段容器，统一 label / helper / error 关联。
 *
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §9.3
 * - 结构顺序：Label → Input → Helper / Error
 * - label、helper、error 必须通过 id 关联
 * - Error 使用文字 + 图标，不只变红
 * - Disabled 仍需可读
 * - 必填状态必须被读屏识别
 * - 提交失败不得清空用户输入
 */

interface FormFieldProps {
  /** 字段标签 */
  label: string;
  /** 是否必填（视觉标记 + aria-required） */
  required?: boolean;
  /** 提示文字 */
  helper?: string;
  /** 错误信息（有值时显示错误状态） */
  error?: string;
  /** HTML name 属性，用于关联 label */
  name?: string;
  /** 子元素（Input / Textarea / Select） */
  children: ReactNode;
  /** 额外 className */
  className?: string;
}

export function FormField({
  label,
  required = false,
  helper,
  error,
  name,
  children,
  className = "",
}: FormFieldProps) {
  const id = useId();
  const inputId = name ?? id;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div
      className={`form-field ${error ? "form-field--error" : ""} ${className}`}
      data-ui="form-field"
    >
      <label htmlFor={inputId} className="form-field__label">
        {label}
        {required && (
          <span className="form-field__required" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="form-field__control">
        {typeof children === "object" && children !== null
          ? // 注入 id / aria 属性到子元素
            cloneChildWithProps(children, {
              id: inputId,
              "aria-required": required || undefined,
              "aria-describedby": describedBy,
              "aria-invalid": error ? true : undefined,
            })
          : children}
      </div>

      {helper && !error && (
        <p id={helperId} className="form-field__helper">
          {helper}
        </p>
      )}

      {error && (
        <p id={errorId} className="form-field__error" role="alert">
          <Icon.AlertCircle className="form-field__error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}

/** 给子 React 元素注入额外 props */
function cloneChildWithProps(
  child: ReactNode,
  extraProps: Record<string, string | boolean | undefined>,
): ReactNode {
  if (
    typeof child === "object" &&
    child !== null &&
    "type" in child &&
    typeof (child as unknown as Record<string, unknown>).type === "string"
  ) {
    // 原生 HTML 元素 — 不支持直接注入，返回原始 child
    return child;
  }
  if (
    typeof child === "object" &&
    child !== null &&
    "props" in child
  ) {
    const el = child as React.ReactElement<Record<string, unknown>>;
    const existingProps = (el.props ?? {}) as Record<string, unknown>;
    return {
      ...el,
      props: { ...existingProps, ...extraProps },
    };
  }
  return child;
}
