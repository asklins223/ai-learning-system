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
import { SETTINGS_ATTENTION_AI_CONSENT } from "../../app/companion-consent-gate";
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
 * - **需要处理**：只归并同一目标上的同类记录，可执行项在前，共用的处置语提到
 *   组头只说一次，超出两个预览项就折叠；
 * - **学习记录**：主叙事时间线；派生系统活动默认收起，空了就就地给真实出口；
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

/** 首屏只预览两个处理项，给真正的学习记录留出可见空间。 */
const TRIAGE_PREVIEW = 2;

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
 * 有一件待处理才给动作；按钮会把读者送到下面的分诊区并转移键盘焦点。
 */
function DayVerdict({
  verdict,
  triageCount,
  onTriage,
}: {
  readonly verdict: TodayVerdict;
  readonly triageCount: number;
  readonly onTriage: () => void;
}) {
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
        <button type="button" className="button primary day-verdict__act" onClick={onTriage}>
          <TriangleAlert size={13} strokeWidth={2.2} aria-hidden="true" />
          查看 {triageCount} 个处理项
        </button>
      ) : null}
    </div>
  );
}

/**
 * 待处理事务分诊。
 *
 * 与上一版的三点差别，都针对实机数据里真实发生的事：
 * - 可执行项优先，再按**体量**排序，先给读者真正能处理的出口；
 * - 多数组共用的处置语提到组头说一次，卡片里不再逐行复读同一句话；
 * - 超过 2 项折叠，展开是显式动作，避免分诊墙把学习主线推到首屏之外。
 */
function AnomalyTriage({
  groups,
  total,
  sharedStep,
  note,
  onOpen,
  onRecover,
  anchorRef,
}: {
  readonly groups: readonly TodayAnomalyGroup[];
  readonly total: number;
  readonly sharedStep: string | null;
  readonly note: string | null;
  readonly onOpen: (target: ActivityTargetV1) => void;
  readonly onRecover: (recovery: TodayAnomalyGroup["recovery"]) => void;
  readonly anchorRef: Ref<HTMLElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  const overflow = groups.length - TRIAGE_PREVIEW;
  const collapsed = overflow > 0 && !expanded;
  const visible = collapsed ? groups.slice(0, TRIAGE_PREVIEW) : groups;

  return (
    <section className="day-triage" aria-labelledby="today-triage-title" ref={anchorRef} tabIndex={-1}>
      <h2 className="day-section-head" id="today-triage-title">
        <b>待处理</b>
        <span>{groups.length} 项{groups.length < total ? ` · 共 ${total} 条记录` : ""}</span>
      </h2>

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
                    <span className="day-anomaly__count" title={`同类系统记录 ${group.count} 条`}>
                      同类记录 ×{group.count}
                    </span>
                  ) : null}
                  {/* 处置语与组头相同就不再复读；不同才在这里说这一组自己的话。 */}
                  {step === sharedStep ? null : <span className="day-anomaly__step">{step}</span>}
                  {group.target || group.recovery ? null : (
                    <span className="day-anomaly__stuck">这条记录没有可直接打开的位置</span>
                  )}
                </span>
              </div>

              {group.recovery ? (
                <button
                  type="button"
                  className="button day-jump"
                  onClick={() => onRecover(group.recovery)}
                  aria-label={`去设置处理 ${group.title}`}
                >
                  去设置
                </button>
              ) : (
                <EntryJump target={group.target} label={group.title} action="去处理" onOpen={onOpen} />
              )}
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
          {expanded ? "收起" : `还有 ${overflow} 个处理项`}
        </button>
      ) : null}

      {note ? <p className="day-log__note">{note}</p> : null}
    </section>
  );
}

function LogRows({
  rows,
  ariaLabel,
  onOpen,
}: {
  readonly rows: readonly TodayLogRow[];
  readonly ariaLabel: string;
  readonly onOpen: (target: ActivityTargetV1) => void;
}) {
  return (
    <ol className="day-log__stream" aria-label={ariaLabel}>
      {rows.map((row, index) => {
        const Icon = KIND_ICONS[row.kind];
        return (
          <li className="day-log__entry day-enter" key={row.id} data-kind={row.kind} style={enterDelay(index)}>
            <time className="day-log__time" dateTime={row.at}>{row.time}</time>
            <span className="day-log__node" aria-hidden="true">
              <Icon size={13} strokeWidth={2.2} />
            </span>
            <div className="day-log__body">
              {row.headline.includes(row.kindLabel) ? null : (
                <span className="sr-only">{row.kindLabel} · </span>
              )}
              <b>{row.headline}</b>
              {row.detail ? <small>{row.detail}</small> : null}
            </div>
            <EntryJump target={row.target} label={row.headline} action="查看" onOpen={onOpen} />
          </li>
        );
      })}
    </ol>
  );
}

