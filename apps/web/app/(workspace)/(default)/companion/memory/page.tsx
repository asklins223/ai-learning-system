"use client";

/**
 * 伴星记忆管理（方案 16 §10.3：有来源、可审计、可删除）。
 *
 * - 列表：active（参与主动策略）+ candidate（模型候选，默认不参与）；
 * - candidate → 确认/拒绝（确认后参与主动策略；拒绝 soft delete 审计保留）；
 * - active → 删除（soft delete；canonical 学习事实与 schedule 绝不受影响）；
 * - 记忆删除与学习真相解耦：本页不显示也不修改掌握度/复习安排。
 */

import "../conversations/conversation-page.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { Icon } from "@/components/ui/icons";

interface MemoryItem {
  memoryItemId: string;
  kind: "preference" | "goal" | "learning_context" | "interaction_note";
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  candidate: boolean;
  createdAt: string;
  updatedAt: string;
}

const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  preference: "偏好",
  goal: "目标",
  learning_context: "学习情境",
  interaction_note: "互动备注",
};

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
  if (!item.userConfirmed && !item.userStated) {
    return <span className="memory-badge is-derived">派生记忆</span>;
  }
  return <span className="memory-badge is-active">活跃记忆</span>;
}

function MemoryActions({
  item,
  onChanged,
}: {
  item: MemoryItem;
  onChanged: (id: string, kind: "confirm" | "reject" | "delete") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (kind: "confirm" | "reject" | "delete") => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "confirm") await api.confirmCompanionMemory(item.memoryItemId);
      else if (kind === "reject") await api.rejectCompanionMemory(item.memoryItemId);
      else await api.deleteCompanionMemory(item.memoryItemId);
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
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => void act("delete")}>
          删除
        </button>
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
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void api.listCompanionMemories(true).then((result) => {
      setItems((result.items as MemoryItem[]) ?? []);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "暂时无法读取记忆");
    });
  }, []);

  // F#7（🟡17）：单项操作后仅局部 mutate 列表，不整表 reload。confirm 把候选
  // 提升为活跃；reject/delete 从列表移除（soft delete 审计保留由服务端负责）。
  const handleMemoryChanged = useCallback((id: string, kind: "confirm" | "reject" | "delete") => {
    setItems((current) => {
      if (!current) return current;
      if (kind === "confirm") {
        return current.map((item) =>
          item.memoryItemId === id
            ? { ...item, candidate: false, userConfirmed: true }
            : item,
        );
      }
      if (kind === "reject" || kind === "delete") {
        return current.filter((item) => item.memoryItemId !== id);
      }
      return current;
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <main className="companion-memory-page">
      <header className="companion-memory-head">
        <span className="companion-memory-eyebrow"><i aria-hidden="true" /> COMPANION MEMORY</span>
        <h1>伴星记忆</h1>
        <p>
          伴星长期记住的目标、偏好与情境。候选记忆默认不参与主动介入；
          确认后才会被使用。删除记忆不影响任何已提交的学习事实与复习安排。
        </p>
      </header>

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
          <strong>还没有保存的记忆</strong>
          <p>当你在对话中明确表达目标、偏好或约束时，伴星会在这里保存可审计的记忆。</p>
        </section>
      ) : (
        <ul className="companion-memory-list" aria-label="记忆列表">
          {items!.map((item) => (
            <li key={item.memoryItemId} data-candidate={item.candidate || undefined}>
              <div className="memory-item-main">
                <span className="memory-item-kind">{KIND_LABEL[item.kind]}</span>
                <p>{item.content}</p>
              </div>
              <div className="memory-item-meta">
                <MemoryStatusBadge item={item} />
                <small>
                  创建 {formatMemoryDate(item.createdAt)}
                  {item.sourceSessionId ? ` · 会话 ${item.sourceSessionId.slice(0, 8)}` : ""}
                </small>
              </div>
              <MemoryActions item={item} onChanged={handleMemoryChanged} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
