"use client";

import Link from "next/link";
import { useEffect, useRef, type CSSProperties } from "react";
import type { CardDetailResponse, CardSetListItem } from "@/lib/api";
import type { StatusPresentation } from "@/lib/status-map";
import { readPartialCardCoverageWarning } from "@/lib/card-coverage-warning";
import { statusMap } from "@/lib/status-map";
import { compareCardSetMembers } from "@/lib/card-set-members";
import { StatusChip } from "@/components/ui/StatusChip";
import { Icon } from "@/components/ui/icons";
import { DeckCoverFace } from "./DeckCover";

/**
 * 展开态成员卡排序（总览先、再按 ordinal）— 与 /card-sets/[id]、/cards/[id]
 * 详情页共用 lib/card-set-members.ts 的同一 comparator。
 */

/** 成员卡瓦片 — 紧凑变体：ordinal + 标题 + 摘要 + 要点数 + 状态 chip（§6.2，重统计留给详情页）。 */
export function MemberCardTile({
  item,
  ordinalLabel,
  enterDelay = 0,
  enterRotate = 0,
}: {
  item: CardDetailResponse;
  ordinalLabel: string;
  /** 入场 stagger（§5.3）：@keyframes + animation-delay，index>10 统一封顶 350ms。 */
  enterDelay?: number;
  enterRotate?: number;
}) {
  const card = item.card;
  const partialWarning = readPartialCardCoverageWarning(card.schemaJson);
  const presentation = partialWarning
    ? { label: "部分结果", tone: "warning" as const }
    : statusMap.cardStatus(card.status);
  const isOverview = card.scope === "overview";

  return (
    <Link
      href={`/cards/${card.id}`}
      className={[
        "deck-member-tile",
        `deck-member-tile--${card.status}`,
        isOverview ? "deck-member-tile--overview" : "",
      ].filter(Boolean).join(" ")}
      data-ui="deck-member-card"
      style={
        {
          "--enter-delay": `${enterDelay}ms`,
          "--enter-rotate": `${enterRotate}deg`,
        } as CSSProperties
      }
    >
      <span className="deck-member-tile-accent" aria-hidden="true" />
      <span className="deck-member-tile-topline">
        <span className="deck-member-tile-ordinal">{ordinalLabel}</span>
        <StatusChip tone={presentation.tone} size="sm" dot>
          {presentation.label}
        </StatusChip>
      </span>
      <span className="deck-member-tile-title">
        {card.schemaJson.title?.trim() || "未命名学习卡"}
      </span>
      <span className="deck-member-tile-summary">
        {card.schemaJson.summary?.trim()
          || "暂无摘要，打开卡片查看完整内容。"}
      </span>
      {partialWarning && (
        <span className="deck-member-tile-partial">
          <Icon.Warn aria-hidden="true" />
          已排除 {partialWarning.excludedImageCount} 张图片，为部分结果。
        </span>
      )}
      <span className="deck-member-tile-footer">
        {item.keyPoints.length} 个理解要点
      </span>
    </Link>
  );
}

interface DeckExpandedViewProps {
  set: CardSetListItem;
  /** null = 加载中。 */
  cards: CardDetailResponse[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCollapse: () => void;
  presentation: StatusPresentation;
  /** 收起退场中：成员 120ms 同时淡出（§5.1 获得慢、放弃快）。 */
  leaving?: boolean;
}

/**
 * 桌面展开「摊牌」（§4.1）：左列 sticky 封面停靠 + 右列成员流。
 * 复刻 /card-sets/[id] workbench 的「左导航 + 右内容」比例；成员全量渲染。
 */
export function DeckExpandedView({
  set,
  cards,
  loading,
  error,
  onRetry,
  onCollapse,
  presentation,
  leaving = false,
}: DeckExpandedViewProps) {
  const ordered = (cards ?? []).slice().sort(compareCardSetMembers);
  const overview = ordered.find((item) => item.card.scope === "overview") ?? null;
  const sections = ordered.filter((item) => item.card.id !== overview?.card.id);
  const collapseRef = useRef<HTMLButtonElement>(null);

  /* 展开后焦点移入面板（收起按钮），Esc 由页面全局处理 */
  useEffect(() => {
    collapseRef.current?.focus();
  }, []);

  return (
    <div
      className={`deck-expanded ${leaving ? "deck-expanded--leaving" : ""}`}
      data-ui="deck-expanded"
    >
      <aside className="deck-expanded-cover">
        <div className="deck-expanded-cover-face">
          <DeckCoverFace set={set} presentation={presentation} compact />
        </div>
        <div className="deck-expanded-cover-stats" role="group" aria-label="卡组统计">
          <div>
            <b>{set.cardCount}</b>
            <span>张卡片</span>
          </div>
          <div>
            <b>{sections.length}</b>
            <span>个章节</span>
          </div>
          <div>
            <b>{overview ? "含" : "无"}</b>
            <span>总览</span>
          </div>
        </div>
        <div className="deck-expanded-cover-actions">
          <button
            ref={collapseRef}
            type="button"
            className="deck-expanded-collapse"
            data-ui="deck-collapse"
            onClick={onCollapse}
          >
            <Icon.Chevron aria-hidden="true" />
            收起卡组
          </button>
          <Link href={`/card-sets/${set.id}`} className="deck-expanded-open">
            打开完整卡组页
            <Icon.Open aria-hidden="true" />
          </Link>
        </div>
      </aside>

      <section className="deck-expanded-members" aria-label="卡组成员">
        <header className="deck-expanded-heading">
          <h2>{set.title?.trim() || "未命名学习卡组"}</h2>
          <div className="deck-expanded-heading-meta">
            <span>{set.cardCount} 张卡片</span>
            {sections.length > 0 && (
              <>
                <span className="deck-expanded-heading-dot" aria-hidden="true" />
                <span>{sections.length} 个章节</span>
              </>
            )}
            <span className="deck-expanded-heading-dot" aria-hidden="true" />
            <span>展开后全部可见</span>
          </div>
        </header>

        {loading ? (
          <div
            className="deck-expanded-skeletons"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="正在加载卡组成员"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className={index === 0
                  ? "deck-member-skeleton deck-member-skeleton--overview"
                  : "deck-member-skeleton"}
                aria-hidden="true"
              >
                <span className="deck-skeleton-topline" />
                <span className="deck-skeleton-title" />
                <span className="deck-skeleton-copy" />
                <span className="deck-skeleton-copy deck-skeleton-copy--short" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="deck-expanded-error" role="alert">
            <Icon.Warn aria-hidden="true" />
            <div>
              <strong>成员暂时无法读取</strong>
              <p>{error}</p>
              <button type="button" onClick={onRetry}>
                <Icon.Refresh aria-hidden="true" />
                重新加载
              </button>
            </div>
          </div>
        ) : ordered.length === 0 ? (
          <div className="deck-expanded-error" role="status">
            <Icon.Card aria-hidden="true" />
            <div>
              <strong>卡组还没有可阅读的卡片</strong>
              <p>可以打开完整卡组页重新生成。</p>
            </div>
          </div>
        ) : (
          <div className="deck-expanded-members-grid">
            {overview && (
              <MemberCardTile
                item={overview}
                ordinalLabel="总览"
              />
            )}
            {sections.map((item, index) => (
              <MemberCardTile
                key={item.card.id}
                item={item}
                ordinalLabel={`章节 ${String(index + 1).padStart(2, "0")}`}
                enterDelay={Math.min(index, 10) * 35}
                enterRotate={(index % 2 === 0 ? 1 : -1) * 2}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
