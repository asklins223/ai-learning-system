"use client";

/**
 * 真桌宠记忆管理（22-real-desktop-pet-memory-context-prd-tdd.md §10.2.2）。
 *
 * - 搜索（300ms 防抖）/类型/状态筛选；
 * - candidate → 确认 / 拒绝 / 忽略；
 * - active → 固定 / 取消固定 / 归档 / 删除；
 * - archived → 恢复 / 删除；
 * - 一键清空（ConfirmDialog 二次确认）。
 */

import "../conversations/conversation-page.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";
import Link from "next/link";

interface MemoryItem {
  memoryItemId: string;
  kind: "preference" | "goal" | "learning_context" | "interaction_note" | "episodic";
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  candidate: boolean;
  importance: number;
  confidence: number;
  scope: "global" | "workspace" | "task";
  pinned: boolean;
  archived: boolean;
  dismissedAt: string | null;
  conflictGroup: string | null;
  embeddingStatus: "none" | "pending" | "ready" | "failed";
  sourceType: "user_stated" | "model_inferred" | "confirmed" | "summary" | "legacy";
  createdAt: string;
  updatedAt: string;
}

const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  preference: "偏好",
  goal: "目标",
  learning_context: "学习情境",
  interaction_note: "互动备注",
  episodic: "情景摘要",
};

const KIND_OPTIONS = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));

// F#7（第六轮 🟡9）：行内 toLocaleDateString 用模块单例替换。
const memoryDateFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatMemoryDate(value: string): string {
  return memoryDateFmt.format(new Date(value));
}

function MemoryStatusBadge({ item }: { item: MemoryItem }) {
  if (item.candidate) {
    return <span className="memory-badge is-candidate">候选待确认</span>;
  }
  if (item.archived) {
    return <span className="memory-badge is-archived">已归档</span>;
  }
  if (item.pinned) {
    return <span className="memory-badge is-pinned">已固定</span>;
  }
  if (!item.userConfirmed && !item.userStated) {
    return <span className="memory-badge is-derived">派生记忆</span>;
  }
  return <span className="memory-badge is-active">活跃记忆</span>;
}

type MemoryActionKind =
  | "confirm"
  | "reject"
  | "delete"
  | "pin"
  | "unpin"
  | "archive"
  | "restore"
  | "dismiss";

function MemoryActions({
  item,
  onChanged,
}: {
  item: MemoryItem;
  onChanged: (id: string, kind: MemoryActionKind) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (kind: MemoryActionKind) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "confirm") await api.confirmCompanionMemory(item.memoryItemId);
      else if (kind === "reject") await api.rejectCompanionMemory(item.memoryItemId);
      else if (kind === "delete") await api.deleteCompanionMemory(item.memoryItemId);
      else if (kind === "pin") await api.pinCompanionMemory(item.memoryItemId);
      else if (kind === "unpin") await api.unpinCompanionMemory(item.memoryItemId);
      else if (kind === "archive") await api.archiveCompanionMemory(item.memoryItemId);
      else if (kind === "restore") await api.restoreCompanionMemory(item.memoryItemId);
      else if (kind === "dismiss") await api.dismissCompanionMemory(item.memoryItemId);
      onChanged(item.memoryItemId, kind);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [item.memoryItemId, onChanged]);

  return (
    <span className="memory-actions">
      {item.candidate ? (
        <>
          <button type="button" disabled={busy} onClick={() => void act("confirm")}>
            确认
          </button>
          <button type="button" disabled={busy} onClick={() => void act("reject")}>
            拒绝
          </button>
          <button type="button" disabled={busy} onClick={() => void act("dismiss")}>
            忽略
          </button>
        </>
      ) : item.archived ? (
        <>
          <button type="button" disabled={busy} onClick={() => void act("restore")}>
            恢复
          </button>
          <button type="button" disabled={busy} onClick={() => void act("delete")}>
            删除
          </button>
        </>
      ) : (
        <>
          {item.pinned ? (
            <button type="button" disabled={busy} onClick={() => void act("unpin")}>
              取消固定
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void act("pin")}>
              固定
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void act("archive")}>
            归档
          </button>
          <button type="button" disabled={busy} onClick={() => void act("delete")}>
            删除
          </button>
        </>
      )}
      {error && <small className="memory-action-error">{error}</small>}
    </span>
  );
}

