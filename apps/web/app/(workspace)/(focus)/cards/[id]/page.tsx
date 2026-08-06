"use client";

import "@/app/styles/card-detail.css";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  CardDetailResponse,
  CardSetDetailResponse,
  CardListItem,
  CardEvidenceGroup,
  EvidenceOverride,
  effectiveAlignment,
  isHardEvidence,
  type ValidationEvent,
} from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { compareCardSetMembers } from "@/lib/card-set-members";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { EvidenceDialog } from "@/components/EvidenceDialog";
import { Drawer } from "@/components/ui/Drawer";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { StudyPaper } from "@/components/study/StudyPaper";
import { EvidenceRail } from "@/components/study/EvidenceRail";
import { UnderstandingFacts } from "@/components/study/UnderstandingFacts";
import { ReviewPlanCard } from "@/components/study/ReviewPlanCard";
import { AccountMenu } from "@/components/account/AccountMenu";
import {
  sanitizeSearchReturnTarget,
  withSearchReturnTarget,
} from "@/lib/search-return";
import {
  sanitizeTodayReturnTarget,
  withTodayReturnTarget,
} from "@/lib/today-return";
import { isQuestionFirstUIEnabled } from "@/lib/feature-flags";
import { statusMap } from "@/lib/status-map";
import {
  formatSafeImageUnitReference,
  readPartialCardCoverageWarning,
} from "@/lib/card-coverage-warning";

type DetailLayoutMode = "wide" | "medium" | "compact";

type PagerState = {
  index: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
};

const EMPTY_PAGER: PagerState = {
  index: 1,
  total: 1,
  previousId: null,
  nextId: null,
};

