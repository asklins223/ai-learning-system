"use client";

import { useEffect, useRef } from "react";
import { PetIcon } from "@/features/companion-pet/surfaces/PetIcon";

const MAX_DRAFT_LENGTH = 1_200;

export function ConversationComposer({
  draft,
  sending,
  onChange,
  onSubmit,
}: {
  draft: string;
  sending: boolean;
  onChange: (draft: string) => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(152, Math.max(24, input.scrollHeight))}px`;
  }, [draft]);

  const canSend = !sending && draft.trim().length > 0;

  return (
    <footer className="conversation-composer">
      <div className="conversation-composer__field">
        <textarea
          ref={textareaRef}
          className="conversation-composer__input"
          rows={1}
          maxLength={MAX_DRAFT_LENGTH}
          placeholder="问问题、聊想法，或说说你在学什么…"
          value={draft}
          disabled={sending}
          aria-label="伴星消息输入"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        <div className="conversation-composer__tools">
          {draft.length > 900 ? (
            <span className="conversation-composer__count" aria-live="polite">
              {draft.length}/{MAX_DRAFT_LENGTH}
            </span>
          ) : null}
          <button
            type="button"
            className="conversation-composer__send"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label={sending ? "发送中" : "发送消息"}
            title="发送消息"
          >
            <PetIcon name="send" />
          </button>
        </div>
      </div>
      <div className="conversation-composer__hint">
        <span>{sending ? "回复生成中，你可以稍等一下" : "Enter 发送 · Shift + Enter 换行"}</span>
        <span>伴星会记住这段对话</span>
      </div>
    </footer>
  );
}
