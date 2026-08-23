"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CompanionHistoryArchive } from "@/features/companion-history/CompanionHistoryArchive";
import { COMPANION_HISTORY_FIXTURES } from "@/features/companion-history/history-fixtures";
import {
  adaptProductionHistoryMessage,
  type CompanionHistoryMessageInput,
} from "@/features/companion-history/history-model";
import { useCompanionConversations } from "@/features/companion-pet/conversation/useCompanionConversations";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import "./conversation-page.css";

/**
 * 伴星交互记录现在是同一只 Live2D 桌面伴星的只读档案/审计页。
 * 它复用现有真实历史读取链，但不再提供 create / composer / send / delete，
 * 避免形成第二套聊天前台。
 */
export default function CompanionConversationsPage() {
  return (
    <Suspense fallback={<HistoryLoading />}>
      <CompanionConversationsRoute />
    </Suspense>
  );
}

function CompanionConversationsRoute() {
  const searchParams = useSearchParams();
  if (process.env.NODE_ENV === "development" && searchParams.get("preview") === "full") {
    return <CompanionHistoryPreview />;
  }

  const requestedConversationId = searchParams.get("conversationId")
    ?? searchParams.get("conversation");
  return <ProductionCompanionHistory requestedConversationId={requestedConversationId} />;
}

function ProductionCompanionHistory({
  requestedConversationId,
}: {
  requestedConversationId: string | null;
}) {
  // P5（文档 16 §14.2）：完整历史页发布 bounded context。
  // 第八轮 🟡B-1：useMemo 稳定引用（取决于 requestedConversationId）。
  useMainPageContext(useMemo(() => ({
    routeRef: { kind: "conversation" },
    pageKind: "conversation",
    entityRefs: requestedConversationId
      ? [{ kind: "assistant_session", assistantSessionId: requestedConversationId }]
      : [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  }), [requestedConversationId]));
  const {
    enabled,
    conversations,
    selectedId,
    messages,
    messagesLoading,
    loading,
    error,
    selectConversation,
    loadOlderMessages,
    olderAvailable,
    olderLoading,
    deleteSelected,
  } = useCompanionConversations(requestedConversationId);

  // FN1：稳定 entries 身份——useMemo 让未变的历史条目在流式 delta 时保持
  // 对象引用，避免每次 delta 重建数组导致 CompanionHistoryArchive 全量重算。
  const entries = useMemo(() => messages.map(
    (message) => adaptProductionHistoryMessage(message as CompanionHistoryMessageInput),
  ), [messages]);

  // 删除确认：ConfirmDialog 二次确认（替代原生 window.confirm）。
  // Hooks 必须在 early return 之前调用。
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteSelected();
      setConfirmDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  }, [deleteSelected]);

  if (loading) return <HistoryLoading />;

  // P8（文档 16 §10.4/§21.3）：导出/删除/召回接线（服务端端点已存在）。
  const handleExport = () => {
    // NDJSON 下载（GET + cookie 鉴权；Content-Disposition attachment）。
    window.open("/api/companion/export", "_blank", "noopener");
  };
  const handleDelete = () => {
    if (!selectedId) return;
    setConfirmDeleteOpen(true);
  };
  const handleRecallPet = () => {
    // 仅 Electron Main 窗口存在 desktopAPI（浏览器 fail closed）。
    window.desktopAPI?.setPetModeEnabled(true).catch(() => {});
  };

  return (
    <>
      <CompanionHistoryArchive
        conversations={conversations}
        selectedId={selectedId}
        entries={entries}
        entriesLoading={messagesLoading}
        onSelect={selectConversation}
        source="production"
        error={error}
        limitationNote={enabled === false
          ? "当前账户尚未开启文字历史读取；桌面伴星的其他能力不受影响。"
          : "读取范围：最多 50 段活跃对话；每段最近 100 条，更早记录按需分页读取。"}
        historyPage={{
          loadedCount: entries.length,
          // P8：真实 cursor 分页已接线（服务端 beforeSeq keyset + hasMore）。
          hasEarlier: olderAvailable,
          loading: olderLoading,
          onLoadEarlier: () => void loadOlderMessages(),
        }}
        onExport={handleExport}
        onDelete={handleDelete}
        onRecallPet={handleRecallPet}
      />
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除这段对话？"
        message="删除后将清除该对话的正文与索引，并保留最小审计留痕。已提交的学习事实不会改变。"
        confirmLabel="删除"
        variant="danger"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deleting) setConfirmDeleteOpen(false);
        }}
      />
    </>
  );
}

function CompanionHistoryPreview() {
  const [selectedId, setSelectedId] = useState(COMPANION_HISTORY_FIXTURES[0]?.id ?? null);
  const [visibleEntryCount, setVisibleEntryCount] = useState(5);
  const selected = COMPANION_HISTORY_FIXTURES.find((conversation) => conversation.id === selectedId) ?? null;
  useEffect(() => setVisibleEntryCount(5), [selectedId]);
  const allEntries = selected?.entries ?? [];
  const visibleEntries = allEntries.slice(Math.max(0, allEntries.length - visibleEntryCount));
  return (
    <CompanionHistoryArchive
      conversations={COMPANION_HISTORY_FIXTURES.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        messageCount: conversation.entries.length,
      }))}
      selectedId={selectedId}
      entries={visibleEntries}
      onSelect={setSelectedId}
      source="prototype"
      limitationNote="开发预览不会读取、创建或修改账户中的任何对话。"
      historyPage={{
        loadedCount: visibleEntries.length,
        totalCount: allEntries.length,
        hasEarlier: visibleEntries.length < allEntries.length,
        onLoadEarlier: visibleEntries.length < allEntries.length
          ? () => setVisibleEntryCount((count) => count + 20)
          : undefined,
      }}
    />
  );
}

function HistoryLoading() {
  return (
    <div className="history-loading" aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">正在打开伴星交互档案</span>
      <header className="history-loading__masthead">
        <div><i /><i /><i /></div>
        <span><Icon.Lock aria-hidden="true" /></span>
      </header>
      <div className="history-loading__layout">
        <aside>
          <i className="history-loading__portrait" />
          <i /><i /><i /><i />
        </aside>
        <section>
          <i /><i />
          <div className="history-loading__entry"><b /><span /></div>
          <div className="history-loading__entry"><b /><span /></div>
          <div className="history-loading__entry"><b /><span /></div>
        </section>
      </div>
    </div>
  );
}
