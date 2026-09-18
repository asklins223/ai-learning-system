import { useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import {
  BookOpen,
  Compass,
  FileText,
  Layers,
  LoaderCircle,
  MousePointerClick,
  RefreshCw,
  Route,
  Settings2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { ActivityTargetV1, TodayActivityV1 } from "@ailearn/shared/activity-surface-contracts";
import { useRoomStore } from "../../app/room-store";
import type { RoomIntent } from "../../app/room-machine";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { SurfaceDataState, useDayAnchor, useSurfaceProjection } from "./surface-data";
import {
  anomalyStep,
  buildTodayAnomalyGroups,
  buildTodayLogRows,
  buildTodayVerdict,
  sharedAnomalyStep,
  sortAnomalyGroups,
  todayAnomalyTruncationNote,
  todayLogTruncationNote,
  type TodayAnomalyGroup,
  type TodayLogRow,
  type TodayVerdict,
} from "./today-log";
import "./study-surface.css";

/**
 * Page 14 「今日学习」（2026-09-18 设计重构）。
 *
 * 上一版把这一页从"三张票的推荐位"改成了操作日志流 —— 方向是对的，但把日志
 * 流塞进了一个为老布局调过的壳里，于是留下三类问题（本次重构的输入）：
 *
 * 1. **信息层级倒置**：页面第一屏是一堵异常卡，×10（同一份笔记失败了 10 次）
 *    这个最带信息量的数字被压在 9.5px 的徽标里；而"今天到底做了几件事"只能
 *    去右栏找，右栏又和左栏说同一句话。
 * 2. **可读性损耗**：异常标题直接是笔记正文，`nowrap + ellipsis` 把它截成半句
 *    （"核心原理是记忆痕迹衰减与强化，每…"）；三张卡的第二行逐字相同；两条
 *    居中的小灰字道歉堆在页底。
 * 3. **交互断头**：只有异常、没有正向操作时（正是真实数据的常态）空态只给一句
 *    散文描述，没有任何出口 —— 而"整天都空"那一支却给了按钮，两条路径不一致。
 *
 * 重构后的层级（一屏之内先给判断，再给待办，最后才是流水）：
 * - **判断条**：今天记录了几件 / 几件待处理 / 从几点到几点 —— 数字先说话；
 * - **需要处理**：同一件事归并成"一摞"，最厚的一摞排最前，共用的处置语提到
 *   组头只说一次，超出预览条数就折叠；
 * - **今天的操作**：主叙事，时间线；空了就就地给真实出口；
 * - **伴星栏**：只讲它独有的那件事（伴星日记读的就是这条日志背后的同一批表）。
 */
function dayWindowFromAnchor(nowMs: number): { from: string; to: string } {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  // 不用 `+86_400_000`：跨夏令时的那天会偏出一小时。交给 Date 自己算次日午夜。
  const nextMidnight = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + 1);
  return { from: midnight.toISOString(), to: nextMidnight.toISOString() };
}

function todayDateLabel(nowMs: number): string {
  const now = new Date(nowMs);
  return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
}

function todayWeekdayLabel(nowMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(nowMs));
}

/** `day` 是页面自己查询的窗口锚点，用本地日历日 —— 不信服务端那条会差一天的字段。 */
function dayIso(nowMs: number): string {
  const now = new Date(nowMs);
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const date = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${date}`;
}

/** 每类事件一枚 lucide 图标 + 一味纸面色，整页图标语言保持同一套线性笔画。 */
const KIND_ICONS: Readonly<Record<TodayLogRow["kind"], typeof FileText>> = {
  note: FileText,
  source: BookOpen,
  objective: Compass,
  learning_run: Route,
  card_generation: Layers,
  job: Settings2,
  page: MousePointerClick,
};

const KIND_ICON_COLORS: Readonly<Record<TodayLogRow["kind"], string>> = {
  note: "#3b6a8f",
  source: "#55704f",
  objective: "#b05c33",
  learning_run: "#3f7d8a",
  card_generation: "#9a7a2e",
  job: "#6f5b4b",
  page: "#8a7969",
};

/** 分诊预览条数：超过这个数就折叠 —— 一堵 12 行的墙不是分诊，是罚站。 */
const TRIAGE_PREVIEW = 3;

/** 列表入场：每条错开 35ms，最多错开 8 条（再长就一起进来，不然末尾要等半秒）。 */
const ENTER_STAGGER_MS = 35;
const ENTER_STAGGER_CAP = 8;

function enterDelay(index: number): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, ENTER_STAGGER_CAP) * ENTER_STAGGER_MS}ms` };
}

