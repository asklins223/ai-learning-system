/**
 * 卡组成员排序 — 单一事实来源（docs/plans/card-set-carousel-ui.md §1.3）。
 *
 * 总览卡（overview）永远排在章节卡前，章节卡按 ordinal 升序，ordinal 相同时
 * 按 id 稳定排序。轮播展开态与两个详情页（/card-sets/[id]、/cards/[id]）
 * 共用同一 comparator，避免三处复制漂移。
 */
import type { CardDetailResponse } from "@/lib/api";

export function compareCardSetMembers(
  left: CardDetailResponse,
  right: CardDetailResponse,
): number {
  const leftScope = left.card.scope === "overview" ? 0 : 1;
  const rightScope = right.card.scope === "overview" ? 0 : 1;
  if (leftScope !== rightScope) return leftScope - rightScope;
  const leftOrdinal =
    typeof left.card.ordinal === "number"
      ? left.card.ordinal
      : Number.MAX_SAFE_INTEGER;
  const rightOrdinal =
    typeof right.card.ordinal === "number"
      ? right.card.ordinal
      : Number.MAX_SAFE_INTEGER;
  return leftOrdinal - rightOrdinal || left.card.id.localeCompare(right.card.id);
}
