"use client";

import { PetIcon } from "@/features/companion-pet/surfaces/PetIcon";
import {
  conversationSubtitle,
  type Conversation,
} from "./conversation-model";

export function ConversationSidebar({
  conversations,
  selectedId,
  onSelect,
  onCreate,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="conversation-sidebar" aria-label="对话列表">
      <header className="conversation-sidebar__header">
        <h1 className="conversation-sidebar__title">
          <PetIcon name="history" />
          完整对话
        </h1>
        <button
          type="button"
          className="conversation-sidebar__new"
          onClick={onCreate}
        >
          <PetIcon name="plus" />
          新对话
        </button>
      </header>

      <div className="conversation-list">
        {conversations.map((conversation) => {
          const active = selectedId === conversation.id;
          return (
            <button
              type="button"
              key={conversation.id}
              className="conversation-list__item"
              onClick={() => onSelect(conversation.id)}
              aria-pressed={active}
              title={conversation.title || "未命名对话"}
            >
              <span className="conversation-list__title">
                {conversation.title || "未命名对话"}
              </span>
              <span className="conversation-list__meta">
                {conversationSubtitle(conversation)}
              </span>
            </button>
          );
        })}
        {conversations.length === 0 ? (
          <p className="conversation-sidebar__empty">
            还没有对话，
            <br />
            先发一条消息吧。
          </p>
        ) : null}
      </div>
    </aside>
  );
}
