import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Archive, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Database, Download, MessageCircle, Pencil, Pin, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import type { CompanionActivityDeliveryV1, CompanionActivityTimelineV1, CompanionDailyFailureReasonV1, CompanionDailySummaryV1, CompanionExportKindV1, CompanionHistoryItemV1, CompanionMemoryItemV1, CompanionMemoryKindV1, CompanionPersonaProfileV1, CompanionPersonaPresetV1, CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { CompanionJourneyAction, CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import { CompanionQuoteBlock, CompanionRecordImage, MonthCalendar } from "../companion/CompanionChatRecord";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select";
import { diaryDayLabel, shiftIsoDate, todayIsoDate } from "./companion-diary-day";
import { formatDate, formatRelative } from "./surface-data";

export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export const MEMORY_KIND_LABEL: Record<CompanionMemoryKindV1, string> = {
  preference: "偏好", goal: "目标", learning_context: "学习线索", interaction_note: "互动观察", episodic: "共同经历",
};
export const MEMORY_STATE_LABEL: Record<string, string> = {
  candidate: "待确认", active: "已写入", pinned: "已固定", archived: "已归档", linked: "真实关联", orphaned: "关联失效",
};

/**
 * 「这一天她没能写下来」的三种成因（0250 的 failure_reason）。
 *
 * 旧文案只有一句"生成失败"，用户分不清是自己没开设置还是我们出了问题；
 * 那句「可稍后重试读取」也是假话——读取不会触发重新生成，只有第二天会。
 * `unknown` 是这次改动之前写下的失败行（当时没有成因这一列）。
 */
const DIARY_FAILURE_DETAIL: Record<CompanionDailyFailureReasonV1 | "unknown", string> = {
  consent_required: "日记要由她来写，而「允许发送到外部模型服务」没有开启。开启后从第二天开始写。",
  model_unavailable: "她试了几次没写出来，明天会再试。",
  diary_output_invalid: "她写回来的东西还是在报数，不像日记，没有收下来。",
  unknown: "不会用推测内容填充这一天。",
};
// 「导出记忆」和「导出操作记录」曾经共用同一句副标题，三个按钮看上去
// 像同一件事的三个副本；各自说清自己带走哪些表。
const EXPORT_COPY: Record<CompanionExportKindV1, { label: string; detail: string }> = {
  all: { label: "导出全部伴星数据", detail: "记忆、对话、人格与操作记录的完整副本" },
  memory: { label: "导出记忆", detail: "只含记忆条目与星图关系" },
  audit: { label: "导出操作记录", detail: "只含安全操作与邀请记录" },
};
const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "语气标签", "允许回复携带表演语气"],
] as const;

export const MEMORY_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<CompanionMemoryKindV1>> = (
  Object.entries(MEMORY_KIND_LABEL) as Array<[CompanionMemoryKindV1, string]>
).map(([value, label]) => ({ value, label }));

const MEMORY_LIST_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];
const MEMORY_PIN_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | "pinned" | "candidate">> = [
  { value: "all", label: "全部状态" },
  { value: "candidate", label: "待确认" },
  { value: "pinned", label: "已固定" },
];

const JOURNEY_STEP_LABEL: Record<string, string> = {
  boundary_intro: "了解使用边界",
  preference_capture: "记录学习偏好",
  goal_capture: "确认学习卡",
  choose_start: "选择开始方式",
  first_source: "添加第一份材料",
  source_processing: "整理材料",
  first_note: "写下第一篇笔记",
  first_card: "生成第一张学习卡",
  first_evidence: "补充第一条证据",
  first_run: "完成第一次理解验证",
  first_schedule: "安排第一次复习",
  sample_orientation: "熟悉示例空间",
  closing: "完成旅程",
};
const JOURNEY_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  skipped: "已结束",
  completed: "已完成",
  recoverable_error: "需要重试",
};
const JOURNEY_BRANCH_LABEL: Record<string, string> = {
  own_material: "使用自己的材料",
  blank_note: "从空白笔记开始",
  sandbox_sample: "使用示例材料",
};

