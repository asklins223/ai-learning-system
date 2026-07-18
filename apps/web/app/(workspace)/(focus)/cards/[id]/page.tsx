"use client";

import "@/app/styles/card-detail.css";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  CardDetailResponse,
  CardListItem,
  CardEvidenceGroup,
  EvidenceOverride,
  effectiveAlignment,
  isHardEvidence,
  type ValidationFeedback,
  type ValidationEvent,
} from "@/lib/api";
import { EvidenceDrawer } from "@/components/EvidenceDrawer";
import { ValidationPanel, ValidationQuestion } from "@/components/ValidationPanel";
import { Drawer } from "@/components/ui/Drawer";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { StudyPaper } from "@/components/study/StudyPaper";
import { EvidenceRail } from "@/components/study/EvidenceRail";
import { UnderstandingFacts } from "@/components/study/UnderstandingFacts";
import { ReviewPlanCard } from "@/components/study/ReviewPlanCard";
import { AccountMenu } from "@/components/account/AccountMenu";
import { normalizeKeyPointClaim } from "@/lib/card-display";
import {
  sanitizeSearchReturnTarget,
  withSearchReturnTarget,
} from "@/lib/search-return";
import {
  sanitizeTodayReturnTarget,
  withTodayReturnTarget,
} from "@/lib/today-return";

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
  const validationSheetRef = useRef<HTMLDivElement>(null);
  const validationTriggerRef = useRef<HTMLButtonElement>(null);
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
  const [feedback, setFeedback] = useState<ValidationFeedback | null>(null);
  const [validating, setValidating] = useState(false);
  const [nextReviewAt, setNextReviewAt] = useState<string | null>(null);
  const [cardListItem, setCardListItem] = useState<CardListItem | null>(null);
  const [pager, setPager] = useState<PagerState>(EMPTY_PAGER);
  const [openKeyPointId, setOpenKeyPointId] = useState<string | null>(null);
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [layoutMode, setLayoutMode] =
    useState<DetailLayoutMode>("medium");
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
        width >= 1240 ? "wide" : width >= 960 ? "medium" : "compact",
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
    if (layoutMode === "wide") setEvidencePanelOpen(false);
    if (layoutMode !== "compact") setValidationPanelOpen(false);
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode !== "compact" || !validationPanelOpen) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const validationTrigger = validationTriggerRef.current;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableSelector =
      'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setValidationPanelOpen(false);
        return;
      }
      if (event.key !== "Tab" || !validationSheetRef.current) return;

      const focusable = Array.from(
        validationSheetRef.current.querySelectorAll<HTMLElement>(
          focusableSelector,
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => {
      validationSheetRef.current
        ?.querySelector<HTMLElement>(".validation-mobile-close")
        ?.focus();
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
      (validationTrigger ?? previousFocus)?.focus();
    };
  }, [layoutMode, validationPanelOpen]);

  useEffect(() => {
    if (!cardId) return;

    setData(null);
    setCardError(null);
    setEvidence(null);
    setEvidenceError(null);
    setEvidenceActionError(null);
    setValidationHistory([]);
    setValidationError(null);
    setFeedback(null);
    setValidating(false);
    setNextReviewAt(null);
    setCardListItem(null);
    setPager(EMPTY_PAGER);
    setOpenKeyPointId(null);
    setEvidencePanelOpen(false);
    setValidationPanelOpen(false);
    setLifecycleAction("idle");
    setLifecycleMessage(null);
  }, [cardId]);

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
    } catch (caught) {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setCardError(
        caught instanceof Error ? caught.message : "学习卡暂时无法读取。",
      );
    }
  }, [cardId]);

  const fetchEvidence = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    try {
      const result = await api.getCardEvidence(cardId);
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setEvidence(result);
      setEvidenceError(null);
    } catch (caught) {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setEvidenceError(
        caught instanceof Error ? caught.message : "证据暂时无法读取。",
      );
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
    } catch (caught) {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setValidationError(
        caught instanceof Error ? caught.message : "验证记录暂时无法读取。",
      );
    }
  }, [cardId]);

  const refreshReviewSchedule = useCallback(async () => {
    if (!cardId) return;
    const requestCardId = cardId;
    try {
      let items: CardListItem[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 10; page += 1) {
        const result = await api.listCards({ cursor, limit: 100 });
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        items = appendUniqueCards(items, result.items);
        const current = items.find((item) => item.id === cardId);
        if (current || !result.nextCursor) {
          setCardListItem(current ?? null);
          setNextReviewAt(current?.nextReviewAt ?? null);
          return;
        }
        cursor = result.nextCursor ?? undefined;
      }
    } catch {
      // 复习计划失败不阻断阅读或验证。
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
          setLifecycleMessage(
            `重新生成失败：${job.lastError ?? "未知错误"}`,
          );
          setLifecycleAction("idle");
          return;
        }
        delay = Math.min(3000, delay * 1.3);
      }

      setLifecycleMessage("等待超时，可稍后返回列表查看生成结果。");
      setLifecycleAction("idle");
    } catch (caught) {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        return;
      }
      setLifecycleMessage(
        `操作失败：${caught instanceof Error ? caught.message : "未知错误"}`,
      );
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
      } catch (caught) {
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        const message =
          caught instanceof Error ? caught.message : "证据状态更新失败。";
        setEvidenceActionError(message);
      }
    },
    [cardId, fetchEvidence],
  );

  const validationQuestions = useMemo<ValidationQuestion[]>(() => {
    if (!data || !evidence) return [];

    return data.keyPoints
      .filter((keyPoint) => {
        const group = evidence.find(
          (item) => item.keyPoint.id === keyPoint.id,
        );
        return group?.evidences.some((item) =>
          isHardEvidence(
            item.alignment,
            item.effectiveOverride ?? item.userOverride,
          ),
        );
      })
      .slice(0, 3)
      .map((keyPoint, index) => ({
        type: (["explain", "example", "apply"] as const)[index % 3],
        prompt: buildPrompt(keyPoint.claim, index),
        refClaim: buildKnowledgeLabel(keyPoint.claim),
        refQuote: keyPoint.quoteText,
        keyPointId: keyPoint.id,
      }));
  }, [data, evidence]);

  const handleValidation = useCallback(
    async (
      answer: string,
      question: ValidationQuestion,
    ): Promise<ValidationFeedback> => {
      if (!cardId || !question.keyPointId) {
        throw new Error("缺少学习卡或关键要点。");
      }

      const requestCardId = cardId;
      const isCurrentRequest = () =>
        mountedRef.current &&
        activeCardIdRef.current === requestCardId;
      setValidating(true);
      try {
        const { questionId } = await api.createValidationQuestion(cardId, {
          keyPointId: question.keyPointId,
          questionType: question.type,
          question: question.prompt,
        });
        if (!isCurrentRequest()) throw new Error("页面已切换");

        const { jobId } = await api.submitValidation(cardId, {
          questionId,
          userAnswer: answer,
        });
        if (!isCurrentRequest()) throw new Error("页面已切换");

        const deadline = Date.now() + 60_000;
        let delay = 1000;
        let completed = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          if (!isCurrentRequest()) throw new Error("页面已切换");
          const job = await api.getJob(jobId);
          if (job.status === "succeeded") {
            completed = true;
            break;
          }
          if (job.status === "failed" || job.status === "dead") {
            throw new Error(job.lastError || "验证任务执行失败");
          }
          delay = Math.min(3000, delay * 1.5);
        }

        if (!completed) throw new Error("验证判定超时，请稍后重试");

        const result = await api.getValidationByJobId(jobId);
        if (!isCurrentRequest()) throw new Error("页面已切换");
        if (!result?.feedback) throw new Error("验证结果尚未准备完成");

        setValidationHistory((current) => [
          result,
          ...current.filter((item) => item.id !== result.id),
        ]);
        setFeedback(result.feedback);
        void refreshReviewSchedule();

        try {
          const fresh = await api.listValidations(cardId);
          if (isCurrentRequest()) {
            setValidationHistory([
              result,
              ...fresh.items.filter((item) => item.id !== result.id),
            ]);
          }
        } catch {
          // 新结果已写入界面，历史刷新失败不回滚成功状态。
        }

        return result.feedback;
      } finally {
        if (isCurrentRequest()) setValidating(false);
      }
    },
    [cardId, refreshReviewSchedule],
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
        <section className="card-detail-state" aria-labelledby="card-error-title">
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
  const latestFeedback = feedback ?? validationHistory[0]?.feedback ?? null;
  const isCardActive = card.status === "active";
  const evidenceLoading = evidence === null && !evidenceError;
  const canValidate =
    isCardActive && !evidenceLoading && validationQuestions.length > 0;
  const activeGroup = openKeyPointId
    ? evidenceGroups.find(
        (group) => group.keyPoint.id === openKeyPointId,
      )
    : null;
  const activeKeyPoint = keyPoints.find(
    (keyPoint) => keyPoint.id === openKeyPointId,
  );
  const initialValidation = validationHistory[0];

  const openEvidenceDetail = (keyPointId: string) => {
    setEvidencePanelOpen(false);
    setValidationPanelOpen(false);
    setOpenKeyPointId(keyPointId);
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
          <span
            className={`card-detail-status card-detail-status--${card.status}`}
          >
            {card.status === "active"
              ? "使用中"
              : card.status === "superseded"
                ? "历史版本"
                : "已归档"}
          </span>
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
          {layoutMode !== "wide" && (
            <button
              type="button"
              className="card-detail-header-action card-detail-evidence-trigger"
              onClick={() => setEvidencePanelOpen(true)}
            >
              <Icon.Link aria-hidden="true" />
              <span>证据</span>
              <b>{evidenceCount}</b>
            </button>
          )}
          {isCardActive && (
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
          <ThemeToggle className="card-detail-theme-toggle" />
          <AccountMenu
            className="card-detail-account-menu"
            triggerClassName="card-detail-avatar"
          />
        </div>
      </header>

      <div className="card-detail-alerts" aria-live="polite">
        {evidenceError && layoutMode !== "wide" && (
          <div className="card-detail-alert is-danger">
            <Icon.Warn aria-hidden="true" />
            <span>证据加载失败，学习卡正文仍可阅读。</span>
            <button type="button" onClick={() => void fetchEvidence()}>
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
        className="study-desk-grid"
        aria-label="学习卡阅读与验证工作台"
      >
        {layoutMode === "wide" && (
          <aside className="study-left-column" aria-label="证据与复习计划">
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

        <StudyPaper
          data={currentData}
          groups={evidenceGroups}
          latestFeedback={latestFeedback}
          onOpenEvidence={openEvidenceDetail}
        />

        <aside
          className={`validation-side ${
            validationPanelOpen ? "is-mobile-open" : ""
          }`}
          role={layoutMode === "compact" ? "dialog" : undefined}
          aria-modal={layoutMode === "compact" ? true : undefined}
          aria-label={
            layoutMode === "compact" ? "验证理解" : undefined
          }
          aria-hidden={
            layoutMode === "compact" && !validationPanelOpen
              ? true
              : undefined
          }
        >
          {layoutMode === "compact" && (
            <button
              type="button"
              className="validation-sheet-backdrop"
              onClick={() => setValidationPanelOpen(false)}
              aria-label="关闭验证面板"
              tabIndex={-1}
            />
          )}
          <div ref={validationSheetRef} className="validation-side-shell">
            <button
              type="button"
              className="validation-mobile-close"
              onClick={() => setValidationPanelOpen(false)}
              aria-label="关闭验证面板"
            >
              <Icon.Close aria-hidden="true" />
            </button>

            {validationError && validationHistory.length === 0 && (
              <div className="validation-history-error" role="status">
                <span>验证记录暂时无法读取，但仍可以提交新的回答。</span>
                <button type="button" onClick={() => void fetchValidations()}>
                  重试
                </button>
              </div>
            )}

            {canValidate ? (
              <ValidationPanel
                questions={validationQuestions}
                evidenceQuote={validationQuestions[0]?.refQuote ?? ""}
                onSubmit={handleValidation}
                busy={validating}
                feedback={latestFeedback}
                initialAnswer={initialValidation?.userAnswer ?? ""}
                initialKeyPointId={initialValidation?.keyPointId ?? null}
                nextReviewAt={nextReviewAt}
                onOpenEvidence={openEvidenceDetail}
              />
            ) : (
              <section className="ref-validation-panel ref-validation-empty">
                <header className="ref-validation-header">
                  <div className="ref-validation-heading">
                    <span className="ref-validation-bulb" aria-hidden="true">
                      ✦
                    </span>
                    <h2 className="ref-validation-title">验证理解</h2>
                  </div>
                </header>
                <div className="ref-validation-empty-body">
                  <span className="ref-validation-empty-icon">
                    {evidenceLoading ? (
                      <Icon.Refresh aria-hidden="true" />
                    ) : (
                      <Icon.Warn aria-hidden="true" />
                    )}
                  </span>
                  <h3>
                    {!isCardActive
                      ? "历史卡片仅供阅读"
                      : evidenceLoading
                        ? "正在检查证据"
                        : "需要硬证据才能验证"}
                  </h3>
                  <p>
                    {!isCardActive
                      ? "此学习卡不是当前版本，因此不再接受新的理解验证。"
                      : evidenceLoading
                        ? "证据加载完成后，符合条件的关键要点会自动生成验证题。"
                        : "先打开证据线索，确认至少一条引用能够支持当前关键要点。"}
                  </p>
                  {layoutMode !== "wide" && (
                    <button
                      type="button"
                      onClick={() => setEvidencePanelOpen(true)}
                    >
                      查看证据线索
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
        </aside>
      </section>

      <UnderstandingFacts
        evidenceCount={alignedCount}
        validationCount={validationCount}
        latestFeedback={latestFeedback}
        nextReviewAt={nextReviewAt}
      />

      {layoutMode === "compact" &&
        !validationPanelOpen &&
        !evidencePanelOpen &&
        !openKeyPointId && (
        <nav
          className="card-detail-action-dock"
          aria-label="学习卡详情操作"
        >
          <button
            type="button"
            onClick={() => setEvidencePanelOpen(true)}
          >
            <Icon.Link aria-hidden="true" />
            <span>证据线索</span>
            <b>{evidenceCount}</b>
          </button>
          <button
            ref={validationTriggerRef}
            type="button"
            className="is-primary"
            onClick={() => setValidationPanelOpen(true)}
          >
            <Icon.Check aria-hidden="true" />
            <span>{canValidate ? "验证理解" : "查看验证状态"}</span>
          </button>
        </nav>
        )}

      <Drawer
        open={evidencePanelOpen && layoutMode !== "wide"}
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
        <EvidenceDrawer
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

function buildPrompt(claim: string, index: number): string {
  const normalizedClaim = normalizeKeyPointClaim(claim);
  if (/[？?]\s*$/.test(normalizedClaim)) return normalizedClaim;
  const head = compactText(normalizedClaim, 64);
  const shortHead = compactText(normalizedClaim, 34);
  if (index === 0) return `请用自己的话解释：${head}`;
  if (index === 1) return `给出一个能体现「${shortHead}」的实例。`;
  return `「${shortHead}」具体解决了什么问题？如果没有它会怎样？`;
}

function buildKnowledgeLabel(claim: string): string {
  return compactText(
    normalizeKeyPointClaim(claim).replace(/[。？?！!]$/, ""),
    18,
  );
}

function compactText(text: string | null | undefined, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}
