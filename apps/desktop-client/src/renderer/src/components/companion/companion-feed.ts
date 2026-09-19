/**
 * 划选/拖拽投喂的事件总线（2026-09-18，设计文档 §二 切片①③）。
 *
 * 采集侧（右键菜单 / 窗口 drop）通过 window CustomEvent 把选中文本递给
 * CompanionPresence → 聊天抽屉；解耦为事件而不直接 import，避免菜单组件
 * 与伴星树互相依赖。文本上限 2000 字（与 turn 契约一致）。
 */

export const COMPANION_FEED_EVENT = "ailearn:companion-feed";
export const COMPANION_OPEN_CHAT_EVENT = "ailearn:companion-open-chat";

export const COMPANION_FEED_MAX_CHARS = 2_000;

export interface CompanionFeedSelection {
  readonly text: string;
  readonly source: "selection" | "drop";
}

export function feedSelectionToCompanion(selection: CompanionFeedSelection): void {
  const text = selection.text.trim();
  if (text.length === 0) return;
  window.dispatchEvent(new CustomEvent<CompanionFeedSelection>(COMPANION_FEED_EVENT, {
    detail: { text: text.slice(0, COMPANION_FEED_MAX_CHARS), source: selection.source },
  }));
  window.dispatchEvent(new CustomEvent(COMPANION_OPEN_CHAT_EVENT));
}

export function truncateFeedText(text: string): string {
  return text.trim().slice(0, COMPANION_FEED_MAX_CHARS);
}

/** 订阅投喂/开抽屉事件；返回退订函数。 */
export function subscribeCompanionFeed(handlers: {
  onFeed: (selection: CompanionFeedSelection) => void;
  onOpenChat: () => void;
}): () => void {
  const onFeed = (event: Event) => {
    const detail = (event as CustomEvent<CompanionFeedSelection>).detail;
    if (detail && typeof detail.text === "string" && detail.text.length > 0) {
      handlers.onFeed({ text: detail.text, source: detail.source === "drop" ? "drop" : "selection" });
    }
  };
  const onOpenChat = () => handlers.onOpenChat();
  window.addEventListener(COMPANION_FEED_EVENT, onFeed);
  window.addEventListener(COMPANION_OPEN_CHAT_EVENT, onOpenChat);
  return () => {
    window.removeEventListener(COMPANION_FEED_EVENT, onFeed);
    window.removeEventListener(COMPANION_OPEN_CHAT_EVENT, onOpenChat);
  };
}
