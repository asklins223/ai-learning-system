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
  type ValidationEvent,
} from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
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
import { LearningCardActions } from "@/components/learning-companion/LearningCardActions";
import {
  sanitizeSearchReturnTarget,
  withSearchReturnTarget,
} from "@/lib/search-return";
import {
  sanitizeTodayReturnTarget,
  withTodayReturnTarget,
} from "@/lib/today-return";
import { isLearningRunV1Enabled } from "@/lib/feature-flags";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
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

// 2026-08-12（数据面审计 P1-2）：分页定位缓存——此前每次打开详情页都从
// 第一页串行翻页直到定位当前卡（最多 50 页 ≈ 5000 张，网络风暴 + 冗余传输）。
// 定位结果（index/total/prev/next）60s 内复用；翻页只查一次。
interface PagerLocateResult {
  pager: PagerState;
  item: CardListItem;
  nextReviewAt: string | null;
}
type PagerLocateOutcome =
  | { kind: "located"; result: PagerLocateResult }
  | { kind: "not-found"; total: number };

const PAGER_LOCATE_TTL_MS = 60_000;
const PAGER_LOCATE_MAX_ENTRIES = 100;
const pagerLocateCache = new Map<string, { at: number; outcome: PagerLocateOutcome }>();

async function locateCardInList(
  cardId: string,
): Promise<PagerLocateOutcome> {
  // 2026-08-12 review nit：缓存键加 workspace 维度——切工作区后同 id 卡
  // 的 index/prev/next 可能不同（getMeCached 已缓存，成本可忽略）。
  let workspaceKey = "";
  try {
    const me = await api.getMe();
    workspaceKey = `${me.workspaceId}:`;
  } catch {
    // getMe 失败时退回无前缀键（TTL 60s 内自愈）
  }
  const cacheKey = `${workspaceKey}${cardId}`;
  const cached = pagerLocateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PAGER_LOCATE_TTL_MS) return cached.outcome;

  let items: CardListItem[] = [];
  let cursor: string | undefined;
  let total = 0;
  let pages = 0;
  let outcome: PagerLocateOutcome;
  while (true) {
    const result = await api.listCards({ cursor, limit: 100 });
    items = appendUniqueCards(items, result.items);
    total = result.total;
    const currentIndex = items.findIndex((item) => item.id === cardId);
    const hasNextItem = currentIndex >= 0 && !!items[currentIndex + 1];

    if (currentIndex >= 0 && (hasNextItem || !result.nextCursor)) {
      outcome = {
        kind: "located",
        result: {
          pager: {
            index: currentIndex + 1,
            total: Math.max(total, items.length, 1),
            previousId: items[currentIndex - 1]?.id ?? null,
            nextId: items[currentIndex + 1]?.id ?? null,
          },
          item: items[currentIndex],
          nextReviewAt: items[currentIndex].nextReviewAt ?? null,
        },
      };
      break;
    }

    if (!result.nextCursor) {
      outcome = { kind: "not-found", total: Math.max(total, items.length, 1) };
      break;
    }

    cursor = result.nextCursor;
    pages += 1;
    // 用最新 total 动态算页数上限（F#3 round3：降到 20 页 ≈ 2000 张即可覆盖
    // 绝大多数用户库，超出即放弃定位——冷路径最多 20 次往返，避免 50 页瀑布）
    const maxPages = Math.min(Math.max(Math.ceil(total / 100), 1), 20);
    if (pages >= maxPages) {
      outcome = { kind: "not-found", total: Math.max(total, items.length, 1) };
      break;
    }
  }

  if (outcome.kind === "located") {
    pagerLocateCache.set(cacheKey, { at: Date.now(), outcome });
    while (pagerLocateCache.size > PAGER_LOCATE_MAX_ENTRIES) {
      const oldest = pagerLocateCache.keys().next().value;
      if (oldest === undefined) break;
      pagerLocateCache.delete(oldest);
    }
  }
  return outcome;
}

