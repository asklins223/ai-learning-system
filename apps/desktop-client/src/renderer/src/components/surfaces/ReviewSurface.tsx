import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarCheck2, Check, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { ReviewQueueV2 } from "@ailearn/shared/review-queue-v2-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { SceneReferenceFrame } from "../../scene/SceneReferenceFrame";
import { SurfaceCalibrator } from "../../scene/SurfaceCalibrator";
import {
  REVIEW_NOTEBOOK_STYLE,
  REVIEW_SURFACE_REGISTRY,
  REVIEW_SURFACE_STYLES,
  REVIEW_TAPE_STYLE,
} from "../../scene/scene-surfaces";
import {
  useSceneSurfaceProjections,
  type SceneSurfaceQuadOverrides,
  type SceneSurfaceProjectionTarget,
} from "../../scene/useSceneSurfaceProjection";
import {
  useSceneSurfaceInputRuntime,
  writeSceneInputDiagnostics,
  type SceneSurfacePointerResolution,
} from "../../scene/scene-input-runtime";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { matchesReviewTarget } from "../review-focus";
import { SurfaceReturnControl } from "./SurfaceReturnControl";

gsap.registerPlugin(useGSAP);

type ReviewItem = ReviewQueueV2["items"][number];
type LoadedReviewQueue = {
  readonly version: 2;
  readonly items: ReviewItem[];
  readonly nextCursor: string | null;
};
type ReviewBoundaryTone = "loading" | "empty" | "error";
type ReviewFailure = {
  readonly message: string;
  readonly source: "queue" | "pagination" | "start";
};

const REVIEW_WINDOW_SIZE = 6;
const REVIEW_CALIBRATION_SURFACES = Object.freeze(Object.values(REVIEW_SURFACE_REGISTRY.surfaces));

const reviewTapeDueFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const reviewDueDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
});

const reviewDueTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const reviewCalendarFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "short",
});

function reviewBlockedReason(reason: Exclude<ReviewItem["startability"], { kind: "ready" }>["reason"]) {
  const labels = {
    not_due: "尚未到期",
    cooldown: "仍在冷却期",
    stale_generation: "复习版本已变化",
    invalid_identity: "目标身份无法确认",
    feature_unavailable: "当前环境未启用",
  } as const;
  return labels[reason];
}

function reviewTapeStatus(item: ReviewItem) {
  if (item.startability.kind === "ready") return "可开始";
  const labels = {
    not_due: "未到期",
    cooldown: "冷却中",
    stale_generation: "版本已变",
    invalid_identity: "暂不可用",
    feature_unavailable: "未启用",
  } as const;
  return labels[item.startability.reason];
}

function uniqueReviewItems(items: readonly ReviewItem[]): ReviewItem[] {
  return [...new Map(items.map((item) => [item.reviewId, item])).values()];
}

export function reviewWindowStart(selectedIndex: number, itemCount: number): number {
  if (selectedIndex < 0 || itemCount <= REVIEW_WINDOW_SIZE) return 0;
  const groupStart = Math.floor(selectedIndex / REVIEW_WINDOW_SIZE) * REVIEW_WINDOW_SIZE;
  return Math.min(groupStart, Math.max(0, itemCount - 1));
}

