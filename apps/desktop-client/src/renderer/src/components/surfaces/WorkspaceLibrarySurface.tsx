import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FolderOpen,
  History,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  Target,
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(parsed);
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

export function ObjectiveLibrarySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const epochRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLUListElement>(null);
  const loadedCursorsRef = useRef(new Set<string>());
  const [page, setPage] = useState<ObjectiveListPageV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pageFailure, setPageFailure] = useState<string | null>(null);
  const [primaryFocusId, setPrimaryFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState(() => readObjectiveLibraryView().query);
  const [filter, setFilter] = useState<ObjectiveLibraryFilter>(() => readObjectiveLibraryView().filter);
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
      } else {
        setPrimaryFocusId(null);
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
    if (!page || !listRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = readObjectiveLibraryView().scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page?.items.length]);

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

  const openObjective = (objectiveId: string) => {
    setActiveObjectiveId(objectiveId);
    invoke("open-objective");
  };

  return (
    <ApprovedSurfaceFrame family="workshop" eyebrow="理解构建" headingId="objective-library-title" title="理解目标" detail="先看下一步，再浏览每一条可验证的理解">
      {loading ? <SurfaceDataState kind="loading" message="正在读取理解目标" detail="状态和进度都来自服务器，不是本机推算的。" /> : null}
      {!loading && failure ? <SurfaceDataState kind="error" message="理解目标暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {!loading && !failure && !activeGoal ? <SurfaceDataState kind="empty" message="还没有活跃目标" detail="从笔记生成或确认目标后，会在这里形成理解路线。" /> : null}
      {!loading && !failure && activeGoal ? (
        <div className="v3-goal-workbench">
          <section className="v3-goal-focus" aria-labelledby="goal-focus-title">
            <div className="v3-goal-focus__topline">
              <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(activeGoal.personalState.state)}`}><CircleDot size={12} aria-hidden="true" />{formatObjectiveState(activeGoal.personalState.state)}</span>
              <span>{formatKnowledgeForm(activeGoal.knowledgeForm)}</span>
            </div>
            <div className="v3-goal-focus__copy">
              <p>{serverFocus ? "今日主焦点" : "接下来可以继续"}</p>
              <h3 id="goal-focus-title">{activeGoal.conceptLabel ?? activeGoal.primaryNoteTitle ?? "未命名理解目标"}</h3>
              <blockquote>{activeGoal.publicSummary}</blockquote>
              <button type="button" className="v3-goal-focus__action" onClick={() => openObjective(activeGoal.objectiveId)}>
                <span><small>打开目标详情</small>{primaryActionLabel(activeGoal.primaryAction)}</span>
                <ArrowRight size={19} aria-hidden="true" />
              </button>
            </div>
            <dl className="v3-goal-pulse" aria-label="目标状态概览">
              {PERSONAL_BUCKETS.map((bucket) => (
                <div key={bucket.key} title={bucket.hint}><dt>{bucket.label}</dt><dd>{counts[bucket.key]}</dd></div>
              ))}
            </dl>
            <p className="v3-goal-focus__source"><BookOpenText size={13} aria-hidden="true" />{activeGoal.primaryNoteTitle ?? "未关联主笔记"}</p>
          </section>

          <section className="v3-goal-ledger" aria-labelledby="goal-ledger-title">
            <header className="v3-goal-ledger__header">
              <div>
                <h3 id="goal-ledger-title">全部理解目标</h3>
                <p>已载入 {page?.items.length ?? 0} / {page?.total ?? 0} 条{page?.snapshotAt ? ` · 更新于 ${formatObjectiveDateTime(page.snapshotAt)}` : ""}</p>
              </div>
              <label className="v3-goal-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">搜索理解目标</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已载入目标" />
              </label>
            </header>
            <div className="v3-goal-filters" role="group" aria-label="筛选理解目标">
              {FILTER_BUCKETS.map((bucket) => (
                <button
                  key={bucket.key}
                  type="button"
                  className={filter === bucket.key ? "is-active" : ""}
                  aria-pressed={filter === bucket.key}
                  title={bucket.hint}
                  onClick={() => setFilter(bucket.key)}
                >
                  {bucket.label}<span>{bucket.key === "all" ? page?.items.length ?? 0 : counts[bucket.key]}</span>
                </button>
              ))}
            </div>
            <ul
              ref={listRef}
              className="v3-goal-list"
              onScroll={(event) => { writeObjectiveLibraryView({ scrollTop: event.currentTarget.scrollTop }); }}
            >
              {visibleGoals.map((item) => (
                <li key={item.objectiveId}>
                  <button type="button" className="v3-goal-row" onClick={() => openObjective(item.objectiveId)}>
                    <span className={`v3-goal-row__marker v3-goal-row__marker--${objectiveStateTone(item.personalState.state)}`} aria-hidden="true" />
                    <span className="v3-goal-row__body">
                      <span className="v3-goal-row__title">{item.conceptLabel ?? item.primaryNoteTitle ?? "未命名理解目标"}</span>
                      <span className="v3-goal-row__summary">{item.publicSummary}</span>
                      {/* 一行 tag：状态（带色调的图标）+ 知识形态 + 作答进展。此前这些
                          挤在一句 8px 灰字里，答完一张卡回到列表看不出任何变化（复盘 #7）。 */}
                      <span className="v3-objective-tags">
                        <span
                          className={`v3-objective-state v3-objective-state--${objectiveStateTone(item.personalState.state)}`}
                          title={objectiveStateHint(item.personalState.state)}
                        >
                          <CircleDot size={12} aria-hidden="true" />{formatObjectiveState(item.personalState.state)}
                        </span>
                        <span>{formatKnowledgeForm(item.knowledgeForm)}</span>
                        {objectiveProgressChips(item.progress).map((chip) => (
                          <span key={chip}>{chip}</span>
                        ))}
                      </span>
                      <span className="v3-goal-row__meta">建于 {formatDate(item.createdAt)}</span>
                    </span>
                    <span className="v3-goal-row__next"><small>{primaryActionLabel(item.primaryAction)}</small><ChevronRight size={16} aria-hidden="true" /></span>
                  </button>
                </li>
              ))}
              {!visibleGoals.length ? <li className="v3-goal-list__empty" role="status"><Search size={19} aria-hidden="true" /><strong>已载入范围内没有匹配目标</strong><span>{page?.nextCursor ? "可以继续读取后面的目标，或更换条件。" : "换一个关键词或筛选条件。"}</span></li> : null}
              {pageFailure ? <li className="v3-goal-list__paging" role="alert"><span>{pageFailure}</span>{page?.nextCursor ? <button type="button" onClick={() => void loadMore()}>重试读取</button> : null}</li> : null}
              {page?.nextCursor && !pageFailure ? <li className="v3-goal-list__paging"><button type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : `继续读取（还有 ${Math.max(0, page.total - page.items.length)} 条）`}</button></li> : null}
              {!page?.nextCursor && page && page.items.length > 0 ? <li className="v3-goal-list__end" role="status">已读到全部目标</li> : null}
            </ul>
          </section>
        </div>
      ) : null}
    </ApprovedSurfaceFrame>
  );
}

/** 目标详情只拿到 phase 字符串；复用学习旅程的中文标签，未知值原样显示。 */
function formatRunPhase(phase: string): string {
  return (learningRunPhaseLabels as Record<string, string>)[phase] ?? phase;
}

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
    const action = objective.primaryAction;
    setActionFailure(null);
    if (action.kind === "refresh") {
      await load();
      return;
    }
    if (action.kind === "view_successor") {
      setActiveObjectiveId(action.successorObjectiveId);
      return;
    }
    if (action.kind === "resume_run") {
      setActiveRunId(action.runId);
      invoke("validate");
      return;
    }
    if (action.kind !== "create_run" && action.kind !== "create_review_run" && action.kind !== "practice_only") return;
    if (!window.ailearn) {
      setActionFailure("这次没有拿到完整的学习凭据，先不开始。");
      return;
    }
    setStarting(true);
    try {
      const response = await window.ailearn.learningRun.start({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId(action.kind === "create_review_run" ? "start-objective-review" : action.kind === "practice_only" ? "start-objective-practice" : "start-objective-run"),
        request: action.start,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const snapshot = unwrapGatewayResult(response);
      setActiveRunId(snapshot.runId);
      invoke("validate");
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const content = objective?.content;
  const detailState = objective?.personalState.state ?? null;
  const evidenceSnapshotCount = objective?.sources.origins.reduce((sum, origin) => sum + origin.evidenceSnapshotIds.length, 0) ?? 0;
  return (
    <ApprovedSurfaceFrame family="workshop" eyebrow="理解构建" headingId="objective-detail-title" title="理解目标详情" detail="看清主张、当前理解状态、证据来路与下一步">
      {!activeObjectiveId ? <SurfaceDataState kind="empty" message="还没有选择理解目标" detail="从理解目标库点击目标后，会直接进入完整详情。" /> : null}
      {activeObjectiveId && loading ? <SurfaceDataState kind="loading" message="正在读取目标详情" detail="这里只显示公开内容，不含答案和评分规则。" /> : null}
      {activeObjectiveId && !loading && failure ? <SurfaceDataState kind="error" message="目标详情暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {activeObjectiveId && !loading && !failure && objective && content && detailState ? (
        <div className="v3-objective-workspace">
          <article className="v3-objective-sheet">
            <div className="v3-objective-intro">
              <header className="v3-objective-sheet__header">
                <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(detailState)}`}><CircleDot size={12} aria-hidden="true" />{formatObjectiveState(detailState)}</span>
                <span>更新于 {formatObjectiveDateTime(objective.updatedAt)}</span>
              </header>
              <h3>{content.conceptLabel ?? "未命名理解目标"}</h3>
              <p className="v3-objective-summary">{content.publicSummary}</p>
              <div className="v3-objective-tags" aria-label="目标属性">
                <span>{formatKnowledgeForm(content.knowledgeForm)}</span>
                <span>{formatFreshness(content.freshness)}</span>
                <span>{formatLifecycle(content.lifecycle)}</span>
              </div>
            </div>

            <section className="v3-next-action" aria-labelledby="objective-next-action-title">
              <div>
                <span id="objective-next-action-title">现在最值得做</span>
                <strong>{primaryActionLabel(objective.primaryAction)}</strong>
                {/* 状态词先解释自己，再谈下一步：只留一个灰色按钮时，用户读到的是
                    "产品坏了"，不是"我上次看了答案"（2026-09-20 实走复盘 #9）。 */}
                <p>{objectiveStateHint(detailState)}</p>
                <p>{primaryActionDescription(objective.primaryAction)}</p>
              </div>
              <button type="button" disabled={starting || !isActionable(objective.primaryAction)} onClick={() => void startAction()}>
                {starting ? <LoaderCircle size={17} aria-hidden="true" /> : objective.primaryAction.kind === "refresh" ? <RefreshCw size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
                {starting ? "正在准备" : primaryActionLabel(objective.primaryAction)}
              </button>
            </section>
            {actionFailure ? <p className="v3-action-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{actionFailure}</p> : null}

            <section className="v3-learning-ledger" aria-labelledby="learning-ledger-title">
              <div className="v3-section-heading"><div><History size={15} aria-hidden="true" /><h4 id="learning-ledger-title">理解足迹</h4></div><span>{objective.personal.practiceTrailCount} 次练习</span></div>
              <dl>
                <div>
                  <dt><CheckCircle2 size={14} aria-hidden="true" />首次验证</dt>
                  <dd>{objective.personal.initialValidation ? ({ ready: "现在就能正式答", deferred: "要等一等", idle: "还没开始", completed: "已经答过了" } as const)[objective.personal.initialValidation.status] : "还没安排"}</dd>
                  <small>{objective.personal.initialValidation?.status === "deferred" && objective.personal.initialValidation.qualificationNotBefore
                    ? `${formatObjectiveDateTime(objective.personal.initialValidation.qualificationNotBefore)} 开放。这一题的参考答案你看过，马上答等于开卷，所以正式验证要等记忆回落之后再算数；等待期间可以随时练。`
                    : objective.personal.initialValidation?.qualificationNotBefore
                      ? `开放时间 ${formatObjectiveDateTime(objective.personal.initialValidation.qualificationNotBefore)}`
                      : "没有其他等待条件"}</small>
                </div>
                <div>
                  <dt><Clock3 size={14} aria-hidden="true" />学习旅程</dt>
                  <dd>{objective.personal.activeRun ? formatRunPhase(objective.personal.activeRun.phase) : "没有进行中的旅程"}</dd>
                  <small>{objective.personal.lastCanonicalAt ? `最近一次正式结果 ${formatObjectiveDateTime(objective.personal.lastCanonicalAt)}` : "还没有正式验证结果"}</small>
                </div>
                <div>
                  <dt><CalendarClock size={14} aria-hidden="true" />复习安排</dt>
                  <dd>{objective.personal.review ? (objective.personal.review.status === "due" ? "已经到期" : "已排入计划") : "尚未排期"}</dd>
                  <small>{objective.personal.review ? `${formatObjectiveDateTime(objective.personal.review.dueAt)} · 第 ${objective.personal.review.generation} 轮` : "完成一次正式验证后会自动排期"}</small>
                </div>
              </dl>
            </section>

            <footer className="v3-objective-revision">
              <span>目标第 {objective.surfaceRevision} 版</span>
              <span>状态变更 {objective.lifecycleEpoch} 次</span>
              <span>{content.presentation.cardRevision ? `学习卡第 ${content.presentation.cardRevision} 版` : "尚无公开学习卡"}</span>
              <span>{content.presentation.publicationRevision ? `发布第 ${content.presentation.publicationRevision} 版` : "尚未发布"}</span>
              <span>创建于 {formatObjectiveDateTime(objective.createdAt)}</span>
            </footer>
          </article>

          <aside className="v3-lineage-ledger" aria-label="证据与出处">
            <header>
              <div><Layers3 size={16} aria-hidden="true" /><h3>证据清单</h3></div>
              <span>{objective.sources.origins.length} 条来源 · {evidenceSnapshotCount} 条原文证据</span>
            </header>
            {objective.sources.primaryNote ? (
              <button type="button" className="v3-primary-note" onClick={() => invoke("open-notebook")}>
                <FileText size={17} aria-hidden="true" />
                <span><small>主笔记</small><strong>{objective.sources.primaryNote.title}</strong></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ) : <div className="v3-primary-note v3-primary-note--missing"><AlertTriangle size={17} aria-hidden="true" /><span><small>主笔记</small><strong>尚未关联主笔记</strong></span></div>}
            {objective.sources.missingOrigin ? <p className="v3-lineage-warning"><AlertTriangle size={14} aria-hidden="true" />部分来源还没对上，验证前建议先补齐。</p> : null}
            <div className="v3-origin-list">
              {objective.sources.origins.length ? objective.sources.origins.map((origin, index) => (
                <article key={origin.originId} className="v3-origin-row">
                  <span className="v3-origin-row__index">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <div><strong>{formatOriginKind(origin.kind)}</strong><span>{formatSupportGrade(origin.supportGrade)}</span></div>
                    <p>{formatOriginIntegrity(origin.integrity)} · {origin.evidenceSnapshotIds.length} 条原文证据</p>
                    <small>{origin.kind === "imported" ? `导入批次 ${origin.importBatchRef}` : origin.sourceSnapshotId ? "留了当时引用的原文" : "没有留当时引用的原文"}</small>
                  </div>
                </article>
              )) : <div className="v3-origin-empty"><FolderOpen size={19} aria-hidden="true" /><strong>还没有可公开的出处</strong><span>这里不会用示例证据填充空白。</span></div>}
            </div>
            <footer className="v3-lineage-boundary">
              <strong>这里会展示什么</strong>
              <p>这里仅呈现来源关系与学习状态；标准答案、评分规则和完整证据原文不会进入桌面渲染边界。</p>
            </footer>
          </aside>
        </div>
      ) : null}
    </ApprovedSurfaceFrame>
  );
}
