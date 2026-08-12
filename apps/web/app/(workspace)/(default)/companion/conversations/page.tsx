"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PetIcon } from "@/features/companion-pet/surfaces/PetIcon";
import { ConversationComposer } from "@/features/companion-pet/conversation/ConversationComposer";
import { ConversationMessages } from "@/features/companion-pet/conversation/ConversationMessages";
import { ConversationSidebar } from "@/features/companion-pet/conversation/ConversationSidebar";
import { useCompanionConversations } from "@/features/companion-pet/conversation/useCompanionConversations";
import "./conversation-page.css";

// 2026-08-11：useSearchParams 需在 Suspense 内（Next 15 CSR bailout 约束）——
// 无 Suspense 时构建产生 warning，部署 Vercel 会拒。默认导出包 Suspense。
export default function CompanionConversationsPage() {
  return (
    <Suspense fallback={<main className="conversation-loading"><LoadingPanel /></main>}>
      <CompanionConversationsInner />
    </Suspense>
  );
}

function LoadingPanel() {
  return (
    <>
      <aside className="conversation-loading__panel" aria-hidden="true">
        <div className="conversation-loading__skeleton-line conversation-loading__skeleton-line--w58" />
        <div className="conversation-loading__skeleton-line conversation-loading__skeleton-line--w92" />
        <div className="conversation-loading__skeleton-line conversation-loading__skeleton-line--w78" />
        <div className="conversation-loading__skeleton-line conversation-loading__skeleton-line--w86" />
      </aside>
      <section className="conversation-loading__panel" aria-hidden="true">
        <div className="conversation-loading__skeleton-line conversation-loading__skeleton-line--w34" />
      </section>
    </>
  );
}

function CompanionConversationsInner() {
  const searchParams = useSearchParams();
  const requestedConversationId = searchParams.get("conversationId");
  const {
    enabled,
    conversations,
    selected,
    selectedId,
    messages,
    draft,
    loading,
    sending,
    error,
    setDraft,
    selectConversation,
    createConversation,
    sendMessage,
    deleteSelected,
  } = useCompanionConversations(requestedConversationId);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createConversation();
    } catch {
      // createConversation 抛错时保持现状；hook 无 error 通道，静默即可
      // 与旧行为一致（原页面 catch 由调用方 promise 链吞掉）。
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmDelete = async () => {
    setConfirmDeleteOpen(false);
    await deleteSelected();
  };

  if (loading) {
    return (
      <main className="conversation-loading">
        <LoadingPanel />
      </main>
    );
  }
  if (enabled === false) {
    return (
      <main className="conversation-loading conversation-loading--single">
        <section className="conversation-loading__panel">
          <h1 className="conversation-sidebar__title"><PetIcon name="history" />完整对话</h1>
          <p className="conversation-loading__note">
            文字对话能力尚未开启，桌宠仍可使用文字演示模式。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="conversation-page">
      <ConversationSidebar
        conversations={conversations}
        selectedId={selectedId}
        onSelect={selectConversation}
        onCreate={() => void handleCreate()}
      />

      <section className="conversation-main" aria-label="对话">
        <header className="conversation-main__header">
          <div className="conversation-main__heading">
            <h2 className="conversation-main__title">
              {selected?.title || "新对话"}
            </h2>
            <p className="conversation-main__subtitle">
              <PetIcon name="sparkles" />
              和伴星的对话会自动保存，随时回来接着聊
            </p>
          </div>
          {selected ? (
            <button
              type="button"
              className="conversation-main__delete"
              onClick={() => setConfirmDeleteOpen(true)}
            >
              <PetIcon name="trash" />
              删除
            </button>
          ) : null}
        </header>

        <ConversationMessages
          messages={messages}
          sending={sending}
          hasConversation={Boolean(selected)}
          onSuggestion={setDraft}
        />

        {error ? (
          <p role="alert" className="conversation-error">
            <PetIcon name="alert" />
            {error}
          </p>
        ) : null}

        <ConversationComposer
          draft={draft}
          sending={sending}
          onChange={setDraft}
          onSubmit={() => void sendMessage()}
        />
      </section>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除这段对话？"
        message="删除后这段对话将不再出现在列表里，操作无法撤销。"
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </main>
  );
}
