"use client";

import { useEffect, useRef } from "react";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import { PetIcon } from "./PetIcon";

const MAX_DRAFT_LENGTH = 1_200;

export function PetComposer() {
  const { state, dispatch } = usePetRuntime();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editing = state.composer.kind === "editing";
  const submitting = state.composer.kind === "submitting";
  const draft = state.composer.kind === "editing"
    ? state.composer.draft
    : state.composer.kind === "submitting"
      ? state.composer.draftSnapshot
      : "";
  const running = state.turn.kind === "running";

  useEffect(() => {
    if (!editing) return;
    const input = textareaRef.current;
    input?.focus();
    if (input) {
      input.style.height = "0px";
      input.style.height = `${Math.min(76, Math.max(24, input.scrollHeight))}px`;
    }
  }, [editing, draft]);

  if (!editing && !submitting) return null;

  const submit = () => {
    // running 时发送按钮已被"停止回复"替代；Enter/快捷键不得绕过该门控
    // （草稿保留在 editing 状态，回复结束后仍可发送）。
    if (!editing || running || submitting || draft.trim().length === 0) return;
    dispatch({ type: "composer.submitted" });
  };

  return (
    <section
      className="pet-composer"
      data-pet-region="composer"
      data-state={submitting ? "submitting" : running ? "replying" : "editing"}
      aria-label="和学习伴星对话"
    >
      <header className="pet-composer-header">
        <span className="pet-composer-identity"><PetIcon name="sparkles" /> 和伴星聊聊</span>
        <span className="pet-composer-hint">Enter 发送</span>
        <button
          type="button"
          className="pet-icon-button"
          aria-label="关闭输入框"
          disabled={submitting}
          onClick={() => dispatch({ type: "composer.closed" })}
        >
          <PetIcon name="close" />
        </button>
      </header>

      <div className="pet-composer-field">
        <textarea
          ref={textareaRef}
          className="pet-composer-input"
          rows={1}
          maxLength={MAX_DRAFT_LENGTH}
          placeholder="问问题、聊想法，或说说你在学什么…"
          value={draft}
          disabled={submitting}
          aria-label="伴星消息输入"
          onChange={(event) => dispatch({ type: "composer.draft_changed", draft: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              dispatch({ type: "composer.closed" });
            }
          }}
        />

        <div className="pet-composer-tools">
          {draft.length > 900 ? (
            <span className="pet-composer-count" aria-live="polite">{draft.length}/{MAX_DRAFT_LENGTH}</span>
          ) : null}
          {running ? (
            <button
              type="button"
              className="pet-composer-submit is-stop"
              onClick={() => dispatch({ type: "turn.cancel_requested" })}
              aria-label="停止回复"
              title="停止当前回复"
            >
              <PetIcon name="stop" />
            </button>
          ) : (
            <button
              type="button"
              className="pet-composer-submit"
              onClick={submit}
              disabled={submitting || draft.trim().length === 0}
              aria-label="发送消息"
              title="发送消息"
            >
              <PetIcon name="send" />
            </button>
          )}
        </div>
      </div>

      <footer className="pet-composer-footer">
        <span>{running ? "回复生成中，你可以先写下一条" : "Shift + Enter 换行"}</span>
      </footer>
    </section>
  );
}
