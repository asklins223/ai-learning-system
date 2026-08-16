"use client";

import "@/app/styles/today.css";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type CardListItem,
  type JobRow,
  type NoteHeader,
  type ReviewWithCard,
  type SourceRow,
  type SourceType,
} from "@/lib/api";
import { fullTime, relativeTime } from "@/lib/format";
import { statusMap, type StatusTone } from "@/lib/status-map";
import { buildTodayReturnTarget, withTodayReturnTarget } from "@/lib/today-return";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { useIsOwner } from "@/lib/use-current-user";
import { isLearningRunV1Enabled } from "@/lib/feature-flags";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { learningCardHref, mergeLearningCardsV2 } from "@/lib/learning-card-library";

type ActivityType = "note" | "card" | "source" | "review" | "job";
type ActivityGroup = "attention" | "running" | "recorded";
type ActivityFilter = "all" | ActivityType;
type DataKey = "notes" | "cards" | "reviews" | "jobs" | "sources";
const LEARNING_RUN_UI_PREVIEW = process.env.NODE_ENV === "development";

interface TodayActivity {
  id: string;
  objectId: string;
  type: ActivityType;
  group: ActivityGroup;
  time: string;
  typeLabel: string;
  title: string;
  description: string;
  statusLabel?: string;
  statusTone?: StatusTone;
  href?: string;
  actionLabel?: string;
  aggregateCount?: number;
}

const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "note", label: "笔记" },
  { value: "card", label: "学习卡" },
  { value: "source", label: "来源" },
  { value: "review", label: "复习" },
  { value: "job", label: "自动任务" },
];

const GROUP_META: Record<
  ActivityGroup,
  { title: string; eyebrow: string; description: string }
> = {
  attention: {
    title: "需要关注",
    eyebrow: "优先处理",
    description: "处理未完成的资料和任务，避免理解链路停在半路。",
  },
  running: {
    title: "正在处理",
    eyebrow: "进行中",
    description: "这些项目仍在后台推进，状态会在刷新后更新。",
  },
  recorded: {
    title: "今日记录",
    eyebrow: "已记录",
    description: "今天在当前工作区中可追溯的学习产出与处理记录。",
  },
};

const DATA_LABELS: Record<DataKey, string> = {
  notes: "笔记",
  cards: "学习卡",
  reviews: "复习计划",
  jobs: "自动任务",
  sources: "来源资料",
};

const FILTER_DATA_KEY: Partial<Record<ActivityFilter, DataKey>> = {
  note: "notes",
  card: "cards",
  source: "sources",
  review: "reviews",
  job: "jobs",
};

function isActivityFilter(value: string | null): value is ActivityFilter {
  return FILTERS.some((item) => item.value === value);
}

function isWithinDay(iso: string | null | undefined, start: number, end: number) {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && time >= start && time < end;
}

function sourceTypeLabel(type: SourceType): string {
  switch (type) {
    case "markdown":
      return "Markdown";
    case "code":
      return "代码";
    case "url":
      return "网页";
    case "text":
    default:
      return "文本";
  }
}

function jobLabel(type: string): string {
  switch (type) {
    case "execute_card_agent_turn":
      return "生成学习卡";
    case "evaluate_validation":
      return "评估验证";
    case "align_evidence":
      return "证据对齐";
    case "parse_source":
      return "解析来源";
    default:
      return "后台处理";
  }
}

function jobEventTime(job: JobRow): string {
  if (["succeeded", "failed", "dead"].includes(job.status)) {
    return job.finishedAt ?? job.scheduledAt;
  }
  if (job.status === "running") return job.startedAt ?? job.scheduledAt;
  return job.scheduledAt;
}

function jobDescription(status: string): string {
  switch (status) {
    case "succeeded":
      return "后台处理已完成";
    case "failed":
    case "dead":
      return "后台处理未完成，可稍后回到对应对象重试";
    case "running":
      return "后台任务正在执行";
    case "pending":
    default:
      return "后台任务已进入队列";
  }
}

// 第八轮 🟡B-6：模块级 Intl 单例 formatter（原实现每行 new Date().toLocaleTimeString
// 每渲重建）。行渲染只做 format 调用，不重复创建 formatter。
const activityClockFmt = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function activityClock(iso: string): string {
  return activityClockFmt.format(new Date(iso));
}

function learningRunUiPreviewHref(input: {
  origin: "today" | "today_v2";
  cardId?: string | null;
  keyPointId?: string | null;
  scheduleId?: string | null;
  isV2?: boolean;
}) {
  // P3 切流：learning_run_v1 开 → 生产创建入口；否则开发态原型或 null。
  if (isLearningRunV1Enabled()) {
    const params = new URLSearchParams({ origin: input.isV2 ? "today_v2" : "today", returnTo: "/today" });
    if (input.isV2 && input.keyPointId) {
      params.set("objectiveId", input.keyPointId);
    } else if (input.keyPointId) {
      params.set("keyPointId", input.keyPointId);
    }
    return `/learning-runs/new?${params.toString()}`;
  }
  if (!LEARNING_RUN_UI_PREVIEW) return null;
  const params = new URLSearchParams({
    origin: input.origin,
    returnTo: "/today",
  });
  if (input.cardId) params.set("cardId", input.cardId);
  if (input.keyPointId) params.set("keyPointId", input.keyPointId);
  if (input.scheduleId) params.set("scheduleId", input.scheduleId);
  return `/learning-runs/ui-redraw?${params.toString()}`;
}


// F#2（round3）：当日复习分页瀑布——加页数硬上限 + 同日缓存，避免复习旺季
// 每次进入都串行拉几十页且逐次重跑。页数上限 10 页（limit 100 → 至多 1000 条），
// 超限即停止（当日到期复习远超此量属异常，宁可少拉也不制造 10+ 次串行往返）；
// F3（round4）：缓存 key 加入 workspaceId 维度（避免同一会话当日切换工作区/账户
// 命中他人复习列表——跨租户串数），并对 Map 做有界 eviction（最多保留 N 条，
// 按写入序淘汰最旧，防止长驻 tab 无界累积）。
const REVIEW_MAX_PAGES = 10;
const REVIEW_CACHE_MAX_ENTRIES = 50;
const listAllReviewsCache = new Map<string, ReviewWithCard[]>();

