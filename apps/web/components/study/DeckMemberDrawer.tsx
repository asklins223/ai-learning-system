"use client";

import Link from "next/link";
import type { CardDetailResponse, CardSetListItem } from "@/lib/api";
import { statusMap, type StatusPresentation } from "@/lib/status-map";
import { readPartialCardCoverageWarning } from "@/lib/card-coverage-warning";
import { StatusChip } from "@/components/ui/StatusChip";
import { Icon } from "@/components/ui/icons";
import { Drawer } from "@/components/ui/Drawer";
import { compareCardSetMembers } from "@/lib/card-set-members";

interface DeckMemberDrawerProps {
  set: CardSetListItem;
  open: boolean;
  onClose: () => void;
  /** null = 加载中。 */
  cards: CardDetailResponse[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  presentation: StatusPresentation;
}

function memberPresentation(card: CardDetailResponse["card"]) {
  const partialWarning = readPartialCardCoverageWarning(card.schemaJson);
  return partialWarning
    ? { label: "部分结果", tone: "warning" as const }
    : statusMap.cardStatus(card.status);
}

/**
 * 移动端展开（§4.3）：复用底部 Drawer，focus trap + 滚动锁 + Esc + safe-area 免费。
 * 首行总览卡 highlight-soft 打头 + 章节行列表（≥64px）。
 */
export function DeckMemberDrawer({
  set,
  open,
  onClose,
  cards,
  loading,
  error,
  onRetry,
  presentation,
}: DeckMemberDrawerProps) {
  const ordered = (cards ?? []).slice().sort(compareCardSetMembers);
  const overview = ordered.find((item) => item.card.scope === "overview") ?? null;
  const sections = ordered.filter((item) => item.card.id !== overview?.card.id);

  const footer = (
    <Link
      href={`/card-sets/${set.id}`}
      className="deck-member-drawer-open"
      data-ui="deck-member-open"
    >
      打开完整卡组页
      <Icon.Open aria-hidden="true" />
    </Link>
  );

  return (
    <Drawer
      id="deck-member-drawer"
      open={open}
      onClose={onClose}
      title={`${set.title?.trim() || "未命名学习卡组"} · ${presentation.label}`}
      side="bottom"
      maxHeight="86dvh"
      footer={footer}
    >
      <div className="deck-member-drawer" data-ui="deck-member">
        {loading ? (
          <div
            className="deck-member-skeletons"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="正在加载卡组成员"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="deck-member-skeleton-row" aria-hidden="true">
                <span className="deck-skeleton-ordinal" />
                <span className="deck-skeleton-row-copy" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="deck-member-error" role="alert">
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
          <div className="deck-member-error" role="status">
            <Icon.Card aria-hidden="true" />
            <div>
              <strong>卡组还没有可阅读的卡片</strong>
              <p>可以打开完整卡组页重新生成。</p>
            </div>
          </div>
        ) : (
          <ol className="deck-member-list">
            {overview && (
              <li>
                <Link
                  href={`/cards/${overview.card.id}`}
                  className="deck-member-overview"
                >
                  <span className="deck-member-overview-kicker">
                    <Icon.Sparkle aria-hidden="true" />
                    总览
                  </span>
                  <strong>
                    {overview.card.schemaJson.title?.trim() || "未命名学习卡"}
                  </strong>
                  <small>{overview.keyPoints.length} 个理解要点</small>
                  <Icon.Arrow aria-hidden="true" />
                </Link>
              </li>
            )}
            {sections.map((item, index) => {
              const cardPresentation = memberPresentation(item.card);
              return (
                <li key={item.card.id}>
                  <Link
                    href={`/cards/${item.card.id}`}
                    className="deck-member-row"
                  >
                    <span className="deck-member-row-ordinal">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="deck-member-row-copy">
                      <strong>
                        {item.card.schemaJson.title?.trim() || "未命名学习卡"}
                      </strong>
                      <small>{item.keyPoints.length} 个理解要点</small>
                    </span>
                    <StatusChip
                      tone={cardPresentation.tone}
                      size="sm"
                      dot
                    >
                      {cardPresentation.label}
                    </StatusChip>
                    <Icon.Chevron aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Drawer>
  );
}