/** 学习记录是主叙事；派生 job 保留可查，但默认收在“系统活动”里。 */
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
  const [systemExpanded, setSystemExpanded] = useState(false);
  const learningRows = rows.filter((row) => row.kind !== "job");
  const systemRows = rows.filter((row) => row.kind === "job");

  return (
    <section className="day-stream" aria-labelledby="today-learning-log-title">
      <h2 className="day-section-head" id="today-learning-log-title">
        <b>学习记录</b>
        <span>{learningRows.length > 0 ? `${learningRows.length} 条 · 最新的在最上面` : "还没有记录"}</span>
      </h2>

      {learningRows.length > 0 ? (
        <LogRows rows={learningRows} ariaLabel="今日学习记录" onOpen={onOpen} />
      ) : (
        <div className="day-stream__empty">
          <b>从这里开始</b>
          <p>从下面任意一件事开始，真正的学习记录会按时间排在这里。</p>
          <div className="actions">
            {START_ACTIONS.map((action) => (
              <button key={action.intent} type="button" className="button" onClick={() => onPick(action.intent)}>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {systemRows.length > 0 ? (
        <section className="day-system" aria-labelledby="today-system-log-title">
          <button
            type="button"
            className="day-system__toggle"
            aria-expanded={systemExpanded}
            aria-controls="today-system-log"
            onClick={() => setSystemExpanded((value) => !value)}
          >
            <span>
              <b id="today-system-log-title">系统活动</b>
              <small>{systemRows.length} 条派生处理，不计入学习记录</small>
            </span>
            <span aria-hidden="true">{systemExpanded ? "收起" : "展开"}</span>
          </button>
          {systemExpanded ? (
            <div id="today-system-log">
              <LogRows rows={systemRows} ariaLabel="今日系统活动" onOpen={onOpen} />
            </div>
          ) : null}
        </section>
      ) : null}

      {note ? <p className="day-log__note">{note}</p> : null}
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
        <h2>
          <Sparkles size={13} strokeWidth={2.2} aria-hidden="true" />
          伴星日记
        </h2>
        <p>伴星每天凌晨 1 点，把昨天的学习与对话整理成一篇日记。</p>
        <p className="day-rail__why">它整理的就是这一页上的这些记录。</p>
        <button type="button" className="button" onClick={onOpen}>打开伴星</button>
      </div>
    </aside>
  );
}

export function StudySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  useHudPage("today");

  // 日锚点先于数据读取确定：窗口是"读者的今天"，刷新焦点时页面会自己跟上
  // 跨午夜的变化（useDayAnchor 在可见性恢复/跨天时重锚）。
  const nowMs = useDayAnchor();
  const dayWindow = useMemo(() => dayWindowFromAnchor(nowMs), [nowMs]);

  const { data, loading, failure, refreshing, refreshFailure, reload } = useSurfaceProjection<TodayActivityV1>(async ({ workspaceEpoch }) => {
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
  const scrollToTriage = () => {
    triageRef.current?.scrollIntoView({ block: "start" });
    triageRef.current?.focus({ preventScroll: true });
  };

  const openTarget = (target: ActivityTargetV1) => {
    switch (target.kind) {
      case "learning_run":
        setActiveRunId(target.id);
        invoke("validate");
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

  const recoverAnomaly = (recovery: TodayAnomalyGroup["recovery"]) => {
    if (recovery !== "ai_consent") return;
    setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    setSettingsSection("data");
    invoke("open-settings");
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
            <div className="day-head__actions">
              {refreshFailure ? (
                <span className="day-head__refresh-failure" role="status">
                  刷新失败，仍显示上次结果
                </span>
              ) : null}
              <button
                type="button"
                className="button day-head__refresh"
                onClick={() => void reload({ silent: true })}
                disabled={refreshing}
                aria-label="重新读取今日学习记录"
                aria-busy={refreshing}
              >
                <RefreshCw size={13} strokeWidth={2.2} aria-hidden="true" />
                {refreshing ? "刷新中" : "刷新"}
              </button>
            </div>
          )}
        </div>

        {reading ? (
          <div className="day-route__state">
            {loading ? (
              <SurfaceDataState
                kind="loading"
                message="正在读取今天的操作日志"
                detail="内容来自你的笔记、来源、目标和学习旅程的真实记录。"
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
            <DayVerdict verdict={verdict} triageCount={groups.length} onTriage={scrollToTriage} />

            <div className="day-log" tabIndex={0} role="group" aria-label="今日操作日志与待处理事务">
              {groups.length > 0 ? (
                <AnomalyTriage
                  groups={groups}
                  total={data?.anomalies.length ?? groups.length}
                  sharedStep={sharedStep}
                  note={anomalyNote}
                  onOpen={openTarget}
                  onRecover={recoverAnomaly}
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