async function listAllReviews(): Promise<ReviewWithCard[]> {
  // F3：缓存的 key 必须含工作区维度。getMe 命中短 TTL 缓存，成本可忽略；
  // getMe 失败时退化为仅 dayEnd（跨租户风险窗口缩小到一次调用，可接受）。
  let workspaceScope = "anon";
  try {
    const me = await api.getMe();
    workspaceScope = me.workspaceId || "anon";
  } catch {
    // getMe 失败时退化为无前缀 key（与 pages/cards 的 pagerLocateCache 同款兜底）。
  }

  const items: ReviewWithCard[] = [];
  const seenIds = new Set<string>();
  let offset = 0;

  // 2026-08-11（性能专项）：按到期窗口拉取——只限上界（今天结束前），
  // 避免历史未处理到期项被漏掉（dueReviews 语义 = pending 且已到期，
  // 不限过去）。原实现 includeAll 全量拉取，复习历史大时串行瀑布几十页。
  const now = new Date();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
  const cacheKey = `${workspaceScope}:${dayEnd}`;

  // F#2/F3：同日同工作区已拉取过则复用缓存，不再重跑分页瀑布。
  const cached = listAllReviewsCache.get(cacheKey);
  if (cached && cached.length > 0) return cached;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await api.listReviews({ includeAll: true, limit: 100, offset, dueToMs: dayEnd });
    for (const item of page.items) {
      if (!seenIds.has(item.review.id)) {
        seenIds.add(item.review.id);
        items.push(item);
      }
    }

    if (page.nextCursor === null) break;
    if (page.nextCursor <= offset) {
      throw new Error("复习分页游标未向前推进");
    }
    // F#2：页数硬上限——超限停止，避免无界串行瀑布。
    if (offset >= (REVIEW_MAX_PAGES - 1) * 100) break;
    offset = page.nextCursor;
  }

  listAllReviewsCache.set(cacheKey, items);
  // F3：有界 eviction——超出上限时按写入序淘汰最旧条目。
  if (listAllReviewsCache.size > REVIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = listAllReviewsCache.keys().next().value;
    if (oldestKey !== undefined) listAllReviewsCache.delete(oldestKey);
  }
  return items;
}

function ActivityIcon({ type }: { type: ActivityType }) {
  const Component =
    type === "note"
      ? Icon.Notepad
      : type === "card"
        ? Icon.Card
        : type === "source"
          ? Icon.Folder
          : type === "review"
            ? Icon.Review
            : Icon.Bolt;
  return <Component aria-hidden="true" />;
}