export default function CardPage() {
  const { isOwner, loading: ownerLoading } = useIsOwner();
  const params = useParams<{ id: string }>();
  const cardId = params?.id;
  // P5（文档 16 §14.2）：Card 详情页发布 bounded context（Key Point 由
  // 选中目标补充；无选中时仅 card 实体）。
  // F#7（第六轮 🟡8）：useMemo 稳定对象，避免 hook 内 JSON.stringify 每渲重跑。
  useMainPageContext(useMemo(
    () => cardId ? {
      routeRef: { kind: "card", cardId },
      pageKind: "card",
      entityRefs: [{ kind: "card", cardId }],
      interactionState: "idle",
      capabilityHints: ["focus_ui_target"],
      sensitivity: "normal",
    } : null,
    [cardId],
  ));
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
  // regenerate 轮询句柄：新请求取消旧请求；卸载时 abort 飞行请求 + 清定时器
  const regenerateAbortRef = useRef<AbortController | null>(null);
  const regenerateTimersRef = useRef<number[]>([]);
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
  const [pager, setPager] = useState<PagerState>(EMPTY_PAGER);
  const [openKeyPointId, setOpenKeyPointId] = useState<string | null>(null);
  const [evidencePanelOpen, setEvidencePanelOpen] = useState(false);
  const [layoutMode, setLayoutMode] =
    useState<DetailLayoutMode>("compact");
  const [lifecycleAction, setLifecycleAction] = useState<
    "idle" | "regenerating"
  >("idle");
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
  const [lifecycleConsentRequired, setLifecycleConsentRequired] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 取消未完成的 regenerate 轮询（abort 飞行请求 + 清定时器）
      regenerateAbortRef.current?.abort();
      regenerateAbortRef.current = null;
      for (const timer of regenerateTimersRef.current) window.clearTimeout(timer);
      regenerateTimersRef.current = [];
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
    setPager(EMPTY_PAGER);
    setOpenKeyPointId(null);
    setEvidencePanelOpen(false);
    setLifecycleAction("idle");
    setLifecycleMessage(null);
    setLifecycleConsentRequired(false);
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
        // 2026-08-12（数据面审计 P1-2）：定位逻辑抽到模块级 locateCardInList
        // + 60s 缓存（此前每次打开详情页都从第一页串行翻页，最多 50 页）。
        const outcome = await locateCardInList(cardId);
        if (cancelled) return;
        if (outcome.kind === "located") {
          setPager(outcome.result.pager);
          setCardListItem(outcome.result.item);
          setNextReviewAt(outcome.result.nextReviewAt);
        } else {
          // 未定位到当前卡：至少落一次分页状态（真实总数），不静默保持 EMPTY。
          setPager({ ...EMPTY_PAGER, total: outcome.total });
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
    // 2026-08-11 修复：轮询可取消——新 regenerate 取消旧轮询；卸载时
    // cleanup 会 abort 飞行请求并清定时器（此前 setTimeout 无法取消、
    // getJob 无法中止，仅靠 mountedRef 兜底）。
    regenerateAbortRef.current?.abort();
    const controller = new AbortController();
    regenerateAbortRef.current = controller;
    setLifecycleAction("regenerating");
    setLifecycleMessage(null);
    setLifecycleConsentRequired(false);

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
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, delay);
          regenerateTimersRef.current.push(timer);
        });
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }
        const job = await api.getJob(jobId, controller.signal);
        if (
          !mountedRef.current ||
          activeCardIdRef.current !== requestCardId
        ) {
          return;
        }

        if (job.status === "succeeded") {
          setLifecycleMessage(`学习卡已重新生成，正在返回${backLabel}…`);
          const navTimer = window.setTimeout(
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
          regenerateTimersRef.current.push(navTimer);
          return;
        }
        if (job.status === "failed" || job.status === "dead") {
          if (job.failureReason === "ai_consent_required") {
            setLifecycleMessage("重新生成需要先签署工作区 AI 使用协议。");
            setLifecycleConsentRequired(true);
          } else {
            setLifecycleMessage("学习卡暂时没有重新生成成功，请稍后重试。");
          }
          setLifecycleAction("idle");
          return;
        }
        delay = Math.min(3000, delay * 1.3);
      }

      setLifecycleMessage("等待超时，可稍后返回列表查看生成结果。");
      setLifecycleAction("idle");
    } catch (err) {
      if (
        !mountedRef.current ||
        activeCardIdRef.current !== requestCardId
      ) {
        // 卸载/切换卡后丢弃（abort 触发的 AbortError 也落这里）
        return;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
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
  const validationCount = Math.max(
    cardListItem?.validationCount ?? 0,
    validationHistory.length,
  );
  const latestFeedback = validationHistory[0]?.feedback ?? null;
  const isCardActive = card.status === "active";
  const evidenceLoading = evidence === null && !evidenceError;
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
              {lifecycleConsentRequired && (
                <button type="button" onClick={() => router.push("/settings#model")}>
                  签署 AI 使用协议
                </button>
              )}
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
                单张学习卡
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

            {keyPoints[0] && (
              <LearningCardActions
                compact={layoutMode === "compact"}
                live={isLearningRunV1Enabled()}
                onStartJourney={() => {
                  // Legacy cards can still contain several key points. Keep the
                  // formal target stable instead of letting an evidence click
                  // silently change which objective the Run will assess.
                  const target = keyPoints[0];
                  try {
                    sessionStorage.setItem(
                      `companion-origin:${cardId}`,
                      JSON.stringify({ href: window.location.href, scrollY: window.scrollY }),
                    );
                  } catch {
                    // Origin restore is best effort; the Session remains authoritative.
                  }
                  // 方案 16：统一 LearningRun 是唯一入口（旧 companion/validate
                  // 分支已于 P9 删除）。fail closed：flag 关闭时不发起。
                  const route = isLearningRunV1Enabled()
                    ? `/learning-runs/new?origin=card&cardId=${encodeURIComponent(cardId)}&keyPointId=${encodeURIComponent(target.id)}&returnTo=${encodeURIComponent(`/cards/${cardId}`)}`
                    : null;
                  if (route) router.push(route);
                }}
                onViewEvidence={revealEvidenceWorkspace}
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

// F#7（第六轮 🟠3 扩展 + 🟡8）：Intl 构造器提升为模块级单例。
const cardDateFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function formatCardDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return cardDateFmt.format(date);
}