function messageText(item: CompanionHistoryItemV1): string {
  return item.blocks.map((block) => block.type === "text" ? block.text : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n");
}
function memoryState(item: CompanionMemoryItemV1) {
  if (item.archived) return "archived";
  if (item.candidate) return "candidate";
  return item.pinned ? "pinned" : "active";
}

/**
 * 气泡里的段落节奏（B4，评审 §6 从 B3 接的那一条）。
 *
 * 服务端把整条回复作为一个字符串送回来，里面带着模型自己写的 `\n\n\n`；气泡是
 * `white-space: pre-wrap`，于是每个换行都排成一行，一段话中间出现三行高的空档
 * （实测那条 h=225、单个 `<p>`、6 个换行）。这里只按「两个及以上连续换行」切段，
 * 段与段之间的节奏交回 CSS；**段内的单个换行是作者自己的换行，原样留着**，
 * 不吞内容。
 */
function paragraphLines(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

export function SectionState({ message, detail, onRetry }: { readonly message: string; readonly detail?: string; readonly onRetry?: () => void }) {
  return <div className="companion-section-state" role="status"><strong>{message}</strong>{detail ? <span>{detail}</span> : null}{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={14} />重新读取</button> : null}</div>;
}

type MemoryPanelProps = {
  section: Section<{ version: 2; items: CompanionMemoryItemV1[] }>; items: CompanionMemoryItemV1[]; focus: CompanionMemoryItemV1 | null;
  query: string; kind: "all" | CompanionMemoryKindV1; pinFilter: "all" | "pinned" | "candidate"; busy: string | null; error: string | null; notice: string | null;
  confirmDelete: boolean; createOpen: boolean; createContent: string; createKind: CompanionMemoryKindV1; correctionOpen: boolean; correctionContent: string;
  onQuery: (value: string) => void; onKind: (value: "all" | CompanionMemoryKindV1) => void; onPinFilter: (value: "all" | "pinned" | "candidate") => void;
  onFocus: (id: string) => void; onAction: (action: "confirm" | "pin" | "unpin" | "archive" | "restore" | "dismiss" | "remove") => void;
  onConfirmDelete: (value: boolean) => void; onCreateOpen: (value: boolean) => void; onCreateContent: (value: string) => void; onCreateKind: (value: CompanionMemoryKindV1) => void; onCreate: () => void; onSummarize: () => void; onCorrectionOpen: (value: boolean) => void; onCorrectionContent: (value: string) => void; onCorrect: () => void; onRetry: () => void;
};
export function MemoryPanel(props: MemoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focus) return;
    const selected = panelRef.current?.querySelector<HTMLElement>('.companion-record-list > button[aria-pressed="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [props.focus?.memoryItemId]);
  useEffect(() => {
    const selector = props.correctionOpen ? ".companion-memory-detail .companion-inline-form" : props.createOpen ? ":scope > .companion-inline-form" : null;
    if (!selector) return;
    const form = panelRef.current?.querySelector(selector);
    if (!form) return;
    // 便签在滚动列表里展开：整块表单（含保存按钮）要滚进可视区，否则主按钮被面板底边裁掉。
    form.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [props.correctionOpen, props.createOpen]);
  if (!props.section.ok) return <SectionState message="记忆列表当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const visible = props.items.filter((item) => (props.kind === "all" || item.kind === props.kind) && (props.pinFilter === "all" || props.pinFilter === "pinned" && item.pinned || props.pinFilter === "candidate" && item.candidate) && (!props.query.trim() || item.content.toLowerCase().includes(props.query.trim().toLowerCase())))
    .sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.updatedAt.localeCompare(a.updatedAt));
  return <div ref={panelRef} className="companion-panel-stack"><div className="companion-panel-heading"><div className="companion-heading-actions"><button type="button" disabled={props.busy !== null} data-busy={props.busy === "summarize" || undefined} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button><button type="button" onClick={() => props.onCreateOpen(!props.createOpen)}>{props.createOpen ? "取消" : "手动添加"}</button></div></div>
    {props.createOpen ? <div className="companion-inline-form"><CompanionSelect paper ariaLabel="新记忆类型" value={props.createKind} options={MEMORY_KIND_OPTIONS} onChange={props.onCreateKind} /><textarea value={props.createContent} maxLength={200} onChange={(event) => props.onCreateContent(event.target.value)} placeholder="写下希望伴星长期记住的事实" aria-label="新记忆内容" /><button type="button" className="primary" disabled={!props.createContent.trim() || props.busy !== null} data-busy={props.busy === "create" || undefined} onClick={props.onCreate}>{props.busy === "create" ? "正在保存…" : "保存记忆"}</button></div> : null}
    <label className="companion-search"><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="筛选记忆列表" aria-label="筛选记忆列表" />{props.query ? <button type="button" className="companion-search__clear" onClick={() => props.onQuery("")} aria-label="清空记忆列表搜索"><X size={13} /></button> : null}</label>
    <div className="companion-filter-group" role="group" aria-label="记忆列表筛选"><span>列表</span><CompanionSelect paper ariaLabel="筛选记忆列表类型" value={props.kind} options={MEMORY_LIST_KIND_OPTIONS} onChange={props.onKind} /><CompanionSelect paper ariaLabel="筛选记忆列表状态" value={props.pinFilter} options={MEMORY_PIN_OPTIONS} onChange={props.onPinFilter} /></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
  {(() => {
    const detailCard = props.focus ? (<article className="companion-memory-detail"><div className="companion-memory-detail__meta"><span>{MEMORY_KIND_LABEL[props.focus.kind]}</span><span>{MEMORY_STATE_LABEL[memoryState(props.focus)]}</span><span>重要度 {Math.round(props.focus.importance * 100)}%</span></div>{props.correctionOpen ? <div className="companion-inline-form"><textarea value={props.correctionContent} maxLength={200} onChange={(event) => props.onCorrectionContent(event.target.value)} aria-label="纠正后的记忆内容" /><div className="companion-action-row"><button type="button" className="primary" disabled={!props.correctionContent.trim() || props.correctionContent.trim() === props.focus.content || props.busy !== null} data-busy={props.busy === "correct" || undefined} onClick={props.onCorrect}>{props.busy === "correct" ? "正在纠正…" : "保存为待确认记忆"}</button><button type="button" onClick={() => props.onCorrectionOpen(false)}>取消</button></div></div> : <strong>{props.focus.content}</strong>}<small>更新于 {formatRelative(props.focus.updatedAt)}</small><div className="companion-action-row">{props.focus.candidate ? <button type="button" className="primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>确认写入</button> : null}{!props.focus.candidate && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.pinned ? "unpin" : "pin")}><Pin size={13} />{props.focus.pinned ? "取消固定" : "固定"}</button> : null}{!props.correctionOpen && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={13} />纠正</button> : null}{!props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.archived ? "restore" : "archive")}><Archive size={13} />{props.focus.archived ? "恢复" : "归档"}</button> : null}{props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button> : null}<MemoryDeleteAction active={props.confirmDelete} busy={props.busy !== null} onOpen={() => props.onConfirmDelete(true)} onCancel={() => props.onConfirmDelete(false)} onConfirm={() => props.onAction("remove")} /></div></article>) : null;
  return <div className="companion-memory-workspace">
    <div className="companion-record-list" aria-label="记忆列表">{visible.length === 0 ? <div className="companion-empty-with-action"><SectionState message="没有符合条件的记忆" detail="清空筛选或手动添加一条记忆。" /><button type="button" onClick={() => { props.onQuery(""); props.onKind("all"); props.onPinFilter("all"); }}>清除筛选</button></div> : visible.map((item) => <button key={item.memoryItemId} type="button" aria-pressed={props.focus?.memoryItemId === item.memoryItemId} className={[props.focus?.memoryItemId === item.memoryItemId ? "is-selected" : null, item.archived ? "is-archived" : null].filter(Boolean).join(" ") || undefined} onClick={() => props.onFocus(item.memoryItemId)}><strong>{item.content}</strong><span><i className={`is-${memoryState(item)}`} aria-hidden="true" /><em>{MEMORY_KIND_LABEL[item.kind]}</em>· {MEMORY_STATE_LABEL[memoryState(item)]} · {formatRelative(item.updatedAt)}</span></button>)}</div>
    <aside className="companion-memory-focus" aria-label="所选记忆详情">{detailCard ?? <SectionState message="选择一条记忆" detail="查看它的内容与可用操作。" />}</aside>
  </div>;
  })()}
  </div>;
}

type DialoguePanelProps = { section: Section<{ version: 1; items: CompanionHistoryItemV1[]; nextCursor: string | null }>; items: CompanionHistoryItemV1[]; cursor: string | null; query: string; searching: boolean; loadingMore: boolean; error: string | null; onQuery: (value: string) => void; onSearch: () => void; onLoadMore: () => void; onContinue: () => void; onRetry: () => void };
export function DialoguePanel(props: DialoguePanelProps) {
  if (!props.section.ok) return <SectionState message="连续对话当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><h3>连续对话</h3><p>按全局时间排列；内部数据分段不会显示在这里。</p><button type="button" className="primary" onClick={props.onContinue}><MessageCircle size={14} />继续交流</button></div><form className="companion-search" onSubmit={(event) => { event.preventDefault(); props.onSearch(); }}><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索全部对话正文" aria-label="搜索全部对话正文" /><button type="submit" disabled={props.searching}>{props.searching ? "搜索中" : "搜索"}</button></form><p className="companion-result-status" aria-live="polite">{props.searching ? "正在搜索对话" : props.query.trim() ? `找到 ${props.items.length} 条对话` : ""}</p>{props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}{props.cursor ? <button type="button" className="companion-load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "正在读取更早记录…" : "加载更早记录"}</button> : null}<div className="companion-thread">{props.items.length === 0 ? <SectionState message="还没有对话记录" detail="开始交流后，消息会连续出现在这里。" /> : props.items.map((item) => <article key={item.messageId} tabIndex={-1} className={`is-${item.role}`} id={`companion-message-${item.messageId}`}><span><b>{item.role === "user" ? "你" : item.role === "assistant" ? "伴星" : "系统"}</b><time>{formatRelative(item.createdAt)}</time></span>{paragraphLines(messageText(item) || "这条记录不含可展示正文。").map((paragraph, index) => <p key={index}>{paragraph}</p>)}{item.kind === "cancelled" ? <small>这是一条被你停止的未完成回复。</small> : null}</article>)}</div></div>;
}

type ActivityPanelProps = {
  section: Section<CompanionJourneyBootstrap>;
  learningContextSection: Section<CompanionLearningContextV1>;
  deliverySection: Section<CompanionActivityTimelineV1>;
  deliveries: CompanionActivityDeliveryV1[];
  busy: boolean;
  error: string | null;
  onStart: (kind: "start_journey" | "replay") => void;
  onAction: (action: CompanionJourneyAction) => void;
  onResumeLearning: (runId: string) => void;
  onOpenObjective: (objectiveId: string) => void;
  onPresent: (item: CompanionActivityDeliveryV1) => void;
  onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
  onRetry: () => void;
};

/** 还能被处理的投递：其余（已处理 / 已忽略 / 已失效）都收进历史组。 */
const DELIVERY_PENDING_STATES: ReadonlyArray<CompanionActivityDeliveryV1["state"]> = ["queued", "delivered", "displayed"];
function isPendingDelivery(item: CompanionActivityDeliveryV1): boolean {
  return !item.expired && DELIVERY_PENDING_STATES.includes(item.state);
}

export function ActivityPanel(props: ActivityPanelProps) {
  const journeyState = props.section.ok ? props.section.value : null;
  const learningContext = props.learningContextSection.ok ? props.learningContextSection.value : null;
  const resumeCandidate = learningContext?.learningRunResumeCandidate ?? null;
  const startCandidate = learningContext?.learningRunStartCandidate ?? null;
  const pending = props.deliveries.filter(isPendingDelivery);
  const resolved = props.deliveries.filter((item) => !isPendingDelivery(item));

  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>动态</h3><p>邀请、旅程与主动状态只列出系统允许你做的动作。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}

    <section className="companion-activity-feed" aria-label="学习衔接">
      <h4>继续学习</h4>
      {!props.learningContextSection.ok
        ? <SectionState message="学习上下文当前不可用" detail={props.learningContextSection.message} onRetry={props.onRetry} />
        : resumeCandidate
          ? <article className="companion-activity-card"><div><strong>{resumeCandidate.title}</strong><p>{resumeCandidate.targetSummary}</p><small>{resumeCandidate.impactSummary}</small></div><button type="button" className="primary" onClick={() => props.onResumeLearning(resumeCandidate.runId)}>继续学习</button></article>
          : startCandidate
            ? <article className="companion-activity-card"><div><strong>{startCandidate.title}</strong><p>{startCandidate.targetSummary}</p><small>{startCandidate.impactSummary}</small></div><button type="button" onClick={() => props.onOpenObjective(startCandidate.objectiveId)}>查看目标</button></article>
            : <SectionState message="当前没有可继续的学习" detail="这里只列出系统从真实学习状态里挑出的候选。" />}
    </section>

    <section className="companion-activity-feed" aria-label="伴星旅程">
      <h4>伴星旅程</h4>
      {!journeyState ? <SectionState message="旅程当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} /> : <>
        {(journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") && !journeyState.journey ? <article className="companion-activity-card"><Sparkles size={18} /><div><strong>开始第一段学习旅程</strong><p>从你自己的资料开始，伴星会跟随真实进度。</p></div><button type="button" className="primary" disabled={props.busy} onClick={() => props.onStart("start_journey")}>开始旅程</button></article> : null}
        {journeyState.invitation.status === "skipped" && !journeyState.journey ? <article className="companion-activity-card"><div><strong>旅程邀请已跳过</strong><p>需要时可以重新开始，不会补造任何里程碑。</p></div><button type="button" disabled={props.busy} onClick={() => props.onStart("replay")}>重新邀请</button></article> : null}
        {journeyState.journey ? <article className="companion-activity-card is-journey"><div><strong>{journeyState.journey.currentStep ? `当前步骤：${JOURNEY_STEP_LABEL[journeyState.journey.currentStep] ?? "继续学习旅程"}` : "旅程状态"}</strong><p>{journeyState.journey.status === "recoverable_error" ? "这一步暂时没有完成，可以直接重试。" : `${JOURNEY_STATUS_LABEL[journeyState.journey.status] ?? "状态已更新"} · ${JOURNEY_BRANCH_LABEL[journeyState.journey.branch] ?? "当前学习路径"}`}</p></div><div className="companion-action-row">{journeyState.journey.status === "active" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "pause" })}>暂停</button> : null}{journeyState.journey.status === "paused" ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "resume", resumeToken: journeyState.journey!.resumeTokenRef })}>继续</button> : null}{journeyState.journey.status === "recoverable_error" && journeyState.journey.error?.retryable ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "retry" })}>重试</button> : null}{journeyState.journey.status === "active" || journeyState.journey.status === "paused" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "skip" })}>结束旅程</button> : null}</div></article> : null}
        {/* 旅程是空间级的：另一个空间的旅程不在这里露出（2026-09-22 裁决）。 */}
        {!journeyState.journey && journeyState.invitation.status === "accepted" ? <SectionState message="目前没有进行中的旅程" detail="新的状态更新会在这里出现。" /> : null}
      </>}
    </section>

    <section className="companion-activity-feed companion-activity-feed--inbox" aria-label="主动投递与状态更新">
      <h4>最近动态</h4>
      {!props.deliverySection.ok
        ? <SectionState message="主动投递当前不可用" detail={props.deliverySection.message} onRetry={props.onRetry} />
        : props.deliveries.length === 0
          ? <SectionState message="目前没有新的动态" detail="新的邀请、主动投递和状态更新会出现在这里。" />
          : <>
            {pending.length > 0
              ? pending.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)
              : <SectionState message="没有待处理的动态" detail="处理完的会收进下面的历史记录。" />}
            {resolved.length > 0 ? <details className="companion-delivery-group">
              <summary>历史动态 · {resolved.length} 条</summary>
              <div>{resolved.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)}</div>
            </details> : null}
          </>}
    </section>
  </div>;
}

