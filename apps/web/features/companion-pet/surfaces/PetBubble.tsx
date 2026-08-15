"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import { bubbleAutoDismissMs, shouldShowFullContentLink } from "./bubble-model";
import type {
  BubbleDisplayStateV1,
  ConversationTurnStateV1,
  VoiceDialogueStateV1,
} from "../runtime/pet-runtime-types";
import type { AllowedMainRouteV1 } from "@ailearn/shared";
import { PetIcon, type PetIconNameV1 } from "./PetIcon";

type BubbleToneV1 = "neutral" | "active" | "success" | "warning" | "danger";

interface BubbleViewV1 {
  key: string;
  tone: BubbleToneV1;
  icon: PetIconNameV1;
  label: string;
  liveLabel?: string;
  content: React.ReactNode;
  dismissible: boolean;
  autoDismissKind: "incoming" | "final" | null;
  textLength: number;
}

function turnBubbleView(
  bubble: Extract<BubbleDisplayStateV1, { kind: "turn" }>,
  turn: ConversationTurnStateV1,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onScroll: () => void,
): BubbleViewV1 | null {
  if (bubble.ref.kind === "client") {
    return {
      key: `client-${bubble.ref.clientMessageId}`,
      tone: "active",
      icon: "send",
      label: "消息已送出",
      liveLabel: "正在交给伴星",
      dismissible: false,
      autoDismissKind: null,
      textLength: 0,
      content: <p className="pet-bubble-copy">我收到了，马上看看。</p>,
    };
  }

  if (turn.kind === "running") {
    if (turn.phase === "accepted" || turn.phase === "thinking") {
      return {
        key: `thinking-${turn.runId}`,
        tone: "active",
        icon: "sparkles",
        label: "伴星正在想",
        liveLabel: turn.phase === "accepted" ? "已接收" : "组织回复中",
        dismissible: false,
        autoDismissKind: null,
        textLength: 0,
        content: (
          <div className="pet-thinking-line" role="status" aria-live="polite">
            <span className="pet-bubble-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>正在整理一个清楚的回答</span>
          </div>
        ),
      };
    }

    const long = shouldShowFullContentLink(turn.previewText);
    return {
      key: `streaming-${turn.runId}`,
      tone: "active",
      icon: "sparkles",
      label: "伴星",
      liveLabel: "回复生成中",
      dismissible: false,
      autoDismissKind: null,
      textLength: turn.previewText.length,
      content: (
        <div className="pet-bubble-answer" role="status" aria-live="polite">
          <div className="pet-bubble-scroll" data-bubble-scroll ref={scrollRef} onScroll={onScroll}>
            <p className={`pet-bubble-copy pet-bubble-preview${long ? " is-long" : ""}`}>
              {turn.previewText || "正在写下第一句…"}
            </p>
          </div>
        </div>
      ),
    };
  }

  if (turn.kind === "final") {
    const long = shouldShowFullContentLink(turn.previewText);
    return {
      key: `final-${turn.runId}`,
      tone: "success",
      icon: "check",
      label: "伴星",
      liveLabel: "回复完成",
      dismissible: true,
      autoDismissKind: "final",
      textLength: turn.previewText.length,
      content: (
        <div className="pet-bubble-answer is-final" aria-live="polite">
          <div className="pet-bubble-scroll" data-bubble-scroll ref={scrollRef} onScroll={onScroll}>
            <p className={`pet-bubble-copy pet-bubble-preview${long ? " is-long" : ""}`}>
              {turn.previewText}
            </p>
          </div>
        </div>
      ),
    };
  }

  if (turn.kind === "cancelled") {
    return {
      key: `cancelled-${turn.runId}`,
      tone: "neutral",
      icon: "stop",
      label: "回复已停止",
      dismissible: true,
      autoDismissKind: "final",
      textLength: 6,
      content: <p className="pet-bubble-copy">这一轮停在这里，你随时可以换个问法。</p>,
    };
  }

  return null;
}

