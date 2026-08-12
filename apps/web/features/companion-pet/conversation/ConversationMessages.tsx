"use client";

import { useEffect, useRef } from "react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { PetIcon } from "@/features/companion-pet/surfaces/PetIcon";
import {
  formatMessageTime,
  textFromBlocks,
  type Message,
} from "./conversation-model";

export const CONVERSATION_SUGGESTIONS = [
  "帮我梳理今天学的内容",
  "用一句话解释这个概念",
  "出一个题考考我",
  "根据我的笔记做个小结",
] as const;

/**
 * 消息流：assistant 带头像徽章、气泡 + markdown 渲染；user 右侧气泡；
 * 流式消息带闪烁光标；自动吸附底部。
 */
export function ConversationMessages({
  messages,
  sending,
  hasConversation,
  onSuggestion,
}: {
  messages: Message[];
  sending: boolean;
  hasConversation: boolean;
  onSuggestion: (text: string) => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const element = threadRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
  };

  useEffect(() => {
    const element = threadRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="conversation-empty">
        <img
          className="conversation-empty__art"
          src="/images/companion/pet/sprite-v1/idle.png"
          alt=""
          aria-hidden="true"
        />
        <h2 className="conversation-empty__title">
          {hasConversation ? "从一句话开始" : "和伴星聊聊"}
        </h2>
        <p className="conversation-empty__copy">
          {hasConversation
            ? "这段对话还是空的，问点问题，或说说你正在学什么。"
            : "伴星会记住你们的完整对话，随时回来接着聊。"}
        </p>
        <div className="conversation-empty__suggestions">
          {CONVERSATION_SUGGESTIONS.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className="conversation-empty__suggestion"
              onClick={() => onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={threadRef}
      className="conversation-thread"
      aria-live="polite"
      onScroll={handleScroll}
    >
      {messages.map((message) => {
        const isUser = message.role === "user";
        const text = textFromBlocks(message.blocks);
        const streaming = !isUser && message.id.startsWith("assistant-") && sending;
        return (
          <article
            key={message.id}
            className={`conversation-message conversation-message--${isUser ? "user" : "assistant"}`}
            data-streaming={streaming ? "true" : "false"}
          >
            <span className="conversation-message__avatar" aria-hidden="true">
              <PetIcon name={isUser ? "study" : "sparkles"} />
            </span>
            <div className="conversation-message__body">
              <div className="conversation-bubble">
                {isUser ? (
                  <p>{text}</p>
                ) : (
                  <MarkdownPreview source={text} />
                )}
                {streaming ? <span className="conversation-caret" aria-hidden="true" /> : null}
              </div>
              <div className="conversation-message__meta">
                {formatMessageTime(message.createdAt)}
                {streaming ? " · 生成中" : ""}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