function ActivityDeliveryCard({ item, busy, onPresent, onDelivery }: {
  readonly item: CompanionActivityDeliveryV1;
  readonly busy: boolean;
  readonly onPresent: (item: CompanionActivityDeliveryV1) => void;
  readonly onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || item.expired || !["queued", "delivered"].includes(item.state) || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)) {
        onPresent(item);
        observer.disconnect();
      }
    }, { root: element.closest(".companion-tab-panel, .companion-stage"), threshold: 0.6 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item, onPresent]);

  return <article ref={ref} className={`companion-delivery-card is-${item.state}${item.expired ? " is-expired" : ""}`}><div><strong>{item.label}</strong><small>{formatRelative(item.createdAt)} · {item.expired ? "已失效" : item.state === "acted" ? "已处理" : item.state === "dismissed" ? "已忽略" : "待处理"}</small></div>{!item.expired && DELIVERY_PENDING_STATES.includes(item.state) ? <div className="companion-action-row"><button type="button" className="primary" disabled={busy} onClick={() => onDelivery(item, "acted")}>{item.target.kind === "none" ? "知道了" : "查看"}</button><button type="button" disabled={busy} onClick={() => onDelivery(item, "dismissed")}>忽略</button></div> : null}</article>;
}

export function DiaryPanel(props: {
  section: Section<CompanionDailySummaryV1> | null;
  loading: boolean;
  failure: string | null;
  date: string | null;
  onDate: (value: string | null) => void;
  onMemory: (id: string) => void;
  onRetry: () => void;
  marks: ReadonlyMap<string, "generated" | "failed"> | null;
  marksFailure: string | null;
  onMarksMonth: (month: string) => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  // 折叠面板的收起条件：点外面、Escape。选中一天后由 onPick 自己关。
  useEffect(() => {
    if (!calendarOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setCalendarOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 必须声明这次按键被吃掉了：App 的全局 Escape（window 上，冒泡比 document 晚）
      // 看到 defaultPrevented 才会放手，否则关日历的同时把人弹出伴星中心。
      event.preventDefault();
      event.stopPropagation();
      setCalendarOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [calendarOpen]);
  if (props.loading && !props.section) return <SectionState message="正在读取日记" />;
  if (!props.section) return <SectionState message="日记当前不可用" detail={props.failure ?? undefined} onRetry={props.onRetry} />;
  if (!props.section.ok) return <SectionState message="日记当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const daily = props.section.value; const anchor = props.date ?? daily.date ?? todayIsoDate(); const today = todayIsoDate();
  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>日记</h3><p>伴星会将每天的旅程写成日记展示在这里。</p></div></div>
    {/* 日期筛选与聊天记录共用那张月历（2026-09-22 用户指定）：平时收成一颗日期胶囊，
        点开才是月历；前一天 / 后一天留在页面上，翻页不必经过日历。
        原来这里是五个 `09-17` 这样的裸字符串横排，既读不出「这是哪天」，也只能回看五天。 */}
    <div className="companion-date-nav" ref={navRef}>
      <button type="button" onClick={() => props.onDate(shiftIsoDate(anchor, -1))}><ChevronLeft size={15} />前一天</button>
      <div className="companion-date-pick">
        <button type="button" className="companion-date-pick__trigger" data-active={calendarOpen || undefined} aria-expanded={calendarOpen} aria-controls="companion-diary-calendar" aria-label={`选择日记日期，当前 ${diaryDayLabel(anchor)}`} onClick={() => setCalendarOpen((value) => !value)}>
          <CalendarDays size={14} aria-hidden="true" /><span>{diaryDayLabel(anchor)}</span><ChevronDown size={13} aria-hidden="true" />
        </button>
        {calendarOpen ? <MonthCalendar key={anchor} panelId="companion-diary-calendar" selected={anchor} maxDay={today} marks={props.marks} onMonthChange={props.onMarksMonth} onPick={(day) => { props.onDate(day); setCalendarOpen(false); }} footer={props.marksFailure ? <p className="companion-diary-marks-failed">这个月她写过哪几天，这次没读出来；下面的点先别当准。</p> : null} /> : null}
      </div>
      <button type="button" disabled={anchor >= today} onClick={() => props.onDate(shiftIsoDate(anchor, 1))}>后一天<ChevronRight size={15} /></button>
    </div>
    {daily.status === "generated"
      ? <article className="companion-diary-entry">
          {/* 按她给的顺序排：图跟在说到它的那段后面，不是全堆在末尾。
              渲染器直接复用对话记录那两处（含长引用的量高折叠与图片取回重试），
              不在这页再抄一份"图片显示不出来时说什么"。 */}
          {daily.blocks.map((block, index) => block.type === "text"
            ? <p className="companion-diary-prose" key={`text-${index}`}>{block.text}</p>
            : block.type === "quote"
              ? <CompanionQuoteBlock block={block} key={`quote-${index}`} />
              : block.type === "image"
                ? <CompanionRecordImage block={block} key={`image-${index}`} />
                : null)}
          <small>{daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供"}</small>
          {daily.memory ? <button type="button" onClick={() => props.onMemory(daily.memory!.memoryItemId)}>查看关联记忆</button> : null}
        </article>
      : <SectionState message={daily.status === "failed" ? "这一天她没能写下来" : "这一天还没有日记"} detail={daily.status === "failed" ? DIARY_FAILURE_DETAIL[daily.failureReason ?? "unknown"] : undefined} />}
  </div>;
}

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; busy: string | null; error: string | null; notice: string | null; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onRename: (name: string) => void; onRetry: () => void };
/**
 * 改名那一行。草稿住在本地，且**只在真的改过时覆盖**当前值：`null` 表示"跟着档案"，
 * 于是服务端回什么就显示什么，不会出现输入框和档案各存一份名字。
 * 单独成组件是因为 `PersonaPanel` 在 hooks 之前就有早退。
 */
function CompanionNameRow(props: { readonly current: string; readonly busy: boolean; readonly onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.current;
  const trimmed = shown.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.current;
  const commit = () => { props.onRename(trimmed); setDraft(null); };
  // 容器与按钮行都用伴星中心现成的两块（`.companion-inline-form` /
  // `.companion-action-row`，记忆纠正那一套用的就是它们），不为一行输入新开一档样式。
  return <div className="companion-inline-form">
    <input
      type="text"
      value={shown}
      maxLength={60}
      aria-label="她叫什么"
      disabled={props.busy}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && dirty) { event.preventDefault(); commit(); } }}
    />
    <div className="companion-action-row">
      <button type="button" className="primary" disabled={props.busy || !dirty} onClick={commit}>改名</button>
      {dirty ? <button type="button" onClick={() => setDraft(null)}>取消</button> : null}
    </div>
  </div>;
}

export function PersonaPanel(props: PersonaPanelProps) {
  if (!props.section.ok || !props.persona) return <SectionState message="人格档案当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} />;
  const profile = props.persona.profile;
  return <div className="companion-panel-stack companion-persona-groups">
    <div className="companion-panel-heading"><div><h3>人格</h3><p>预设、活跃度与边界都会存进你的档案，立刻对伴星生效。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>她叫什么</h4><p>署名、对话记录与轨道上的说明都跟着换，改完立刻生效。</p>
      {profile ? <CompanionNameRow current={profile.name} busy={props.busy !== null} onRename={props.onRename} /> : null}
    </section>
    <section>
      <h4>人格外观</h4><p>选择系统提供的完整人格预设。</p>
      <div className="companion-choice-grid">{props.persona.presets.map((preset) => <button key={preset.presetId} type="button" aria-pressed={profile?.presetId === preset.presetId} className={profile?.presetId === preset.presetId ? "is-selected" : undefined} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><strong>{preset.name}</strong><span>{preset.speakingStyle}</span></button>)}</div>
      <button type="button" disabled={!profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button>
    </section>
    <section>
      <h4>活跃度</h4><p>她一次说多少、日记写多细。<strong>多久主动开口一次不在这里</strong>——那由账户页的「主动介入」决定。</p>
      <div className="companion-segmented">{(["quiet", "moderate", "active"] as const).map((value) => <button key={value} type="button" aria-pressed={profile?.activeness === value} className={profile?.activeness === value ? "is-selected" : undefined} disabled={!profile || props.busy !== null} onClick={() => props.onActiveness(value)}>{value === "quiet" ? "安静" : value === "moderate" ? "适度" : "活跃"}</button>)}</div>
    </section>
    <section>
      <h4>边界</h4><p>每项都是独立授权，关闭后伴星不会把它当成默认同意。</p>
      <div className="companion-boundaries">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={!profile || props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><small>{detail}</small></span><span className="companion-switch" data-on={profile?.boundaries[key] === true || undefined} aria-hidden="true"><i /></span></button>)}</div>
    </section>
  </div>;
}

type DataPanelProps = { busy: string | null; error: string | null; notice: string | null; dangerConfirm: "memory" | "history" | "audit" | null; conflictItems: CompanionMemoryItemV1[] | null; onDangerConfirm: (value: "memory" | "history" | "audit" | null) => void; onConflicts: () => void; onResolveConflict: (keepId: string, removeId: string) => void; onRebuild: () => void; onExport: (kind: CompanionExportKindV1) => void; onDanger: (kind: "memory" | "history" | "audit") => void; diagnostics: { mapVersion: number | null; memoryCount: number; historyCount: number } };
export function DataPanel(props: DataPanelProps) {
  const conflictGroups = props.conflictItems ? Object.values(props.conflictItems.reduce<Record<string, CompanionMemoryItemV1[]>>((groups, item) => {
    if (item.conflictGroup) (groups[item.conflictGroup] ??= []).push(item);
    return groups;
  }, {})) : null;
  return <div className="companion-panel-stack companion-data-groups">
    <div className="companion-panel-heading"><div><h3>数据与隐私</h3><p>检查、导出和清除分别分组；每个危险操作都会再次确认。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>检查与整理</h4><p>这些操作只整理真实记录，不会生成新的学习内容。</p>
      <div className="companion-data-actions">
        <button type="button" disabled={props.busy !== null} onClick={props.onConflicts}><AlertTriangle size={14} /><span><strong>检查记忆冲突</strong><small>{props.conflictItems === null ? "按需检查待处理的冲突" : `发现 ${props.conflictItems.length} 条冲突记录`}</small></span></button>
        {conflictGroups?.map((group) => group.length > 1 ? <div key={group[0].conflictGroup ?? group[0].memoryItemId} className="companion-conflict-group"><strong>选择要保留的记忆</strong>{group.map((item) => <button key={item.memoryItemId} type="button" disabled={props.busy !== null} onClick={() => props.onResolveConflict(item.memoryItemId, group.find((candidate) => candidate.memoryItemId !== item.memoryItemId)!.memoryItemId)}><span>{item.content}</span><small>保留此条</small></button>)}</div> : null)}
        <button type="button" disabled={props.busy !== null} onClick={props.onRebuild}><Database size={14} /><span><strong>整理记忆检索索引</strong><small>只更新查找能力，不改动记忆正文</small></span></button>
      </div>
    </section>
    <section>
      <h4>导出副本</h4><p>通过系统保存窗口把当前数据保存到本机。</p>
      <div className="companion-data-actions">
        {(["all", "memory", "audit"] as const).map((kind) => <button key={kind} type="button" disabled={props.busy !== null} onClick={() => props.onExport(kind)}><Download size={14} /><span><strong>{EXPORT_COPY[kind].label}</strong><small>{EXPORT_COPY[kind].detail}</small></span></button>)}
      </div>
    </section>
    <section className="companion-danger-zone">
      <h4>清除数据</h4><p>清除后无法在应用内恢复；每项只影响说明中列出的内容。</p>
      <div className="companion-data-actions">
        <DangerAction active={props.dangerConfirm === "memory"} busy={props.busy === "memory"} title="清空全部记忆" detail="删除长期记忆、候选和星图关系；连续对话与人格保留。" onOpen={() => props.onDangerConfirm("memory")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("memory")} />
        <DangerAction active={props.dangerConfirm === "history"} busy={props.busy === "history"} title="清空连续对话记录" detail="删除对话和动态收件记录；记忆、人格、旅程与操作记录保留。" onOpen={() => props.onDangerConfirm("history")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("history")} />
        <DangerAction active={props.dangerConfirm === "audit"} busy={props.busy === "audit"} title="删除操作与邀请记录" detail="删除当前工作区内你的安全操作与邀请记录；不会重新触发邀请。" onOpen={() => props.onDangerConfirm("audit")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("audit")} />
      </div>
    </section>
    {import.meta.env.DEV ? <section><h4>开发诊断</h4><p>仅开发构建可见；不提供制造提案或手工注入事件。</p><dl className="companion-diagnostics"><div><dt>记忆图谱</dt><dd>{props.diagnostics.mapVersion ? `V${props.diagnostics.mapVersion}` : "不可用"}</dd></div><div><dt>记忆节点</dt><dd>{props.diagnostics.memoryCount}</dd></div><div><dt>已读历史</dt><dd>{props.diagnostics.historyCount}</dd></div></dl></section> : null}
  </div>;
}

function DangerAction(props: { active: boolean; busy: boolean; title: string; detail: string; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const actionsId = useId();
  const openRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const wasActive = useRef(false);
  useEffect(() => {
    if (props.active && !wasActive.current) confirmRef.current?.focus();
    if (!props.active && wasActive.current) openRef.current?.focus();
    wasActive.current = props.active;
  }, [props.active]);
  return <div className="companion-danger-action"><Trash2 size={14} /><span><strong>{props.title}</strong><small>{props.detail}</small></span><div id={actionsId}><button ref={openRef} type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} aria-controls={actionsId} onClick={props.active ? props.onCancel : props.onOpen}>{props.active ? "取消" : "清除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>{props.busy ? "正在清除…" : "确认清除"}</button> : null}</div></div>;
}

function MemoryDeleteAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (props.active) confirmRef.current?.focus();
  }, [props.active]);
  return <><button type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} onClick={props.active ? props.onCancel : props.onOpen}><Trash2 size={13} />{props.active ? "取消删除" : "删除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>确认删除</button> : null}</>;
}
