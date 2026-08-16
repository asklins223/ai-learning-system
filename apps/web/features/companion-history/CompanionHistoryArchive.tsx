"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { Icon } from "@/components/ui/icons";
import { PetIcon } from "@/features/companion-pet/surfaces/PetIcon";
import {
  compactReference,
  formatHistoryDay,
  formatHistoryTime,
  historyDayKey,
  historyEntryText,
  historyReferenceState,
  type CompanionHistoryBlock,
  type CompanionHistoryEntry,
  type CompanionHistoryKind,
} from "./history-model";

export type CompanionHistoryConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount?: number;
};

type HistoryFilter =
  | "all"
  | "dialogue"
  | "voice"
  | "proactive"
  | "actions"
  | "issues";

type CompanionHistoryArchiveProps = {
  conversations: CompanionHistoryConversationSummary[];
  selectedId: string | null;
  entries: CompanionHistoryEntry[];
  onSelect: (conversationId: string) => void;
  source: "production" | "prototype";
  error?: string | null;
  entriesLoading?: boolean;
  limitationNote?: string;
  historyPage?: {
    loadedCount: number;
    totalCount?: number;
    hasEarlier: boolean;
    loading?: boolean;
    onLoadEarlier?: () => void;
  };
  /** 导出全部记录（GET /companion/export NDJSON）。 */
  onExport?: () => void;
  /** 删除当前选中的对话（服务端 hard delete + 审计）。 */
  onDelete?: () => void;
  /** 唤起桌面桌宠（仅 Electron Main 窗口存在 desktopAPI）。 */
  onRecallPet?: () => void;
};

const FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "dialogue", label: "对话" },
  { id: "voice", label: "语音" },
  { id: "proactive", label: "主动介入" },
  { id: "actions", label: "行动与结果" },
  { id: "issues", label: "异常与恢复" },
];