function voiceBubbleView(voice: VoiceDialogueStateV1): BubbleViewV1 | null {
  switch (voice.kind) {
    case "error":
      if (voice.code === "AUDIO_TOO_SHORT") {
        return {
          key: `voice-error-${voice.code}`,
          tone: "warning",
          icon: "microphone",
          label: "录音太短",
          liveLabel: "请再说一小句",
          dismissible: true,
          autoDismissKind: null,
          textLength: 0,
          content: <p className="pet-bubble-copy">请多说一小句，再点一下结束录音。</p>,
        };
      }
      if (voice.code === "AUDIO_TOO_LARGE") {
        return {
          key: `voice-error-${voice.code}`,
          tone: "warning",
          icon: "microphone",
          label: "录音太长",
          liveLabel: "请缩短后重试",
          dismissible: true,
          autoDismissKind: null,
          textLength: 0,
          content: <p className="pet-bubble-copy">这段录音超过大小上限，请缩短后再试。</p>,
        };
      }
      if (voice.code === "permission_denied" || voice.code === "AUDIO_CAPTURE_FAILED") {
        return {
          key: `voice-error-${voice.code}`,
          tone: "danger",
          icon: "alert",
          label: "麦克风不可用",
          liveLabel: "文字输入仍可用",
          dismissible: true,
          autoDismissKind: null,
          textLength: 0,
          content: <p className="pet-bubble-copy">没有拿到可用的麦克风，你可以继续打字。</p>,
        };
      }
      // Provider/network failures are deliberately mapped to static copy;
      // never render the server error code or provider detail in the bubble.
      return {
        key: `voice-error-${voice.code}`,
        tone: "warning",
        icon: "alert",
        label: "暂时无法识别",
        liveLabel: "可以重试或继续打字",
        dismissible: true,
        autoDismissKind: null,
        textLength: 0,
        content: <p className="pet-bubble-copy">语音识别暂时不可用，可以重试，或继续使用文字输入。</p>,
      };
    default:
      return null;
  }
}

function bubbleView(
  bubble: BubbleDisplayStateV1,
  turn: ConversationTurnStateV1,
  voice: VoiceDialogueStateV1,
  privacyMode: boolean,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onScroll: () => void,
  onOpenRoute: (route: AllowedMainRouteV1) => void,
): BubbleViewV1 | null {
  const voiceView = voiceBubbleView(voice);
  if (voiceView) return voiceView;

  switch (bubble.kind) {
    case "hidden":
      return null;
    case "turn":
      return turnBubbleView(bubble, turn, scrollRef, onScroll);
    case "incoming":
      // §10.3：手动隐私模式只显示无正文占位，不显示 proactive 正文。
      if (privacyMode) {
        return {
          key: `incoming-${bubble.deliveryId}`,
          tone: "warning",
          icon: "sparkles",
          label: "伴星提醒",
          liveLabel: "不着急",
          dismissible: true,
          autoDismissKind: "incoming",
          textLength: 0,
          content: <p className="pet-bubble-copy pet-bubble-incoming">伴星有一条消息，内容已隐藏。</p>,
        };
      }
      return {
        key: `incoming-${bubble.deliveryId}`,
        tone: "warning",
        icon: "sparkles",
        label: "伴星提醒",
        liveLabel: "不着急",
        dismissible: true,
        autoDismissKind: "incoming",
        textLength: bubble.previewText.length,
        content: <p className="pet-bubble-copy pet-bubble-incoming">{bubble.previewText}</p>,
      };
    case "voice_status":
      return voiceView;
    case "error":
      return {
        key: `error-${bubble.code}`,
        tone: "danger",
        icon: "alert",
        label: "连接遇到问题",
        liveLabel: "草稿还在",
        dismissible: true,
        autoDismissKind: null,
        textLength: 0,
        content: <p className="pet-bubble-copy">这次没有成功送达。可以稍后重试，或先换个问题。</p>,
      };
    case "action_result":
      return {
        key: `action-result-${bubble.actionRunId}`,
        tone: bubble.status === "completed" ? "success" : "danger",
        icon: bubble.status === "completed" ? "check" : "alert",
        label: bubble.status === "completed" ? "学习动作完成" : "学习动作未完成",
        liveLabel: bubble.status === "completed" ? "已更新" : "可以重试",
        dismissible: true,
        autoDismissKind: null,
        textLength: bubble.summary.length,
        content: (
          <div className="pet-bubble-action-result" role="status" aria-live="polite">
            <p className="pet-bubble-copy">{bubble.summary}</p>
            {bubble.route ? (
              <button
                type="button"
                className="pet-bubble-route-action"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenRoute(bubble.route!);
                }}
              >
                打开相关页面
              </button>
            ) : null}
          </div>
        ),
      };
    case "action_pending":
      return {
        key: `action-pending-${bubble.actionRunId}`,
        tone: "active",
        icon: "sparkles",
        label: "学习动作进行中",
        liveLabel: "正在处理",
        dismissible: false,
        autoDismissKind: null,
        textLength: bubble.summary.length,
        content: (
          <div className="pet-bubble-action-result" role="status" aria-live="polite">
            <p className="pet-bubble-copy">{bubble.summary}</p>
          </div>
        ),
      };
    case "confirmation":
      return null;
  }
}

