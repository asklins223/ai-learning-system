"use client";

import { useState, useRef, useCallback, ReactNode, useId } from "react";

/**
 * Tabs — 选项卡基础组件。
 *
 *
 * 支持：
 * - tablist / tab / tabpanel 语义
 * - Roving tabindex（方向键切换 Tab）
 * - 选中 Tab 用 aria-selected
 * - 受控与非受控两种模式
 */

export interface TabItem {
  key: string;
  label: string;
  content: ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  items: TabItem[];
  /** 受控：当前选中 key；不传则内部管理 */
  activeKey?: string;
  /** 受控模式下切换回调 */
  onChange?: (key: string) => void;
  /** 默认选中 key */
  defaultActiveKey?: string;
  className?: string;
}

export function Tabs({
  items,
  activeKey,
  onChange,
  defaultActiveKey,
  className,
}: TabsProps) {
  const [internalKey, setInternalKey] = useState(
    defaultActiveKey ?? items[0]?.key ?? "",
  );
  const currentKey = activeKey ?? internalKey;

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  const setCurrent = useCallback(
    (key: string) => {
      if (activeKey === undefined) setInternalKey(key);
      onChange?.(key);
    },
    [activeKey, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const enabled = items.filter((item) => !item.disabled);
      if (enabled.length === 0) return;

      const currentIdx = enabled.findIndex((item) => item.key === currentKey);
      let nextIdx = currentIdx;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextIdx = (currentIdx + 1) % enabled.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        nextIdx = (currentIdx - 1 + enabled.length) % enabled.length;
      } else if (e.key === "Home") {
        e.preventDefault();
        nextIdx = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        nextIdx = enabled.length - 1;
      } else {
        return;
      }

      const nextItem = enabled[nextIdx];
      setCurrent(nextItem.key);

      // 聚焦下一个 Tab
      const domIdx = items.findIndex((item) => item.key === nextItem.key);
      tabRefs.current[domIdx]?.focus();
    },
    [items, currentKey, setCurrent],
  );

  const activeItem = items.find((item) => item.key === currentKey);

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        className="tabs-list"
      >
        {items.map((item, idx) => {
          const isActive = item.key === currentKey;
          const tabId = `${baseId}-tab-${item.key}`;
          const panelId = `${baseId}-panel-${item.key}`;

          return (
            <button
              key={item.key}
              ref={(el) => { tabRefs.current[idx] = el; }}
              role="tab"
              id={tabId}
              aria-selected={isActive}
              aria-controls={panelId}
              aria-disabled={item.disabled}
              tabIndex={isActive ? 0 : -1}
              className={`tabs-tab ${isActive ? "tabs-tab--active" : ""} ${item.disabled ? "tabs-tab--disabled" : ""}`}
              onClick={() => !item.disabled && setCurrent(item.key)}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {activeItem && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${activeItem.key}`}
          aria-labelledby={`${baseId}-tab-${activeItem.key}`}
          tabIndex={0}
          className="tabs-panel"
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