export default function CardPage() {
  const { isOwner, loading: ownerLoading } = useIsOwner();
  const params = useParams<{ id: string }>();
  const cardId = params?.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchReturnTarget = sanitizeSearchReturnTarget(searchParams.get("returnTo"));
  const todayReturnTarget = sanitizeTodayReturnTarget(searchParams.get("returnTo"));
  const reviewReturnTarget = sanitizeReviewReturnTarget(
    searchParams.get("returnTo"),
  );
  const backHref =
    searchReturnTarget ?? todayReturnTarget ?? reviewReturnTarget ?? "/cards";
  const backLabel = searchReturnTarget
    ? "搜索结果"
    : todayReturnTarget
      ? "今日变化"
      : reviewReturnTarget
        ? "今日复习"
        : "学习卡";
  const shouldReplaceBackNavigation = Boolean(
    searchReturnTarget || todayReturnTarget || reviewReturnTarget,
  );
  const withCardReturnTarget = (destination: string) =>
    searchReturnTarget
      ? withSearchReturnTarget(destination, searchReturnTarget)
      : todayReturnTarget
        ? withTodayReturnTarget(destination, todayReturnTarget)
        : reviewReturnTarget
          ? withReviewReturnTarget(destination, reviewReturnTarget)
          : null;
  const deskRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const activeCardIdRef = useRef(cardId);
  activeCardIdRef.current = cardId;

  const [data, setData] = useState<CardDetailResponse | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<CardEvidenceGroup[] | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceActionError, setEvidenceActionError] = useState<string | null>(
    null,
  );
  const [validationHistory, setValidationHistory] = useState<ValidationEvent[]>(
    [],
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nextReviewAt, setNextReviewAt] = useState<string | null>(null);
  const [cardListItem, setCardListItem] = useState<CardListItem | null>(null);
  const [cardSetDetail, setCardSetDetail] =
    useState<CardSetDetailResponse | null>(null);
  const [pager, setPager] = useState<PagerState>(EMPTY_PAGER);
  const [openKeyPointId, setOpenKeyPointId] = useState<string | null>(null);
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [layoutMode, setLayoutMode] =
    useState<DetailLayoutMode>("compact");
  const [lifecycleAction, setLifecycleAction] = useState<
    "idle" | "regenerating"
  >("idle");
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const element = deskRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const setModeFromWidth = (width: number) => {
      setLayoutMode(
        width >= 1240 ? "wide" : width >= 1080 ? "medium" : "compact",
      );
    };

    setModeFromWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setModeFromWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (layoutMode !== "compact") setEvidencePanelOpen(false);
  }, [layoutMode]);

  useEffect(() => {
    if (!cardId) return;

    setData(null);
    setCardError(null);
    setEvidence(null);
    setEvidenceError(null);
    setEvidenceActionError(null);
    setValidationHistory([]);
    setValidationError(null);
    setNextReviewAt(null);
    setCardListItem(null);
    setCardSetDetail(null);
    setPager(EMPTY_PAGER);
    setOpenKeyPointId(null);
    setEvidencePanelOpen(false);
    setLifecycleAction("idle");
    setLifecycleMessage(null);
  }, [cardId]);

  useEffect(() => {
    const parentSetId =
      data?.card.id === cardId ? data.card.cardSetId : null;
    if (!parentSetId) {
      setCardSetDetail(null);
      return;
    }

    let cancelled = false;
    void api.getCardSet(parentSetId)
      .then((result) => {
        if (!cancelled) setCardSetDetail(result);
      })
      .catch(() => {
        // Membership still comes from the card row; sibling navigation is an
        // enhancement and must not block the card itself.
        if (!cancelled) setCardSetDetail(null);
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, data?.card.cardSetId, data?.card.id]);

  const fetchCardDetail = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    try {
      const result = await api.getCard(cardId);
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setData(result);
      setCardError(null);
    } catch {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setCardError("暂时无法读取这张学习卡，请稍后重试。");
    }
  }, [cardId]);

  const fetchEvidence = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    try {
      const result = await api.getCardEvidence(cardId);
      const reviewedEvidenceId = result
        .flatMap((group) => group.evidences)
        .find((item) => Boolean(item.id))?.id;
      if (reviewedEvidenceId) {
        // The server only accepts this acknowledgement with an evidence row
        // belonging to the active workspace. Await the best-effort write so a
        // route change cannot cancel it after evidence is already rendered.
        await api.markOnboardingStep("evidence_review", reviewedEvidenceId).catch(() => {});
      }
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setEvidence(result);
      setEvidenceError(null);
    } catch {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setEvidenceError("证据暂时无法读取，请稍后重试。");
    }
  }, [cardId]);

  const fetchValidations = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    try {
      const result = await api.listValidations(cardId);
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setValidationHistory(result.items);
      setValidationError(null);
    } catch {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setValidationError("验证记录暂时无法读取，请稍后重试。");
    }
  }, [cardId]);

  useEffect(() => {
    if (!cardId) return;
    void fetchCardDetail();
    void fetchEvidence();
    void fetchValidations();

    let cancelled = false;
    void (async () => {
      try {
        let items: CardListItem[] = [];
        let cursor: string | undefined;
        let total = 0;

        for (let page = 0; page < 10; page += 1) {
          const result = await api.listCards({ cursor, limit: 100 });
          items = appendUniqueCards(items, result.items);
          total = result.total;
          const currentIndex = items.findIndex((item) => item.id === cardId);
          const hasNextItem = currentIndex >= 0 && !!items[currentIndex + 1];

          if (
            currentIndex >= 0 &&
            (hasNextItem || !result.nextCursor)
          ) {
            if (cancelled) return;
            const current = items[currentIndex];
            setPager({
              index: currentIndex + 1,
              total: Math.max(total, items.length, 1),
              previousId: items[currentIndex - 1]?.id ?? null,
              nextId: items[currentIndex + 1]?.id ?? null,
            });
            setCardListItem(current);
            setNextReviewAt(current.nextReviewAt ?? null);
            return;
          }

          if (!result.nextCursor) {
            if (cancelled) return;
            setPager({
              ...EMPTY_PAGER,
              total: Math.max(total, items.length, 1),
            });
            return;
          }

          cursor = result.nextCursor;
        }
      } catch {
        // 翻页统计失败时保留安全默认值，详情主体仍可使用。
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    cardId,
    fetchCardDetail,
    fetchEvidence,
    fetchValidations,
  ]);

  const handleRegenerate = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    setLifecycleAction("regenerating");
    setLifecycleMessage(null);

    try {
      const { jobId, sameVersion } = await api.regenerateCard(cardId);
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setLifecycleMessage(
        sameVersion
          ? "内容未变化，正在重新整理这张学习卡…"
          : `已提交重新生成任务，完成后将返回${backLabel}。`,
      );

      let delay = 1500;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        const job = await api.getJob(jobId);
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }

        if (job.status === "succeeded") {
          setLifecycleMessage(`学习卡已重新生成，正在返回${backLabel}…`);
          window.setTimeout(
            () => {
              if (
                mountedRef.current &&
                activeCardIdRef.current === requestCardId
              ) {
                router.replace(backHref);
              }
            },
            1200,
          );
          return;
        }
        if (job.status === "failed" || job.status === "dead") {
          setLifecycleMessage("学习卡暂时没有重新生成成功，请稍后重试。");
          setLifecycleAction("idle");
          return;
        }
        delay = Math.min(3000, delay * 1.3);
      }

      setLifecycleMessage("等待超时，可稍后返回列表查看生成结果。");
      setLifecycleAction("idle");
    } catch {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setLifecycleMessage("重新生成暂时没有开始，请稍后重试。");
      setLifecycleAction("idle");
    }
  }, [backHref, backLabel, cardId, router]);

  const handleEvidenceOverride = useCallback(
    async (evidenceId: string, override: EvidenceOverride) => {
      const requestCardId = cardId;
      if (!requestCardId) return;
      setEvidenceActionError(null);
      try {
        await api.overrideEvidence(evidenceId, override);
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        await fetchEvidence();
      } catch {
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        setEvidenceActionError("证据状态暂时没有更新成功，请稍后重试。");
      }
    },
    [cardId, fetchEvidence],
  );

  const currentData = data?.card.id === cardId ? data : null;

  if (cardError && !currentData) {
    return (
      <div
        ref={deskRef}
        className="card-detail-desk"
        data-layout={layoutMode}
      >
        <CardDetailSimpleHeader
          backHref={backHref}
          backLabel={backLabel}
          replace={shouldReplaceBackNavigation}
        />
        <section
          className="card-detail-state"
          role="alert"
          aria-labelledby="card-error-title"
        >
          <span className="card-detail-state-icon is-error">
            <Icon.Warn aria-hidden="true" />
          </span>
          <p className="card-detail-state-kicker">CARD UNAVAILABLE</p>
          <h1 id="card-error-title">这张学习卡暂时打不开</h1>
          <p>{cardError}</p>
          <div className="card-detail-state-actions">
            <button type="button" onClick={() => void fetchCardDetail()}>
              <Icon.Refresh aria-hidden="true" />
              重新加载
            </button>
            <Link href={backHref} replace={shouldReplaceBackNavigation}>返回{backLabel}</Link>
          </div>
        </section>
      </div>
    );
  }

  if (!currentData) {
    return (
      <div
        ref={deskRef}
        className="card-detail-desk"
        data-layout={layoutMode}
      >
        <CardDetailSimpleHeader
          backHref={backHref}
          backLabel={backLabel}
          replace={shouldReplaceBackNavigation}
        />
        <section
          className="card-detail-loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="card-detail-loading-label">正在整理学习卡…</span>
          <div className="card-detail-loading-rail" aria-hidden="true" />
          <div className="card-detail-loading-paper" aria-hidden="true" />
          <div className="card-detail-loading-panel" aria-hidden="true" />
        </section>
      </div>
    );
  }

  const { card, keyPoints } = currentData;
  const evidenceGroups = evidence ?? [];
  const allEvidence = evidenceGroups
    .flatMap((group) => group.evidences)
    .filter(
      (item) =>
        effectiveAlignment(
          item.alignment,
          item.effectiveOverride ?? item.userOverride,
        ) !== null,
    );
  const alignedCount = allEvidence.filter((item) =>
    isHardEvidence(
      item.alignment,
      item.effectiveOverride ?? item.userOverride,
    ),
  ).length;
  const evidenceCount = allEvidence.length;
  const validationCount = Math.max(
    cardListItem?.validationCount ?? 0,
    validationHistory.length,
  );
  const latestFeedback = validationHistory[0]?.feedback ?? null;
  const isCardActive = card.status === "active";
  const evidenceLoading = evidence === null && !evidenceError;
  const eligibleKeyPointCount = evidenceGroups.filter((group) =>
    group.evidences.some((item) =>
      isHardEvidence(
        item.alignment,
        item.effectiveOverride ?? item.userOverride,
      ),
    ),
  ).length;
  const canValidate =
    isCardActive && !evidenceLoading && eligibleKeyPointCount > 0;
  const questionFirstEnabled = isQuestionFirstUIEnabled();
  const canStartValidation = questionFirstEnabled && canValidate;
  const partialCoverageWarning = readPartialCardCoverageWarning(
    card.schemaJson,
  );
  const cardPresentation = partialCoverageWarning
    ? { label: "部分结果", tone: "warning" as const }
    : statusMap.cardStatus(card.status);
  const cardTitle = card.schemaJson.title?.trim() || "未命名学习卡";
  const cardSummary =
    card.schemaJson.summary?.trim() || "这张学习卡还没有核心理解摘要。";
  const createdAtLabel = formatCardDate(card.createdAt);
  const activeGroup = openKeyPointId
    ? evidenceGroups.find(
        (group) => group.keyPoint.id === openKeyPointId,
      )
    : null;
  const activeKeyPoint = keyPoints.find(
    (keyPoint) => keyPoint.id === openKeyPointId,
  );
  const setCards = cardSetDetail
    ? [...cardSetDetail.cards].sort(compareCardSetMembers)
    : [];
  const setCardIndex = setCards.findIndex(
    (item) => item.card.id === card.id,
  );
  const previousSetCard =
    setCardIndex > 0 ? setCards[setCardIndex - 1] : null;
  const nextSetCard =
    setCardIndex >= 0 ? setCards[setCardIndex + 1] ?? null : null;

  const openEvidenceDetail = (keyPointId: string) => {
    setEvidencePanelOpen(false);
    setOpenKeyPointId(keyPointId);
  };

  const revealEvidenceWorkspace = () => {
    if (layoutMode === "compact") {
      setEvidencePanelOpen(true);
      return;
    }

    document
      .querySelector<HTMLElement>('[data-ui="evidence-rail"]')
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div
      ref={deskRef}
      className="card-detail-desk"
      data-layout={layoutMode}
    >
      <header className="card-detail-header" data-ui="card-detail-header">
        <div className="card-detail-header-leading">
          <Link
            href={backHref}
            replace={shouldReplaceBackNavigation}
            className="card-detail-back"
          >
            <Icon.Chevron aria-hidden="true" />
            <span>{backLabel}</span>
          </Link>
          <StatusChip tone={cardPresentation.tone} size="sm" dot>
            {cardPresentation.label}
          </StatusChip>
        </div>

        <nav className="card-detail-pager" aria-label="学习卡导航">
          {pager.previousId ? (
            <Link
              href={
                withCardReturnTarget(`/cards/${pager.previousId}`) ??
                `/cards/${pager.previousId}`
              }
              replace={shouldReplaceBackNavigation}
              className="card-detail-pager-button"
              aria-label="上一张学习卡"
            >
              <Icon.Chevron aria-hidden="true" />
            </Link>
          ) : (
            <span
              className="card-detail-pager-button is-disabled"
              aria-hidden="true"
            >
              <Icon.Chevron />
            </span>
          )}
          <span className="card-detail-pager-count">
            <small>卡片</small>
            <strong>
              {pager.index} / {pager.total}
            </strong>
          </span>
          {pager.nextId ? (
            <Link
              href={
                withCardReturnTarget(`/cards/${pager.nextId}`) ??
                `/cards/${pager.nextId}`
              }
              replace={shouldReplaceBackNavigation}
              className="card-detail-pager-button is-next"
              aria-label="下一张学习卡"
            >
              <Icon.Chevron aria-hidden="true" />
            </Link>
          ) : (
            <span
              className="card-detail-pager-button is-next is-disabled"
              aria-hidden="true"
            >
              <Icon.Chevron />
            </span>
          )}
        </nav>

        <div className="card-detail-header-actions">
          {isCardActive && isOwner && (
            <button
              type="button"
              className="card-detail-header-action card-detail-regenerate"
              onClick={() => void handleRegenerate()}
              disabled={lifecycleAction !== "idle"}
              aria-label={
                lifecycleAction === "regenerating"
                  ? "正在重新生成学习卡"
                  : "重新生成学习卡"
              }
              title="重新生成学习卡"
            >
              <Icon.Highlighter aria-hidden="true" />
              <span>
                {lifecycleAction === "regenerating"
                  ? "生成中"
                  : "重新生成"}
              </span>
            </button>
          )}
          {isCardActive && !ownerLoading && !isOwner && <MemberNotice variant="badge" />}
          <ThemeToggle className="card-detail-theme-toggle" />
          <AccountMenu
            className="card-detail-account-menu"
            triggerClassName="card-detail-avatar"
          />
        </div>
      </header>

      <div className="card-detail-main">
        {card.cardSetId && (
          <nav
            className="card-detail-set-navigation"
            aria-label="卡组内学习卡导航"
          >
            <Link
              href={`/card-sets/${card.cardSetId}`}
              className="card-detail-set-link"
            >
              <Icon.Card aria-hidden="true" />
              <span>
                {cardSetDetail?.cardSet.title?.trim() || "查看所属卡组"}
              </span>
            </Link>
            {setCardIndex >= 0 && (
              <>
                <span className="card-detail-set-position">
                  {card.scope === "overview" ? "总览卡" : "章节卡"} ·{" "}
                  {setCardIndex + 1} / {setCards.length}
                </span>
                <span className="card-detail-set-siblings">
                  {previousSetCard ? (
                    <Link
                      href={`/cards/${previousSetCard.card.id}`}
                      aria-label="卡组内上一张学习卡"
                    >
                      <Icon.Chevron aria-hidden="true" />
                      上一张
                    </Link>
                  ) : (
                    <span aria-hidden="true">上一张</span>
                  )}
                  {nextSetCard ? (
                    <Link
                      href={`/cards/${nextSetCard.card.id}`}
                      aria-label="卡组内下一张学习卡"
                    >
                      下一张
                      <Icon.Chevron aria-hidden="true" />
                    </Link>
                  ) : (
                    <span aria-hidden="true">下一张</span>
                  )}
                </span>
              </>
            )}
          </nav>
        )}
        <div className="card-detail-alerts" aria-live="polite">
          {partialCoverageWarning && (
            <div
              className="card-detail-alert card-detail-partial-alert is-warning"
              role="status"
            >
              <Icon.Warn aria-hidden="true" />
              <div className="card-detail-partial-alert-copy">
                <strong>部分结果</strong>
                <p>
                  生成时排除了 {partialCoverageWarning.excludedImageCount}{" "}
                  张图片。这张卡不会替换完整学习卡，也不能用于验证或复习。
                </p>
                {partialCoverageWarning.excludedImages.length > 0 && (
                  <ul aria-label="已排除的图片素材">
                    {partialCoverageWarning.excludedImages
                      .slice(0, 5)
                      .map((image, index) => (
                        <li key={image.imageAssetId}>
                          缺失图片 {index + 1}
                          <span>
                            素材{" "}
                            <code>
                              {formatSafeImageUnitReference(image.imageAssetId)}
                            </code>
                          </span>
                        </li>
                      ))}
                    {partialCoverageWarning.excludedImages.length > 5 && (
                      <li>
                        另有{" "}
                        {partialCoverageWarning.excludedImages.length - 5}{" "}
                        张图片未展开
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          )}
          {evidenceError && layoutMode === "compact" && (
            <div className="card-detail-alert is-danger">
              <Icon.Warn aria-hidden="true" />
              <span>证据暂时没有载入，学习卡正文仍可阅读。</span>
              <button type="button" onClick={() => void fetchEvidence()}>
                重试
              </button>
            </div>
          )}
          {validationError && validationHistory.length === 0 && (
            <div className="card-detail-alert is-warning">
              <Icon.Warn aria-hidden="true" />
              <span>验证记录暂时没有载入，不影响继续阅读。</span>
              <button type="button" onClick={() => void fetchValidations()}>
                重试
              </button>
            </div>
          )}
          {lifecycleMessage && (
            <div className="card-detail-alert is-info">
              <Icon.Refresh aria-hidden="true" />
              <span>{lifecycleMessage}</span>
            </div>
          )}
        </div>

        <section
          className="card-detail-overview"
          aria-labelledby="card-detail-title"
        >
          <div className="card-detail-overview-grid">
            <div className="card-detail-overview-copy">
              <div className="card-detail-overview-meta">
                <span className="card-detail-overview-mobile-status">
                  <StatusChip tone={cardPresentation.tone} size="sm" dot>
                    {cardPresentation.label}
                  </StatusChip>
                </span>
                <time dateTime={card.createdAt}>创建于 {createdAtLabel}</time>
              </div>
              <span className="card-detail-overview-kicker">
                <i aria-hidden="true" />
                个人理解工作台
              </span>
              <h1 id="card-detail-title">{cardTitle}</h1>
              <div className="card-detail-core-understanding">
                <span className="card-detail-core-icon" aria-hidden="true">
                  <Icon.Sparkle />
                </span>
                <div>
                  <span>核心理解</span>
                  <p>{cardSummary}</p>
                </div>
              </div>
            </div>

            {layoutMode !== "compact" && (
              <CardNextStep
                cardId={cardId}
                enabled={questionFirstEnabled}
                active={isCardActive}
                canValidate={canValidate}
                evidenceLoading={evidenceLoading}
                eligibleKeyPointCount={eligibleKeyPointCount}
                onOpenEvidence={revealEvidenceWorkspace}
              />
            )}
          </div>

          <UnderstandingFacts
            evidenceCount={alignedCount}
            validationCount={validationCount}
            latestFeedback={latestFeedback}
            nextReviewAt={nextReviewAt}
          />
        </section>

        <section
          className="card-detail-content-grid"
          aria-label="学习卡正文与学习依据"
        >
          <StudyPaper
            data={currentData}
            groups={evidenceGroups}
            latestFeedback={latestFeedback}
            onOpenEvidence={openEvidenceDetail}
          />

          {layoutMode !== "compact" && (
            <aside className="card-detail-side-rail" aria-label="证据与复习计划">
              <EvidenceRail
                groups={evidenceGroups}
                selectedKeyPointId={openKeyPointId}
                loading={evidenceLoading}
                error={evidenceError}
                onSelect={openEvidenceDetail}
                onRetry={() => void fetchEvidence()}
              />
              <ReviewPlanCard
                alignedCount={alignedCount}
                validationCount={validationCount}
                nextReviewAt={nextReviewAt}
              />
            </aside>
          )}
        </section>
      </div>

      {layoutMode === "compact" &&
        !evidencePanelOpen &&
        !openKeyPointId && (
          <nav
            className={`card-detail-action-dock ${canStartValidation ? "" : "is-single"}`}
            aria-label="学习卡详情操作"
          >
            <button
              type="button"
              onClick={() => setEvidencePanelOpen(true)}
            >
              <Icon.Link aria-hidden="true" />
              <span>{canStartValidation ? "证据线索" : "证据与复习"}</span>
              <b>{evidenceCount}</b>
            </button>
            {canStartValidation && (
              <button
                type="button"
                className="is-primary"
                onClick={() => router.push(`/cards/${cardId}/validate`)}
              >
                <Icon.Target aria-hidden="true" />
                <span>开始验证</span>
              </button>
            )}
          </nav>
        )}

      <Drawer
        open={evidencePanelOpen && layoutMode === "compact"}
        onClose={() => setEvidencePanelOpen(false)}
        title="证据与复习"
        side="right"
        width="440px"
      >
        <div className="card-detail-evidence-sheet">
          <EvidenceRail
            groups={evidenceGroups}
            selectedKeyPointId={openKeyPointId}
            loading={evidenceLoading}
            error={evidenceError}
            onSelect={openEvidenceDetail}
            onRetry={() => void fetchEvidence()}
          />
          <ReviewPlanCard
            alignedCount={alignedCount}
            validationCount={validationCount}
            nextReviewAt={nextReviewAt}
          />
        </div>
      </Drawer>

      {activeGroup && activeKeyPoint && (
        <EvidenceDialog
          open={!!openKeyPointId}
          onClose={() => setOpenKeyPointId(null)}
          claim={activeKeyPoint.claim}
          chips={activeGroup.evidences}
          onOverride={handleEvidenceOverride}
          error={evidenceActionError}
        />
      )}
    </div>
  );
}

function CardNextStep({
  cardId,
  enabled,
  active,
  canValidate,
  evidenceLoading,
  eligibleKeyPointCount,
  onOpenEvidence,
}: {
  cardId: string;
  enabled: boolean;
  active: boolean;
  canValidate: boolean;
  evidenceLoading: boolean;
  eligibleKeyPointCount: number;
  onOpenEvidence: () => void;
}) {
  const state = !active
    ? "readonly"
    : !enabled
      ? "paused"
      : evidenceLoading
        ? "checking"
        : canValidate
          ? "ready"
          : "needs-evidence";
  const title = !active
    ? "历史卡片仅供阅读"
    : !enabled
      ? "独立验证暂未开启"
      : evidenceLoading
        ? "正在检查验证条件"
        : canValidate
          ? "用一次独立回答检验理解"
          : "先补齐可验证的学习依据";
  const detail = !active
    ? "这张卡已有更新版本，仍可回看内容与证据记录。"
    : !enabled
      ? "你仍可阅读理解要点、核对证据并查看复习安排。"
      : evidenceLoading
        ? "证据载入完成后，会自动确认哪些要点可以进入独立验证。"
        : canValidate
          ? `${eligibleKeyPointCount} 个要点已具备验证依据。作答时不会提前展示结论或原文。`
          : "至少确认一条能够支持理解要点的硬证据，才能开始独立验证。";
  const statusLabel = !active
    ? "只读状态"
    : !enabled
      ? "功能已暂停"
      : evidenceLoading
        ? "检查中"
        : canValidate
          ? "可以开始"
          : "等待硬证据";

  return (
    <aside className="card-detail-next-step" data-state={state} aria-labelledby="card-next-step-title">
      <header className="card-detail-next-step-header">
        <span className="card-detail-next-step-icon" aria-hidden="true">
          <Icon.Target />
        </span>
        <div>
          <span>下一步</span>
          <h2 id="card-next-step-title">理解验证</h2>
        </div>
        <span className="card-detail-next-step-status">
          <i aria-hidden="true" />
          {statusLabel}
        </span>
      </header>

      <div className="card-detail-next-step-body">
        <h3>{title}</h3>
        <p>{detail}</p>

        {enabled && active && canValidate ? (
          <Link href={`/cards/${cardId}/validate`} className="card-detail-next-step-primary">
            开始验证
            <Icon.Arrow aria-hidden="true" />
          </Link>
        ) : active && !evidenceLoading ? (
          <button type="button" className="card-detail-next-step-secondary" onClick={onOpenEvidence}>
            <Icon.Link aria-hidden="true" />
            查看学习依据
          </button>
        ) : null}
      </div>

      <p className="card-detail-next-step-privacy">
        <Icon.Lock aria-hidden="true" />
        验证在独立页面进行，阅读内容不会被带入作答区。
      </p>
    </aside>
  );
}

function CardDetailSimpleHeader({
  backHref,
  backLabel,
  replace,
}: {
  backHref: string;
  backLabel: string;
  replace: boolean;
}) {
  return (
    <header className="card-detail-header card-detail-header--simple">
      <Link href={backHref} replace={replace} className="card-detail-back">
        <Icon.Chevron aria-hidden="true" />
        <span>{backLabel}</span>
      </Link>
      <ThemeToggle className="card-detail-theme-toggle" />
    </header>
  );
}

const REVIEW_RETURN_BASE = "https://review-return.local";
const REVIEW_RETURN_DESTINATION = /^\/cards\/[A-Za-z0-9_-]+$/;
const REVIEW_RETURN_ID = /^[A-Za-z0-9_-]{1,160}$/;

function sanitizeReviewReturnTarget(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 1024 || raw.includes("\\")) return null;

  try {
    const url = new URL(raw, REVIEW_RETURN_BASE);
    const reviewId = url.searchParams.get("review")?.trim() ?? "";
    if (
      url.origin !== REVIEW_RETURN_BASE ||
      url.pathname !== "/review" ||
      !REVIEW_RETURN_ID.test(reviewId)
    ) {
      return null;
    }

    const params = new URLSearchParams({ review: reviewId });
    return `/review?${params.toString()}`;
  } catch {
    return null;
  }
}

function withReviewReturnTarget(
  destination: string,
  returnTo: string,
): string | null {
  const safeReturnTarget = sanitizeReviewReturnTarget(returnTo);
  if (!safeReturnTarget || !destination || destination.includes("\\")) {
    return null;
  }

  try {
    const url = new URL(destination, REVIEW_RETURN_BASE);
    if (
      url.origin !== REVIEW_RETURN_BASE ||
      !REVIEW_RETURN_DESTINATION.test(url.pathname)
    ) {
      return null;
    }
    url.searchParams.set("returnTo", safeReturnTarget);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function appendUniqueCards(
  current: CardListItem[],
  incoming: CardListItem[],
): CardListItem[] {
  const known = new Set(current.map((item) => item.id));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (known.has(item.id)) return false;
      known.add(item.id);
      return true;
    }),
  ];
}

function formatCardDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