export function PetBubble() {
  const { state, dispatch, adapter } = usePetRuntime();
  const { bubble, turn, voice, composer, menu } = state;
  const timerRef = useRef<number | null>(null);
  const [held, setHeld] = useState(false);
  const [contentOverflowing, setContentOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }, []);

  const view = useMemo(
    () => bubbleView(bubble, turn, voice, state.context.privacyMode, scrollRef, handleScroll, (route) => void adapter.openMainRoute(route)),
    [adapter, bubble, turn, voice, state.context.privacyMode, handleScroll],
  );

  const previewText = turn.kind === "running" || turn.kind === "final" ? turn.previewText : undefined;
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [previewText, view?.key]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      setContentOverflowing(Boolean(element && element.scrollHeight > element.clientHeight + 1));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewText, view?.key]);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!view || !view.autoDismissKind || held) return;
    if (composer.kind !== "closed" || menu.kind !== "closed" || voice.kind === "speaking") return;
    const duration = bubbleAutoDismissMs(view.autoDismissKind === "incoming" ? "incoming" : "turn", view.textLength);
    if (duration === null) return;
    timerRef.current = window.setTimeout(() => dispatch({ type: "bubble.dismissed" }), duration);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [view, held, composer.kind, menu.kind, voice.kind, dispatch]);

  if (!view) return null;
  const longText = contentOverflowing || (view.textLength > 0 && shouldShowFullContentLink(previewText ?? ""));

  return (
    <section
      className="pet-bubble"
      data-pet-region="bubble"
      data-tone={view.tone}
      data-bubble={view.key}
      aria-label={view.label}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        dispatch({ type: "composer.opened" });
      }}
    >
      <header className="pet-bubble-header">
        <span className="pet-bubble-icon"><PetIcon name={view.icon} /></span>
        <span className="pet-bubble-label">{view.label}</span>
        {view.liveLabel ? <span className="pet-bubble-live">{view.liveLabel}</span> : null}
        {view.dismissible ? (
          <button
            type="button"
            className="pet-icon-button pet-bubble-dismiss"
            aria-label="收起这条消息"
            onClick={() => dispatch({ type: "bubble.dismissed" })}
          >
            <PetIcon name="close" />
          </button>
        ) : null}
      </header>

      <div className="pet-bubble-body">{view.content}</div>

      {(longText || view.tone === "danger" || view.autoDismissKind === "incoming" || view.autoDismissKind === "final") ? (
        <footer className="pet-bubble-footer">
          {longText ? (
            <button
              type="button"
              className="pet-text-action"
              onClick={() => void adapter.openMainRoute({ kind: "conversation" })}
            >
              完整内容 <PetIcon name="chevron" />
            </button>
          ) : null}
          {view.tone === "danger" ? (
            <button
              type="button"
              className="pet-text-action"
              onClick={() => {
                dispatch({ type: "bubble.dismissed" });
                dispatch({ type: "composer.opened" });
              }}
            >
              改用文字 <PetIcon name="message" />
            </button>
          ) : null}
          {!longText && view.tone !== "danger" ? (
            <button type="button" className="pet-text-action" onClick={() => dispatch({ type: "composer.opened" })}>
              继续聊 <PetIcon name="message" />
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