export const CompanionHistoryArchive = memo(function CompanionHistoryArchive({
  conversations,
  selectedId,
  entries,
  onSelect,
  source,
  error,
  entriesLoading = false,
  limitationNote,
  historyPage,
  onExport,
  onDelete,
  onRecallPet,
}: CompanionHistoryArchiveProps) {
  const [conversationQuery, setConversationQuery] = useState("");
  const [entryQuery, setEntryQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [dayFilter, setDayFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  useEffect(() => {
    setEntryQuery("");
    setFilter("all");
    setDayFilter("all");
    setRunFilter("all");
    setSourceFilter("all");
  }, [selectedId]);

  const visibleConversations = useMemo(() => {
    const normalized = conversationQuery.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return conversations;
    return conversations.filter((conversation) => conversation.title.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [conversationQuery, conversations]);

  const visibleEntries = useMemo(() => {
    const normalized = entryQuery.trim().toLocaleLowerCase("zh-CN");
    return entries.filter((entry) => {
      if (!matchesFilter(entry.kind, filter)) return false;
      if (dayFilter !== "all" && historyDayKey(entry.createdAt) !== dayFilter) return false;
      if (runFilter !== "all" && entry.runId !== runFilter) return false;
      if (sourceFilter !== "all" && (entry.sourceLabel ?? "来源未知") !== sourceFilter) return false;
      return !normalized || historyEntryText(entry).includes(normalized);
    });
  }, [dayFilter, entries, entryQuery, filter, runFilter, sourceFilter]);

  const facetOptions = useMemo(() => {
    const days = new Map<string, string>();
    const runs = new Set<string>();
    const sources = new Set<string>();
    for (const entry of entries) {
      days.set(historyDayKey(entry.createdAt), formatCompactDay(entry.createdAt));
      if (entry.runId) runs.add(entry.runId);
      sources.add(entry.sourceLabel ?? "来源未知");
    }
    return {
      days: [...days.entries()],
      runs: [...runs],
      sources: [...sources].sort((left, right) => left.localeCompare(right, "zh-CN")),
    };
  }, [entries]);

  const hasActiveFacets = dayFilter !== "all" || runFilter !== "all" || sourceFilter !== "all";

  const clearEntryFilters = () => {
    setEntryQuery("");
    setFilter("all");
    setDayFilter("all");
    setRunFilter("all");
    setSourceFilter("all");
  };

  const filterCounts = useMemo(() => {
    // 单趟遍历 entries，每类 filter 独立计数；避免原先对每个 filter 各做一次
    // entries.filter 全表扫描（O(F×N)）。
    const counts = new Map<HistoryFilter, number>(FILTERS.map(({ id }) => [id, 0]));
    for (const entry of entries) {
      for (const { id } of FILTERS) {
        if (matchesFilter(entry.kind, id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [entries]);

  return (
    <section
      className="history-archive"
      data-history-source={source}
      aria-labelledby="companion-history-title"
    >
      {source === "prototype" ? (
        <div className="history-preview-notice" role="status">
          <span><Icon.Eye aria-hidden="true" /></span>
          <div>
            <strong>开发预览 · 非账户数据</strong>
            <p>以下结构化样例用于验收 UI；route、错误恢复详情尚未接入生产消息合同。</p>
          </div>
        </div>
      ) : null}

      <header className="history-archive__masthead">
        <div className="history-archive__identity">
          <span className="history-archive__eyebrow">COMPANION RECORD</span>
          <h1 id="companion-history-title">伴星交互档案</h1>
          <p>当前已载入的对话、主动介入和系统行动按发生顺序呈现；读取范围以每段记录顶部的边界说明为准。</p>
        </div>
        <div className="history-archive__readonly">
          <Icon.Lock aria-hidden="true" />
          <span><strong>只读记录</strong><small>继续对话请回到桌面伴星</small></span>
          <Link className="history-memory-link" href="/companion/memory">管理记忆</Link>
        </div>
      </header>

      <div className="history-archive__layout">
        <aside className="history-index" aria-label="对话档案索引">
          <div className="history-index__companion">
            <div className="history-index__portrait" aria-hidden="true">
              <Icon.Archive />
            </div>
            <div>
              <span>只读档案索引</span>
              <strong>已载入的交互记录</strong>
            </div>
          </div>

          <div className="history-index__heading">
            <div>
              <span>对话索引</span>
              <strong>{conversations.length} 段记录</strong>
            </div>
            <Icon.Archive aria-hidden="true" />
          </div>

          <label className="history-search history-search--index">
            <span className="sr-only">搜索对话标题</span>
            <Icon.Search aria-hidden="true" />
            <input
              type="search"
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              placeholder="搜索对话标题"
            />
            {conversationQuery ? (
              <button type="button" onClick={() => setConversationQuery("")} aria-label="清除对话搜索">
                <Icon.Close aria-hidden="true" />
              </button>
            ) : null}
          </label>

          <nav className="history-index__list" aria-label="历史对话">
            {visibleConversations.map((conversation) => {
              const active = conversation.id === selectedId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className="history-index__item"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className="history-index__item-mark" aria-hidden="true">
                    <PetIcon name={active ? "sparkles" : "message"} />
                  </span>
                  <span className="history-index__item-copy">
                    <strong>{conversation.title || "未命名对话"}</strong>
                    <small>{formatConversationDate(conversation.lastMessageAt ?? conversation.createdAt)}</small>
                  </span>
                  {typeof conversation.messageCount === "number" ? (
                    <span className="history-index__count" aria-label={`${conversation.messageCount} 条记录`}>
                      {conversation.messageCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {visibleConversations.length === 0 ? (
              <div className="history-index__empty">
                <Icon.Search aria-hidden="true" />
                <p>没有匹配的对话标题</p>
              </div>
            ) : null}
          </nav>

          <label className="history-index__mobile-select">
            <span>当前对话</span>
            <select
              value={selectedId ?? ""}
              onChange={(event) => event.target.value && onSelect(event.target.value)}
            >
              {visibleConversations.length === 0 ? <option value="">没有匹配的对话</option> : null}
              {visibleConversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title || "未命名对话"} · {formatConversationDate(conversation.lastMessageAt ?? conversation.createdAt)}
                </option>
              ))}
            </select>
          </label>

          <div className="history-index__footnote">
            <Icon.Lock aria-hidden="true" />
            <p>这里不生成回复，也不会在后台执行新的学习动作。</p>
          </div>
        </aside>

        <section className="history-ledger" aria-labelledby="history-ledger-title">
          {selected ? (
            <>
              <header className="history-ledger__header">
                <div className="history-ledger__title-group">
                  <span className="history-ledger__kicker"><Icon.Timeline aria-hidden="true" />按时间线审阅</span>
                  <h2 id="history-ledger-title">{selected.title || "未命名对话"}</h2>
                  <HistorySummary entries={entries} />
                </div>
                <div className="history-ledger__seal" aria-label="档案状态：已保存">
                  <Icon.Check aria-hidden="true" />
                  <span>已保存</span>
                </div>
              </header>

              <div className="history-ledger__tools">
                <label className="history-search history-search--entries">
                  <span className="sr-only">搜索当前对话内容</span>
                  <Icon.Search aria-hidden="true" />
                  <input
                    type="search"
                    value={entryQuery}
                    onChange={(event) => setEntryQuery(event.target.value)}
                    placeholder="搜索这段记录的内容、状态或引用"
                  />
                  {entryQuery ? (
                    <button type="button" onClick={() => setEntryQuery("")} aria-label="清除内容搜索">
                      <Icon.Close aria-hidden="true" />
                    </button>
                  ) : null}
                </label>
                <div className="history-facets" aria-label="按日期、学习 Run 和来源筛选">
                  <span className="history-facets__label"><Icon.Filter aria-hidden="true" />精确筛选</span>
                  <label>
                    <span>日期</span>
                    <select value={dayFilter} onChange={(event) => setDayFilter(event.target.value)}>
                      <option value="all">全部日期</option>
                      {facetOptions.days.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Learning Run</span>
                    <select value={runFilter} onChange={(event) => setRunFilter(event.target.value)}>
                      <option value="all">全部 Run</option>
                      {facetOptions.runs.map((runId) => <option key={runId} value={runId}>Run {compactReference(runId)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>来源</span>
                    <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                      <option value="all">全部来源</option>
                      {facetOptions.sources.map((sourceLabel) => <option key={sourceLabel} value={sourceLabel}>{sourceLabel}</option>)}
                    </select>
                  </label>
                  {hasActiveFacets ? <button type="button" onClick={clearEntryFilters}>重置</button> : null}
                </div>
                <div className="history-filter" role="group" aria-label="按记录类型筛选">
                  {FILTERS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={filter === item.id}
                      onClick={() => setFilter(item.id)}
                    >
                      {item.label}
                      <span>{filterCounts.get(item.id) ?? 0}</span>
                    </button>
                  ))}
                </div>
                <div className="history-management" aria-describedby="history-management-note">
                  <div>
                    <span><Icon.Lock aria-hidden="true" /></span>
                    <p><strong>档案管理</strong><small id="history-management-note">
                      {source === "production"
                        ? "导出全部记录；删除当前选中对话（正文清除、保留审计留痕）；删除不改变已提交的学习事实。"
                        : "开发预览中的档案管理不会修改任何账户数据。"}
                    </small></p>
                  </div>
                  <div className="history-management__actions">
                    <button type="button" disabled={!onExport} title={onExport ? "导出全部记录" : "导出能力不可用"} onClick={onExport}>
                      <Icon.Download aria-hidden="true" />导出
                    </button>
                    <button
                      type="button"
                      disabled={!selectedId || !onDelete}
                      title={selectedId ? "删除当前选中的对话" : "请先选中一段对话"}
                      onClick={onDelete}
                    >
                      <Icon.Trash aria-hidden="true" />删除
                    </button>
                    <button type="button" disabled={!onRecallPet} title={onRecallPet ? "在桌面唤起学习伴星" : "桌面伴星能力不可用"} onClick={onRecallPet}>
                      <Icon.Sparkle aria-hidden="true" />召回桌宠
                    </button>
                  </div>
                </div>
              </div>

              {error ? (
                <div className="history-ledger__error" role="alert">
                  <Icon.AlertCircle aria-hidden="true" />
                  <p><strong>部分记录暂时无法读取</strong><span>{error}</span></p>
                </div>
              ) : null}

              <div className="history-ledger__body" aria-busy={entriesLoading || undefined}>
                {!entriesLoading && historyPage ? <HistoryPageBoundary page={historyPage} /> : null}
                {entriesLoading ? (
                  <HistoryEntriesLoading />
                ) : visibleEntries.length > 0 ? (
                  <HistoryTimeline entries={visibleEntries} />
                ) : (
                  <div className="history-ledger__empty">
                    <Icon.Search aria-hidden="true" />
                    <h3>没有匹配的记录</h3>
                    <p>调整搜索词或记录类型，原始档案不会受到影响。</p>
                    <button type="button" onClick={clearEntryFilters}>
                      清除筛选
                    </button>
                  </div>
                )}
              </div>

              <footer className="history-ledger__footer">
                <div>
                  <Icon.Lock aria-hidden="true" />
                  <p><strong>档案页到此为止</strong><span>召回桌面伴星，才能继续这段对话或发起新学习动作。</span></p>
                </div>
                {limitationNote ? <small>{limitationNote}</small> : null}
              </footer>
            </>
          ) : (
            <EmptyArchive hasConversations={conversations.length > 0} />
          )}
        </section>
      </div>
    </section>
  );
});

function HistoryPageBoundary({
  page,
}: {
  page: NonNullable<CompanionHistoryArchiveProps["historyPage"]>;
}) {
  const complete = !page.hasEarlier;
  const countLabel = typeof page.totalCount === "number"
    ? `已显示 ${page.loadedCount} / ${page.totalCount} 条`
    : `已显示最近 ${page.loadedCount} 条`;

  return (
    <div className="history-page-boundary" data-complete={complete ? "true" : "false"}>
      <span className="history-page-boundary__mark" aria-hidden="true">
        {complete ? <Icon.Check /> : <Icon.Archive />}
      </span>
      <div>
        <strong>{complete ? "已到最早一条记录" : "这段对话还有更早记录"}</strong>
        <small>{countLabel}</small>
      </div>
      {!complete ? (
        <button
          type="button"
          disabled={!page.onLoadEarlier || page.loading}
          onClick={page.onLoadEarlier}
          aria-describedby={!page.onLoadEarlier ? "history-pagination-deferred" : undefined}
        >
          {page.loading ? "正在载入…" : page.onLoadEarlier ? "载入更早记录" : "更早记录待接线"}
        </button>
      ) : null}
      {!complete && !page.onLoadEarlier ? (
        <span id="history-pagination-deferred" className="sr-only">
          当前生产读取链尚未接入更早记录分页，不代表更早记录不存在。
        </span>
      ) : null}
    </div>
  );
}

function HistoryTimeline({ entries }: { entries: CompanionHistoryEntry[] }) {
  let previousDay = "";
  return (
    <ol className="history-timeline" aria-label="对话事件时间线">
      {entries.map((entry) => {
        const day = historyDayKey(entry.createdAt);
        const startsDay = day !== previousDay;
        previousDay = day;
        return (
          <li key={entry.id} className="history-timeline__row">
            {startsDay ? (
              <div className="history-timeline__day">
                <span>{formatHistoryDay(entry.createdAt)}</span>
              </div>
            ) : null}
            <HistoryEntryCard entry={entry} />
          </li>
        );
      })}
    </ol>
  );
}

function HistoryEntriesLoading() {
  return (
    <div className="history-entries-loading" role="status" aria-live="polite">
      <span className="sr-only">正在读取所选对话的记录</span>
      {[0, 1, 2].map((item) => (
        <div key={item} className="history-entries-loading__row" aria-hidden="true">
          <i />
          <span><b /><b /><b /></span>
        </div>
      ))}
    </div>
  );
}

// FN1：memo 化条目卡片与块——流式 delta 只更新最新条目，未变历史条目
// 的对象身份稳定，从而跳过整条历史树的 Markdown 重解析与重渲染。
const HistoryEntryCard = memo(function HistoryEntryCard({ entry }: { entry: CompanionHistoryEntry }) {
  const meta = entryMeta(entry);
  return (
    <article className="history-entry" data-kind={entry.kind} data-role={entry.role}>
      <div className="history-entry__rail" aria-hidden="true">
        <span>{meta.icon}</span>
      </div>
      <div className="history-entry__content">
        <header className="history-entry__header">
          <div>
            <strong>{meta.actor}</strong>
            <span className="history-entry__kind">{meta.kindLabel}</span>
            {entry.kind === "voice_transcript" ? <span className="history-entry__verified"><Icon.Check />已确认转写</span> : null}
          </div>
          <time dateTime={entry.createdAt}>{formatHistoryTime(entry.createdAt)}</time>
        </header>
        <div className="history-entry__surface">
          {entry.blocks.map((block, index) => (
            <HistoryBlock key={`${entry.id}-${block.type}-${index}`} block={block} />
          ))}
        </div>
        <footer className="history-entry__footer">
          <span>{entry.sourceLabel ?? "伴星档案"}</span>
          {entry.editedAt ? <span>已编辑</span> : null}
          {entry.runId ? <span title={entry.runId}>Run {compactReference(entry.runId)}</span> : null}
          <span>#{entry.seq}</span>
        </footer>
      </div>
    </article>
  );
});

const HistoryBlock = memo(function HistoryBlock({ block }: { block: CompanionHistoryBlock }) {
  switch (block.type) {
    case "text":
      return (
        <div className="history-block history-block--text">
          <MarkdownPreview source={block.text} demoteHeadings allowRemoteImages={false} />
        </div>
      );
    case "code":
      return (
        <div className="history-block history-block--code">
          {block.language ? <span>{block.language}</span> : null}
          <pre><code>{block.code}</code></pre>
        </div>
      );
    case "citation":
      return block.href ? (
        <a className="history-reference history-reference--citation" href={block.href} target="_blank" rel="noreferrer">
          <Icon.Link aria-hidden="true" />
          <span><strong>{block.label}</strong><small>外部安全链接</small></span>
          <Icon.Open aria-hidden="true" />
        </a>
      ) : (
        <div className="history-reference history-reference--citation">
          <Icon.Notepad aria-hidden="true" />
          <span><strong>{block.label}</strong><small>{block.entityRef ?? "学习内容引用"}</small></span>
        </div>
      );
    case "action_ref":
      {
        const state = historyReferenceState("action", block.status);
        return (
        <div className="history-reference history-reference--action" data-status-tone={state.tone}>
          <Icon.Bolt aria-hidden="true" />
          <span><strong>{block.label ?? "行动提案"}</strong><small>{state.detail} · {compactReference(block.proposalId)}</small></span>
          <span className="history-reference__state">
            {state.tone === "success" ? <Icon.Check /> : state.tone === "danger" ? <Icon.AlertCircle /> : <Icon.Timeline />}
            {state.label}
          </span>
        </div>
        );
      }
    case "result_ref":
      {
        const state = historyReferenceState("result", block.status);
        return (
        <div className="history-reference history-reference--result" data-status-tone={state.tone}>
          <Icon.Target aria-hidden="true" />
          <span><strong>{block.label ?? "行动结果"}</strong><small>{state.detail} · {compactReference(block.actionRunId)}</small></span>
          <span className="history-reference__state">
            {state.tone === "success" ? <Icon.Check /> : state.tone === "danger" ? <Icon.AlertCircle /> : <Icon.Timeline />}
            {state.label}
          </span>
        </div>
        );
      }
    case "route_ref":
      return (
        <Link className="history-reference history-reference--route" href={block.route} prefetch={false}>
          <Icon.Compass aria-hidden="true" />
          <span><strong>{block.label}</strong><small>{block.detail ?? block.route}</small></span>
          <Icon.Arrow aria-hidden="true" />
        </Link>
      );
    case "error_detail":
      return (
        <div className="history-reference history-reference--error">
          <Icon.AlertCircle aria-hidden="true" />
          <span><strong>{block.code}</strong><small>{block.detail}</small></span>
          <span className="history-reference__state">{block.retryable ? "可恢复" : "已终止"}</span>
        </div>
      );
    case "recovery_detail":
      return (
        <div className="history-reference history-reference--recovery">
          <Icon.Refresh aria-hidden="true" />
          <span><strong>{block.label}</strong><small>{block.detail}</small></span>
          <span className="history-reference__state"><Icon.Timeline />恢复说明已记录</span>
        </div>
      );
  }
});

function HistorySummary({ entries }: { entries: CompanionHistoryEntry[] }) {
  // PERF: 汇总统计仅依赖 entries，用 useMemo 避免随父级重渲反复全量 filter。
  const actionCount = useMemo(
    () => entries.filter((entry) => ["action", "result", "route"].includes(entry.kind)).length,
    [entries],
  );
  if (entries.length === 0) return <p className="history-ledger__summary">这段档案还没有可展示的记录。</p>;
  const first = entries[0];
  const last = entries[entries.length - 1];
  return (
    <p className="history-ledger__summary">
      <span>{entries.length} 条记录</span>
      <i aria-hidden="true" />
      <span>{formatCompactDay(first.createdAt)}—{formatCompactDay(last.createdAt)}</span>
      <i aria-hidden="true" />
      <span>{actionCount} 条行动相关记录</span>
    </p>
  );
}

function EmptyArchive({ hasConversations }: { hasConversations: boolean }) {
  return (
    <div className="history-archive-empty">
      <div className="history-archive-empty__art" aria-hidden="true">
        <Icon.Archive />
        <Icon.Lock />
      </div>
      <span>只读档案</span>
      <h2 id="history-ledger-title">{hasConversations ? "选择一段对话开始审阅" : "这里还没有伴星记录"}</h2>
      <p>{hasConversations
        ? "左侧索引会切换完整时间线，不会开启另一套聊天窗口。"
        : "第一次通过桌面伴星对话或完成系统行动后，记录会按顺序出现在这里。"}</p>
      <div><Icon.Lock aria-hidden="true" />此页面不提供新对话或消息输入</div>
    </div>
  );
}

function entryMeta(entry: CompanionHistoryEntry): {
  actor: string;
  kindLabel: string;
  icon: React.ReactNode;
} {
  // 先相信消息角色/来源，再用 kind 描述事件类型。kind 不能把用户动作改写成“伴星行动”。
  if (entry.role === "user") {
    if (entry.kind === "voice_transcript") return { actor: "你", kindLabel: "语音转写", icon: <PetIcon name="microphone" /> };
    if (entry.kind === "action") return { actor: "你", kindLabel: "操作确认", icon: <Icon.User /> };
    return { actor: "你", kindLabel: "文字", icon: <Icon.User /> };
  }

  if (entry.role === "system") {
    if (entry.kind === "route") return { actor: "系统路由", kindLabel: "页面联动", icon: <Icon.Compass /> };
    if (entry.kind === "error") return { actor: "系统回执", kindLabel: "异常", icon: <Icon.AlertCircle /> };
    if (entry.kind === "result") return { actor: "评估系统", kindLabel: "结果记录", icon: <Icon.Target /> };
    return { actor: "系统", kindLabel: "记录", icon: <Icon.Timeline /> };
  }

  if (entry.kind === "proactive") return { actor: "伴星", kindLabel: "主动介入", icon: <Icon.Sparkle /> };
  if (entry.kind === "action") return { actor: "伴星", kindLabel: "行动提案", icon: <Icon.Bolt /> };
  if (entry.kind === "result") return { actor: "伴星", kindLabel: "结果转述", icon: <Icon.Target /> };
  if (entry.kind === "error") return { actor: "伴星", kindLabel: "异常转述", icon: <Icon.AlertCircle /> };
  if (entry.kind === "recovery") return { actor: "伴星", kindLabel: "恢复通知", icon: <Icon.Refresh /> };
  return { actor: "伴星", kindLabel: "回复", icon: <PetIcon name="sparkles" /> };
}

function matchesFilter(kind: CompanionHistoryKind, filter: HistoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "dialogue") return kind === "text" || kind === "voice_transcript";
  if (filter === "voice") return kind === "voice_transcript";
  if (filter === "proactive") return kind === "proactive";
  if (filter === "actions") return kind === "action" || kind === "result" || kind === "route";
  return kind === "error" || kind === "recovery";
}

function formatConversationDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function formatCompactDay(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}
