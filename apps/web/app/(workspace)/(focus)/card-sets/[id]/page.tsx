"use client";

import "@/app/styles/card-detail.css";
import "@/app/styles/card-set-detail.css";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type CardDetailResponse,
  type CardEvidenceGroup,
  type CardSetDetailResponse,
  type CardSetStatus,
} from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { readPartialCardCoverageWarning, readPartialCardSetCoverageWarning } from "@/lib/card-coverage-warning";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { AccountMenu } from "@/components/account/AccountMenu";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { StudyPaper } from "@/components/study/StudyPaper";
import { EvidenceRail } from "@/components/study/EvidenceRail";
import { EvidenceDrawer } from "@/components/EvidenceDrawer";

type LifecycleAction = "accept" | "dismiss" | "regenerate" | null;

const CARD_SET_STATUS: Record<
  CardSetStatus,
  { label: string; tone: StatusTone }
> = {
  draft: { label: "草稿", tone: "muted" },
  active: { label: "完整结果", tone: "success" },
  partial_ready: { label: "部分结果", tone: "warning" },
  superseded: { label: "已被替代", tone: "muted" },
  archived: { label: "已归档", tone: "muted" },
};

export default function CardSetPage() {
  const params = useParams<{ id: string }>();
  const cardSetId = params?.id;
  const activeCardSetIdRef = useRef(cardSetId);
  const cardPageRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  activeCardSetIdRef.current = cardSetId;
  const { isOwner, loading: ownerLoading } = useIsOwner();
  const [detail, setDetail] = useState<CardSetDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<CardEvidenceGroup[] | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceReloadKey, setEvidenceReloadKey] = useState(0);
  const [openKeyPointId, setOpenKeyPointId] = useState<string | null>(null);
  const [action, setAction] = useState<LifecycleAction>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const loadCardSet = useCallback(async () => {
    if (!cardSetId) return;
    setLoadError(null);
    try {
      const result = await api.getCardSet(cardSetId);
      if (activeCardSetIdRef.current !== cardSetId) return;
      setDetail(result);
      setSelectedCardId((current) =>
        result.cards.some((item) => item.card.id === current)
          ? current
          : findInitialCard(result.cards)?.card.id ?? null,
      );
    } catch {
      if (activeCardSetIdRef.current !== cardSetId) return;
      setLoadError("暂时无法读取这组学习卡，请稍后重试。");
    }
  }, [cardSetId]);

  useEffect(() => {
    cardPageRequestRef.current += 1;
    loadingMoreRef.current = false;
    setDetail(null);
    setSelectedCardId(null);
    setEvidence(null);
    setEvidenceError(null);
    setActionMessage(null);
    setActionError(null);
    setLoadingMore(false);
    setLoadMoreError(null);
    void loadCardSet();
  }, [cardSetId, loadCardSet]);

  const orderedCards = useMemo(
    () => detail ? [...detail.cards].sort(compareCardSetMembers) : [],
    [detail],
  );
  const overviewCard = orderedCards.find(
    (item) => item.card.scope === "overview",
  ) ?? null;
  const sectionCards = orderedCards.filter(
    (item) => item.card.id !== overviewCard?.card.id,
  );
  const selectedCard = orderedCards.find(
    (item) => item.card.id === selectedCardId,
  ) ?? orderedCards[0] ?? null;
  const selectedEvidenceCardId = selectedCard?.card.id ?? null;

  useEffect(() => {
    if (!selectedEvidenceCardId) {
      setEvidence(null);
      setEvidenceError(null);
      return;
    }

    let cancelled = false;
    setEvidence(null);
    setEvidenceError(null);
    setOpenKeyPointId(null);
    void api.getCardEvidence(selectedEvidenceCardId)
      .then((result) => {
        if (!cancelled) setEvidence(result);
      })
      .catch(() => {
        if (!cancelled) {
          setEvidenceError("证据暂时无法读取，学习卡正文仍可阅读。");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [evidenceReloadKey, selectedEvidenceCardId]);

  const loadMoreCards = useCallback(async () => {
    const cursor = detail?.nextCursor;
    if (!cardSetId || !cursor || loadingMoreRef.current) return;

    const requestId = cardPageRequestRef.current + 1;
    cardPageRequestRef.current = requestId;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const result = await api.listCardSetCards(cardSetId, {
        cursor,
        limit: 30,
      });
      if (
        activeCardSetIdRef.current !== cardSetId
        || cardPageRequestRef.current !== requestId
      ) {
        return;
      }
      if (result.cardSetId !== cardSetId) {
        setLoadMoreError("返回的卡组信息不一致，请重新加载页面。");
        return;
      }
      setDetail((current) => {
        if (
          !current
          || current.cardSet.id !== cardSetId
          || current.nextCursor !== cursor
        ) {
          return current;
        }
        return {
          ...current,
          cards: appendUniqueCardSetMembers(current.cards, result.items),
          nextCursor: result.nextCursor,
        };
      });
    } catch {
      if (
        activeCardSetIdRef.current === cardSetId
        && cardPageRequestRef.current === requestId
      ) {
        setLoadMoreError("更多学习卡暂时没有加载成功，请稍后重试。");
      }
    } finally {
      if (cardPageRequestRef.current === requestId) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [cardSetId, detail?.nextCursor]);

  const runAction = useCallback(async (
    nextAction: Exclude<LifecycleAction, null>,
  ) => {
    if (!cardSetId || action) return;
    if (
      nextAction === "dismiss"
      && !window.confirm("归档后，这组学习卡将退出当前学习流程。确认归档吗？")
    ) {
      return;
    }

    setAction(nextAction);
    setActionMessage(null);
    setActionError(null);
    try {
      if (nextAction === "accept") {
        const result = await api.acceptCardSet(cardSetId);
        const accepted =
          result.acceptedArtifacts ?? result.acceptedArtifactCount;
        setActionMessage(
          accepted == null
            ? "已接受整组学习卡，可以开始后续学习。"
            : `已接受整组学习卡，共发布 ${accepted} 个学习产物。`,
        );
      } else if (nextAction === "dismiss") {
        await api.dismissCardSet(cardSetId);
        setDetail((current) => current
          ? {
              ...current,
              cardSet: { ...current.cardSet, status: "archived" },
              cards: current.cards.map((item) => ({
                ...item,
                card: { ...item.card, status: "archived" },
              })),
            }
          : current);
        setActionMessage("这组学习卡已归档。");
      } else {
        const result = await api.regenerateCardSet(cardSetId);
        setActionMessage(
          result.runId
            ? `已创建重新生成任务（${shortId(result.runId)}），完成后会生成新的卡组。`
            : "已提交重新生成任务。",
        );
      }
    } catch {
      setActionError(
        nextAction === "accept"
          ? "暂时无法接受这组学习卡，请稍后再试。"
          : nextAction === "dismiss"
            ? "暂时无法归档这组学习卡，请稍后再试。"
            : "暂时无法创建重新生成任务，请稍后再试。",
      );
    } finally {
      setAction(null);
    }
  }, [action, cardSetId]);

  if (loadError && !detail) {
    return (
      <main className="card-set-detail" data-page-root>
        <CardSetHeader />
        <section className="card-set-state" role="alert">
          <Icon.Warn aria-hidden="true" />
          <p>卡组暂时不可用</p>
          <h1>这组学习卡没有成功打开</h1>
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadCardSet()}>
            <Icon.Refresh aria-hidden="true" />
            重新加载
          </button>
        </section>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="card-set-detail" data-page-root>
        <CardSetHeader />
        <section
          className="card-set-state is-loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <Icon.Sparkle aria-hidden="true" />
          <p>正在整理学习卡组…</p>
          <span>正在装订总览与章节卡。</span>
        </section>
      </main>
    );
  }

  const { cardSet } = detail;
  const presentation = CARD_SET_STATUS[cardSet.status];
  const setWarning = readPartialCardSetCoverageWarning(
    cardSet.coverageReport,
  ) ?? orderedCards
    .map((item) => readPartialCardCoverageWarning(item.card.schemaJson))
    .find((warning) => warning !== null)
    ?? null;
  const isPartial = cardSet.status === "partial_ready" || Boolean(setWarning);
  const canAccept = isOwner && cardSet.status === "active";
  const canChange =
    isOwner
    && cardSet.status !== "archived"
    && cardSet.status !== "superseded";
  const evidenceGroups = evidence ?? [];
  const activeEvidenceGroup = openKeyPointId
    ? evidenceGroups.find((group) => group.keyPoint.id === openKeyPointId)
    : null;
  const activeKeyPoint = selectedCard?.keyPoints.find(
    (keyPoint) => keyPoint.id === openKeyPointId,
  );

  return (
    <main className="card-set-detail" data-page-root>
      <CardSetHeader>
        <StatusChip tone={presentation.tone} size="sm" dot>
          {presentation.label}
        </StatusChip>
      </CardSetHeader>

      <div className="card-set-detail-shell">
        <section
          className="card-set-hero"
          aria-labelledby="card-set-detail-title"
        >
          <div className="card-set-hero-copy">
            <span className="card-set-kicker">
              <Icon.Sparkle aria-hidden="true" />
              LEARNING CARD SET
            </span>
            <h1 id="card-set-detail-title">
              {cardSet.title?.trim() || "未命名学习卡组"}
            </h1>
            <p>
              {cardSet.summary?.trim()
                || "由总览卡与章节卡组成的一组结构化学习材料。"}
            </p>
            <dl className="card-set-facts">
              <div>
                <dt>总览卡</dt>
                <dd>{overviewCard ? 1 : 0}</dd>
              </div>
              <div>
                <dt>章节卡</dt>
                <dd>
                  {sectionCards.length}
                  {detail.nextCursor ? "+" : ""}
                </dd>
              </div>
              <div>
                <dt>生成时间</dt>
                <dd>{formatDate(cardSet.createdAt)}</dd>
              </div>
            </dl>
          </div>

          <div className="card-set-actions" aria-label="卡组操作">
            {canAccept && (
              <button
                type="button"
                className="is-primary"
                disabled={Boolean(action)}
                onClick={() => void runAction("accept")}
              >
                <Icon.Check aria-hidden="true" />
                {action === "accept" ? "正在接受…" : "接受整组"}
              </button>
            )}
            {canChange && (
              <button
                type="button"
                disabled={Boolean(action)}
                onClick={() => void runAction("regenerate")}
              >
                <Icon.Refresh aria-hidden="true" />
                {action === "regenerate" ? "正在提交…" : "重新生成"}
              </button>
            )}
            {canChange && (
              <button
                type="button"
                className="is-danger"
                disabled={Boolean(action)}
                onClick={() => void runAction("dismiss")}
              >
                <Icon.Archive aria-hidden="true" />
                {action === "dismiss" ? "正在归档…" : "归档"}
              </button>
            )}
            {!ownerLoading && !isOwner && <MemberNotice variant="badge" />}
          </div>
        </section>

        <div className="card-set-messages" aria-live="polite">
          {isPartial && (
            <section className="card-set-partial-warning" role="status">
              <Icon.Warn aria-hidden="true" />
              <div>
                <strong>这是部分结果，覆盖范围并不完整</strong>
                <p>
                  {setWarning
                    ? `生成时排除了 ${setWarning.excludedImageCount} 张失败图片。`
                    : "部分素材未能完成处理。"}
                  {" "}该卡组不会自动替换已有完整学习卡，也不能直接进入验证或复习。
                </p>
                {setWarning && setWarning.excludedUnitIds.length > 0 && (
                  <span>
                    已明确记录 {setWarning.excludedUnitIds.length} 个排除单元。
                  </span>
                )}
              </div>
            </section>
          )}
          {actionMessage && (
            <div className="card-set-action-message is-success">
              <Icon.Check aria-hidden="true" />
              {actionMessage}
            </div>
          )}
          {actionError && (
            <div className="card-set-action-message is-error" role="alert">
              <Icon.Warn aria-hidden="true" />
              {actionError}
            </div>
          )}
        </div>

        {orderedCards.length === 0 ? (
          <section className="card-set-empty">
            <Icon.Card aria-hidden="true" />
            <h2>卡组还没有可阅读的卡片</h2>
            <p>可以重新生成，或稍后回来查看。</p>
          </section>
        ) : (
          <div className="card-set-workbench">
            <aside className="card-set-navigator">
              <div className="card-set-navigator-heading">
                <span>卡组目录</span>
                <strong>
                  {orderedCards.length}
                  {detail.nextCursor ? "+" : ""} 张
                </strong>
              </div>

              <CardSetMemberGroup
                title="总览"
                cards={overviewCard ? [overviewCard] : []}
                selectedCardId={selectedCard?.card.id ?? null}
                onSelect={setSelectedCardId}
              />
              <CardSetMemberGroup
                title="章节卡"
                cards={sectionCards}
                selectedCardId={selectedCard?.card.id ?? null}
                onSelect={setSelectedCardId}
              />
              {(detail.nextCursor || loadMoreError) && (
                <div
                  className="card-set-pagination"
                  aria-live="polite"
                  aria-busy={loadingMore}
                >
                  {loadMoreError && (
                    <p role="alert">
                      <Icon.Warn aria-hidden="true" />
                      {loadMoreError}
                    </p>
                  )}
                  {detail.nextCursor && (
                    <button
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadMoreCards()}
                    >
                      {loadingMore ? (
                        <Icon.Refresh aria-hidden="true" />
                      ) : (
                        <Icon.Plus aria-hidden="true" />
                      )}
                      {loadingMore ? "正在加载…" : "加载更多"}
                    </button>
                  )}
                </div>
              )}
            </aside>

            {selectedCard && (
              <section
                className="card-set-reader"
                aria-label="当前学习卡"
              >
                <header className="card-set-reader-header">
                  <div>
                    <span>
                      {selectedCard.card.scope === "overview"
                        ? "总览卡"
                        : `章节卡 ${Math.max(
                            1,
                            sectionCards.findIndex(
                              (item) =>
                                item.card.id === selectedCard.card.id,
                            ) + 1,
                          )}`}
                    </span>
                    <h2>
                      {selectedCard.card.schemaJson.title?.trim()
                        || "未命名学习卡"}
                    </h2>
                  </div>
                  <Link href={`/cards/${selectedCard.card.id}`}>
                    打开单卡详情
                    <Icon.Open aria-hidden="true" />
                  </Link>
                </header>

                <div className="card-set-reader-grid">
                  <StudyPaper
                    data={selectedCard}
                    groups={evidenceGroups}
                    latestFeedback={null}
                    onOpenEvidence={setOpenKeyPointId}
                  />
                  <aside className="card-set-evidence" aria-label="当前卡片证据">
                    <EvidenceRail
                      groups={evidenceGroups}
                      selectedKeyPointId={openKeyPointId}
                      loading={evidence === null && !evidenceError}
                      error={evidenceError}
                      onSelect={setOpenKeyPointId}
                      onRetry={() =>
                        setEvidenceReloadKey((current) => current + 1)}
                    />
                  </aside>
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {activeEvidenceGroup && activeKeyPoint && (
        <EvidenceDrawer
          open={Boolean(openKeyPointId)}
          onClose={() => setOpenKeyPointId(null)}
          claim={activeKeyPoint.claim}
          chips={activeEvidenceGroup.evidences}
        />
      )}
    </main>
  );
}

function CardSetHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="card-set-header">
      <div className="card-set-header-leading">
        <Link href="/cards" className="card-set-back">
          <Icon.Chevron aria-hidden="true" />
          <span>学习卡</span>
        </Link>
        {children}
      </div>
      <div className="card-set-header-tools">
        <ThemeToggle className="card-detail-theme-toggle" />
        <AccountMenu
          className="card-detail-account-menu"
          triggerClassName="card-detail-avatar"
        />
      </div>
    </header>
  );
}

function CardSetMemberGroup({
  title,
  cards,
  selectedCardId,
  onSelect,
}: {
  title: string;
  cards: CardDetailResponse[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
}) {
  return (
    <section className="card-set-member-group" aria-label={title}>
      <h2>{title}</h2>
      {cards.length === 0 ? (
        <p className="card-set-member-empty">暂无{title}卡片</p>
      ) : (
        <ol>
          {cards.map((item, index) => {
            const selected = item.card.id === selectedCardId;
            return (
              <li key={item.card.id}>
                <button
                  type="button"
                  className={selected ? "is-selected" : undefined}
                  aria-pressed={selected}
                  onClick={() => onSelect(item.card.id)}
                >
                  <span className="card-set-member-index">
                    {item.card.scope === "overview"
                      ? "总"
                      : String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="card-set-member-copy">
                    <strong>
                      {item.card.schemaJson.title?.trim() || "未命名学习卡"}
                    </strong>
                    <small>{item.keyPoints.length} 个理解要点</small>
                  </span>
                  <Icon.Chevron aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function findInitialCard(
  cards: CardDetailResponse[],
): CardDetailResponse | null {
  if (cards.length === 0) return null;
  return [...cards].sort(compareCardSetMembers)[0] ?? null;
}

function appendUniqueCardSetMembers(
  current: CardDetailResponse[],
  incoming: CardDetailResponse[],
): CardDetailResponse[] {
  const knownIds = new Set(current.map((item) => item.card.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (knownIds.has(item.card.id)) return false;
      knownIds.add(item.card.id);
      return true;
    }),
  ];
}

function compareCardSetMembers(
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function shortId(value: string): string {
  return value.length > 12
    ? `${value.slice(0, 8)}…${value.slice(-4)}`
    : value;
}