export default function CompanionMemoryPage() {
  // 第八轮 🟡B-1：useMemo 稳定引用。
  useMainPageContext(useMemo(() => ({
    routeRef: { kind: "conversation" },
    pageKind: "conversation",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  }), []));

  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [conflicts, setConflicts] = useState<MemoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // 300ms 防抖：搜索词稳定后才触发 reload，避免每次击键都请求列表 + 冲突两个接口。
  const [debouncedQ, setDebouncedQ] = useState("");
  const [kind, setKind] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showCandidates, setShowCandidates] = useState(true);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(handle);
  }, [q]);

  const reload = useCallback(() => {
    setError(null);
    void Promise.all([
      api.listCompanionMemories({
        includeCandidates: showCandidates,
        includeArchived: showArchived,
        q: debouncedQ || undefined,
        kind: (kind || undefined) as MemoryItem["kind"] | undefined,
      }),
      api.listCompanionMemoryConflicts(),
    ]).then(([listResult, conflictResult]) => {
      setItems((listResult.items as MemoryItem[]) ?? []);
      setConflicts((conflictResult.items as MemoryItem[]) ?? []);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "暂时无法读取记忆");
    });
  }, [debouncedQ, kind, showArchived, showCandidates]);

  const handleResolveConflict = useCallback(async (keepId: string, removeId: string) => {
    setError(null);
    try {
      await api.resolveCompanionMemoryConflict(keepId, removeId);
      setConflicts((current) => current.filter((item) => item.memoryItemId !== keepId && item.memoryItemId !== removeId));
      setItems((current) => current?.filter((item) => item.memoryItemId !== removeId) ?? current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "冲突裁决失败");
    }
  }, []);

  // 单项操作后仅局部 mutate 列表，不整表 reload。
  const handleMemoryChanged = useCallback((id: string, action: MemoryActionKind) => {
    setItems((current) => {
      if (!current) return current;
      if (action === "confirm") {
        return current.map((item) =>
          item.memoryItemId === id
            ? { ...item, candidate: false, userConfirmed: true }
            : item,
        );
      }
      if (action === "pin" || action === "unpin") {
        return current.map((item) =>
          item.memoryItemId === id ? { ...item, pinned: action === "pin" } : item,
        );
      }
      if (action === "archive") {
        return current.map((item) =>
          item.memoryItemId === id ? { ...item, archived: true } : item,
        );
      }
      if (action === "restore") {
        return current.map((item) =>
          item.memoryItemId === id ? { ...item, archived: false } : item,
        );
      }
      if (action === "dismiss") {
        return current.map((item) =>
          item.memoryItemId === id ? { ...item, dismissedAt: new Date().toISOString() } : item,
        );
      }
      if (action === "reject" || action === "delete") {
        return current.filter((item) => item.memoryItemId !== id);
      }
      return current;
    });
  }, []);

  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(() => {
    setError(null);
    setExporting(true);
    void api.exportCompanionMemories().then((result) => {
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `companion-memory-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "导出失败");
    }).finally(() => {
      setExporting(false);
    });
  }, []);

  // 一键清空：ConfirmDialog 二次确认（替代原生 window.confirm）。
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClearAll = useCallback(() => {
    setConfirmClearOpen(true);
  }, []);

  const confirmClearAll = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await api.clearCompanionMemories();
      setItems([]);
      setConfirmClearOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清空失败");
    } finally {
      setClearing(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 手动新增记忆（PRD §2.2.2 来源5 / §13.1）：服务端默认 userStated+candidate=false，
  // 即直接成为 active 记忆并触发 embedding。
  const [newKind, setNewKind] = useState<MemoryItem["kind"]>("preference");
  const [newContent, setNewContent] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    const content = newContent.trim();
    if (!content) return;
    setCreating(true);
    setError(null);
    try {
      await api.createCompanionMemory({
        kind: newKind,
        content,
        sourceType: "user_stated",
        candidate: false,
      });
      setNewContent("");
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新增失败");
    } finally {
      setCreating(false);
    }
  }, [newContent, newKind, reload]);

  return (
    <main className="companion-memory-page">
      <header className="companion-memory-head">
        <span className="companion-memory-eyebrow"><i aria-hidden="true" /> AI 伴星</span>
        <h1>伴星记忆</h1>
        <p>
          伴星长期记住的目标、偏好与情境。候选记忆默认不参与主动介入；
          确认后才会被使用。删除记忆不影响任何已提交的学习事实与复习安排。
        </p>
      </header>

      <nav className="companion-memory-links" aria-label="快捷入口">
        <Link href="/companion/memory/star-map" className="companion-memory-link">
          <Icon.StarMap />
          <span>记忆星图</span>
        </Link>
        <Link href="/companion/daily" className="companion-memory-link">
          <Icon.Sparkle />
          <span>桌宠日记</span>
        </Link>
        <Link href="/companion/conversations" className="companion-memory-link">
          <Icon.Timeline />
          <span>对话历史</span>
        </Link>
      </nav>

      <section className="companion-memory-create" aria-label="手动新增记忆">
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as MemoryItem["kind"])} aria-label="新记忆类型">
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          value={newContent}
          maxLength={200}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleCreate();
            }
          }}
          placeholder="手动记一条，例如：这周想重点突破有机化学"
          aria-label="新记忆内容"
        />
        <button type="button" disabled={creating || !newContent.trim()} onClick={() => void handleCreate()}>
          {creating ? "添加中…" : "添加记忆"}
        </button>
      </section>

      <section className="companion-memory-toolbar" aria-label="记忆筛选">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索记忆内容"
          aria-label="搜索记忆内容"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="记忆类型">
          <option value="">全部类型</option>
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={showCandidates} onChange={(e) => setShowCandidates(e.target.checked)} />
          显示候选
        </label>
        <label>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示归档
        </label>
        <button
          type="button"
          className="memory-export"
          disabled={exporting}
          onClick={handleExport}
        >
          {exporting ? "导出中…" : "导出记忆"}
        </button>
        <button type="button" className="memory-clear-all" onClick={handleClearAll}>
          一键清空
        </button>
      </section>

      {conflicts.length > 0 && (
        <section className="companion-memory-conflicts" aria-label="记忆冲突">
          <h2>记忆冲突</h2>
          <ul>
            {conflicts.map((item) => {
              const pair = conflicts.find((c) => c.conflictGroup === item.conflictGroup && c.memoryItemId !== item.memoryItemId);
              if (!pair || pair.memoryItemId < item.memoryItemId) return null;
              return (
                <li key={item.memoryItemId}>
                  <span>{KIND_LABEL[item.kind]}：{item.content}</span>
                  <span>vs</span>
                  <span>{KIND_LABEL[pair.kind]}：{pair.content}</span>
                  <button type="button" onClick={() => void handleResolveConflict(item.memoryItemId, pair.memoryItemId)}>
                    保留前者
                  </button>
                  <button type="button" onClick={() => void handleResolveConflict(pair.memoryItemId, item.memoryItemId)}>
                    保留后者
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {error && (
        <section className="companion-memory-error" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={reload}>重新加载</button>
        </section>
      )}

      {items === null && !error ? (
        <section className="companion-memory-loading" aria-busy="true" role="status">
          正在读取记忆…
        </section>
      ) : items !== null && items.length === 0 ? (
        <section className="companion-memory-empty" role="status">
          <Icon.Sparkle aria-hidden="true" />
          <strong>还没有匹配的记忆</strong>
          <p>当你在对话中明确表达目标、偏好或约束时，伴星会在这里保存可审计的记忆。</p>
        </section>
      ) : (
        <ul className="companion-memory-list" aria-label="记忆列表">
          {items!.map((item) => (
            <li key={item.memoryItemId} data-candidate={item.candidate || undefined} data-archived={item.archived || undefined}>
              <div className="memory-item-main">
                <span className="memory-item-kind">{KIND_LABEL[item.kind]}</span>
                <p>{item.content}</p>
              </div>
              <div className="memory-item-meta">
                <MemoryStatusBadge item={item} />
                <small>
                  创建 {formatMemoryDate(item.createdAt)}
                  {item.sourceSessionId ? ` · 会话 ${item.sourceSessionId.slice(0, 8)}` : ""}
                  {item.importance !== undefined ? ` · 重要度 ${item.importance.toFixed(1)}` : ""}
                </small>
              </div>
              <MemoryActions item={item} onChanged={handleMemoryChanged} />
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClearOpen}
        title="清空全部桌宠记忆？"
        message="将删除伴星保存的全部记忆（含候选）。该操作不会影响已提交的学习事实与对话历史。"
        confirmLabel="清空"
        variant="danger"
        loading={clearing}
        onConfirm={() => void confirmClearAll()}
        onCancel={() => {
          if (!clearing) setConfirmClearOpen(false);
        }}
      />
    </main>
  );
}
