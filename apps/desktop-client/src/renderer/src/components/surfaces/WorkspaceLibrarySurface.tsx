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

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "暂无记录";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatObjectiveState(state: ObjectiveListItemV3["personalState"]["state"]): string {
  switch (state) {
    case "unvalidated": return "待验证";
    case "learning": return "学习中";
    case "stable": return "已稳定";
    case "fragile": return "需要巩固";
    case "needs_repair": return "需要修复";
    case "due_review": return "到期复习";
    case "scheduled": return "已排期";
    case "outdated": return "内容过期";
    case "archived": return "已归档";
    case "superseded": return "已被替代";
    default: return state;
  }
}

function objectiveStateTone(state: ObjectiveListItemV3["personalState"]["state"]): "calm" | "attention" | "progress" | "neutral" {
  switch (state) {
    case "stable": return "calm";
    case "learning":
    case "scheduled": return "progress";
    case "fragile":
    case "needs_repair":
    case "due_review":
    case "outdated": return "attention";
    default: return "neutral";
  }
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

function actionDescription(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "create_run": return action.label;
    case "resume_run": return "从上次保存的位置继续，不会丢失已经完成的步骤。";
    case "create_review_run": return `${action.label}，完成后会回写新的复习结果。`;
    case "practice_only": return `${action.label}，本次不会改变正式理解状态。`;
    case "wait_for_initial_validation": return `首次验证将在 ${formatDateTime(action.qualificationNotBefore)} 后开放。`;
    case "view_successor": return "当前内容已有更新后的目标版本。";
    case "refresh": return "目标或来源发生变化，需要重新读取最新内容。";
    case "none": return "服务端暂时没有提供下一步行动。";
  }
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

type ObjectiveLibraryFilter = "all" | "attention" | "progress" | "stable";

let objectiveLibraryViewState: {
  workspaceId: string | null;
  query: string;
  filter: ObjectiveLibraryFilter;
  scrollTop: number;
} = {
  workspaceId: null,
  query: "",
  filter: "all",
  scrollTop: 0,
};

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
  const [query, setQuery] = useState(() => objectiveLibraryViewState.query);
  const [filter, setFilter] = useState<ObjectiveLibraryFilter>(() => objectiveLibraryViewState.filter);
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
      if (objectiveLibraryViewState.workspaceId !== workspaceId) {
        objectiveLibraryViewState = { workspaceId, query: "", filter: "all", scrollTop: 0 };
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
      if (listRef.current) listRef.current.scrollTop = objectiveLibraryViewState.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page?.items.length]);

  useEffect(() => {
    objectiveLibraryViewState.query = query;
    objectiveLibraryViewState.filter = filter;
  }, [filter, query]);

  const serverFocus = page?.items.find((item) => item.objectiveId === primaryFocusId) ?? null;
  const activeGoal = serverFocus ?? page?.items.find((item) => isActionable(item.primaryAction)) ?? page?.items[0] ?? null;
  const counts = useMemo(() => {
    const items = page?.items ?? [];
    return items.reduce((summary, item) => {
      const tone = objectiveStateTone(item.personalState.state);
      if (tone === "attention" || item.personalState.state === "unvalidated") summary.attention += 1;
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
        || (filter === "attention" && (tone === "attention" || item.personalState.state === "unvalidated"))
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
      {loading ? <SurfaceDataState kind="loading" message="正在读取理解目标" detail="目标状态与个人学习进度由服务端返回。" /> : null}
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
                <span><small>下一步已经准备好</small>{actionLabel(activeGoal.primaryAction)}</span>
                <ArrowRight size={19} aria-hidden="true" />
              </button>
            </div>
            <dl className="v3-goal-pulse" aria-label="目标状态概览">
              <div><dt>待处理</dt><dd>{counts.attention}</dd></div>
              <div><dt>推进中</dt><dd>{counts.progress}</dd></div>
              <div><dt>已稳定</dt><dd>{counts.stable}</dd></div>
            </dl>
            <p className="v3-goal-focus__source"><BookOpenText size={13} aria-hidden="true" />{activeGoal.primaryNoteTitle ?? "未关联主笔记"}</p>
          </section>

          <section className="v3-goal-ledger" aria-labelledby="goal-ledger-title">
            <header className="v3-goal-ledger__header">
              <div>
                <h3 id="goal-ledger-title">目标口袋</h3>
                <p>已载入 {page?.items.length ?? 0} / {page?.total ?? 0} 条 · 更新于 {formatDateTime(page?.snapshotAt)}</p>
              </div>
              <label className="v3-goal-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">搜索理解目标</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已载入目标" />
              </label>
            </header>
            <div className="v3-goal-filters" role="group" aria-label="筛选理解目标">
              {([
                ["all", "全部", page?.items.length ?? 0],
                ["attention", "待处理", counts.attention],
                ["progress", "推进中", counts.progress],
                ["stable", "已稳定", counts.stable],
              ] as const).map(([value, label, count]) => (
                <button key={value} type="button" className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>
              ))}
            </div>
            <ul
              ref={listRef}
              className="v3-goal-list"
              onScroll={(event) => { objectiveLibraryViewState.scrollTop = event.currentTarget.scrollTop; }}
            >
              {visibleGoals.map((item) => (
                <li key={item.objectiveId}>
                  <button type="button" className="v3-goal-row" onClick={() => openObjective(item.objectiveId)}>
                    <span className={`v3-goal-row__marker v3-goal-row__marker--${objectiveStateTone(item.personalState.state)}`} aria-hidden="true" />
                    <span className="v3-goal-row__body">
                      <span className="v3-goal-row__title">{item.conceptLabel ?? item.primaryNoteTitle ?? "未命名理解目标"}</span>
                      <span className="v3-goal-row__summary">{item.publicSummary}</span>
                      <span className="v3-goal-row__meta">{formatObjectiveState(item.personalState.state)} · {formatKnowledgeForm(item.knowledgeForm)} · {formatDate(item.createdAt)}</span>
                    </span>
                    <span className="v3-goal-row__next"><small>{actionLabel(item.primaryAction)}</small><ChevronRight size={16} aria-hidden="true" /></span>
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

function actionLabel(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "resume_run": return "继续学习";
    case "create_review_run": return action.label;
    case "create_run": return action.label;
    case "practice_only": return action.label;
    case "wait_for_initial_validation": return "等待首次验证";
    case "view_successor": return "查看后继目标";
    case "refresh": return "重新读取";
    case "none": return "暂无动作";
  }
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
      setActionFailure("服务端没有提供完整的可验证学习身份，本次不会启动运行。");
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
      {activeObjectiveId && loading ? <SurfaceDataState kind="loading" message="正在读取目标详情" detail="只显示服务端公开内容，不泄露测评答案或评分规则。" /> : null}
      {activeObjectiveId && !loading && failure ? <SurfaceDataState kind="error" message="目标详情暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {activeObjectiveId && !loading && !failure && objective && content && detailState ? (
        <div className="v3-objective-workspace">
          <article className="v3-objective-sheet">
            <div className="v3-objective-intro">
              <header className="v3-objective-sheet__header">
                <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(detailState)}`}><CircleDot size={12} aria-hidden="true" />{formatObjectiveState(detailState)}</span>
                <span>更新于 {formatDateTime(objective.updatedAt)}</span>
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
                <strong>{actionLabel(objective.primaryAction)}</strong>
                <p>{actionDescription(objective.primaryAction)}</p>
              </div>
              <button type="button" disabled={starting || !isActionable(objective.primaryAction)} onClick={() => void startAction()}>
                {starting ? <LoaderCircle size={17} aria-hidden="true" /> : objective.primaryAction.kind === "refresh" ? <RefreshCw size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
                {starting ? "正在准备" : actionLabel(objective.primaryAction)}
              </button>
            </section>
            {actionFailure ? <p className="v3-action-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{actionFailure}</p> : null}

            <section className="v3-learning-ledger" aria-labelledby="learning-ledger-title">
              <div className="v3-section-heading"><div><History size={15} aria-hidden="true" /><h4 id="learning-ledger-title">理解足迹</h4></div><span>{objective.personal.practiceTrailCount} 次练习</span></div>
              <dl>
                <div>
                  <dt><CheckCircle2 size={14} aria-hidden="true" />首次验证</dt>
                  <dd>{objective.personal.initialValidation ? ({ ready: "可以开始", deferred: "等待开放", idle: "尚未开始", completed: "已经完成" } as const)[objective.personal.initialValidation.status] : "尚未安排"}</dd>
                  <small>{objective.personal.initialValidation?.qualificationNotBefore ? `开放时间 ${formatDateTime(objective.personal.initialValidation.qualificationNotBefore)}` : "没有额外资格时间"}</small>
                </div>
                <div>
                  <dt><Clock3 size={14} aria-hidden="true" />学习旅程</dt>
                  <dd>{objective.personal.activeRun ? `进行中 · ${objective.personal.activeRun.phase}` : "没有进行中的旅程"}</dd>
                  <small>{objective.personal.lastCanonicalAt ? `最近一次正式结果 ${formatDateTime(objective.personal.lastCanonicalAt)}` : "还没有正式验证结果"}</small>
                </div>
                <div>
                  <dt><CalendarClock size={14} aria-hidden="true" />复习安排</dt>
                  <dd>{objective.personal.review ? (objective.personal.review.status === "due" ? "已经到期" : "已排入计划") : "尚未排期"}</dd>
                  <small>{objective.personal.review ? `${formatDateTime(objective.personal.review.dueAt)} · 第 ${objective.personal.review.generation} 轮` : "完成正式验证后由服务端安排"}</small>
                </div>
              </dl>
            </section>

            <footer className="v3-objective-revision">
              <span>目标修订 {objective.surfaceRevision}</span>
              <span>生命周期版本 {objective.lifecycleEpoch}</span>
              <span>{content.presentation.cardRevision ? `学习卡修订 ${content.presentation.cardRevision}` : "尚无公开学习卡"}</span>
              <span>{content.presentation.publicationRevision ? `发布修订 ${content.presentation.publicationRevision}` : "尚未发布"}</span>
              <span>创建于 {formatDateTime(objective.createdAt)}</span>
            </footer>
          </article>

          <aside className="v3-lineage-ledger" aria-label="证据与来源血缘">
            <header>
              <div><Layers3 size={16} aria-hidden="true" /><h3>证据口袋</h3></div>
              <span>{objective.sources.origins.length} 条来源 · {evidenceSnapshotCount} 条证据快照</span>
            </header>
            {objective.sources.primaryNote ? (
              <button type="button" className="v3-primary-note" onClick={() => invoke("open-notebook")}>
                <FileText size={17} aria-hidden="true" />
                <span><small>主笔记</small><strong>{objective.sources.primaryNote.title}</strong></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ) : <div className="v3-primary-note v3-primary-note--missing"><AlertTriangle size={17} aria-hidden="true" /><span><small>主笔记</small><strong>尚未关联主笔记</strong></span></div>}
            {objective.sources.missingOrigin ? <p className="v3-lineage-warning"><AlertTriangle size={14} aria-hidden="true" />部分来源血缘缺失，验证前建议先补齐。</p> : null}
            <div className="v3-origin-list">
              {objective.sources.origins.length ? objective.sources.origins.map((origin, index) => (
                <article key={origin.originId} className="v3-origin-row">
                  <span className="v3-origin-row__index">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <div><strong>{formatOriginKind(origin.kind)}</strong><span>{formatSupportGrade(origin.supportGrade)}</span></div>
                    <p>{formatOriginIntegrity(origin.integrity)} · {origin.evidenceSnapshotIds.length} 条证据快照</p>
                    <small>{origin.kind === "imported" ? `导入批次 ${origin.importBatchRef}` : origin.sourceSnapshotId ? "保留来源快照" : "没有来源快照"}</small>
                  </div>
                </article>
              )) : <div className="v3-origin-empty"><FolderOpen size={19} aria-hidden="true" /><strong>尚无公开来源血缘</strong><span>这里不会用示例证据填充空白。</span></div>}
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