/** 空一天的出口：两条路径（整天空 / 只有异常）共用同一组动作，不再一边有按钮一边没有。 */
const START_ACTIONS: readonly { readonly label: string; readonly intent: RoomIntent }[] = [
  { label: "写笔记", intent: "open-notebook" },
  { label: "收录来源", intent: "open-sources" },
  { label: "理解目标", intent: "open-objectives" },
];

/** 单条日志/异常的跳转按钮：target 为空时不给按钮，不给读者一条死路。 */
function EntryJump({
  target,
  label,
  action,
  onOpen,
}: {
  readonly target: ActivityTargetV1 | null;
  readonly label: string;
  readonly action: string;
  readonly onOpen: (target: ActivityTargetV1) => void;
}) {
  if (!target) return null;
  return (
    <button type="button" className="button day-jump" onClick={() => onOpen(target)} aria-label={`${action} ${label}`}>
      {action}
    </button>
  );
}

/**
 * 今日判断条：这一页第一眼要回答"今天怎么样"。
 *
 * 数字与判断分开放 —— 数字进 `<dl>`（一眼可读），判断句里不再重复同一个数。
 * 有一件待处理才给动作；"处理这 N 件"会把读者送到下面的分诊区。
 */
function DayVerdict({ verdict, onTriage }: { readonly verdict: TodayVerdict; readonly onTriage: () => void }) {
  return (
    <div className="day-verdict" data-pending={verdict.pending > 0 || undefined}>
      {verdict.metrics.length > 0 ? (
        <dl className="day-verdict__metrics">
          {verdict.metrics.map((metric) => (
            <div className="day-verdict__metric" key={metric.key} data-metric={metric.key} data-alarm={metric.alarm || undefined}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="day-verdict__copy">
        <b>{verdict.headline}</b>
        <span>{verdict.detail}</span>
      </div>

      {verdict.pending > 0 ? (
        <button type="button" className="button day-verdict__act" onClick={onTriage}>
          <TriangleAlert size={13} strokeWidth={2.2} aria-hidden="true" />
          处理这 {verdict.pending} 件
        </button>
      ) : null}
    </div>
  );
}

/**
 * 待处理事务分诊。
 *
 * 与上一版的三点差别，都针对实机数据里真实发生的事：
 * - 组按**体量**排序（最厚的一摞在前），因为处理一次的收益最大；
 * - 多数组共用的处置语提到组头说一次，卡片里不再逐行复读同一句话；
 * - 超过 3 类折叠，展开是显式动作，读者知道自己在要什么。
 */
function AnomalyTriage({
  groups,
  total,
  sharedStep,
  note,
  onOpen,
  anchorRef,
}: {
  readonly groups: readonly TodayAnomalyGroup[];
  readonly total: number;
  readonly sharedStep: string | null;
  readonly note: string | null;
  readonly onOpen: (target: ActivityTargetV1) => void;
  readonly anchorRef: Ref<HTMLElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  const overflow = groups.length - TRIAGE_PREVIEW;
  const collapsed = overflow > 0 && !expanded;
  const visible = collapsed ? groups.slice(0, TRIAGE_PREVIEW) : groups;

  return (
    <section className="day-triage" aria-label="待处理的事务" ref={anchorRef}>
      <p className="day-section-head">
        {/* 「待处理」与判断条那一枚数字同一套词：读者不必在两处之间做同义转换 */}
        <b>待处理</b>
        <span>{total} 件{groups.length < total ? ` · 归并为 ${groups.length} 类` : ""}</span>
      </p>

      {sharedStep ? <p className="day-triage__step">{sharedStep}</p> : null}

      <ul className="day-triage__list">
        {visible.map((group, index) => {
          const step = anomalyStep(group);
          return (
            <li
              className="day-anomaly day-enter"
              key={group.id}
              data-phase={group.phase}
              style={enterDelay(index)}
            >
              <span className="day-anomaly__icon" aria-hidden="true">
                {group.phase === "inflight" ? (
                  <LoaderCircle size={13} strokeWidth={2.2} />
                ) : (
                  <TriangleAlert size={13} strokeWidth={2.2} />
                )}
              </span>

              <div className="day-anomaly__main">
                <b className="day-anomaly__title">{group.title}</b>
                <span className="day-anomaly__meta">
                  {group.count > 1 ? (
                    // 只写 ×10 会被读成"10 张卡"；写清是同一件事被记了 10 条。
                    <span className="day-anomaly__count" title={`同一件事记了 ${group.count} 条`}>
                      同一件事 ×{group.count}
                    </span>
                  ) : null}
                  {/* 处置语与组头相同就不再复读；不同才在这里说这一组自己的话。 */}
                  {step === sharedStep ? null : <span className="day-anomaly__step">{step}</span>}
                  {group.target ? null : (
                    <span className="day-anomaly__stuck">服务端没能定位到现场，只能在这里看</span>
                  )}
                </span>
              </div>

              <EntryJump target={group.target} label={group.title} action="去处理" onOpen={onOpen} />
            </li>
          );
        })}
      </ul>

      {overflow > 0 ? (
        <button
          type="button"
          className="day-triage__more"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "只留最厚的三类" : `还有 ${overflow} 类待处理`}
        </button>
      ) : null}

      {note ? <p className="day-log__note">{note}</p> : null}
    </section>
  );
}

/** 今天的操作：主叙事。空了就地给出口，不把读者丢在一条断头路上。 */
function LogStream({
  rows,
  note,
  onOpen,
  onPick,
}: {
  readonly rows: readonly TodayLogRow[];
  readonly note: string | null;
  readonly onOpen: (target: ActivityTargetV1) => void;
  readonly onPick: (intent: RoomIntent) => void;
}) {
  return (
    <section className="day-stream" aria-label="今天的操作">
      <p className="day-section-head">
        <b>今天的操作</b>
        <span>{rows.length > 0 ? `${rows.length} 条 · 按时间倒序` : "还没有记录"}</span>
      </p>

      {rows.length > 0 ? (
        <>
          <ol className="day-log__stream" aria-label="今日操作日志">
            {rows.map((row, index) => {
              const Icon = KIND_ICONS[row.kind];
              return (
                <li
                  className="day-log__entry day-enter"
                  key={row.id}
                  data-kind={row.kind}
                  style={enterDelay(index)}
                >
                  <time className="day-log__time" dateTime={row.at}>{row.time}</time>
                  <span
                    className="day-log__node"
                    aria-hidden="true"
                    style={{ color: KIND_ICON_COLORS[row.kind] }}
                  >
                    <Icon size={13} strokeWidth={2.2} />
                  </span>
                  <div className="day-log__body">
                    <b>
                      <span className="sr-only">{row.kindLabel} · </span>
                      {row.action} · {row.title}
                    </b>
                    {row.detail ? <small>{row.detail}</small> : null}
                  </div>
                  <EntryJump
                    target={row.target}
                    label={`${row.action} ${row.title}`}
                    action="查看"
                    onOpen={onOpen}
                  />
                </li>
              );
            })}
          </ol>
          {note ? <p className="day-log__note">{note}</p> : null}
        </>
      ) : (
        <div className="day-stream__empty">
          <b>今天还没有正向操作</b>
          <p>从下面任意一件事开始，做过的事都会按时间排在这里。</p>
          <div className="actions">
            {START_ACTIONS.map((action) => (
              <button key={action.intent} type="button" className="button" onClick={() => onPick(action.intent)}>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 伴星栏。
 *
 * 上一版这里是"今日概要"，内容是左栏底部那句话的复述（"今天还没有留下记录"），
 * 252px 的栏里 60% 是空的。删掉复述之后，这一栏只剩它真正独有的东西：伴星日记
 * 的入口，以及它和这条日志的关系（读的是同一批权威表）。
 */
function CompanionRail({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <aside className="day-rail" aria-label="伴星">
      <span className="tag">伴星</span>
      <div className="day-rail__card">
        <b>
          <Sparkles size={13} strokeWidth={2.2} aria-hidden="true" />
          伴星日记
        </b>
        <p>伴星每天凌晨 1 点，把昨天的学习与对话整理成一篇日记。</p>
        <p className="day-rail__why">它读的正是这一页背后的同一批记录。</p>
        <button type="button" className="button" onClick={onOpen}>打开伴星</button>
      </div>
    </aside>
  );
}

export function StudySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  useHudPage("today");

  // 日锚点先于数据读取确定：窗口是"读者的今天"，刷新焦点时页面会自己跟上
  // 跨午夜的变化（useDayAnchor 在可见性恢复/跨天时重锚）。
  const nowMs = useDayAnchor();
  const dayWindow = useMemo(() => dayWindowFromAnchor(nowMs), [nowMs]);

  const { data, loading, failure, reload } = useSurfaceProjection<TodayActivityV1>(async ({ workspaceEpoch }) => {
    const meta = createRequestMeta(workspaceEpoch);
    const result = await window.ailearn.activity.getToday({ meta, from: dayWindow.from, to: dayWindow.to });
    return unwrapGatewayResult(result);
  }, [dayWindow.from, dayWindow.to], { refreshOnFocus: true });

  const rows: readonly TodayLogRow[] = useMemo(() => (data ? buildTodayLogRows(data.events) : []), [data]);
  const groups: readonly TodayAnomalyGroup[] = useMemo(
    () => (data ? sortAnomalyGroups(buildTodayAnomalyGroups(data.anomalies)) : []),
    [data],
  );
  const verdict = useMemo(() => (data ? buildTodayVerdict(data) : null), [data]);
  const sharedStep = useMemo(() => sharedAnomalyStep(groups), [groups]);
  const logNote = useMemo(() => (data ? todayLogTruncationNote(data) : null), [data]);
  const anomalyNote = useMemo(() => (data ? todayAnomalyTruncationNote(data) : null), [data]);

  const triageRef = useRef<HTMLElement>(null);
  // 滚动交给容器的 `scroll-behavior`（CSS 里在 reduced-motion 下退回 auto），
  // 这样"要不要平滑"只在一处决定，不在 JS 里再抄一遍动效偏好。
  const scrollToTriage = () => triageRef.current?.scrollIntoView({ block: "start" });

  const openTarget = (target: ActivityTargetV1) => {
    switch (target.kind) {
      case "review":
        invoke("review");
        return;
      case "objective":
        setActiveObjectiveId(target.id);
        invoke("open-objective");
        return;
      case "note":
        setActiveNoteRef({ noteId: target.id, noteVersionId: target.noteVersionId });
        invoke("open-notebook");
        return;
      case "card_generation":
        setActiveCardGenerationRunId(target.id);
        invoke("open-card-generation");
        return;
      case "source":
        setActiveSourceId(target.id);
        invoke("open-source");
        return;
    }
  };

  const reading = loading || Boolean(failure);

  return (
    <HudPage page="today">
      {/* 外壳 chip 已经是这一页的标题（今日学习 + 副标题），页内再放一个大标题
          只会把同一句话说两遍；这里换成一枚日期行，它才是这一页独有的东西。 */}
      <section className="day-route" data-page="today-log" aria-label="今日学习">
        <div className="day-head">
          <p className="day-head__date">
            <time dateTime={dayIso(nowMs)}>{todayDateLabel(nowMs)}</time>
            <span>{todayWeekdayLabel(nowMs)}</span>
          </p>
          {reading ? null : (
            <button
              type="button"
              className="button day-head__refresh"
              onClick={() => void reload({ silent: true })}
              disabled={loading}
              aria-label="重新读取今天的操作日志"
            >
              <RefreshCw size={13} strokeWidth={2.2} aria-hidden="true" />
              刷新
            </button>
          )}
        </div>

        {reading ? (
          <div className="day-route__state">
            {loading ? (
              <SurfaceDataState
                kind="loading"
                message="正在读取今天的操作日志"
                detail="日志由服务端从笔记、来源、理解目标与学习旅程的权威记录投影而来。"
              />
            ) : (
              <SurfaceDataState
                kind="error"
                message="今天的操作日志暂时不可用"
                detail={failure ?? ""}
                onRetry={() => void reload()}
              />
            )}
          </div>
        ) : verdict ? (
          <>
            <DayVerdict verdict={verdict} onTriage={scrollToTriage} />

            <div className="day-log" tabIndex={0} role="group" aria-label="今日操作日志与待处理事务">
              {groups.length > 0 ? (
                <AnomalyTriage
                  groups={groups}
                  total={data?.anomalies.length ?? groups.length}
                  sharedStep={sharedStep}
                  note={anomalyNote}
                  onOpen={openTarget}
                  anchorRef={triageRef}
                />
              ) : null}

              <LogStream rows={rows} note={logNote} onOpen={openTarget} onPick={invoke} />
            </div>

            <CompanionRail onOpen={() => invoke("open-companion-center")} />
          </>
        ) : null}
      </section>
    </HudPage>
  );
}
