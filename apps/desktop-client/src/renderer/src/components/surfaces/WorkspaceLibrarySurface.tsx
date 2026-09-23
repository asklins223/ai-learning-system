import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CircleAlert,
  Clock3,
  FileText,
  Flag,
  FolderOpen,
  History,
  Layers3,
  Leaf,
  LoaderCircle,
  Map as MapIcon,
  RefreshCw,
  Route,
  Search,
  Target,
  X,
} from "lucide-react";
import type {
  CapabilityProjectionV1,
  SessionContextV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type {
  DesktopNoteListItem,
  DesktopNoteListPage,
} from "@ailearn/shared/desktop-surface-contracts";
import type {
  LearningObjectivePrimaryActionV3,
  LearningObjectiveSurfaceV3,
  ObjectiveListItemV3,
  ObjectiveListPageV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { SurfaceReturnControl } from "./SurfaceReturnControl";
import { learningRunPhaseLabels } from "./learning-run-surface";
import { startObjectiveJourney } from "./objective-primary-action";
import { ObjectiveProgressBand } from "./ObjectiveProgressBand";
import { progressSegmentForState } from "./objective-progress-band";
import {
  formatObjectiveDateTime,
  formatObjectiveState,
  objectiveStateHint,
  objectiveStateNeedsAttention,
  objectiveStateTone,
  objectiveProgressChips,
  primaryActionDescription,
  primaryActionLabel,
} from "./objective-state-copy";
import {
  readObjectiveLibraryView,
  retargetObjectiveLibraryView,
  writeObjectiveLibraryView,
  type ObjectiveLibraryFilter,
} from "./objective-library-view-state";
import { useHudPage } from "../hud/use-hud-page";
import {
  objectiveQuestRegion,
  orderObjectivesForQuest,
  runModePresentation,
  type ObjectiveQuestRegion,
} from "./objective-quest-presentation";

type SurfaceHeaderProps = {
  // 页面家族眉标：与 .impeccable/review/desktop-pages-v2/REVIEW.md 的家族列一致。
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly headingId?: string;
};

function SurfaceHeader({ eyebrow, title, detail, headingId }: SurfaceHeaderProps) {
  // 样式在 components/approved-surfaces.css：__heading 是左上角标题块，
  // __return 是独立的左下角返回控件（两者都自己绝对定位）。
  return (
    <>
      <header className="approved-surface__heading task-artifact task-artifact--header">
        <span className="approved-surface__eyebrow">{eyebrow}</span>
        <h2 id={headingId}>{title}</h2>
        <p>{detail}</p>
      </header>
      <SurfaceReturnControl className="approved-surface__return" />
    </>
  );
}

export function ApprovedSurfaceFrame({
  family,
  eyebrow,
  title,
  detail,
  headingId,
  children,
}: {
  readonly family: "library" | "writing" | "workshop" | "observatory" | "system";
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly headingId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={`approved-surface approved-surface--${family} task-artifact`} aria-labelledby={headingId}>
      <SurfaceHeader eyebrow={eyebrow} headingId={headingId} title={title} detail={detail} />
      <div className="approved-surface__content">{children}</div>
    </section>
  );
}

function SurfaceDataState({
  kind,
  message,
  detail,
  onRetry,
}: {
  readonly kind: "loading" | "error" | "empty";
  readonly message: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className={`approved-state approved-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" ? <LoaderCircle size={24} aria-hidden="true" /> : null}
      {kind === "error" ? <CircleAlert size={24} aria-hidden="true" /> : null}
      {kind === "empty" ? <FolderOpen size={24} aria-hidden="true" /> : null}
      <strong>{message}</strong>
      <p>{detail}</p>
      {kind === "error" && onRetry ? <button type="button" className="surface-primary" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重新读取</button> : null}
    </div>
  );
}

// 按行调的 formatter 提到模块作用域建一次（同 surface-data，0269 轮 M23）。
const LIBRARY_MONTH_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

function formatDate(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return LIBRARY_MONTH_DAY_FORMAT.format(parsed);
}

function formatKnowledgeForm(value: ObjectiveListItemV3["knowledgeForm"]): string {
  return {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[value] ?? value;
}

function formatLifecycle(value: LearningObjectiveSurfaceV3["content"]["lifecycle"]): string {
  return {
    active: "正在推进",
    archived: "已归档",
    superseded: "已有后继版本",
    blocked_content_upgrade: "等待内容更新",
  }[value];
}

function formatFreshness(value: LearningObjectiveSurfaceV3["content"]["freshness"]): string {
  return {
    fresh: "来源内容最新",
    source_outdated: "来源已有更新",
    legacy_unreviewed: "旧来源待复核",
  }[value];
}

function formatOriginKind(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["kind"]): string {
  return { note: "笔记", manual: "手动建立", imported: "导入记录" }[value];
}

function formatOriginIntegrity(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["integrity"]): string {
  return value === "verified" ? "链路已核对" : "旧链路待复核";
}

function formatSupportGrade(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["supportGrade"]): string {
  return value === "primary" ? "主要依据" : "补充依据";
}

function isActionable(action: LearningObjectivePrimaryActionV3): boolean {
  return action.kind === "create_run"
    || action.kind === "resume_run"
    || action.kind === "create_review_run"
    || action.kind === "practice_only"
    || action.kind === "view_successor"
    || action.kind === "refresh";
}

async function readAuthenticatedSession(epochRef: React.MutableRefObject<number | undefined>): Promise<SessionContextV1> {
  if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实工作区数据。");
  const response = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
  if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
  const session = unwrapGatewayResult(response);
  if (session.status !== "authenticated" || !session.workspace) {
    throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
  }
  return session;
}

/**
 * 概览数字和筛选按钮共用这一张表。此前同一组桶在两处各写一遍字面量，
 * 「待处理 / 推进中 / 已稳定」到底是按什么口径数的，只有读代码的人知道
 * （2026-09-20 实走复盘 #9、#14）。
 */
const PERSONAL_BUCKETS = [
  { key: "attention", label: "要处理", hint: "还没正式答过、答错了、到复习时间，或原文已经更新的" },
  { key: "progress", label: "进行中", hint: "这一轮还没答完，或复习时间已经排好的" },
  { key: "stable", label: "答对过", hint: "至少有一次正式作答达到标准的" },
] as const satisfies ReadonlyArray<{ key: Exclude<ObjectiveLibraryFilter, "all">; label: string; hint: string }>;

const FILTER_BUCKETS = [
  { key: "all", label: "全部", hint: "这个工作区里全部的理解目标" },
  ...PERSONAL_BUCKETS,
] as const satisfies ReadonlyArray<{ key: ObjectiveLibraryFilter; label: string; hint: string }>;

const QUEST_REGIONS = [
  { key: "ready", label: "待挑战", detail: "需要验证、复习或修补", icon: Flag },
  { key: "active", label: "远征中", detail: "正在作答或等待复习", icon: Route },
  { key: "mastered", label: "已掌握", detail: "已有正式证据支撑", icon: Leaf },
] as const satisfies ReadonlyArray<{
  key: ObjectiveQuestRegion;
  label: string;
  detail: string;
  icon: typeof Flag;
}>;

export function ObjectiveLibrarySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const epochRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLUListElement>(null);
  const indexToggleRef = useRef<HTMLButtonElement>(null);
  const loadedCursorsRef = useRef(new Set<string>());
  const [page, setPage] = useState<ObjectiveListPageV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [startingFocus, setStartingFocus] = useState(false);
  const [focusFailure, setFocusFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pageFailure, setPageFailure] = useState<string | null>(null);
  const [primaryFocusId, setPrimaryFocusId] = useState<string | null>(null);
  const [queuePriorityIds, setQueuePriorityIds] = useState<string[]>([]);
  const [compactRegion, setCompactRegion] = useState<ObjectiveQuestRegion>("ready");
  const [indexOpen, setIndexOpen] = useState(false);
  const [query, setQuery] = useState(() => readObjectiveLibraryView().query);
  const [filter, setFilter] = useState<ObjectiveLibraryFilter>(() => readObjectiveLibraryView().filter);
  const lastObjectiveId = readObjectiveLibraryView().lastObjectiveId;
  useHudPage("goals");

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setPageFailure(null);
    loadedCursorsRef.current.clear();
    try {
      const session = await readAuthenticatedSession(epochRef);
      const workspaceId = session.workspace?.workspaceId;
      if (!workspaceId) throw new Error("当前工作区不可用。");
      if (readObjectiveLibraryView().workspaceId !== workspaceId) {
        retargetObjectiveLibraryView(workspaceId);
        setQuery("");
        setFilter("all");
      }
      const meta = createRequestMeta(session.workspaceEpoch);
      const [response, projectionResponse] = await Promise.all([
        window.ailearn.objective.list({ meta, limit: 60, lifecycle: "active" }),
        window.ailearn.room.getProjection({ meta }).catch(() => null),
      ]);
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setPage(unwrapGatewayResult(response));
      if (projectionResponse?.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
      if (projectionResponse) {
        const projection = unwrapGatewayResult(projectionResponse);
        setPrimaryFocusId(projection.primaryFocus.state === "data" ? projection.primaryFocus.data.objective.objectiveId : null);
        setQueuePriorityIds(projection.queueSummary?.state === "data"
          ? projection.queueSummary.data.items.map((item) => item.objectiveId)
          : []);
      } else {
        setPrimaryFocusId(null);
        setQueuePriorityIds([]);
      }
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore || loadedCursorsRef.current.has(cursor)) return;
    loadedCursorsRef.current.add(cursor);
    setLoadingMore(true);
    setPageFailure(null);
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.objective.list({
        meta: createRequestMeta(session.workspaceEpoch),
        cursor,
        limit: 60,
        lifecycle: "active",
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const next = unwrapGatewayResult(response);
      setPage((current) => {
        if (!current) return next;
        const byId = new Map(current.items.map((item) => [item.objectiveId, item]));
        for (const item of next.items) byId.set(item.objectiveId, item);
        return {
          ...next,
          items: [...byId.values()],
          total: Math.max(current.total, next.total),
          nextCursor: next.nextCursor === cursor ? null : next.nextCursor,
        };
      });
      if (next.nextCursor === cursor) {
        setPageFailure("后续页面返回了重复游标，已停止继续读取以避免循环。");
      }
    } catch (error) {
      loadedCursorsRef.current.delete(cursor);
      setPageFailure(gatewayErrorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page?.nextCursor]);

  useEffect(() => {
    if (!page || !indexOpen || !listRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = readObjectiveLibraryView().scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [indexOpen, page?.items.length]);

  useEffect(() => {
    writeObjectiveLibraryView({ query, filter });
  }, [filter, query]);

  const serverFocus = page?.items.find((item) => item.objectiveId === primaryFocusId) ?? null;
  const activeGoal = serverFocus ?? page?.items.find((item) => isActionable(item.primaryAction)) ?? page?.items[0] ?? null;
  const counts = useMemo(() => {
    const items = page?.items ?? [];
    return items.reduce((summary, item) => {
      const tone = objectiveStateTone(item.personalState.state);
      if (objectiveStateNeedsAttention(item.personalState.state)) summary.attention += 1;
      if (tone === "progress") summary.progress += 1;
      if (tone === "calm") summary.stable += 1;
      return summary;
    }, { attention: 0, progress: 0, stable: 0 });
  }, [page]);
  const visibleGoals = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return (page?.items ?? []).filter((item) => {
      const tone = objectiveStateTone(item.personalState.state);
      const matchesFilter = filter === "all"
        || (filter === "attention" && objectiveStateNeedsAttention(item.personalState.state))
        || (filter === "progress" && tone === "progress")
        || (filter === "stable" && tone === "calm");
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      return [item.conceptLabel, item.publicSummary, item.primaryNoteTitle]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    });
  }, [filter, page, query]);
  const orderedVisibleGoals = useMemo(
    () => orderObjectivesForQuest(visibleGoals, primaryFocusId, queuePriorityIds),
    [primaryFocusId, queuePriorityIds, visibleGoals],
  );
  const questGroups = useMemo(() => {
    const groups: Record<ObjectiveQuestRegion, ObjectiveListItemV3[]> = { ready: [], active: [], mastered: [] };
    for (const item of orderedVisibleGoals) groups[objectiveQuestRegion(item.personalState.state)].push(item);
    return groups;
  }, [orderedVisibleGoals]);
  const activeMode = activeGoal ? runModePresentation(activeGoal.primaryAction) : null;
  const recentGoal = page?.items.find((item) => item.objectiveId === lastObjectiveId) ?? null;

  const openObjective = (objectiveId: string) => {
    writeObjectiveLibraryView({ lastObjectiveId: objectiveId });
    setActiveObjectiveId(objectiveId);
    invoke("open-objective");
  };

  /**
   * 焦点卡那颗按钮真的去开始/继续，而不是打开详情页（31 号文档 P9）。
   * 执行处与详情页共用同一个 `startObjectiveJourney`，所以按钮上的动词和
   * 按下去的去处在两边必然一致。
   */
  const startFocus = async (goal: ObjectiveListItemV3) => {
    if (startingFocus) return;
    setFocusFailure(null);
    if (!window.ailearn) {
      setFocusFailure("这次没有拿到完整的学习凭据，先不开始。");
      return;
    }
    setStartingFocus(true);
    writeObjectiveLibraryView({ lastObjectiveId: goal.objectiveId });
    setActiveObjectiveId(goal.objectiveId);
    try {
      const started = await startObjectiveJourney(goal.primaryAction, {
        epochRef,
        setActiveObjectiveId,
        setActiveRunId,
        openRunSurface: () => invoke("validate"),
        reload: load,
      });
      // refresh / view_successor / 等待类不起旅程，留在列表上；
      // 但「看新版本」这种换了对象的，直接带进详情，免得用户在列表上找不着。
      if (!started && goal.primaryAction.kind === "view_successor") openObjective(goal.primaryAction.successorObjectiveId);
    } catch (error) {
      setFocusFailure(gatewayErrorMessage(error));
    } finally {
      setStartingFocus(false);
    }
  };

  return (
    <ApprovedSurfaceFrame family="workshop" eyebrow="理解远征" headingId="objective-library-title" title="理解地图" detail="沿着真实学习证据，一关一关走到真正掌握">
      {loading ? <SurfaceDataState kind="loading" message="正在读取理解目标" detail="状态和进度都来自服务器，不是本机推算的。" /> : null}
      {!loading && failure ? <SurfaceDataState kind="error" message="理解目标暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {!loading && !failure && !activeGoal ? <SurfaceDataState kind="empty" message="还没有活跃目标" detail="从笔记生成或确认目标后，会在这里形成理解路线。" /> : null}
      {!loading && !failure && activeGoal ? (
        <div className="objective-expedition">
          <div className="objective-expedition__landscape">
          <section className="v3-goal-focus objective-expedition__focus" aria-labelledby="goal-focus-title">
            <div className="objective-expedition__focus-flags" aria-label="本轮模式与状态">
              <span className={`objective-mode-badge objective-mode-badge--${activeMode?.mode ?? "unavailable"}`}>
                {activeMode?.label}
              </span>
              <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(activeGoal.personalState.state)}`}>
                <CircleDot size={12} aria-hidden="true" />{formatObjectiveState(activeGoal.personalState.state)}
              </span>
            </div>
            <div className="objective-expedition__focus-copy">
              <span className="objective-expedition__next"><Flag size={16} aria-hidden="true" />{serverFocus ? "下一关" : "推荐下一关"}</span>
              <h3 id="goal-focus-title">{activeGoal.conceptLabel ?? activeGoal.primaryNoteTitle ?? "未命名理解目标"}</h3>
              <blockquote>{activeGoal.publicSummary}</blockquote>
              <ObjectiveProgressBand segment={progressSegmentForState(activeGoal.personalState.state)} />
              <p className="objective-expedition__mode-copy">{activeMode?.description}</p>
            </div>
            <div className="objective-expedition__focus-actions">
              <button type="button" className="v3-goal-focus__action" disabled={startingFocus || !isActionable(activeGoal.primaryAction)} onClick={() => void startFocus(activeGoal)}>
                <span><small>{startingFocus ? "正在准备路线…" : "从这里继续远征"}</small>{primaryActionLabel(activeGoal.primaryAction)}</span>
                <ArrowRight size={19} aria-hidden="true" />
              </button>
              <p className="v3-goal-focus__hint">{primaryActionDescription(activeGoal.primaryAction)}</p>
              {focusFailure ? <p className="v3-goal-focus__error" role="alert">{focusFailure}</p> : null}
              <button type="button" className="v3-goal-focus__detail" onClick={() => openObjective(activeGoal.objectiveId)}>先看挑战简报</button>
              {recentGoal && recentGoal.objectiveId !== activeGoal.objectiveId ? (
                <button type="button" className="objective-expedition__recent" onClick={() => openObjective(recentGoal.objectiveId)}>
                  <History size={16} aria-hidden="true" /><span><small>回到刚才的目标</small><strong>{recentGoal.conceptLabel ?? recentGoal.primaryNoteTitle ?? "未命名理解目标"}</strong></span><ChevronRight size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <p className="v3-goal-focus__source" title={activeGoal.primaryNoteTitle ?? "未关联主笔记"}>
              <BookOpenText size={14} aria-hidden="true" />{activeGoal.primaryNoteTitle ?? "未关联主笔记"}
            </p>
          </section>

          <section className="objective-expedition__map" aria-labelledby="expedition-map-title">
            <header className="objective-expedition__map-heading">
              <div><MapIcon size={19} aria-hidden="true" /><h3 id="expedition-map-title">纸上远征图</h3></div>
              <p>路线只表示系统推荐的学习顺序，不代表知识依赖。</p>
            </header>
            <div className="objective-expedition__tabs" role="tablist" aria-label="切换地图区域">
              {QUEST_REGIONS.map((region) => (
                <button key={region.key} type="button" role="tab" aria-selected={compactRegion === region.key} onClick={() => setCompactRegion(region.key)}>
                  {region.label}<span>{questGroups[region.key].length}</span>
                </button>
              ))}
            </div>
            <div className="objective-expedition__route" data-compact-region={compactRegion}>
              {QUEST_REGIONS.map((region) => {
                const RegionIcon = region.icon;
                const nodes = questGroups[region.key];
                return (
                  <section key={region.key} className="objective-quest-region" data-region={region.key} aria-labelledby={`quest-region-${region.key}`}>
                    <header>
                      <span className="objective-quest-region__icon"><RegionIcon size={17} aria-hidden="true" /></span>
                      <span><strong id={`quest-region-${region.key}`}>{region.label}</strong><small>{region.detail} · {nodes.length} 个</small></span>
                    </header>
                    <ol>
                      {nodes.slice(0, 2).map((item, index) => (
                        <li key={item.objectiveId}>
                          <button
                            type="button"
                            className="objective-quest-node"
                            data-primary={item.objectiveId === activeGoal.objectiveId ? "true" : "false"}
                            title={item.conceptLabel ?? item.primaryNoteTitle ?? "未命名理解目标"}
                            onClick={() => openObjective(item.objectiveId)}
                          >
                            <span className="objective-quest-node__step" aria-hidden="true">{index + 1}</span>
                            <span><strong>{item.conceptLabel ?? item.primaryNoteTitle ?? "未命名理解目标"}</strong><small>{formatObjectiveState(item.personalState.state)} · {formatKnowledgeForm(item.knowledgeForm)}</small></span>
                            <ChevronRight size={15} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                      {!nodes.length ? <li className="objective-quest-region__empty">这片区域暂时没有目标</li> : null}
                    </ol>
                    {nodes.length > 2 ? <p className="objective-quest-region__more">另有 {nodes.length - 2} 个目标在远征册</p> : null}
                  </section>
                );
              })}
            </div>
          </section>
          </div>

          <div className="objective-expedition__index" data-open={indexOpen ? "true" : "false"} onKeyDown={(event) => {
            if (event.key !== "Escape" || !indexOpen) return;
            event.preventDefault();
            setIndexOpen(false);
            indexToggleRef.current?.focus();
          }}>
            <button ref={indexToggleRef} type="button" className="objective-expedition__index-toggle" aria-expanded={indexOpen} aria-controls={indexOpen ? "objective-expedition-index-body" : undefined} onClick={() => setIndexOpen((open) => !open)}>
              <span><Search size={16} aria-hidden="true" /><strong id="goal-ledger-title"><span className="objective-expedition__open-label">打开远征册</span><span className="objective-expedition__close-label">关闭远征册</span></strong></span>
              <small>{page?.nextCursor ? `已载入 ${page.items.length} / ${page.total ?? 0} 条` : `共 ${page?.total ?? 0} 条`}</small>
              <X className="objective-expedition__close-icon" size={19} aria-hidden="true" />
            </button>
            {indexOpen ? <div id="objective-expedition-index-body" className="objective-expedition__index-body">
              <label className="v3-goal-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">搜索理解目标</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={page?.nextCursor ? "搜索已载入目标" : "搜索全部理解目标"} />
              </label>
              <div className="v3-goal-filters" role="group" aria-label="筛选理解目标">
                {FILTER_BUCKETS.map((bucket) => (
                  <button key={bucket.key} type="button" className={filter === bucket.key ? "is-active" : ""} aria-pressed={filter === bucket.key} title={bucket.hint} onClick={() => setFilter(bucket.key)}>
                    {bucket.label}<span>{bucket.key === "all" ? page?.items.length ?? 0 : counts[bucket.key]}</span>
                  </button>
                ))}
              </div>
              <ul ref={listRef} className="v3-goal-list" onScroll={(event) => { writeObjectiveLibraryView({ scrollTop: event.currentTarget.scrollTop }); }}>
                {visibleGoals.map((item) => (
                  <li key={item.objectiveId}>
                    <button type="button" className="v3-goal-row" onClick={() => openObjective(item.objectiveId)}>
                      <span className={`v3-goal-row__marker v3-goal-row__marker--${objectiveStateTone(item.personalState.state)}`} aria-hidden="true" />
                      <span className="v3-goal-row__body">
                        <span className="v3-goal-row__title">{item.conceptLabel ?? item.primaryNoteTitle ?? "未命名理解目标"}</span>
                        <span className="v3-goal-row__summary">{item.publicSummary}</span>
                        <span className="v3-objective-tags">
                          <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(item.personalState.state)}`} title={objectiveStateHint(item.personalState.state)}>
                            <CircleDot size={12} aria-hidden="true" />{formatObjectiveState(item.personalState.state)}
                          </span>
                          <span className="v3-goal-row__facts">{formatKnowledgeForm(item.knowledgeForm)}{objectiveProgressChips(item.progress).map((chip) => <Fragment key={chip}>&nbsp;· {chip}</Fragment>)}</span>
                          <span className="v3-goal-row__meta">建于 {formatDate(item.createdAt)}</span>
                        </span>
                      </span>
                      <span className="v3-goal-row__next"><small>进入详情</small><ChevronRight size={16} aria-hidden="true" /></span>
                    </button>
                  </li>
                ))}
                {!visibleGoals.length ? <li className="v3-goal-list__empty" role="status"><Search size={19} aria-hidden="true" /><strong>已载入范围内没有匹配目标</strong><span>{page?.nextCursor ? "可以继续读取后面的目标，或更换条件。" : "换一个关键词或筛选条件。"}</span></li> : null}
                {pageFailure ? <li className="v3-goal-list__paging" role="alert"><span>{pageFailure}</span>{page?.nextCursor ? <button type="button" onClick={() => void loadMore()}>重试读取</button> : null}</li> : null}
                {page?.nextCursor && !pageFailure ? <li className="v3-goal-list__paging"><button type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : `继续读取（还有 ${Math.max(0, page.total - page.items.length)} 条）`}</button></li> : null}
                {!page?.nextCursor && page && page.items.length > 0 ? <li className="v3-goal-list__end" role="status">已读到全部目标</li> : null}
              </ul>
            </div> : null}
          </div>
        </div>
      ) : null}
    </ApprovedSurfaceFrame>
  );
}

/** 目标详情只拿到 phase 字符串；复用学习旅程的中文标签，未知值原样显示。 */
function formatRunPhase(phase: string): string {
  return (learningRunPhaseLabels as Record<string, string>)[phase] ?? phase;
}

const previousResultLabels = {
  demonstrated: "已证明掌握",
  partial: "已经说对一部分",
  needs_repair: "找到了待修补处",
  not_assessable: "本轮暂无法判定",
  practice_completed: "练习已完成",
  skipped: "本轮已跳过",
  declared_unable: "本轮选择先学习",
} as const;

export function ObjectiveDetailSurface() {
  const activeObjectiveId = useRoomStore((state) => state.activeObjectiveId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const invoke = useRoomStore((state) => state.invoke);
  const epochRef = useRef<number | undefined>(undefined);
  const [objective, setObjective] = useState<LearningObjectiveSurfaceV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useHudPage("goal-detail");

  const load = useCallback(async () => {
    if (!activeObjectiveId) { setLoading(false); return; }
    setLoading(true);
    setFailure(null);
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.objective.get({ meta: createRequestMeta(session.workspaceEpoch), objectiveId: activeObjectiveId });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setObjective(unwrapGatewayResult(response));
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [activeObjectiveId]);
  useEffect(() => { void load(); }, [load]);

  const startAction = async () => {
    if (!objective || starting) return;
    setActionFailure(null);
    if (!window.ailearn) {
      setActionFailure("这次没有拿到完整的学习凭据，先不开始。");
      return;
    }
    setStarting(true);
    try {
      await startObjectiveJourney(objective.primaryAction, {
        epochRef,
        setActiveObjectiveId,
        setActiveRunId,
        openRunSurface: () => invoke("validate"),
        reload: load,
      });
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const content = objective?.content;
  const detailState = objective?.personalState.state ?? null;
  const evidenceSnapshotCount = objective?.sources.origins.reduce((sum, origin) => sum + origin.evidenceSnapshotIds.length, 0) ?? 0;
  const detailMode = objective ? runModePresentation(objective.primaryAction) : null;
  const previousResult = objective?.personal.latestResult;
  const openPreviousResult = () => {
    if (!previousResult) return;
    setActiveRunId(previousResult.runId);
    invoke("validate");
  };
  return (
    <ApprovedSurfaceFrame family="workshop" eyebrow="远征简报" headingId="objective-detail-title" title="挑战简报" detail="先看要证明什么，再决定现在是否出发">
      {!activeObjectiveId ? <SurfaceDataState kind="empty" message="还没有选择理解目标" detail="从理解目标库点击目标后，会直接进入完整详情。" /> : null}
      {activeObjectiveId && loading ? <SurfaceDataState kind="loading" message="正在读取目标详情" detail="这里只显示公开内容，不含答案和评分规则。" /> : null}
      {activeObjectiveId && !loading && failure ? <SurfaceDataState kind="error" message="目标详情暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {activeObjectiveId && !loading && !failure && objective && content && detailState ? (
        <div className="objective-brief">
          <article className="objective-brief__board">
            <header className="objective-brief__masthead">
              <div className="objective-brief__flags">
                <span className={`objective-mode-badge objective-mode-badge--${detailMode?.mode ?? "unavailable"}`}>{detailMode?.label}</span>
                <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(detailState)}`}><CircleDot size={12} aria-hidden="true" />{formatObjectiveState(detailState)}</span>
              </div>
              <h3>{content.conceptLabel ?? "未命名理解目标"}</h3>
              <p className="v3-objective-summary">{content.publicSummary}</p>
            </header>

            <section className="objective-brief__mission" aria-labelledby="objective-proof-title">
              <div className="objective-brief__mission-heading"><Target size={24} aria-hidden="true" /><h4 id="objective-proof-title">过这一关，需要你证明</h4></div>
              <p>不用背原文。请用自己的话说明这条主张，并给出能让它成立的解释、例子或边界。</p>
              <div className={`objective-brief__mode objective-brief__mode--${detailMode?.mode ?? "unavailable"}`}>
                <strong>{detailMode?.label}</strong><span>{detailMode?.description}</span>
              </div>
            </section>

            <section className="objective-brief__departure" aria-labelledby="learning-ledger-title">
              <div className="objective-brief__progress">
                <div className="objective-brief__progress-heading"><h4 id="learning-ledger-title">你已走到这里</h4><span>{objective.personal.practiceTrailCount} 次练习</span></div>
                <ObjectiveProgressBand segment={progressSegmentForState(detailState)} />
                <ul>
                  <li><CheckCircle2 size={16} aria-hidden="true" /><span>正式验证</span><strong>{objective.personal.initialValidation ? objective.personal.initialValidation.status === "ready" && objective.personal.lastCanonicalAt ? "可以再次挑战" : ({ ready: "现在可以挑战", deferred: "等待开放", idle: "还没开始", completed: "已经答过" } as const)[objective.personal.initialValidation.status] : "还没安排"}</strong></li>
                  <li><Clock3 size={16} aria-hidden="true" /><span>当前旅程</span><strong>{objective.personal.activeRun ? formatRunPhase(objective.personal.activeRun.phase) : "尚未开始"}</strong></li>
                  <li><CalendarClock size={16} aria-hidden="true" /><span>复习安排</span><strong>{objective.personal.review ? (objective.personal.review.status === "due" ? "已经到期" : formatObjectiveDateTime(objective.personal.review.dueAt)) : "正式验证后安排"}</strong></li>
                </ul>
              </div>
              <div className="objective-brief__launchpad">
                <p id="objective-next-action-state">{objectiveStateHint(detailState)}</p>
                <button type="button" className="objective-brief__launch" disabled={starting || !isActionable(objective.primaryAction)} onClick={() => void startAction()} aria-labelledby="objective-next-action-verb" aria-describedby="objective-next-action-state objective-next-action-why">
                  <strong id="objective-next-action-verb">{starting ? "正在准备" : previousResult && objective.primaryAction.kind === "create_run" ? "再挑战一次" : primaryActionLabel(objective.primaryAction)}</strong>
                  <span aria-hidden="true">{starting ? <LoaderCircle size={22} /> : objective.primaryAction.kind === "refresh" ? <RefreshCw size={22} /> : <ArrowRight size={22} />}</span>
                </button>
                <small id="objective-next-action-why">{primaryActionDescription(objective.primaryAction)}</small>
              </div>
            </section>
            {actionFailure ? <p className="v3-action-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{actionFailure}</p> : null}

            {previousResult ? (
              <section className="objective-brief__history" aria-labelledby="objective-previous-result-title">
                <div className="objective-brief__history-copy">
                  <span><History size={18} aria-hidden="true" /> 上一次留下的学习记录</span>
                  <h4 id="objective-previous-result-title">{previousResultLabels[previousResult.outcome]}</h4>
                  <p>{formatObjectiveDateTime(previousResult.completedAt)} · 可以回看当时的作答、判定与解析；重新挑战会生成新的一轮，不会覆盖这份记录。</p>
                </div>
                <button type="button" onClick={openPreviousResult}>回看上次结果 <ArrowRight size={18} aria-hidden="true" /></button>
              </section>
            ) : null}

            <details className="objective-brief__dossier">
              <summary><span><Layers3 size={16} aria-hidden="true" /><strong>资料卷宗</strong></span><small>{objective.sources.origins.length} 条来源 · {evidenceSnapshotCount} 条原文证据</small></summary>
              <div className="objective-brief__dossier-body">
                {objective.sources.primaryNote ? <button type="button" className="v3-primary-note" onClick={() => invoke("open-notebook")}><FileText size={17} aria-hidden="true" /><span><small>主笔记</small><strong>{objective.sources.primaryNote.title}</strong></span><ChevronRight size={16} aria-hidden="true" /></button> : <div className="v3-primary-note v3-primary-note--missing"><AlertTriangle size={17} aria-hidden="true" /><span><small>主笔记</small><strong>尚未关联主笔记</strong></span></div>}
                {objective.sources.missingOrigin ? <p className="v3-lineage-warning"><AlertTriangle size={14} aria-hidden="true" />部分来源还没对上，验证前建议先补齐。</p> : null}
                <div className="v3-origin-list">
                  {objective.sources.origins.length ? objective.sources.origins.map((origin, index) => <article key={origin.originId} className="v3-origin-row"><span className="v3-origin-row__index">{String(index + 1).padStart(2, "0")}</span><div><div><strong>{formatOriginKind(origin.kind)}</strong><span>{formatSupportGrade(origin.supportGrade)}</span></div><p>{formatOriginIntegrity(origin.integrity)}{origin.evidenceSnapshotIds.length ? ` · ${origin.evidenceSnapshotIds.length} 条原文证据` : ""}</p><small>{origin.kind === "imported" ? `导入批次 ${origin.importBatchRef}` : origin.sourceSnapshotId ? "留了当时引用的原文" : "没有留当时引用的原文"}</small></div></article>) : <div className="v3-origin-empty"><FolderOpen size={19} aria-hidden="true" /><strong>还没有可公开的出处</strong><span>这里不会用示例证据填充空白。</span></div>}
                </div>
                <footer className="v3-lineage-boundary"><strong>公开边界</strong><p>这里只讲来源关系和学习状态；标准答案、评分依据和原文段落不会提前出现。</p></footer>
              </div>
            </details>
            <footer className="objective-brief__revision"><span>{formatKnowledgeForm(content.knowledgeForm)} · {formatFreshness(content.freshness)} · {formatLifecycle(content.lifecycle)} · 更新于 {formatObjectiveDateTime(objective.updatedAt)}</span></footer>
          </article>
        </div>
      ) : null}
    </ApprovedSurfaceFrame>
  );
}