export default function TodayPage() {
  const { isOwner } = useIsOwner();
  // P5（文档 16 §14.2）：Today 页发布 bounded context。
  // 第八轮 🟡B-1：传 useMemo 稳定引用——热轮询页避免每渲新建 input 触发
  // JSON.stringify（useMemo 的稳定引用短路失效）。
  useMainPageContext(useMemo(() => ({
    routeRef: { kind: "today" },
    pageKind: "today",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  }), []));
  const [notes, setNotes] = useState<NoteHeader[] | null>(null);
  const [cards, setCards] = useState<CardListItem[] | null>(null);
  const [reviews, setReviews] = useState<ReviewWithCard[] | null>(null);
  // F#7（🟡14）：镜像 reviews 到 ref，供 60s interval 判断"是否有 review 刚跨过
  // 到期阈值"（闭包若捕获 state 会因空依赖永远读到初始值）。
  const reviewsRef = useRef(reviews);
  // 第八轮 🟡B-3：镜像写入移入 useEffect（渲染期写 ref 是纯度过反模式）。
  useEffect(() => {
    reviewsRef.current = reviews;
  }, [reviews]);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<DataKey, string>>>({});
  const [retryingKey, setRetryingKey] = useState<DataKey | "all" | null>(null);

  const [activeFilter, setActiveFilter] = useState<ActivityFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [routeReady, setRouteReady] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);
  // Keep the server and first client render timezone-neutral. The actual local
  // day is established after mount so deployments running in UTC do not flash
  // the previous date for users in Asia.
  const [dayAnchor, setDayAnchor] = useState<Date | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => Date.now());
  // F#7（🟡14）：上次到期判断的基准时间 ref——判断某分钟是否有 review 刚到期。
  const minuteTickPrevRef = useRef(minuteTick);

  const [showCapture, setShowCapture] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<{
    tone: "success" | "error";
    text: string;
    sourceId?: string;
  } | null>(null);
  const captureSectionRef = useRef<HTMLElement>(null);
  const captureInputRef = useRef<HTMLTextAreaElement>(null);
  const shouldScrollToCaptureRef = useRef(false);
  const captureBusyRef = useRef(false);
  const loadRequestRef = useRef(0);
  // F#8：格式化 after-unmount 守卫——loadAll/retryDataset 在 await 后 setState。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { startMs, endMs, dateTitle } = useMemo(() => {
    if (!dayAnchor) {
      return { startMs: 0, endMs: 0, dateTitle: "" };
    }
    const start = new Date(dayAnchor);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      startMs: start.getTime(),
      endMs: end.getTime(),
      dateTitle: start.toLocaleDateString("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "long",
      }),
    };
  }, [dayAnchor]);

  const loadAll = useCallback(async (options: { preserve?: boolean } = {}) => {
    const preserve = options.preserve === true;
    const requestId = ++loadRequestRef.current;
    if (preserve) setRefreshing(true);
    else {
      setLoading(true);
      setRetryingKey("all");
    }
    const results = await Promise.allSettled([
      api.listNotes({ limit: 100 }),
      api.listCards({ limit: 100 }),
      api.listLearningCardsV2({ limit: 100 }),
      listAllReviews(),
      api.listJobs({ limit: 50 }),
      api.listSources({ limit: 100 }),
    ] as const);
    const nextErrors: Partial<Record<DataKey, string>> = {};
    const keys: DataKey[] = ["notes", "cards", "cards", "reviews", "jobs", "sources"];

    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === "rejected") nextErrors[key] = "暂时无法读取";
    });

    if (requestId !== loadRequestRef.current) return;
    if (!mountedRef.current) return;

    const [notesResult, cardsResult, v2CardsResult, reviewsResult, jobsResult, sourcesResult] = results;
    if (notesResult.status === "fulfilled") setNotes(notesResult.value.items);
    if (cardsResult.status === "fulfilled" || v2CardsResult.status === "fulfilled") {
      setCards(mergeLearningCardsV2(
        cardsResult.status === "fulfilled" ? cardsResult.value.items : [],
        v2CardsResult.status === "fulfilled" ? v2CardsResult.value.items : [],
      ));
    }
    if (reviewsResult.status === "fulfilled") setReviews(reviewsResult.value);
    if (jobsResult.status === "fulfilled") setJobs(jobsResult.value.items);
    if (sourcesResult.status === "fulfilled") setSources(sourcesResult.value.items);
    setErrors(nextErrors);
    if (preserve) setRefreshing(false);
    else {
      setLoading(false);
      setRetryingKey(null);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadAll]);

  useEffect(() => {
    setDayAnchor(new Date());
  }, []);

  useEffect(() => {
    if (!dayAnchor) return;
    const nextDay = new Date(dayAnchor);
    nextDay.setHours(24, 0, 0, 80);
    const delay = Math.max(1_000, nextDay.getTime() - Date.now());
    const timer = window.setTimeout(() => {
      setDayAnchor(new Date());
      void loadAll({ preserve: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [dayAnchor, loadAll]);

  // F#7（🟡14）：60s 间隔不再是无条件 setMinuteTick 整页重渲——仅当确有
  // 某个 pending review 在 [上次 tick, 本次 tick) 窗口内跨过到期阈值才 touch
  // state（到期判断下推：数据不变、无到期翻转的分钟不重渲整页）。
  const bumpMinuteTickIfDueCrossed = useCallback(() => {
    const currentReviews = reviewsRef.current ?? [];
    const now = Date.now();
    const prev = minuteTickPrevRef.current;
    const crossed = currentReviews.some((item) => {
      if (item.review.status !== "pending") return false;
      const due = new Date(item.review.nextReviewAt ?? item.review.createdAt).getTime();
      return due > prev && due <= now;
    });
    minuteTickPrevRef.current = now;
    if (crossed) setMinuteTick(now);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // F#4（round3）：页面切到后台（不可见）时跳过——后台无需更新到期文案。
      if (document.visibilityState === "hidden") return;
      bumpMinuteTickIfDueCrossed();
    }, 60_000);
    // F#4（round4 leftover）：恢复可见后立即同步 minuteTick，避免切回前台后
    // 要等下一次 60s interval 才刷新，最多滞后一分钟显示旧到期判断。
    const syncMinuteTickOnVisible = () => {
      if (document.visibilityState === "visible") bumpMinuteTickIfDueCrossed();
    };
    document.addEventListener("visibilitychange", syncMinuteTickOnVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncMinuteTickOnVisible);
    };
  }, [bumpMinuteTickIfDueCrossed]);

  const retryDataset = useCallback(async (key: DataKey) => {
    setRetryingKey(key);
    try {
      let notes: NoteHeader[] | null = null;
      let cards: CardListItem[] | null = null;
      let reviews: ReviewWithCard[] | null = null;
      let jobs: JobRow[] | null = null;
      let sources: SourceRow[] | null = null;
      // F23（round4）：先取数据（只写局部变量），所有 setState 都放到
      // mounted 守卫之后——避免卸载中途 setState。
      if (key === "notes") notes = (await api.listNotes({ limit: 100 })).items;
      if (key === "cards") {
        const [legacyResult, v2Result] = await Promise.all([
          api.listCards({ limit: 100 }),
          api.listLearningCardsV2({ limit: 100 }),
        ]);
        cards = mergeLearningCardsV2(legacyResult.items, v2Result.items);
      }
      if (key === "reviews") reviews = await listAllReviews();
      if (key === "jobs") jobs = (await api.listJobs({ limit: 50 })).items;
      if (key === "sources") sources = (await api.listSources({ limit: 100 })).items;
      if (!mountedRef.current) return;
      if (notes !== null) setNotes(notes);
      if (cards !== null) setCards(cards);
      if (reviews !== null) setReviews(reviews);
      if (jobs !== null) setJobs(jobs);
      if (sources !== null) setSources(sources);
      setErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch {
      if (!mountedRef.current) return;
      setErrors((current) => ({ ...current, [key]: "重试后仍无法读取" }));
    } finally {
      if (!mountedRef.current) return;
      setRetryingKey(null);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filter = params.get("type");
    const query = params.get("q")?.slice(0, 200) ?? "";
    if (isActivityFilter(filter)) setActiveFilter(filter);
    setSearchQuery(query);
    setRouteReady(true);
  }, []);

  useEffect(() => {
    if (!routeReady) return;
    const target = buildTodayReturnTarget(searchQuery, activeFilter);
    // Keep Next.js' private history payload intact so a record can return to
    // the exact filtered ledger without breaking client-side back/forward.
    window.history.replaceState(window.history.state, "", target);
  }, [activeFilter, routeReady, searchQuery]);

  const openCapture = useCallback((shouldScroll = true) => {
    if (!isOwner) return;
    shouldScrollToCaptureRef.current = shouldScroll;
    if (showCapture) {
      window.requestAnimationFrame(() => {
        if (shouldScroll) {
          captureSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        captureInputRef.current?.focus({ preventScroll: true });
        shouldScrollToCaptureRef.current = false;
      });
      return;
    }
    setShowCapture(true);
  }, [isOwner, showCapture]);

  useEffect(() => {
    const handleOpenCapture = () => openCapture(true);
    window.addEventListener("today:open-capture", handleOpenCapture);
    if (window.location.hash === "#quick-capture") openCapture(true);
    return () => window.removeEventListener("today:open-capture", handleOpenCapture);
  }, [openCapture]);

  useEffect(() => {
    if (!showCapture) return;
    const frame = window.requestAnimationFrame(() => {
      if (shouldScrollToCaptureRef.current) {
        captureSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      captureInputRef.current?.focus({ preventScroll: true });
      shouldScrollToCaptureRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showCapture]);

  const handleQuickCapture = useCallback(async () => {
    const text = captureText.trim();
    if (!isOwner || !text || captureBusyRef.current) return;
    captureBusyRef.current = true;
    setCaptureBusy(true);
    setCaptureMessage(null);
    try {
      const isUrl = /^https?:\/\//.test(text);
      const result = await api.createSource({
        content: isUrl ? undefined : text,
        url: isUrl ? text : undefined,
      });
      setSources((current) => [
        result.source,
        ...(current ?? []).filter((item) => item.id !== result.source.id),
      ]);
      setCaptureText("");
      setCaptureMessage({
        tone: "success",
        text: "资料已写入今日轨迹，后台会继续处理。",
        sourceId: result.source.id,
      });
    } catch {
      setCaptureMessage({
        tone: "error",
        text: "收录没有完成，输入内容已为你保留，请稍后重试。",
      });
    } finally {
      captureBusyRef.current = false;
      setCaptureBusy(false);
      window.requestAnimationFrame(() => captureInputRef.current?.focus());
    }
  }, [captureText, isOwner]);

  const activities = useMemo<TodayActivity[]>(() => {
    const rows: TodayActivity[] = [];

    for (const note of notes ?? []) {
      const createdToday = isWithinDay(note.createdAt, startMs, endMs);
      const updatedToday = isWithinDay(note.updatedAt, startMs, endMs);
      if (!createdToday && !updatedToday) continue;
      rows.push({
        id: `note:${note.id}:${createdToday ? note.createdAt : note.updatedAt}`,
        objectId: note.id,
        type: "note",
        group: "recorded",
        time: createdToday ? note.createdAt : note.updatedAt,
        typeLabel: "笔记",
        title: note.title || "无标题笔记",
        description: createdToday ? "新笔记已写入当前工作区" : "今天更新了这篇笔记",
        statusLabel: createdToday ? "新建" : "已更新",
        statusTone: "evidence",
        href: `/notes/${note.id}`,
        actionLabel: "打开笔记",
      });
    }

    for (const card of cards ?? []) {
      if (!isWithinDay(card.createdAt, startMs, endMs)) continue;
      rows.push({
        id: `card:${card.id}:${card.createdAt}`,
        objectId: card.id,
        type: "card",
        group: "recorded",
        time: card.createdAt,
        typeLabel: "学习卡",
        title: card.schemaJson?.title || "未命名学习卡",
        description: card.schemaJson?.summary || "从笔记生成了一张新的学习卡",
        statusLabel: "已生成",
        statusTone: "success",
        href: learningCardHref(card),
        actionLabel: "查看卡片",
      });
    }

    for (const source of sources ?? []) {
      if (!isWithinDay(source.createdAt, startMs, endMs)) continue;
      const presentation = statusMap.sourceStatus(source.status);
      const group: ActivityGroup =
        source.status === "failed"
          ? "attention"
          : source.status === "processing" || source.status === "draft"
            ? "running"
            : "recorded";
      rows.push({
        id: `source:${source.id}:${source.createdAt}`,
        objectId: source.id,
        type: "source",
        group,
        time: source.createdAt,
        typeLabel: "来源资料",
        title: source.title || "未命名来源",
        description: `${sourceTypeLabel(source.type)}资料已加入当前工作区`,
        statusLabel: presentation.label,
        statusTone: presentation.tone,
        href: `/sources/${source.id}`,
        actionLabel: "查看来源",
      });
    }

    for (const review of reviews ?? []) {
      const reviewedToday = isWithinDay(review.review.lastReviewAt, startMs, endMs);
      if (!reviewedToday) continue;
      const presentation = statusMap.reviewStatus(review.review.status);
      rows.push({
        id: `review:${review.review.id}:${review.review.lastReviewAt}`,
        objectId: review.review.id,
        type: "review",
        group: "recorded",
        time: review.review.lastReviewAt ?? review.review.createdAt,
        typeLabel: "复习",
        title: review.card.title,
        description: "复习记录今天有更新",
        statusLabel: presentation.label,
        statusTone: presentation.tone,
        href: review.isV2 ? `/learning-cards/${review.card.id}` : `/cards/${review.card.id}`,
        actionLabel: "查看卡片",
      });
    }

    for (const job of jobs ?? []) {
      const time = jobEventTime(job);
      if (!isWithinDay(time, startMs, endMs)) continue;
      const presentation = statusMap.jobStatus(job.status);
      const needsAIConsent = job.failureReason === "ai_consent_required";
      const group: ActivityGroup =
        job.status === "failed" || job.status === "dead"
          ? "attention"
          : job.status === "pending" || job.status === "running"
            ? "running"
            : "recorded";
      rows.push({
        id: `job:${job.id}:${time}`,
        objectId: job.id,
        type: "job",
        group,
        time,
        typeLabel: "自动任务",
        title: jobLabel(job.type),
        description: needsAIConsent
          ? "当前工作区尚未签署 AI 使用协议，任务已安全停止。签署后可回到原内容重试。"
          : jobDescription(job.status),
        statusLabel: presentation.label,
        statusTone: presentation.tone,
        href: needsAIConsent ? "/settings#model" : undefined,
        actionLabel: needsAIConsent ? "签署 AI 使用协议" : undefined,
      });
    }

    const groupPriority: Record<ActivityGroup, number> = {
      attention: 0,
      running: 1,
      recorded: 2,
    };
    // 预计算每行的时间戳与组优先级一次，避免 comparator 在 O(n log n) 内对
    // 每对比较重复 new Date(b.time) 解析。
    const keyed = rows.map((row) => ({
      row,
      timeMs: new Date(row.time).getTime(),
      groupPriority: groupPriority[row.group],
    }));
    return keyed
      .sort(
        (a, b) =>
          a.groupPriority - b.groupPriority ||
          b.timeMs - a.timeMs,
      )
      .map((entry) => entry.row);
  }, [cards, endMs, jobs, notes, reviews, sources, startMs]);

  const dueReviews = useMemo(
    () =>
      (reviews ?? []).filter(
        (item) =>
          item.review.status === "pending" &&
          new Date(item.review.nextReviewAt ?? item.review.createdAt).getTime() <= minuteTick,
      ),
    [minuteTick, reviews],
  );

  const filterCounts = useMemo(() => {
    const counts: Record<ActivityFilter, number> = {
      all: activities.length,
      note: 0,
      card: 0,
      source: 0,
      review: 0,
      job: 0,
    };
    activities.forEach((activity) => {
      counts[activity.type] += 1;
    });
    return counts;
  }, [activities]);

  const todayReturnTarget = useMemo(
    () => buildTodayReturnTarget(searchQuery, activeFilter),
    [activeFilter, searchQuery],
  );

  const filteredActivities = useMemo(() => {
    const term = searchQuery.trim().toLocaleLowerCase("zh-CN");
    return activities.filter((activity) => {
      if (activeFilter !== "all" && activity.type !== activeFilter) return false;
      if (!term) return true;
      return [activity.title, activity.description, activity.typeLabel, activity.statusLabel]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("zh-CN").includes(term));
    });
  }, [activeFilter, activities, searchQuery]);

  const displayActivities = useMemo(() => {
    if (activeFilter !== "all" || searchQuery.trim()) return filteredActivities;

    const jobsByContext = new Map<string, TodayActivity[]>();
    for (const activity of filteredActivities) {
      if (activity.type !== "job") continue;
      const key = `${activity.group}:${activity.title}`;
      const items = jobsByContext.get(key) ?? [];
      items.push(activity);
      jobsByContext.set(key, items);
    }

    const emittedJobContexts = new Set<string>();
    return filteredActivities.flatMap((activity) => {
      if (activity.type !== "job") return [activity];
      const key = `${activity.group}:${activity.title}`;
      const similar = jobsByContext.get(key) ?? [activity];
      if (similar.length < 2) return [activity];
      if (emittedJobContexts.has(key)) return [];
      emittedJobContexts.add(key);
      const latest = similar[0];
      const aggregateState =
        activity.group === "attention"
          ? "未完成"
          : activity.group === "running"
            ? "仍在处理"
            : "已完成";
      return [{
        ...latest,
        id: `job-summary:${activity.group}:${latest.title}:${latest.time}`,
        typeLabel: "自动任务汇总",
        title: `${latest.title} · ${similar.length} 次`,
        description: `今天有 ${similar.length} 个同类后台任务${aggregateState}；切换“自动任务”可查看逐条记录。`,
        aggregateCount: similar.length,
      }];
    });
  }, [activeFilter, filteredActivities, searchQuery]);

  useEffect(() => {
    setVisibleCount(20);
  }, [activeFilter, searchQuery]);

  const visibleActivities = displayActivities.slice(0, visibleCount);
  const groupedActivities = useMemo(
    () =>
      (["attention", "running", "recorded"] as ActivityGroup[])
        .map((group) => ({
          group,
          items: visibleActivities.filter((activity) => activity.group === group),
        }))
        .filter((section) => section.items.length > 0),
    [visibleActivities],
  );

  const rawGroupCounts = useMemo(() => {
    const counts: Record<ActivityGroup, number> = {
      attention: 0,
      running: 0,
      recorded: 0,
    };
    filteredActivities.forEach((activity) => {
      counts[activity.group] += 1;
    });
    return counts;
  }, [filteredActivities]);

  const displayGroupCounts = useMemo(() => {
    const counts: Record<ActivityGroup, number> = {
      attention: 0,
      running: 0,
      recorded: 0,
    };
    displayActivities.forEach((activity) => {
      counts[activity.group] += 1;
    });
    return counts;
  }, [displayActivities]);

  const unavailableData: Record<DataKey, boolean> = {
    notes: Boolean(errors.notes && notes === null),
    cards: Boolean(errors.cards && cards === null),
    reviews: Boolean(errors.reviews && reviews === null),
    jobs: Boolean(errors.jobs && jobs === null),
    sources: Boolean(errors.sources && sources === null),
  };

  const isFilterUnavailable = (filter: ActivityFilter) => {
    const key = FILTER_DATA_KEY[filter];
    return key ? unavailableData[key] : false;
  };

  const handleOverviewFilter = useCallback((filter: ActivityFilter) => {
    setSearchQuery("");
    setActiveFilter(filter);
    window.requestAnimationFrame(() => {
      document.getElementById("today-ledger")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);

  const runningActivities = activities.filter((item) => item.group === "running");
  const runningContext = runningActivities.slice(0, 3);
  const practiceCard = (cards ?? [])[0] ?? null;
  const errorKeys = Object.keys(errors) as DataKey[];
  const allFailed = errorKeys.length === 5 && Object.values(unavailableData).every(Boolean);
  const hasStaleDataErrors = errorKeys.some((key) => !unavailableData[key]);
  const activeUnavailableKey =
    activeFilter === "all" ? null : (FILTER_DATA_KEY[activeFilter] ?? null);
  const activeFilterUnavailable = activeUnavailableKey
    ? unavailableData[activeUnavailableKey]
    : false;
  const attentionDataUnavailable =
    unavailableData.reviews || unavailableData.jobs || unavailableData.sources;
  const attentionContextCount =
    new Set(
      activities
        .filter((item) => item.group === "attention" && item.type !== "review")
        .map((item) => (item.type === "job" ? `job:${item.title}` : `${item.type}:${item.objectId}`)),
    ).size + dueReviews.length;

  return (
    <div className="today-page">
      <PageHeader
        className="workspace-page-header"
        title="今日变化"
        kicker="学习动态"
        subtitle="把当前工作区今天发生的学习动作，整理成一条可回看的真实轨迹。"
        actions={
          <div className="today-header-actions">
            {isOwner && (
              <button
                className="today-header-capture"
                type="button"
                onClick={() => (showCapture ? setShowCapture(false) : openCapture(false))}
                aria-expanded={showCapture}
                aria-controls="quick-capture"
              >
                {showCapture ? <Icon.Close /> : <Icon.Plus />}
                <span>{showCapture ? "收起录入台" : "快速收录"}</span>
              </button>
            )}
            <ThemeToggle className="today-theme-toggle" />
          </div>
        }
      />

      {showCapture && isOwner && (
        <section
          id="quick-capture"
          ref={captureSectionRef}
          className="today-capture-wrap"
          aria-labelledby="today-capture-title"
        >
          <div className="today-capture-paper">
            <div className="today-capture-heading">
              <span className="today-capture-icon" aria-hidden="true">
                <Icon.Inbox />
              </span>
              <div>
                <span className="today-capture-eyebrow">添加学习材料</span>
                <h2 id="today-capture-title">快速收录一份资料</h2>
                <p>粘贴文本、Markdown、代码或网址；系统会判断类型并加入今日轨迹。</p>
              </div>
            </div>
            <label className="sr-only" htmlFor="today-capture-input">
              待收录的资料内容
            </label>
            <textarea
              id="today-capture-input"
              ref={captureInputRef}
              className="today-capture-input"
              value={captureText}
              onChange={(event) => {
                setCaptureText(event.target.value);
                if (captureMessage) setCaptureMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void handleQuickCapture();
                }
              }}
              placeholder="从这里开始粘贴，Enter 正常换行…"
              rows={4}
              disabled={captureBusy}
            />
            <div className="today-capture-footer">
              <div className="today-capture-detection" aria-live="polite">
                <Icon.Sparkle />
                <span>
                  {captureText.trim()
                    ? /^https?:\/\//.test(captureText.trim())
                      ? "识别为网页链接资料"
                      : "系统会自动识别资料类型"
                    : "输入后自动识别资料类型"}
                </span>
                <span aria-hidden="true">·</span>
                <span>⌘ / Ctrl + Enter 提交</span>
              </div>
              <button
                className="today-primary-button"
                onClick={() => void handleQuickCapture()}
                disabled={captureBusy || !captureText.trim()}
                type="button"
              >
                {captureBusy ? <Icon.Refresh className="today-spin" /> : <Icon.Plus />}
                {captureBusy ? "正在收录" : "加入今日轨迹"}
              </button>
            </div>
            {captureMessage && (
              <div
                className={`today-capture-message is-${captureMessage.tone}`}
                role={captureMessage.tone === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {captureMessage.tone === "success" ? <Icon.Check /> : <Icon.Warn />}
                <span>{captureMessage.text}</span>
                {captureMessage.sourceId && (
                  <Link
                    href={
                      withTodayReturnTarget(
                        `/sources/${captureMessage.sourceId}`,
                        todayReturnTarget,
                      ) ?? `/sources/${captureMessage.sourceId}`
                    }
                  >
                    打开来源
                  </Link>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <div className="today-content" aria-busy={loading || refreshing}>
        {errorKeys.length > 0 && !loading && (
          <section className="today-data-alert" aria-labelledby="today-data-alert-title">
            <Icon.Warn aria-hidden="true" />
            <div className="today-data-alert-copy">
              <strong id="today-data-alert-title">
                {allFailed
                  ? "今日记录暂时无法读取"
                  : hasStaleDataErrors
                    ? "部分数据未能刷新"
                    : "部分轨迹暂时没有加载"}
              </strong>
              <p>
                {allFailed
                  ? "服务可能正在恢复，稍后重试不会影响已有内容。"
                  : hasStaleDataErrors
                    ? "页面继续保留上次已加载内容，你可以单独重试失败模块。"
                    : "已加载内容仍可使用；下列模块不会被误算为 0。"}
              </p>
              <div className="today-data-alert-actions">
                {errorKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void retryDataset(key)}
                    disabled={retryingKey !== null || refreshing}
                  >
                    {retryingKey === key ? "重试中…" : `重试${DATA_LABELS[key]}`}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="today-overview" aria-labelledby="today-overview-title">
          <div className="today-overview-copy">
            <span className="today-overview-eyebrow">当前工作区</span>
            <p className="today-overview-date">{dateTitle || "正在读取本地日期"}</p>
            <h2 id="today-overview-title">
              {loading ? (
                <span className="today-overview-loading" role="img" aria-label="正在整理今日轨迹" />
              ) : allFailed ? (
                "今日账本暂时未能打开"
              ) : activities.length > 0 ? (
                <>
                  今天{errorKeys.length > 0 ? "已加载" : "留下了"} <em>{activities.length}</em> 条学习痕迹
                </>
              ) : errorKeys.length > 0 ? (
                "已加载部分暂无今日变化"
              ) : (
                "今天的账本还很安静"
              )}
            </h2>
            <p className="today-overview-description">
              基于当前已加载对象整理；只展示可追溯记录，不把推测当作历史。
            </p>
          </div>

          <div
            className={`today-overview-score ${attentionDataUnavailable ? "is-unknown" : attentionContextCount > 0 ? "is-attention" : "is-clear"}`}
            role="img"
            aria-label={
              loading
                ? "正在加载"
                : attentionDataUnavailable
                  ? "待确认数据未完整加载"
                : attentionContextCount > 0
                  ? `${attentionContextCount} 项待确认`
                  : "当前没有待确认项"
            }
          >
            <span>{loading || attentionDataUnavailable ? "—" : attentionContextCount}</span>
            <small>
              {attentionDataUnavailable
                ? "待确认未加载"
                : attentionContextCount > 0
                  ? "待你确认"
                  : "当前顺畅"}
            </small>
          </div>

          <div className="today-overview-metrics" role="group" aria-label="今日变化摘要">
            <button
              type="button"
              className={activeFilter === "note" ? "is-active" : undefined}
              onClick={() => handleOverviewFilter("note")}
              aria-pressed={activeFilter === "note"}
            >
              <span>笔记变化</span>
              <strong>{loading || isFilterUnavailable("note") ? "—" : filterCounts.note}</strong>
              <small>新建与更新</small>
            </button>
            <button
              type="button"
              className={activeFilter === "card" ? "is-active" : undefined}
              onClick={() => handleOverviewFilter("card")}
              aria-pressed={activeFilter === "card"}
            >
              <span>学习卡</span>
              <strong>{loading || isFilterUnavailable("card") ? "—" : filterCounts.card}</strong>
              <small>今日新生成</small>
            </button>
            <button
              type="button"
              className={activeFilter === "source" ? "is-active" : undefined}
              onClick={() => handleOverviewFilter("source")}
              aria-pressed={activeFilter === "source"}
            >
              <span>资料流入</span>
              <strong>{loading || isFilterUnavailable("source") ? "—" : filterCounts.source}</strong>
              <small>可追溯来源</small>
            </button>
            <button
              type="button"
              className={activeFilter === "job" ? "is-active" : undefined}
              onClick={() => handleOverviewFilter("job")}
              aria-pressed={activeFilter === "job"}
            >
              <span>自动处理</span>
              <strong>{loading || isFilterUnavailable("job") ? "—" : filterCounts.job}</strong>
              <small>后台任务</small>
            </button>
          </div>
        </section>

        <section id="today-ledger" className="today-ledger-toolbar" aria-labelledby="today-ledger-title">
          <div className="today-ledger-title-wrap">
            <span>今日学习记录</span>
            <h2 id="today-ledger-title">今日账本</h2>
            <small aria-live="polite">
              {loading
                ? "正在整理…"
                : allFailed
                  ? "等待重新加载"
                : `${errorKeys.length > 0 ? "已加载 " : ""}${filteredActivities.length} 条匹配记录`}
            </small>
          </div>
          <div className="today-filter-scroller" role="group" aria-label="按记录类型筛选">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={activeFilter === filter.value ? "is-active" : undefined}
                onClick={() => setActiveFilter(filter.value)}
                aria-pressed={activeFilter === filter.value}
              >
                <span>{filter.label}</span>
                <small>
                  {loading
                    ? "·"
                    : filter.value === "all" && allFailed
                      ? "—"
                    : isFilterUnavailable(filter.value)
                      ? "—"
                      : filterCounts[filter.value]}
                </small>
              </button>
            ))}
          </div>
          <div className="today-ledger-tools">
            <form className="today-search" role="search" onSubmit={(event) => event.preventDefault()}>
              <label className="sr-only" htmlFor="today-search-input">搜索今日记录</label>
              <Icon.Search aria-hidden="true" />
              <input
                id="today-search-input"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value.slice(0, 200))}
                placeholder="搜索今日记录"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery("")} aria-label="清空搜索">
                  <Icon.Close />
                </button>
              )}
            </form>
            <button
              type="button"
              className="today-refresh-button"
              onClick={() => void loadAll({ preserve: true })}
              disabled={loading || refreshing || retryingKey !== null}
              aria-label={refreshing ? "正在刷新今日记录" : "刷新今日记录"}
              title={refreshing ? "正在刷新" : "刷新今日记录"}
            >
              <Icon.Refresh className={refreshing ? "today-spin" : undefined} />
            </button>
          </div>
        </section>

        <div className={`today-ledger-layout ${dueReviews.length > 0 || runningContext.length > 0 ? "has-context" : ""}`}>
          <section className="today-ledger-paper" aria-label="今日活动轨迹">
            {loading ? (
              <div className="today-ledger-loading" role="img" aria-label="正在加载今日活动">
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="today-ledger-skeleton-row">
                    <span />
                    <i />
                    <div><b /><small /></div>
                  </div>
                ))}
              </div>
            ) : allFailed ? (
              <div className="today-empty-ledger">
                <span className="today-empty-icon"><Icon.Refresh /></span>
                <h3>暂时没能取回今日账本</h3>
                <p>这不是零记录；当前数据状态未知。</p>
                <button type="button" onClick={() => void loadAll()} disabled={retryingKey !== null}>
                  {retryingKey === "all" ? "重新加载中…" : "重新加载今日记录"}
                </button>
              </div>
            ) : groupedActivities.length === 0 ? (
              <div className="today-empty-ledger">
                <span className="today-empty-icon">
                  {activeFilterUnavailable ? <Icon.Refresh /> : <Icon.Sparkle />}
                </span>
                <h3>
                  {activeFilterUnavailable && activeUnavailableKey
                    ? `${DATA_LABELS[activeUnavailableKey]}暂时未加载`
                    : searchQuery || activeFilter !== "all"
                      ? "没有匹配的今日记录"
                      : "今天还没有可追溯变化"}
                </h3>
                <p>
                  {activeFilterUnavailable
                    ? "这不是零记录；当前数据状态未知，可以单独重试这个模块。"
                    : searchQuery || activeFilter !== "all"
                    ? "换一个关键词或清除筛选，再看看完整账本。"
                    : errorKeys.length > 0
                      ? "已加载的部分暂时没有今日记录。"
                      : "收录一份资料或写下笔记，第一条轨迹就会出现在这里。"}
                </p>
                {activeFilterUnavailable && activeUnavailableKey ? (
                  <button
                    type="button"
                    onClick={() => void retryDataset(activeUnavailableKey)}
                    disabled={retryingKey !== null || refreshing}
                  >
                    {retryingKey === activeUnavailableKey
                      ? "重试中…"
                      : `重试${DATA_LABELS[activeUnavailableKey]}`}
                  </button>
                ) : searchQuery || activeFilter !== "all" ? (
                  <button type="button" onClick={() => { setSearchQuery(""); setActiveFilter("all"); }}>
                    清除筛选
                  </button>
                ) : isOwner ? (
                  <button type="button" onClick={() => openCapture(true)}>快速收录</button>
                ) : (
                  <Link href="/notes">查看工作区笔记</Link>
                )}
              </div>
            ) : (
              <>
                {groupedActivities.map(({ group, items }) => {
                  const meta = GROUP_META[group];
                  return (
                    <section key={group} className={`today-activity-group is-${group}`} aria-labelledby={`today-group-${group}`}>
                      <header className="today-group-header">
                        <div>
                          <span>{meta.eyebrow}</span>
                          <h3 id={`today-group-${group}`}>{meta.title}</h3>
                        </div>
                        <p>{meta.description}</p>
                        <small>
                          {rawGroupCounts[group]} 条
                          {rawGroupCounts[group] > displayGroupCounts[group] ? " · 已归并" : ""}
                        </small>
                      </header>
                      <ol className="today-activity-list">
                        {items.map((activity) => (
                          <li
                            key={activity.id}
                            id={`today-activity-${activity.type}-${activity.objectId}`}
                            className={`today-activity is-${activity.type}${activity.aggregateCount ? " is-aggregate" : ""}`}
                          >
                            <time dateTime={activity.time} title={fullTime(activity.time)}>
                              <strong>{activityClock(activity.time)}</strong>
                              <span>{relativeTime(activity.time)}</span>
                            </time>
                            <span className="today-activity-node" aria-hidden="true">
                              <ActivityIcon type={activity.type} />
                              {activity.aggregateCount && (
                                <b className="today-activity-node-count">{activity.aggregateCount}</b>
                              )}
                            </span>
                            <div className="today-activity-copy">
                              <div className="today-activity-meta">
                                <span>{activity.typeLabel}</span>
                                {activity.statusLabel && activity.statusTone && (
                                  <StatusChip tone={activity.statusTone} size="sm">
                                    {activity.statusLabel}
                                  </StatusChip>
                                )}
                              </div>
                              <h4>{activity.title}</h4>
                              <p>{activity.description}</p>
                            </div>
                            {activity.href && (
                              <Link
                                href={
                                  withTodayReturnTarget(activity.href, todayReturnTarget) ??
                                  activity.href
                                }
                                className="today-activity-action"
                              >
                                <span>{activity.actionLabel ?? "打开"}</span>
                                <Icon.Arrow />
                              </Link>
                            )}
                          </li>
                        ))}
                      </ol>
                    </section>
                  );
                })}
                {displayActivities.length > visibleCount && (
                  <button
                    type="button"
                    className="today-load-more"
                    onClick={() => setVisibleCount((count) => count + 20)}
                  >
                    再显示 {Math.min(20, displayActivities.length - visibleCount)} 条记录
                    <Icon.Chevron />
                  </button>
                )}
                {displayActivities.length > 20 && visibleCount >= displayActivities.length && (
                  <button type="button" className="today-load-more" onClick={() => setVisibleCount(20)}>
                    收起到最近 20 条
                  </button>
                )}
              </>
            )}
          </section>

          {!loading && dueReviews.length > 0 && (
            <aside className="today-context-panel" aria-labelledby="today-context-title">
              <div className="today-context-heading">
                <span className="today-context-icon"><Icon.Review /></span>
                <div>
                  <span>{LEARNING_RUN_UI_PREVIEW ? "3-MINUTE RUN" : "NEXT MOVE"}</span>
                  <h2 id="today-context-title">
                    {LEARNING_RUN_UI_PREVIEW ? "下一次微旅程" : "当前到期复习"}
                  </h2>
                </div>
                <strong>{dueReviews.length}</strong>
              </div>
              <p className="today-context-intro">
                {LEARNING_RUN_UI_PREVIEW
                  ? "先完成一个到期要点。进入后直接开始推荐动作，不要求先选模式。"
                  : "这是此刻最值得处理的学习上下文。先从最早到期的一项开始。"}
              </p>
              {LEARNING_RUN_UI_PREVIEW && (
                <div className="today-context-facts" aria-label="微旅程 UI 预览说明">
                  <span>约 1–3 分钟</span>
                  <span>可说 / 可操作 / 可写</span>
                  <span>可信评估后才改排程</span>
                </div>
              )}
              <ol className="today-context-list">
                {dueReviews.slice(0, 3).map((item, index) => (
                  <li key={item.review.id}>
                    <span>复习任务 {String(index + 1).padStart(2, "0")}</span>
                    <small>
                      {statusMap.reviewReason(item.reviewReason).label} · 当前间隔 {item.review.intervalDays} 天
                    </small>
                  </li>
                ))}
              </ol>
              <Link
                href={
                  learningRunUiPreviewHref({
                    origin: "today",
                    scheduleId: dueReviews[0].review.id,
                    cardId: dueReviews[0].card.id,
                    keyPointId: dueReviews[0].keyPoint?.id,
                    isV2: dueReviews[0].isV2,
                  }) ?? `/review/${encodeURIComponent(dueReviews[0].review.id)}`
                }
                className="today-context-action"
              >
                {LEARNING_RUN_UI_PREVIEW ? "预览这次微旅程" : "开始今日复习"}
                <Icon.Arrow />
              </Link>
            </aside>
          )}

          {!loading && dueReviews.length === 0 && runningContext.length > 0 && (
            <aside className="today-context-panel is-running" aria-labelledby="today-context-title">
              <div className="today-context-heading">
                <span className="today-context-icon"><Icon.Refresh /></span>
                <div>
                  <span>LIVE CONTEXT</span>
                  <h2 id="today-context-title">仍在处理</h2>
                </div>
                <strong>{runningActivities.length}</strong>
              </div>
              <p className="today-context-intro">这些项目尚未形成最终结果，不需要重复提交。</p>
              <ol className="today-context-list">
                {runningContext.map((item) => (
                  <li key={item.id}>
                    <span>{item.title}</span>
                    <small>{item.description}</small>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="today-context-action"
                onClick={() => void loadAll({ preserve: true })}
                disabled={retryingKey !== null || refreshing}
              >
                {refreshing ? "刷新中…" : "刷新处理状态"}
                <Icon.Refresh />
              </button>
            </aside>
          )}

          {!loading && dueReviews.length === 0 && runningContext.length === 0 && practiceCard && (
            <aside className="today-context-panel is-practice" aria-labelledby="today-practice-title">
              <div className="today-context-heading">
                <span className="today-context-icon"><Icon.Target /></span>
                <div>
                  <span>OPTIONAL PRACTICE</span>
                  <h2 id="today-practice-title">巩固一个要点</h2>
                </div>
              </div>
              <p className="today-context-intro">
                {LEARNING_RUN_UI_PREVIEW
                  ? "今天没有到期复习。你可以从最近的学习卡预览一轮短练习，也可以先离开。"
                  : "今天没有到期复习。可以回到最近的学习卡继续巩固，也可以先离开。"}
              </p>
              <div className="today-context-card-name">
                <span>最近的学习卡</span>
                <strong>{practiceCard.schemaJson?.title || "未命名学习卡"}</strong>
              </div>
              {LEARNING_RUN_UI_PREVIEW && (
                <div className="today-context-facts" aria-label="巩固练习 UI 预览说明">
                  <span>不自动下一题</span>
                  <span>随时换方式</span>
                </div>
              )}
              <Link
                href={
                  learningRunUiPreviewHref({
                    origin: practiceCard.isV2 ? "today_v2" : "today",
                    cardId: practiceCard.id,
                    keyPointId: practiceCard.isV2 ? practiceCard.objectiveId ?? null : null,
                    isV2: practiceCard.isV2,
                  }) ?? learningCardHref(practiceCard)
                }
                className="today-context-action"
              >
                {LEARNING_RUN_UI_PREVIEW ? "预览短练习" : "去学习卡继续"}
                <Icon.Arrow />
              </Link>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
