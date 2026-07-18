"use client";

import { useMemo } from "react";
import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";

/**
 * SourceReader — 来源原文阅读器组件。
 *
 * - 原文阅读区为主要视觉对象
 * - 解析片段和关联笔记为辅助区域
 * - 主纸面使用 Paper Surface
 */

interface Segment {
  id: string;
  content: string;
  sourceId: string;
}

interface SourceReaderProps {
  /** 来源标题 */
  title: string;
  /** 原始输入文本 */
  rawInput?: string;
  /** 解析后的片段列表 */
  segments: Segment[];
  /** 来源类型标签 */
  typeLabel?: string;
  /** 来源状态展示 */
  statusChip?: React.ReactNode;
  /** 创建时间 */
  createdAt?: string;
  /** 额外 className */
  className?: string;
}

export function SourceReader({
  title,
  rawInput,
  segments,
  typeLabel,
  statusChip,
  createdAt,
  className = "",
}: SourceReaderProps) {
  const hasSegments = segments.length > 0;

  const contentToDisplay = useMemo(() => {
    if (hasSegments) {
      return segments.map((seg) => (
        <div key={seg.id} className="source-reader__segment">
          <div className="source-reader__segment-content">{seg.content}</div>
        </div>
      ));
    }
    if (rawInput) {
      return (
        <div className="source-reader__raw">
          <div className="source-reader__raw-label">
            <Icon.Pencil className="h-3.5 w-3.5" />
            原始输入
          </div>
          <pre className="source-reader__raw-content">{rawInput}</pre>
        </div>
      );
    }
    return (
      <div className="source-reader__empty">
        <p>此来源尚无解析内容。</p>
      </div>
    );
  }, [hasSegments, segments, rawInput]);

  return (
    <div className={`source-reader ${className}`} data-ui="source-reader">
      {/* Header */}
      <header className="source-reader__header">
        <h1 className="source-reader__title">{title || "未命名来源"}</h1>
        <div className="source-reader__meta">
          {typeLabel && (
            <span className="source-reader__type">{typeLabel}</span>
          )}
          {statusChip}
          {createdAt && (
            <span className="source-reader__date">{createdAt}</span>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="source-reader__body">
        {contentToDisplay}
      </div>
    </div>
  );
}
