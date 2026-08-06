"use client";

import {
  forwardRef,
  type CSSProperties,
  type MouseEventHandler,
} from "react";
import type { CardSetListItem } from "@/lib/api";
import type { DeckPose } from "@/lib/card-set-carousel";
import { relativeTime } from "@/lib/format";
import type { StatusPresentation } from "@/lib/status-map";
import { StatusChip } from "@/components/ui/StatusChip";

/** 封面位姿 → 舞台居中 transform（右到左：先旋转/缩放，再平移到舞台中心 + 位姿偏移）。
 *  拖拽期间 `--deck-dx` 叠加到 translateX（rAF 直写，§5.2）。 */
export function coverTransform(pose: DeckPose): string {
  return `translate(calc(-50% + ${pose.translateX}px + var(--deck-dx, 0px)), calc(-50% + ${pose.translateY}px)) rotateZ(${pose.rotateZ}deg) scale(${pose.scale})`;
}

/**
 * 封面纸面（face）— 轮播封面与展开停靠封面共用，保证视觉绝对一致。
 *
 * 复用 cards-card 视觉配方：paper 底 + 17px 点阵 + 厚纸堆叠阴影 +
 * 状态 accent 条 + 顶部（状态徽章 + 相对时间）+ 标题/摘要 + 底部纸堆边 + 张数徽章。
 */
export function DeckCoverFace({
  set,
  presentation,
  compact = false,
  className,
}: {
  set: CardSetListItem;
  presentation: StatusPresentation;
  compact?: boolean;
  className?: string;
}) {
  const peekCount = Math.min(set.sectionCardCount, 3);
  const isEmpty = set.cardCount === 0;
  const faceClassName = [
    "deck-cover-face",
    `deck-cover-face--${set.status}`,
    compact ? "deck-cover-face--compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={faceClassName}>
      {peekCount > 0 && (
        <div className="deck-cover-peeks" aria-hidden="true">
          {Array.from({ length: peekCount }, (_, k) => (
            <span
              key={k}
              className="deck-cover-peek"
              style={
                {
                  "--peek-w": `${6 * (k + 1)}px`,
                  "--peek-y": `${4 * (k + 1)}px`,
                  "--peek-r": `${(k % 2 === 0 ? 1 : -1) * 1.6}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div className="deck-cover-paper">
        <span className="deck-cover-accent" aria-hidden="true" />
        <div className="deck-cover-topline">
          <StatusChip tone={presentation.tone} size="sm" dot>
            {presentation.label}
          </StatusChip>
          <time
            dateTime={set.createdAt}
            className="deck-cover-time"
            title={new Date(set.createdAt).toLocaleString()}
            suppressHydrationWarning
          >
            {relativeTime(set.createdAt)}
          </time>
        </div>
        <div className="deck-cover-body">
          <h3>{set.title?.trim() || "未命名学习卡组"}</h3>
          <p>
            {set.summary?.trim()
              || (isEmpty
                  ? "该卡组暂无可阅读的卡片，打开详情页查看。"
                  : "暂无摘要，展开查看全部章节卡。")}
          </p>
        </div>
        <span className="deck-cover-count">
          {isEmpty ? "0 张 · 暂无卡片" : `${set.sectionCardCount} 张 · 含总览`}
        </span>
      </div>
    </div>
  );
}

export interface DeckCoverProps {
  set: CardSetListItem;
  presentation: StatusPresentation;
  pose: DeckPose;
  /** 覆盖默认可访问名称（内容含标题/状态/时间）。 */
  ariaLabel: string;
  /** 统一点击入口：轮播内部按 index === focus 决定展开 / 只聚焦。 */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

/**
 * 轮播封面按钮。roving tabindex 下只有焦点封面（d=0，tabIndex 0）可 Tab；
 * 侧翼（|d|≤maxWing）tabIndex -1，可点击只聚焦。降饱和/空卡组封面通过
 * 淡化纸张表达「后退」，文字对比度保持达标（WCAG 1.4.3）。
 */
export const DeckCover = forwardRef<HTMLButtonElement, DeckCoverProps>(
  function DeckCover(
    { set, presentation, pose, ariaLabel, onClick },
    ref,
  ) {
    const isFocus = pose.tabIndex === 0;
    const isEmpty = set.cardCount === 0;
    const className = [
      "deck-cover",
      pose.visible ? "" : "deck-cover--hidden",
      isFocus ? "deck-cover--focus" : "deck-cover--wing",
      isEmpty && isFocus ? "deck-cover--empty" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type="button"
        className={className}
        data-ui="deck-cover"
        style={
          {
            transform: coverTransform(pose),
            zIndex: pose.zIndex,
            opacity: pose.opacity,
          } as CSSProperties
        }
        tabIndex={pose.tabIndex}
        aria-hidden={pose.ariaHidden || undefined}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        <DeckCoverFace set={set} presentation={presentation} />
      </button>
    );
  },
);
