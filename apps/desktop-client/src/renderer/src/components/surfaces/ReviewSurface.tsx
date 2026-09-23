import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, ArrowRight, RotateCcw } from "lucide-react";
import type { LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { ReviewQueueV2 } from "@ailearn/shared/review-queue-v2-contracts";
import type { AnswerModePreferenceV1 } from "@ailearn/shared/companion-shell-contracts";
import { answerModeToResponsePreference } from "@ailearn/shared/companion-shell-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { matchesReviewTarget } from "../review-focus";
import { SurfaceDataState, useDayAnchor } from "./surface-data";
import {
  DECK_DRAG_SLOP,
  REVIEW_WINDOW_SIZE,
  deckDragOutcome,
  deckDragShift,
  reviewDeckPosition,
  reviewDeckRound,
  reviewOverdueLabel,
  reviewReasonFacts,
  reviewReasonSentence,
  reviewReasonTag,
  reviewSequenceAfter,
  reviewStartabilityLabel,
  reviewFormalValidationBlockedLabel,
  reviewWindowStart,
  uniqueReviewItems,
  type ReviewItem,
} from "./review-deck";

type LoadedReviewQueue = {
  readonly version: 2;
  readonly items: ReviewItem[];
  /** 服务端确认的到期总数；位置行用它，而不是已载入的条数。 */
  readonly total: number;
  readonly nextCursor: string | null;
};

type ReviewFailure = {
  readonly message: string;
  readonly source: "queue" | "pagination" | "start" | "defer";
};

/** 每次向服务端要多少张到期项。服务端 limit 上限 100，20 让「继续读取」足够轻。 */
const REVIEW_PAGE_SIZE = 20;
/**
 * 自动翻页的上限：恢复阅读位置时最多读这么多页，免得一条深队列把内存拉满。
 */
const MAX_AUTO_PAGES = 25;
/**
 * 一张牌有多宽的兜底值。牌宽是列宽的一个份额，真正的值运行时从布局里量；这个常量
 * 只在量不到时兜底 —— 例如 jsdom 里没有布局。抽牌的判定按牌宽的比例算。
 */
const DECK_REACH_FALLBACK = 520;

/**
 * Page 15 「复习队列」. The mockup's desk is one card in front of a paper stack with
 * a reason slip beside it. Everything the mockup wrote by hand on that slip —
 * how late the card is, how many of its own cards are waiting, how it has
 * already been carried, what comes next — is derived here from the queue the
 * server returns, so the slip stays true as the real queue changes.
 */
export function ReviewSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const activeReviewTarget = useRoomStore((state) => state.activeReviewTarget);
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const storedResume = useRoomStore((state) => state.reviewQueueResume);
  const setReviewQueueResume = useRoomStore((state) => state.setReviewQueueResume);
  useHudPage("queue");

  // The surface is unmounted by TaskSurface on every navigation, so the reading
  // position is taken from the store once and written back on the way out.
  const resumeRef = useRef(storedResume);

  const [queue, setQueue] = useState<LoadedReviewQueue | null>(null);
  const [objectives, setObjectives] = useState<Record<string, LearningObjectiveSurfaceV3>>({});
  const [unreadableObjectiveIds, setUnreadableObjectiveIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<ReviewFailure | null>(null);
  const [startingReviewId, setStartingReviewId] = useState<string | null>(null);
  const [deferringReviewId, setDeferringReviewId] = useState<string | null>(null);
  const [deferredNotice, setDeferredNotice] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  /** 牌堆的拖拽状态：只影响呈现，不影响选中项。 */
  const [deckDragging, setDeckDragging] = useState(false);
  /**
   * 卡叠自己的焦点环。鼠标点在卡面上、拖着卡滑动，section 同样会拿到焦点，但读者
   * 并不是在用键盘 —— 那时画一个 3px 的红框横在整列卡片外面，只会让人以为出错了。
   * 所以环由这里决定，而不是 CSS 里的 :focus：
   *   · 焦点落下的那一刻浏览器已经算好 :focus-visible（Tab 为真、鼠标点卡面为假），
   *     照它决定；
   *   · 应用明确把焦点交还给卡叠时（走到队尾没有下一张、从今日学习带着目标回来）
   *     直接点亮；
   *   · 指针一碰就撤掉，而且不会自动回来 —— 焦点没变，浏览器不会重算 :focus-visible。
   */
  const [deckRing, setDeckRing] = useState(false);
  const deckRef = useRef<HTMLElement>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const startCommandIdsRef = useRef(new Map<string, string>());
  const focusedReturnTargetRef = useRef<string | null>(null);
  const returnLookupRef = useRef<{ targetKey: string; attemptedCursors: Set<string> } | null>(null);
  /**
   * 最后一次**有效**的选中序号。队列变短时用它退到同一位置，而不是跳回队首；
   * 只有工作区核对通过后才从恢复位置写入。
   */
  const seatRef = useRef(-1);
  /** 离开页面时交给 store 的是"最后一次有效选中"，所以它也要能被 cleanup 读到。 */
  const selectedReviewIdRef = useRef<string | null>(null);
  const nowMs = useDayAnchor();
  /** One busy flag for the whole action row: no request may start mid-request. */
  const busy = startingReviewId !== null || deferringReviewId !== null;
  /** 拖拽的手势状态。位移另存一份 ref，松手时读到的一定是最新值。 */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  /** 手势里最后一次真正落到牌面上的横向位移；松手判定读它，而不是原始 dx。 */
  const dragShiftRef = useRef(0);
  /** 一张牌的宽度：抽多远的判定按它的比例算。 */
  const deckReachRef = useRef(DECK_REACH_FALLBACK);
  /** 这一次手势是拖拽：浏览器在 pointerup 之后还会补一次 click，那不是点选。 */
  const draggedRecentlyRef = useRef(false);
  /**
   * 松手判定要读的队列边界。它们住在 ref 里，因为收束手势的出口挂在 window 上
   * （见 endDeckGestureRef），而那个监听只注册一次 —— 读渲染闭包里的值会停在
   * 挂载那一刻。逐帧改写是安全的：它们只在这一帧的判定里被读一次。
   */
  const deckBoundsRef = useRef({ canPrevious: false, canNext: false, hasMore: false });
  /** 同上的理由：window 上的收口要能调到当前这一帧的 moveSelection。 */
  const moveSelectionRef = useRef<(offset: number) => void>(() => {});
  /** 同上的理由：window 上的收口要能调到当前这一帧的收束逻辑。 */
  const endDeckGestureRef = useRef<(outcome: "release" | "cancel") => void>(() => {});

  const readSession = useCallback(async () => {
    if (!window.ailearn) throw new Error("desktop API is unavailable");
    const response = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const session = unwrapGatewayResult(response);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    return session;
  }, []);

  /** 读一页到期项。游标是服务端签发的不透明值，客户端只负责原样回传。 */
  const fetchPage = useCallback(async (cursor: string | undefined) => {
    if (!window.ailearn) throw new Error("desktop API is unavailable");
    const response = await window.ailearn.review.getQueue({
      meta: createRequestMeta(epochRef.current),
      ...(cursor ? { cursor } : {}),
      limit: REVIEW_PAGE_SIZE,
    });
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    return unwrapGatewayResult(response);
  }, []);

  /**
   * 读到期队列，一直读到覆盖 `targetIndex` 为止。默认只读第一页；恢复阅读位置
   * 或跳转时按服务端返回的 cursor 继续翻。游标是 (nextReviewAt, id) 复合键，
   * 不随集合增减漂移，所以重复走同一条链永远落在同一批卡上。
   *
   * 服务端重复返回同一个游标说明翻页没有前进：立刻停下，别把「继续读取」
   * 变成死循环（对象库那边的 loadMore 也是同一条规则）。
   */
  const loadQueue = useCallback(async (options: { targetIndex?: number } = {}) => {
    await readSession();
    const target = Math.max(0, options.targetIndex ?? 0);
    let items: ReviewItem[] = [];
    let total = 0;
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_AUTO_PAGES; page += 1) {
      const result = await fetchPage(cursor);
      items = uniqueReviewItems([...items, ...result.items]);
      total = result.total;
      nextCursor = result.nextCursor;
      if (!nextCursor || items.length > target || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    setQueue({ version: 2, items, total, nextCursor });
    setFailure(null);
    return items;
  }, [fetchPage, readSession]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const resume = resumeRef.current;
    void loadQueue({ targetIndex: resume?.selectedIndex ?? 0 })
      .then((items) => {
        if (!active || items.length === 0) return;
        // 位置只属于同一个工作区：换空间后「第 40 张」不是同一张卡。epochRef 在
        // loadQueue 的会话读取里已经更新成当前值，所以这里可以核对。
        const sameWorkspace = resume
          && (resume.workspaceEpoch === null || resume.workspaceEpoch === epochRef.current);
        if (!sameWorkspace) return;
        seatRef.current = resume.selectedIndex;
        // 位置先按卡 id 恢复；卡已经不在队列里时交给上面的序号退路。
        if (resume.selectedReviewId) setSelectedReviewId((current) => current ?? resume.selectedReviewId);
      })
      .catch((error) => active && setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadQueue]);

  // 离开页面时把阅读位置交回 store。只存位置，不存数据：回来时按位置重新读到
  // 的永远是服务端当前的真实队列。
  useEffect(() => () => {
    setReviewQueueResume({
      workspaceEpoch: epochRef.current ?? null,
      selectedReviewId: selectedReviewIdRef.current,
      selectedIndex: seatRef.current,
    });
  }, [setReviewQueueResume]);

  const reload = useCallback(() => {
    setLoading(true);
    setFailure(null);
    void loadQueue({ targetIndex: seatRef.current })
      .catch((error) => setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => setLoading(false));
  }, [loadQueue]);

  const loadMore = useCallback(async () => {
    const cursor = queue?.nextCursor;
    if (!cursor || loadingMore) return null;
    setLoadingMore(true);
    setFailure(null);
    try {
      const page = await fetchPage(cursor);
      setQueue((current) => current
        ? {
            version: 2,
            items: uniqueReviewItems([...current.items, ...page.items]),
            total: page.total,
            // 同一个游标回来 = 没有前进：停在这里，按钮不再是无底洞。
            nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          }
        : current);
      return page.items;
    } catch (error) {
      setFailure({ message: gatewayErrorMessage(error), source: "pagination" });
      return null;
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, queue?.nextCursor]);

  // 复习可能在页面停在队列时于别处被完成或延后；窗口重新可见时静默重读——
  // 成功才换数据，失败保留桌上已有的队列，与 useSurfaceProjection 的 silent
  // 语义一致。重读深度跟着当前选中位置走，所以翻过的页和脚下的这张都不会丢。
  const silentRefreshRef = useRef(false);
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === "hidden" || silentRefreshRef.current) return;
      silentRefreshRef.current = true;
      void loadQueue({ targetIndex: seatRef.current })
        .catch(() => {
          // A failed silent re-read keeps the readable queue; it never turns
          // the desk into an error state.
        })
        .finally(() => { silentRefreshRef.current = false; });
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [loadQueue]);

  const selectedIndex = queue?.items.findIndex((item) => item.reviewId === selectedReviewId) ?? -1;
  selectedReviewIdRef.current = selectedReviewId;

  const boundary = loading
    ? { kind: "loading" as const, message: "正在读取复习队列", detail: "正在确认真实到期项与开始条件。" }
    : failure?.source === "queue" && !queue?.items.length
      ? { kind: "error" as const, message: "无法读取真实复习队列", detail: failure.message }
      : queue && queue.items.length === 0
        ? { kind: "empty" as const, message: "今天没有到期项", detail: "现在没有可以开始的到期复习。" }
        : null;

  /**
   * 往后/往前还有没有牌。`hasNext` 把"服务端还有下一页"也算进去，所以按钮不会在
   * 已载入的末尾变灰；`loadedNext` 只数已经拿到的卡，拖拽靠它区分"滑一格"和
   * "该读下一页了"。
   */
  const loadedNext = Boolean(queue && selectedIndex >= 0 && selectedIndex < queue.items.length - 1);
  const loadedPrevious = selectedIndex > 0;
  const hasNext = loadedNext || Boolean(queue?.nextCursor);
  const hasPrevious = loadedPrevious;
  // 松手判定与阻尼都发生在 window 的收束口里，那里读不到这一帧的闭包，所以留一份。
  deckBoundsRef.current = {
    canPrevious: loadedPrevious,
    canNext: loadedNext,
    hasMore: Boolean(queue?.nextCursor),
  };

  // 只记录有效的座位：队列换掉的那一帧 selectedIndex 是 -1，不能用它覆盖记忆。
  useEffect(() => {
    if (selectedIndex >= 0) seatRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    if (!queue?.items.length) {
      setSelectedReviewId(null);
      return;
    }
    setSelectedReviewId((current) => {
      if (current && queue.items.some((item) => item.reviewId === current)) return current;
      // 脚下的卡被别处复习掉或延后了：留在同一位置，不回到队首。
      const seat = seatRef.current >= 0
        ? queue.items[Math.min(seatRef.current, queue.items.length - 1)]
        : null;
      /**
       * 审计 F28：队首那张如果是「正式验证缺冻结证据」的条目，它的结算必然
       * fail closed——用户做完一切、排程也不动。默认落点要跳过这种条目，
       * 否则主操作又把人引到那条注定无效的路上；它仍留在队列里，只是不当
       * 默认落点（`?? queue.items[0]` 兜底：整条队列都有缺口时才落到它）。
       */
      const firstCompletable = queue.items
        .slice(0, REVIEW_WINDOW_SIZE)
        .find((item) => item.startability.kind === "ready" && item.formalValidationBlocked === null);
      return seat?.reviewId
        ?? firstCompletable?.reviewId
        ?? queue.items.find((item) => item.startability.kind === "ready")?.reviewId
        ?? queue.items[0].reviewId;
    });
  }, [queue]);

  // 已离开队列的卡不再需要记着幂等命令 id；不清理的话它会随会话一直长。
  useEffect(() => {
    if (!queue) return;
    const live = new Set(queue.items.map((item) => item.reviewId));
    for (const reviewId of [...startCommandIdsRef.current.keys()]) {
      if (!live.has(reviewId)) startCommandIdsRef.current.delete(reviewId);
    }
  }, [queue]);

  const front = selectedIndex >= 0 ? queue?.items[selectedIndex] ?? null : null;
  const windowStart = reviewWindowStart(selectedIndex, queue?.items.length ?? 0);
  const windowEnd = Math.min(windowStart + REVIEW_WINDOW_SIZE, queue?.items.length ?? 0);
  const visibleItems = useMemo(
    () => queue?.items.slice(windowStart, windowEnd) ?? [],
    [queue, windowEnd, windowStart],
  );

  // The deck only needs the labels of the cards it can show, so the objective
  // read follows the visible window instead of the whole queue.
  const missingObjectiveKey = useMemo(() => {
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const item of visibleItems) {
      if (objectives[item.objectiveId] || seen.has(item.objectiveId)) continue;
      seen.add(item.objectiveId);
      missing.push(item.objectiveId);
    }
    return missing.join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleItems, objectives]);

  useEffect(() => {
    if (!missingObjectiveKey || !window.ailearn) return;
    let active = true;
    const requested = missingObjectiveKey.split(",");
    void Promise.allSettled(requested.map(async (objectiveId) => {
      const response = await window.ailearn.objective.get({ meta: createRequestMeta(epochRef.current), objectiveId });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      return { objectiveId, surface: unwrapGatewayResult(response) };
    }))
      .then((settled) => {
        if (!active) return;
        const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const unreadable = requested.filter((_, index) => settled[index]?.status === "rejected");
        if (loaded.length > 0) {
          const loadedIds = new Set(loaded.map((entry) => entry.objectiveId));
          setObjectives((current) => {
            const next = { ...current };
            for (const { objectiveId, surface } of loaded) next[objectiveId] = surface;
            return next;
          });
          // 读到了就不再是「读不到」：这个集合只该留住真正还没有标签的目标。
          setUnreadableObjectiveIds((current) => {
            const next = new Set([...current].filter((objectiveId) => !loadedIds.has(objectiveId)));
            return next.size === current.size ? current : next;
          });
        }
        // A label that cannot be read is not worth blanking the deck for; the
        // card falls back to its real position instead of an invented title. The
        // ids are remembered so the card can say the label is unreadable instead
        // of claiming a read that already finished is still running.
        if (unreadable.length > 0) setUnreadableObjectiveIds((current) => new Set([...current, ...unreadable]));
      });
    return () => { active = false; };
  }, [missingObjectiveKey]);

  const labelOf = useCallback(
    (item: ReviewItem): string | null => {
      const surface = objectives[item.objectiveId];
      return surface?.content.conceptLabel ?? surface?.sources.primaryNote?.title ?? null;
    },
    [objectives],
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
    const deck = deckRef.current;
    if (!deck) return;
    focusedReturnTargetRef.current = targetKey;
    setDeckRing(true);
    const frame = window.requestAnimationFrame(() => deck.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeReviewTarget, failure?.source, loadMore, loadingMore, queue, selectedReviewId, setActiveReviewTarget]);

  const focusDeck = useCallback(() => {
    const deck = deckRef.current;
    if (!deck) return;
    setDeckRing(true);
    window.requestAnimationFrame(() => deck.focus({ preventScroll: true }));
  }, []);

  /**
   * 把选中项移动 `offset` 格。往前越过已载入的末尾时先读下一页，而不是把「下一张」
   * 变成死按钮；真的没有下一页时把焦点收回卡叠（按钮会变灰，键盘读者不能停在
   * disabled 的分组里）。
   */
  const moveSelection = (offset: number) => {
    if (!queue?.items.length || selectedIndex < 0 || offset === 0) return;
    const lastLoadedIndex = queue.items.length - 1;
    if (offset > 0 && selectedIndex >= lastLoadedIndex) {
      if (!queue.nextCursor) { focusDeck(); return; }
      if (loadingMore) return;
      void (async () => {
        const appended = await loadMore();
        const next = appended?.[0];
        if (next) setSelectedReviewId(next.reviewId);
        else focusDeck();
      })();
      return;
    }
    const next = queue.items[Math.min(lastLoadedIndex, Math.max(0, selectedIndex + offset))];
    if (next) setSelectedReviewId(next.reviewId);
  };
  // 手势收束发生在 window 的监听里（见下），那里读不到这一帧的闭包，所以留一份最新引用。
  moveSelectionRef.current = moveSelection;

  /**
   * 牌堆：最上面那张跟着指针走，松手后要么滑回堆上，要么被抽走。
   *
   * 这里没有"先把动画播完再改状态"那一套：牌面朝哪摆完全由它在堆里的位置
   * （data-depth）和拖拽位移（--deck-drag-*）算出来，换牌只是改一次选中项，
   * 于是每张牌从旧位姿过渡到新位姿 —— 抽卡、洗牌、往回放都是同一条 CSS 过渡。
   * 位移写元素而不是 state：拖拽每秒要改几十次，走 React 会把整张理由条也重渲染。
   */
  const applyDragPose = (x: number, y: number, rotate: number) => {
    const deck = deckRef.current;
    if (!deck) return;
    deck.style.setProperty("--deck-drag-x", `${x}px`);
    deck.style.setProperty("--deck-drag-y", `${y}px`);
    deck.style.setProperty("--deck-drag-rot", `${rotate}deg`);
  };

  /** 把最上面那张放回堆上：位移归零，位姿过渡回 data-depth 给的位置。 */
  const releaseDragPose = () => applyDragPose(0, 0, 0);

  /**
   * 抽 `steps` 张（±1 来自拖拽、方向键与箭头按钮，>1 来自理由条的「后续顺序」）。
   * 往前抽到已载入的最后一张时，交给 moveSelection 去读下一页 —— 牌堆下面没有牌
   * 的时候不该假装还能抽。
   */
  const drawCard = (steps: number) => {
    if (steps === 0) return;
    releaseDragPose();
    moveSelectionRef.current(steps);
  };

  /**
   * 手势唯一的收束口：卡"跟不跟手"由它决定结束，位姿也由它归位。
   *
   * 判别与归位必须分开的两件事，之前合在 onPointerUp 里，于是只有"抬手落在卡叠
   * 内部"这一条路能收口。实际上抬手会落在卡叠外面的几种情形都收不到那个事件：
   * 指针在理由条/侧栏上松开（事件目标是别的元素，卡叠不在它的祖先链上）、窗口
   * 失去焦点、浏览器撤销这次指针（原生拖拽、系统手势）、指针捕获被收走。收不到
   * 事件不等于手势没结束 —— 读者已经松手了，卡却还挂在半路跟着手，这就是"粘手"。
   * 所以出口放在 window 上（capture + blur + lostpointercapture），来路有很多条。
   *
   * 只有真正的 release 才可能抽牌；cancel 一律滑回堆上，撤销不是"抽走"。
   */
  const endDeckGesture = (outcome: "release" | "cancel") => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDeckDragging(false);
    const shift = dragShiftRef.current;
    dragShiftRef.current = 0;
    // click 紧跟 pointerup：等这一轮事件走完再撤掉"刚拖过"的标记。
    window.setTimeout(() => { draggedRecentlyRef.current = false; }, 0);
    if (outcome === "cancel" || !drag.moved) { releaseDragPose(); return; }
    const decision = deckDragOutcome({
      dx: shift,
      reach: deckReachRef.current,
      velocity: drag.velocity,
      ...deckBoundsRef.current,
    });
    if (decision === "next" || decision === "load-next") { drawCard(1); return; }
    if (decision === "previous") { drawCard(-1); return; }
    // 没抽出去：牌自己滑回堆上（位移归零，位姿交回 data-depth）。
    releaseDragPose();
  };
  endDeckGestureRef.current = endDeckGesture;

  /**
   * 挂一次、管一辈子：手势状态的来路不止卡叠自己的指针事件。事件在 capture
   * 阶段于 window 上先到，卡叠里的 onPointerUp 随后只会看到已经收口的状态。
   */
  useEffect(() => {
    const end = (event: Event) => {
      // blur 不冒泡，但 capture 阶段 window 照样收得到每个元素的失焦 —— 页面里
      // 某颗控件拿到焦点（target 是元素，nodeType 1）不算"读者放下了手"。
      if (event.type === "blur") {
        if ((event.target as Node | null)?.nodeType === 1) return;
        endDeckGestureRef.current("cancel");
        return;
      }
      const pointer = event as PointerEvent;
      if (pointer.pointerId !== dragRef.current?.pointerId) return;
      endDeckGestureRef.current(event.type === "pointerup" ? "release" : "cancel");
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("lostpointercapture", end, true);
    window.addEventListener("blur", end, true);
    return () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("lostpointercapture", end, true);
      window.removeEventListener("blur", end, true);
    };
  }, []);

  const onDeckPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // 指针一碰，上一刻"交还焦点"的环就该让位：读者已经改成用鼠标了。
    setDeckRing(false);
    if (event.button !== 0 || boundary) return;
    // 控件上的手势属于控件："开始复习 / 查看来源" 的点按语义必须完整保留。
    if ((event.target as HTMLElement).closest("button, a, input, label, summary")) return;
    // 一次只允许一只手势：上一只还没收口（抬手落在了别的窗口）就先按撤销收掉，
    // 否则新手势会带着旧位移继续走。
    if (dragRef.current) endDeckGesture("cancel");
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastT: performance.now(),
      velocity: 0,
      moved: false,
    };
    // 拿不到捕获也不影响：卡叠外面的抬手由 window 上的收口兜住。
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* 指针已经不是活动指针时捕获会抛，忽略即可 */
    }
  };

  const onDeckPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    const elapsed = Math.max(1, now - drag.lastT);
    drag.velocity = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastT = now;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // 小于判定阈值的手势算点击：按在牌上抖一下不该把牌抽走。
      if (Math.hypot(dx, dy) < DECK_DRAG_SLOP) return;
      drag.moved = true;
      draggedRecentlyRef.current = true;
      setDeckDragging(true);
    }
    // 抽牌只按横向算；竖直方向跟着手指走一点（手感），并让牌随位移侧一侧。
    // 「拖不拖得动」问的是**松手会不会前进**，而不是"已经载入了下一张没有"：
    // 已载入的末尾但服务端还有下一页时，松手会顺势读进来再抽走，那一路就该
    // 1:1 跟手；否则读者在最后一页上会先感到一段莫名的阻尼。
    const shift = deckDragShift(dx, dx < 0 ? deckBoundsRef.current.canNext || deckBoundsRef.current.hasMore : deckBoundsRef.current.canPrevious);
    dragShiftRef.current = shift;
    applyDragPose(shift, dy * 0.3, Math.max(-14, Math.min(14, shift * 0.04)));
  };

  const onDeckPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    // 收口已经发生在 window 的 capture 监听里（抬手落在卡叠外面时也只到那里），
    // 这里只在"事件确实落在卡叠上、且还没收口"时补一次。
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDeckGesture("release");
  };

  /**
   * 露在下面的牌本身就是"再抽几张就是它"，点它就该把它抽上来 —— 一张露着边却按不动
   * 的牌只会把读者引到箭头上去。拖拽结束浏览器补的那次 click 不算点选。
   */
  const onDeckClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!draggedRecentlyRef.current) return;
    draggedRecentlyRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // 牌的宽度决定"抽多远算抽出去"，所以从布局里量；窗口变化时重新量。
  useLayoutEffect(() => {
    const card = deckRef.current?.querySelector<HTMLElement>('.deck-card[data-depth="0"]');
    deckReachRef.current = card && card.offsetWidth > 0 ? card.offsetWidth : DECK_REACH_FALLBACK;
  }, [visibleItems, selectedIndex]);

  useEffect(() => {
    const measure = () => {
      const card = deckRef.current?.querySelector<HTMLElement>('.deck-card[data-depth="0"]');
      if (card && card.offsetWidth > 0) deckReachRef.current = card.offsetWidth;
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /**
   * 账号「作答方式」偏好（doc 34 L15）。读不到就当未设置（"any" → 服务端按情况
   * 编排）：这一个值只是开跑时的一个提示参数，不该因为偏好读失败而点不动「开始复习」。
   */
  const readAnswerMode = useCallback(async (): Promise<AnswerModePreferenceV1> => {
    const gateway = window.ailearn;
    if (!gateway) return "any";
    try {
      const response = await gateway.companion.answerMode.get({ meta: createRequestMeta(epochRef.current) });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      return unwrapGatewayResult(response).preference;
    } catch {
      return "any";
    }
  }, []);

  const startReview = async (item: ReviewItem) => {
    if (item.startability.kind !== "ready" || startingReviewId || !window.ailearn) return;
    const commandId = startCommandIdsRef.current.get(item.reviewId) ?? createCommandId("start-review");
    startCommandIdsRef.current.set(item.reviewId, commandId);
    setStartingReviewId(item.reviewId);
    setActiveReviewTarget(null);
    focusedReturnTargetRef.current = null;
    setFailure(null);
    const answerMode = await readAnswerMode();
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
          // 硬写的 "adaptive" 就是 L15：设置页那个选择在复习这条路上从来没生效。
          // 映射只认 shared 的那一张表，界面不再自己判。
          responsePreference: answerModeToResponsePreference(answerMode),
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
        void loadQueue({ targetIndex: seatRef.current }).catch((refreshError) => {
          setFailure({ message: gatewayErrorMessage(refreshError), source: "queue" });
        });
      } else {
        setFailure({ message: gatewayErrorMessage(error), source: "start" });
      }
    } finally {
      setStartingReviewId(null);
    }
  };

  /**
   * 方案 16 §18.3 的展示层延后：卡在 deferredUntil 之前不再出现在到期队列，
   * 但 official 到期时间不变——这不是完成复习，只是「明天再提醒我」。
   */
  const deferFront = async (item: ReviewItem) => {
    if (deferringReviewId || !window.ailearn) return;
    setDeferringReviewId(item.reviewId);
    setDeferredNotice(null);
    setFailure(null);
    try {
      const response = await window.ailearn.review.defer({
        meta: createRequestMeta(epochRef.current),
        request: {
          scheduleId: item.scheduleId,
          scheduleGeneration: item.scheduleGeneration,
          deferredUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          reasonCode: "user_requested",
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setDeferredNotice("已把这张卡推迟到明天再提醒；它的到期时间没有变。");
      // 保留阅读深度：被延后的那张消失后，读者应该停在同一个位置上。
      await loadQueue({ targetIndex: seatRef.current });
    } catch (error) {
      if (error instanceof RendererGatewayError && (error.code === "conflict" || error.code === "not_found")) {
        setDeferredNotice("这张卡的状态刚变过，队列已经按最新情况刷新。");
        await loadQueue({ targetIndex: seatRef.current }).catch((refreshError) => {
          setFailure({ message: gatewayErrorMessage(refreshError), source: "queue" });
        });
      } else {
        setFailure({ message: gatewayErrorMessage(error), source: "defer" });
      }
    } finally {
      setDeferringReviewId(null);
    }
  };

  // 回执是一次确认，不是常驻状态：看完就该消失，否则它会在读者翻到别的卡之后
  // 还挂在那里说上一张卡的事。
  useEffect(() => {
    if (!deferredNotice) return undefined;
    const timer = window.setTimeout(() => setDeferredNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [deferredNotice]);

  const frontSurface = front ? objectives[front.objectiveId] ?? null : null;

  /**
   * 卡面正文对整行都是同一套说法：滑到左右两边的牌也会显示自己的问题，读者在拖
   * 之前就知道下一张是什么。读不到的标签不编标题，改为说明"读不到"。
   */
  const questionOf = (item: ReviewItem): string => {
    const surface = objectives[item.objectiveId];
    if (surface) return surface.content.conceptLabel ?? surface.content.publicSummary;
    return unreadableObjectiveIds.has(item.objectiveId)
      ? "这张卡的理解目标暂时读不到标签"
      : "正在读取这张卡的问题…";
  };
  const originOf = (item: ReviewItem): string => {
    const surface = objectives[item.objectiveId];
    if (!surface) {
      return unreadableObjectiveIds.has(item.objectiveId)
        ? "已排到的到期复习 · 目标标签暂时读不到"
        : "这张卡是排到时间的到期复习";
    }
    if (surface.sources.primaryNote) return `来自笔记《${surface.sources.primaryNote.title}》`;
    if (surface.content.sourceLabel) return `来自来源「${surface.content.sourceLabel}」`;
    return "来自复习队列里的理解目标";
  };

  /** 同一理解目标在这批到期项里还有几张卡 —— 不是「牵动了几个目标」。 */
  const relatedCards = front && queue
    ? queue.items.filter((item) => item.objectiveId === front.objectiveId).length
    : 0;
  /** 已载入队列覆盖到多少个不同的理解目标。跨目标的说法只由它承担。 */
  const affectedObjectives = queue ? new Set(queue.items.map((item) => item.objectiveId)).size : 0;
  const reason = front
    ? reviewReasonFacts(front, relatedCards, nowMs, Math.max(0, selectedIndex), affectedObjectives)
    : null;
  const reasonTag = reason ? reviewReasonTag(reason) : null;
  const sequence = front && queue
    ? reviewSequenceAfter(queue.items, selectedIndex, labelOf)
    : [];
  const isReturnTarget = Boolean(front && matchesReviewTarget(front, activeReviewTarget));
  const readyCount = queue?.items.filter((item) => item.startability.kind === "ready").length ?? 0;
  /** The card's own state chip; `null` while the card can simply be started. */
  const blockedLabel = front && front.startability.kind !== "ready" ? reviewStartabilityLabel(front) : null;
  /** 位置行对齐服务端总数：已载入 20 张不等于队列只有 20 张。 */
  const deckTotal = Math.max(queue?.total ?? 0, queue?.items.length ?? 0);
  /**
   * 进度条是"整条队列"的比例，不是"已载入窗口"的比例：共 300 张时第 5 张就该是
   * 一点点，已读进来的部分用浅色垫在下面，读者一眼能看出还剩多少没读到。
   */
  const seatRatio = deckTotal > 0 ? (selectedIndex + 1) / deckTotal : 0;
  const loadedRatio = deckTotal > 0 ? (queue?.items.length ?? 0) / deckTotal : 0;
  /**
   * The slip's "到期" fact. The queue only hands out schedules the server already
   * considers due, so the same label answers every card — one fact, one wording.
   */
  const dueLine = front ? reviewOverdueLabel(front.dueAt, nowMs) : "时间未提供";
  /**
   * What the slip says with no card to explain. A failed read must not read as
   * "今天没有到期项": the deck beside it already names which state happened.
   */
  const slipState = loading
    ? "正在读取排好的到期顺序。"
    : failure?.source === "queue"
      ? "这一页没有读到真实的到期队列，因此不给理由。"
      : queue && queue.items.length > 0
        ? `已载入 ${queue.items.length} 项，服务端确认共 ${deckTotal} 项。`
        : "今天没有到期项，理由条也随之留空。";
  /**
   * Stepping the deck rewrites the card in place, so the card that just arrived
   * is announced here; the repaint alone reaches only sighted pointer users.
   */
  const deckAnnouncement = front
    ? frontSurface
      ? `${reviewDeckPosition(selectedIndex, deckTotal)}，${questionOf(front)}`
      : reviewDeckPosition(selectedIndex, deckTotal)
    : boundary?.message ?? "";

  return (
    <HudPage page="queue">
      <div className="queue-desk">
        {/* 卡叠只挂 down/move/up 三条指针来路；pointercancel、抬手落在卡叠外面、
            窗口失焦都归 window 上的收束口（见 endDeckGesture）—— 出口只有一个。 */}
        <section
          ref={deckRef}
          className="card-deck"
          role="group"
          aria-label="复习队列卡叠"
          tabIndex={0}
          data-review-id={front?.reviewId}
          data-review-return-focus={isReturnTarget ? "true" : undefined}
          data-deck-dragging={deckDragging ? "true" : undefined}
          data-deck-ring={deckRing ? "true" : undefined}
          onFocus={(event) => {
            // Read the modifier eagerly: React clears `currentTarget` when the
            // handler returns, and the state updater runs after that. Reading it
            // lazily threw on the first focus and took the whole tree down.
            const ringVisible = event.currentTarget.matches(":focus-visible");
            setDeckRing((current) => current || ringVisible);
          }}
          onBlur={() => setDeckRing(false)}
          onKeyDown={(event) => {
            // 长按会以约 30 次/秒重复触发；每次都会换掉带 key 的正文并重放
            // 淡入，正文会在接近全透明处抖动。按住不放只算一次移动。
            if (event.repeat) return;
            if (event.key === "ArrowLeft") { event.preventDefault(); drawCard(-1); }
            if (event.key === "ArrowRight") { event.preventDefault(); drawCard(1); }
          }}
          onClickCapture={onDeckClickCapture}
          onPointerDown={onDeckPointerDown}
          onPointerMove={onDeckPointerMove}
          onPointerUp={onDeckPointerUp}
        >
          {/* 换卡是整行滑动，看得见的那一下就是反馈；看不到牌面的读者靠这句。 */}
          <p className="sr-only" role="status">{deckAnnouncement}</p>

          {boundary ? (
            /* 状态纸也是卡槽里唯一的一张牌：同一套堆位规则，它才落在正中。 */
            <article className="deck-card front" data-depth="0">
              <SurfaceDataState
                {...boundary}
                onRetry={boundary.kind === "error" ? () => reload() : undefined}
                action={boundary.kind === "empty" ? (
                  <div className="actions">
                    {/* 空队列的下一步是回到今日学习：主行动走主按钮，与
                        「开始复习」共用同一套主按钮语言。 */}
                    <button type="button" className="button primary" onClick={() => invoke("continue")}>
                      回到今日学习<ArrowRight size={15} aria-hidden="true" />
                    </button>
                    <button type="button" className="button" onClick={() => invoke("open-notebook")}>继续写笔记</button>
                  </div>
                ) : undefined}
              />
            </article>
          ) : visibleItems.map((item, offset) => {
              const seat = windowStart + offset;
              const isFront = item.reviewId === front?.reviewId;
              const surface = objectives[item.objectiveId] ?? null;
              const stateLabel = item.startability.kind === "ready" ? null : reviewStartabilityLabel(item);
              // 审计 F28：只有当前这张需要印缺口说明；后面的卡在它成为当前卡时再印。
              const evidenceGapLabel = isFront ? reviewFormalValidationBlockedLabel(item) : null;
              return (
                /* 一行里每张卡只挂一次，换卡只改整行的居中位移：React 不重建节点，
                   滑动过程里没有重新挂载，也没有第二份 id 抢标签。 */
                <article
                  key={item.reviewId}
                  className={`deck-card${isFront ? " front" : ""}`}
                  data-depth={seat - selectedIndex}
                  data-drawn={seat < selectedIndex ? "true" : undefined}
                  aria-hidden={isFront ? undefined : "true"}
                  aria-labelledby={isFront ? "review-deck-question" : undefined}
                  onClick={isFront ? undefined : () => drawCard(seat - selectedIndex)}
                >
                  <div className="deck-card__body">
                    <div className="meta">
                      <span>{reviewDeckPosition(seat, deckTotal)}</span>
                      <span>{reviewDeckRound(item.scheduleGeneration)}</span>
                      {stateLabel ? <span className="tag deck-card__state">{stateLabel}</span> : null}
                    </div>
                    <h2 id={isFront ? "review-deck-question" : undefined}>{questionOf(item)}</h2>
                    <p className="sub">{originOf(item)}</p>
                    {/* 审计 F28：这张到期卡的正式验证现在判不出结论（评分点缺冻结
                        证据）。它必须印在卡面上、紧挨着主按钮——理由条在旁边的纸上，
                        而用户是看着这颗按钮决定要不要投入时间的。 */}
                    {isFront && evidenceGapLabel ? (
                      <p className="small deck-card__evidence-gap" role="status">
                        {evidenceGapLabel}
                        <button
                          type="button"
                          className="text-action text-action--strong"
                          disabled={busy}
                          onClick={() => {
                            setActiveObjectiveId(item.objectiveId);
                            invoke("open-objective");
                          }}
                        >
                          去看这条目标还缺什么
                        </button>
                      </p>
                    ) : null}
                  </div>
                  {isFront ? (
                    <>
                      <div className="actions">
                        {item.startability.kind === "ready" ? (
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => void startReview(item)}
                          >
                            {startingReviewId === item.reviewId
                              ? "正在准备…"
                              : <>开始复习<ArrowRight size={15} aria-hidden="true" /></>}
                          </button>
                        ) : (
                          <button type="button" className="button" disabled={busy} onClick={reload}>
                            <RotateCcw size={14} aria-hidden="true" />刷新开始条件
                          </button>
                        )}
                        {/* 有主笔记就开笔记，否则落到理解目标页——同一个「查看来源」
                            的两条去路，不是两颗按钮。 */}
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={() => {
                            const note = surface?.sources.primaryNote;
                            if (note) {
                              setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.noteVersionId });
                              invoke("open-notebook");
                              return;
                            }
                            setActiveObjectiveId(item.objectiveId);
                            invoke("open-objective");
                          }}
                        >
                          查看来源
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={() => void deferFront(item)}
                        >
                          {deferringReviewId === item.reviewId ? "正在延后…" : "稍后提醒"}
                        </button>
                      </div>
                      {/* 箭头按钮是与拖拽等价的一条路：键盘和不愿意拖的读者都靠它。 */}
                      {queue && (queue.items.length > 1 || queue.nextCursor) ? (
                        <div className="deck-nav" role="group" aria-label="在到期项之间移动">
                          <button
                            type="button"
                            className="deck-nav__step"
                            onClick={() => drawCard(-1)}
                            disabled={!hasPrevious}
                            aria-label="上一张到期项"
                          >
                            <ArrowLeft size={15} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="deck-nav__step"
                            onClick={() => drawCard(1)}
                            disabled={!hasNext}
                            aria-busy={loadingMore || undefined}
                            aria-label={queue.nextCursor && selectedIndex >= queue.items.length - 1
                              ? "读取下一张到期项"
                              : "下一张到期项"}
                          >
                            <ArrowRight size={15} aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </article>
              );
            })}

          {front ? (
            <div className="deck-foot">
              <span className="deck-progress" aria-hidden="true">
                <span className="deck-progress__loaded" style={{ transform: `scaleX(${loadedRatio})` }} />
                <span className="deck-progress__bar" style={{ transform: `scaleX(${seatRatio})` }} />
              </span>
              <span className="deck-foot__hint">把最上面那张拖走，或按 ← → 抽下一张</span>
            </div>
          ) : null}
        </section>

        <aside className="queue-reason" aria-label="这张卡为什么排在最前">
          {/* 徽标只在有话可说时出现：没有卡也没有失败时，「队列」两个字不构成
              状态，只是纸上的一粒噪音。 */}
          {reasonTag ? (
            <span className={reasonTag.tone ? `tag ${reasonTag.tone}` : "tag"}>{reasonTag.label}</span>
          ) : failure ? (
            <span className="tag red">读取失败</span>
          ) : null}
          <h3>为什么现在复习它</h3>

          {/* 回执放在理由条顶部：底部的旧位置在 240px 窄栏里要滚动才看得到。 */}
          {deferredNotice ? (
            <p className="small queue-reason__notice" role="status">{deferredNotice}</p>
          ) : null}

          {reason && reasonTag ? (
            <>
              <p>{reviewReasonSentence(reason)}</p>
              {/* 中段只补句子没说过的**卡级**事实：可以开始的卡，句子里已经写了
                  到期时间和同目标卡数，再列一遍只会让读者对着一组数字猜"2 张和
                  3 张是不是两回事"；冷却卡的句子只说冷却，这两行才有信息量。 */}
              {reason.ready ? null : (
                <>
                  <div className="rule" />
                  <p>
                    到期：{dueLine}
                    <br />
                    同一理解目标：{reason.relatedCards} 张到期卡
                  </p>
                </>
              )}
              <div className="rule" />
              {sequence.length > 0 ? (
                <p className="small queue-reason__order">
                  后续顺序：
                  {sequence.map((stop, stopIndex) => (
                    <span key={stop.reviewId}>
                      {stopIndex > 0 ? " → " : ""}
                      <button
                        type="button"
                        aria-label={`滑到「${stop.label}」`}
                        onClick={() => drawCard(stop.offset)}
                      >
                        {stop.label}
                      </button>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="small">
                  {queue?.nextCursor ? "后续到期项还没有读取。" : "这一批就读到这里，后面还有没读到的会继续取。"}
                </p>
              )}
              {/* 已载入多少、覆盖多少目标是**队列**级的事实：和后续顺序归在
                  同一组，不再夹在两条分隔线中间孤零零地站着。 */}
              <p className="small">
                已载入 {queue?.items.length ?? 0} / {deckTotal} 项
                <br />
                覆盖 {reason.affectedObjectives} 个理解目标
              </p>
              {queue?.nextCursor ? (
                <p className="small">
                  <button type="button" className="queue-reason__more" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? "正在读取…" : "继续读取更多到期项"}
                  </button>
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p>{slipState}</p>
              {queue && queue.items.length > 0 ? (
                <>
                  <div className="rule" />
                  <p>
                    已载入：{queue.items.length} / {deckTotal} 项
                    <br />
                    可以开始：{readyCount} 项
                    <br />
                    当前选中：{selectedIndex >= 0 ? `第 ${selectedIndex + 1} 项` : "未选中"}
                  </p>
                </>
              ) : null}
            </>
          )}

          {failure && queue?.items.length ? (
            <p className="small queue-reason__failure" role="alert">
              {failure.source === "pagination"
                ? "继续读取失败，已载入的卡片仍然保留。"
                : failure.source === "start"
                  ? "还没收到「已经开始」的回音；再点一次不会重复开始。"
                  : failure.source === "defer"
                    ? "延后没送出去，这张卡还在队列里。"
                    : "队列刷新失败，当前卡片仍然保留。"}
              {failure.source === "pagination" ? (
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>重试读取</button>
              ) : failure.source === "queue" ? (
                <button type="button" onClick={reload}>重新读取</button>
              ) : failure.source === "start" ? (
                <button type="button" onClick={() => front ? void startReview(front) : undefined} disabled={busy}>重试开始</button>
              ) : failure.source === "defer" ? (
                <button type="button" onClick={() => front ? void deferFront(front) : undefined} disabled={deferringReviewId !== null}>重试延后</button>
              ) : null}
            </p>
          ) : null}

        </aside>
      </div>
    </HudPage>
  );
}