function ReviewBoundary({
  heading,
  message,
  tone,
  onRetry,
}: {
  readonly heading: string;
  readonly message: string;
  readonly tone: ReviewBoundaryTone;
  readonly onRetry?: () => void;
}) {
  const Icon = tone === "empty" ? Check : CalendarCheck2;
  return (
    <div className={`review-scene-state review-scene-state--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={24} aria-hidden="true" />
      <div>
        <h3>{heading}</h3>
        <p>{message}</p>
      </div>
      {tone === "error" ? (
        <button type="button" className="surface-primary" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />重新读取队列
        </button>
      ) : null}
      {tone === "loading" ? (
        <div className="review-scene-state__lines" aria-hidden="true"><span /><span /><span /></div>
      ) : null}
    </div>
  );
}

export function ReviewSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const theme = useRoomStore((state) => state.theme);
  const setTheme = useRoomStore((state) => state.setTheme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const activeReviewTarget = useRoomStore((state) => state.activeReviewTarget);
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const [queue, setQueue] = useState<LoadedReviewQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<ReviewFailure | null>(null);
  const [startingReviewId, setStartingReviewId] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [surfaceQuadOverrides, setSurfaceQuadOverrides] = useState<SceneSurfaceQuadOverrides | undefined>();
  const rootRef = useRef<HTMLElement>(null);
  const reviewReferenceFrameRef = useRef<HTMLDivElement>(null);
  const tapeWindowRef = useRef<HTMLDivElement>(null);
  const notebookRef = useRef<HTMLElement>(null);
  const tapeHeaderSurfaceRef = useRef<HTMLDivElement>(null);
  const tapeBodySurfaceRef = useRef<HTMLDivElement>(null);
  const tapeFooterSurfaceRef = useRef<HTMLDivElement>(null);
  const leftNotebookSurfaceRef = useRef<HTMLDivElement>(null);
  const rightNotebookSurfaceRef = useRef<HTMLDivElement>(null);
  const reviewProjectionTargets = useMemo<readonly SceneSurfaceProjectionTarget[]>(() => [
    { ref: tapeHeaderSurfaceRef, surface: REVIEW_SURFACE_REGISTRY.surfaces.tapeHeader },
    { ref: tapeBodySurfaceRef, surface: REVIEW_SURFACE_REGISTRY.surfaces.tapeBody },
    { ref: tapeFooterSurfaceRef, surface: REVIEW_SURFACE_REGISTRY.surfaces.tapeFooter },
    { ref: leftNotebookSurfaceRef, surface: REVIEW_SURFACE_REGISTRY.surfaces.notebookLeft },
    { ref: rightNotebookSurfaceRef, surface: REVIEW_SURFACE_REGISTRY.surfaces.notebookRight },
  ], []);
  const observeReviewSurfaceInput = useCallback((input: SceneSurfacePointerResolution) => {
    const frame = reviewReferenceFrameRef.current;
    if (frame) writeSceneInputDiagnostics(frame, input);
  }, []);
  const previousWindowStartRef = useRef<number | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const reviewItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const startCommandIdsRef = useRef(new Map<string, string>());
  const focusedReturnTargetRef = useRef<string | null>(null);
  const returnLookupRef = useRef<{ targetKey: string; attemptedCursors: Set<string> } | null>(null);

  const loadQueue = useCallback(async (cursor?: string, append = false) => {
    if (!window.ailearn) throw new Error("desktop API is unavailable");
    const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
    const session = unwrapGatewayResult(sessionResponse);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    const response = await window.ailearn.review.getQueue({
      meta: createRequestMeta(epochRef.current),
      ...(cursor ? { cursor } : {}),
      limit: 20,
    });
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const nextPage = unwrapGatewayResult(response);
    setQueue((current) => {
      if (!append || !current) {
        return { version: 2, items: uniqueReviewItems(nextPage.items), nextCursor: nextPage.nextCursor };
      }
      return {
        version: 2,
        items: uniqueReviewItems([...current.items, ...nextPage.items]),
        nextCursor: nextPage.nextCursor,
      };
    });
    setFailure(null);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadQueue()
      .catch((error) => active && setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadQueue]);

  const reload = useCallback(() => {
    setLoading(true);
    setFailure(null);
    void loadQueue()
      .catch((error) => setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => setLoading(false));
  }, [loadQueue]);

  const loadMore = useCallback(async () => {
    if (!queue?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setFailure(null);
    try {
      await loadQueue(queue.nextCursor, true);
    } catch (error) {
      setFailure({ message: gatewayErrorMessage(error), source: "pagination" });
    } finally {
      setLoadingMore(false);
    }
  }, [loadQueue, loadingMore, queue]);

  useEffect(() => {
    if (!queue?.items.length) {
      setSelectedReviewId(null);
      return;
    }
    setSelectedReviewId((current) => {
      if (current && queue.items.some((item) => item.reviewId === current)) return current;
      return queue.items.slice(0, REVIEW_WINDOW_SIZE).find((item) => item.startability.kind === "ready")?.reviewId
        ?? queue.items[0].reviewId;
    });
  }, [queue]);

  const selectedIndex = queue?.items.findIndex((item) => item.reviewId === selectedReviewId) ?? -1;
  const selectedItem = selectedIndex >= 0 ? queue?.items[selectedIndex] ?? null : null;
  useSceneSurfaceProjections(reviewProjectionTargets, {
    active: Boolean(selectedItem),
    compactMediaQuery: REVIEW_SURFACE_REGISTRY.compactMediaQuery,
    quadOverrides: surfaceQuadOverrides,
  });
  useSceneSurfaceInputRuntime({
    active: import.meta.env.DEV && Boolean(selectedItem),
    compactMediaQuery: REVIEW_SURFACE_REGISTRY.compactMediaQuery,
    referenceFrameRef: reviewReferenceFrameRef,
    targets: reviewProjectionTargets,
    quadOverrides: surfaceQuadOverrides,
    onInput: observeReviewSurfaceInput,
  });
  const windowStart = reviewWindowStart(selectedIndex, queue?.items.length ?? 0);
  const windowEnd = Math.min(windowStart + REVIEW_WINDOW_SIZE, queue?.items.length ?? 0);
  const visibleItems = useMemo(
    () => queue?.items.slice(windowStart, windowEnd) ?? [],
    [queue, windowEnd, windowStart],
  );

  useEffect(() => {
    if (!activeReviewTarget) {
      focusedReturnTargetRef.current = null;
      returnLookupRef.current = null;
      return;
    }
    if (!queue) return;
    const targetKey = `${activeReviewTarget.scheduleId}:${activeReviewTarget.objectiveId}`;
    if (returnLookupRef.current?.targetKey !== targetKey) {
      returnLookupRef.current = { targetKey, attemptedCursors: new Set() };
    }
    if (focusedReturnTargetRef.current === targetKey) return;
    const item = queue.items.find((candidate) => matchesReviewTarget(candidate, activeReviewTarget));
    if (!item) {
      if (!queue.nextCursor) {
        setActiveReviewTarget(null);
        return;
      }
      const lookup = returnLookupRef.current;
      if (
        lookup
        && !loadingMore
        && failure?.source !== "pagination"
        && !lookup.attemptedCursors.has(queue.nextCursor)
      ) {
        lookup.attemptedCursors.add(queue.nextCursor);
        void loadMore();
      }
      return;
    }
    if (selectedReviewId !== item.reviewId) {
      setSelectedReviewId(item.reviewId);
      return;
    }
    const node = reviewItemRefs.current.get(item.reviewId);
    if (!node) return;
    focusedReturnTargetRef.current = targetKey;
    const frame = window.requestAnimationFrame(() => {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeReviewTarget, failure?.source, loadMore, loadingMore, queue, selectedReviewId, setActiveReviewTarget, windowStart]);

  useGSAP(() => {
    const tapeWindow = tapeWindowRef.current;
    const notebook = notebookRef.current;
    if (!tapeWindow || !notebook) return;
    const previousStart = previousWindowStartRef.current;
    const windowChanged = previousStart !== null && previousStart !== windowStart;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = motionMode === "full" && !reduceMotion ? 0.32 : motionMode === "lite" && !reduceMotion ? 0.18 : 0;
    if (!duration) {
      gsap.set([tapeWindow, notebook], { clearProps: "transform,opacity,visibility" });
      previousWindowStartRef.current = windowStart;
      return;
    }
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    if (windowChanged) {
      const direction = windowStart > (previousStart ?? 0) ? 1 : -1;
      timeline.fromTo(tapeWindow, { autoAlpha: 0.72, y: direction * 9 }, { autoAlpha: 1, y: 0, duration });
    }
    timeline.fromTo(notebook, { autoAlpha: 0.78, y: 5 }, { autoAlpha: 1, y: 0, duration: duration * 0.82 }, windowChanged ? "-=0.18" : 0);
    previousWindowStartRef.current = windowStart;
  }, { scope: rootRef, dependencies: [motionMode, selectedReviewId, windowStart], revertOnUpdate: true });

  const startReview = async (item: ReviewItem) => {
    if (item.startability.kind !== "ready" || startingReviewId || !window.ailearn) return;
    const commandId = startCommandIdsRef.current.get(item.reviewId) ?? createCommandId("start-review");
    startCommandIdsRef.current.set(item.reviewId, commandId);
    setStartingReviewId(item.reviewId);
    setActiveReviewTarget(null);
    focusedReturnTargetRef.current = null;
    setFailure(null);
    try {
      const response = await window.ailearn.learningRun.start({
        meta: createRequestMeta(epochRef.current),
        commandId,
        request: {
          version: 2,
          originV2: {
            kind: "review",
            scheduleId: item.scheduleId,
            objectiveId: item.objectiveId,
            scheduleGeneration: item.scheduleGeneration,
          },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 180,
          responsePreference: "adaptive",
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const snapshot = unwrapGatewayResult(response);
      startCommandIdsRef.current.delete(item.reviewId);
      setActiveRunId(snapshot.runId);
      invoke("validate");
    } catch (error) {
      const refreshRequired = error instanceof RendererGatewayError
        && ["conflict", "not_found", "feature_disabled", "validation"].includes(error.code);
      if (refreshRequired) {
        startCommandIdsRef.current.delete(item.reviewId);
        setFailure({ message: gatewayErrorMessage(error), source: "start" });
        void loadQueue().catch((refreshError) => {
          setFailure({ message: gatewayErrorMessage(refreshError), source: "queue" });
        });
      } else {
        setFailure({ message: gatewayErrorMessage(error), source: "start" });
      }
    } finally {
      setStartingReviewId(null);
    }
  };

  const selectAdjacentWindow = (direction: -1 | 1) => {
    if (!queue?.items.length) return;
    const nextIndex = direction < 0
      ? Math.max(0, windowStart - REVIEW_WINDOW_SIZE)
      : Math.min(queue.items.length - 1, windowStart + REVIEW_WINDOW_SIZE);
    setSelectedReviewId(queue.items[nextIndex]?.reviewId ?? selectedReviewId);
  };

  const readyCount = queue?.items.filter((item) => item.startability.kind === "ready").length ?? 0;
  const calendarNow = new Date();
  const calendarDate = reviewCalendarFormatter.format(calendarNow);
  const hasPreviousWindow = windowStart > 0;
  const hasNextWindow = Boolean(queue && windowEnd < queue.items.length);
  const returnTargetMissing = Boolean(
    activeReviewTarget
      && queue
      && !queue.items.some((item) => matchesReviewTarget(item, activeReviewTarget)),
  );
  const boundary = loading
    ? { heading: "正在读取复习队列…", message: "正在确认真实到期项与开始条件。", tone: "loading" as const }
    : failure?.source === "queue" && !queue?.items.length
      ? { heading: "无法读取真实复习队列", message: failure.message, tone: "error" as const }
      : queue?.items.length === 0
        ? { heading: "今天没有到期项", message: "服务端没有返回可开始或待确认的到期复习。", tone: "empty" as const }
        : null;

  const queueSummary = loading
    ? "正在确认队列"
    : queue?.nextCursor
      ? `已载入 ${queue.items.length} 项 · ${readyCount} 项可开始`
      : `${queue?.items.length ?? 0} 项待复习 · ${readyCount} 项可开始`;

  return (
    <section
      ref={rootRef}
      className={`review-object-surface review-workbench task-artifact${boundary ? ` review-workbench--${boundary.tone}` : " review-workbench--ready"}`}
      aria-labelledby="review-surface-title"
    >
      <SceneReferenceFrame
        ref={reviewReferenceFrameRef}
        className="review-reference-frame"
        data-scene-input-runtime={import.meta.env.DEV ? "observer" : "disabled"}
      >
        <SurfaceReturnControl className="review-scene__return" />

        <header className="review-scene__heading">
          <time dateTime={calendarNow.toISOString()}>{calendarDate}</time>
          <h2 id="review-surface-title">今日复习</h2>
          <p>{queueSummary}</p>
          {queue?.nextCursor ? <small>当前队列还有更多到期项</small> : null}
          {failure && queue?.items.length ? (
            <div className="review-scene__partial-error" role="alert">
              <span>
                {failure.source === "pagination"
                  ? "继续读取失败，已载入项目仍然保留。"
                  : failure.source === "start"
                    ? "开始结果未确认；再次开始会复用同一请求。"
                    : "队列刷新失败，当前项目仍然保留。"}
              </span>
              {failure.source === "pagination" ? (
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>重试读取</button>
              ) : failure.source === "queue" ? (
                <button type="button" onClick={reload}>重新读取</button>
              ) : null}
            </div>
          ) : null}
        </header>

        {boundary ? (
          <div className="review-scene__boundary">
            <ReviewBoundary {...boundary} onRetry={boundary.tone === "error" ? reload : undefined} />
          </div>
        ) : null}

        {!boundary && queue?.items.length ? (
          <section className="review-tape" style={REVIEW_TAPE_STYLE} aria-label="复习队列纸带">
            <div
              ref={tapeHeaderSurfaceRef}
              className="review-tape__surface review-tape__surface--header"
              style={REVIEW_SURFACE_STYLES.tapeHeader}
              data-scene-surface={REVIEW_SURFACE_REGISTRY.surfaces.tapeHeader.id}
            >
              <div className="review-tape__plane">
                <header className="review-tape__header review-tape__ink" data-scene-surface-layer="ink">
                  <span>{windowStart + 1}—{windowEnd} / 已载入 {queue.items.length} 项</span>
                  <nav className="review-tape__navigation" aria-label="浏览复习队列">
                    <button
                      type="button"
                      aria-label="查看上一组复习项目"
                      disabled={!hasPreviousWindow}
                      onClick={() => selectAdjacentWindow(-1)}
                    >
                      <ChevronLeft size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="查看下一组复习项目"
                      disabled={!hasNextWindow}
                      onClick={() => selectAdjacentWindow(1)}
                    >
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </nav>
                </header>
                <span className="review-tape__material review-tape__material--header" data-scene-surface-layer="material" aria-hidden="true" />
              </div>
            </div>

            <div
              ref={tapeBodySurfaceRef}
              className="review-tape__surface review-tape__surface--body"
              style={REVIEW_SURFACE_STYLES.tapeBody}
              data-scene-surface={REVIEW_SURFACE_REGISTRY.surfaces.tapeBody.id}
            >
              <div className="review-tape__plane">
                <div ref={tapeWindowRef} className="review-tape__window review-tape__ink" data-scene-surface-layer="ink" data-window-start={windowStart}>
                  <ol className="review-tape__list" data-testid="review-queue" aria-label="已载入的待复习项目">
                    {visibleItems.map((item, visibleIndex) => {
                      const itemIndex = windowStart + visibleIndex;
                      const ready = item.startability.kind === "ready";
                      const selected = item.reviewId === selectedItem?.reviewId;
                      const isReturnTarget = matchesReviewTarget(item, activeReviewTarget);
                      const dueLabel = reviewTapeDueFormatter.format(new Date(item.dueAt));
                      const statusLabel = reviewTapeStatus(item);
                      return (
                        <li key={item.reviewId} className={ready ? "review-tape__item review-tape__item--ready" : "review-tape__item"}>
                          <button
                            ref={(node) => {
                              if (node) reviewItemRefs.current.set(item.reviewId, node);
                              else reviewItemRefs.current.delete(item.reviewId);
                            }}
                            type="button"
                            className={`review-tape__row${selected ? " review-tape__row--selected" : ""}${isReturnTarget ? " review-tape__row--return-target" : ""}`}
                            data-review-id={item.reviewId}
                            data-review-return-focus={isReturnTarget ? "true" : undefined}
                            aria-label={`第 ${itemIndex + 1} 项，到期 ${dueLabel}，${isReturnTarget ? "返回来源已定位" : statusLabel}`}
                            aria-current={selected ? "true" : undefined}
                            aria-expanded={selected}
                            aria-controls="review-selected-detail"
                            onClick={() => setSelectedReviewId(item.reviewId)}
                          >
                            <span className="review-tape__sequence">{itemIndex + 1}</span>
                            <time dateTime={item.dueAt}>{dueLabel}</time>
                            <span className="review-tape__status">{isReturnTarget ? "已定位" : statusLabel}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
                <span className="review-tape__material review-tape__material--body" data-scene-surface-layer="material" aria-hidden="true" />
              </div>
            </div>

            <div
              ref={tapeFooterSurfaceRef}
              className="review-tape__surface review-tape__surface--footer"
              style={REVIEW_SURFACE_STYLES.tapeFooter}
              data-scene-surface={REVIEW_SURFACE_REGISTRY.surfaces.tapeFooter.id}
            >
              <div className="review-tape__plane">
                <footer className="review-tape__footer review-tape__ink" data-scene-surface-layer="ink">
                  {queue.nextCursor && !hasNextWindow ? (
                    <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? "正在读取…" : returnTargetMissing ? "继续查找来源" : "继续读取到期项"}
                    </button>
                  ) : (
                    <span>{hasNextWindow ? "选择箭头继续浏览" : "已到已载入队列末尾"}</span>
                  )}
                </footer>
                <span className="review-tape__material review-tape__material--footer" data-scene-surface-layer="material" aria-hidden="true" />
              </div>
            </div>
          </section>
        ) : null}

        {!boundary && selectedItem ? (
          <article
            ref={notebookRef}
            id="review-selected-detail"
            className="review-notebook"
            style={REVIEW_NOTEBOOK_STYLE}
            aria-labelledby="review-selected-heading"
          >
            <div
              ref={leftNotebookSurfaceRef}
              className="review-notebook__surface review-notebook__surface--left"
              style={REVIEW_SURFACE_STYLES.notebookLeft}
              data-scene-surface={REVIEW_SURFACE_REGISTRY.surfaces.notebookLeft.id}
            >
              <div className="review-notebook__page review-notebook__page--left">
                <div className="review-notebook__ink review-notebook__ink--left" data-scene-surface-layer="ink">
                  <div className="review-notebook__semantic-copy">
                    <span className="review-notebook__sequence">第 {selectedIndex + 1} 项</span>
                    <h3 id="review-selected-heading">{selectedItem.startability.kind === "ready" ? "三分钟巩固" : "这项还不能开始"}</h3>
                    <p>
                      <span>开始后显示内容，先</span>
                      <span>完成独立回忆。</span>
                    </p>
                  </div>
                  <svg className="review-notebook__curved-copy" viewBox="0 0 220 134" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                    <defs>
                      <path id="review-left-sequence-path" d="M 72 50 C 116 49.2, 166 47.4, 212 45" />
                      <path id="review-left-title-path" d="M 72 79 C 116 78.2, 166 75.4, 212 73" />
                      <path id="review-left-body-one-path" d="M 72 99 C 116 98.2, 166 95.4, 212 93" />
                      <path id="review-left-body-two-path" d="M 72 117 C 116 116.2, 166 113.4, 212 111" />
                    </defs>
                    <text className="review-notebook__curved-sequence"><textPath href="#review-left-sequence-path">第 {selectedIndex + 1} 项</textPath></text>
                    <text className="review-notebook__curved-title"><textPath href="#review-left-title-path">{selectedItem.startability.kind === "ready" ? "三分钟巩固" : "这项还不能开始"}</textPath></text>
                    <text className="review-notebook__curved-body"><textPath href="#review-left-body-one-path">开始后显示内容，先</textPath></text>
                    <text className="review-notebook__curved-body"><textPath href="#review-left-body-two-path">完成独立回忆。</textPath></text>
                  </svg>
                </div>
                <span className="review-notebook__material review-notebook__material--left" data-scene-surface-layer="material" aria-hidden="true" />
              </div>
            </div>
            <div
              ref={rightNotebookSurfaceRef}
              className="review-notebook__surface review-notebook__surface--right"
              style={REVIEW_SURFACE_STYLES.notebookRight}
              data-scene-surface={REVIEW_SURFACE_REGISTRY.surfaces.notebookRight.id}
            >
              <div className="review-notebook__page review-notebook__page--right">
                <div className="review-notebook__ink review-notebook__ink--right" data-scene-surface-layer="ink">
                  <time className="review-notebook__due" dateTime={selectedItem.dueAt}>
                    <span>{reviewDueDateFormatter.format(new Date(selectedItem.dueAt))}</span>
                    <strong>{reviewDueTimeFormatter.format(new Date(selectedItem.dueAt))}</strong>
                  </time>
                  <p className={`review-notebook__status${selectedItem.startability.kind === "ready" ? " review-notebook__status--ready" : ""}`}>
                    {matchesReviewTarget(selectedItem, activeReviewTarget)
                      ? "已回到刚才的位置"
                      : selectedItem.startability.kind === "ready"
                        ? "现在可以开始"
                        : reviewBlockedReason(selectedItem.startability.reason)}
                  </p>
                  <div className="review-notebook__action">
                    {selectedItem.startability.kind === "ready" ? (
                      <button
                        type="button"
                        className="surface-primary"
                        disabled={startingReviewId !== null}
                        onClick={() => void startReview(selectedItem)}
                      >
                        {startingReviewId === selectedItem.reviewId
                          ? "正在准备…"
                          : <>开始三分钟巩固<ArrowRight size={16} aria-hidden="true" /></>}
                      </button>
                    ) : (
                      <button type="button" className="review-notebook__refresh" onClick={reload}>
                        <RotateCcw size={14} aria-hidden="true" />刷新开始条件
                      </button>
                    )}
                  </div>
                </div>
                <span className="review-notebook__material review-notebook__material--right" data-scene-surface-layer="material" aria-hidden="true" />
              </div>
            </div>
            <span className="review-notebook__spine" data-scene-surface-layer="occluder" aria-hidden="true" />
          </article>
        ) : null}

        {!boundary && returnTargetMissing ? (
          <p className="review-scene__return-status" role="status">
            返回来源不在已载入项目中；{queue?.nextCursor ? "继续读取后会恢复服务端确认的位置。" : "服务端队列已经变化，已保留当前真实队列。"}
          </p>
        ) : null}

        {import.meta.env.DEV ? (
          <SurfaceCalibrator
            referenceFrameRef={reviewReferenceFrameRef}
            registry={REVIEW_SURFACE_REGISTRY}
            surfaces={REVIEW_CALIBRATION_SURFACES}
            theme={theme}
            onThemeChange={setTheme}
            onQuadOverridesChange={setSurfaceQuadOverrides}
          />
        ) : null}
      </SceneReferenceFrame>
    </section>
  );
}
