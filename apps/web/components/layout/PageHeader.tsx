"use client";

import { ReactNode } from "react";

/**
 * PageHeader — 页面标题区。
 *
 * 每个页面必须具备唯一 h1，PageHeader 负责统一渲染。
 * Focus 页面若主纸面标题已经是 h1，不再渲染第二个 PageHeader h1。
 *
 * 桌面：
 * - 高度按内容自适应，通常 72–96px。
 * - Kicker 可选，12px UI 字体。
 * - h1 28–32px。
 * - 副标题 14px，最大 72ch。
 * - 操作区最多一个主按钮和两个次按钮。
 *
 * 移动端：
 * - h1 24–28px。
 * - 操作区可下移一行。
 * - 主按钮必要时占满宽度。
 *
 * 参见：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §8.3 + §8.4
 */

interface PageHeaderProps {
  /** 页面标题，渲染为 h1 */
  title: string;
  /** 可选的类别标签，显示在标题上方 */
  kicker?: string;
  /** 副标题，14px，最长 72ch */
  subtitle?: string;
  /** 操作区，通常包含主按钮和次按钮 */
  actions?: ReactNode;
  /** 页面级布局类，用于复用同一套工作区页头契约 */
  className?: string;
}

export function PageHeader({
  title,
  kicker,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={`page-header${className ? ` ${className}` : ""}`}
      data-ui="page-header"
    >
      <div className="page-header-text">
        {kicker && <div className="page-header-kicker">{kicker}</div>}
        <h1 className="page-header-title">{title}</h1>
        {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
