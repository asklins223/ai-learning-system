/**
 * 跨页面收录来源的共享地基：剪贴板链接弹窗与全局拖放浮层都走这里。
 *
 * 常量（900 KB 上限、可收录的文本后缀）原来散在来源库的采集栏里，
 * 抽到这里只有一处真相；事件是外部收录完成后通知来源库刷新索引的窄通道。
 */

export const SOURCE_CAPTURED_EVENT = "ailearn:source-captured";

export type SourceCapturedDetail = {
  readonly sourceId: string;
  readonly title: string;
};

export function dispatchSourceCaptured(sourceId: string, title: string): void {
  window.dispatchEvent(new CustomEvent<SourceCapturedDetail>(SOURCE_CAPTURED_EVENT, {
    detail: { sourceId, title },
  }));
}

/**
 * API 的 Fastify body 上限是 1 MiB，收录在刚好下面拦住，
 * 而不是等服务端回 413。
 */
export const MAX_CAPTURE_BYTES = 900_000;

/** 收录通道能承载的后缀：API 吃文本，不吃二进制。 */
export const TEXT_FILE_PATTERN = /\.(txt|md|markdown|mdx|json|jsonc|csv|tsv|ya?ml|toml|ini|log|html?|css|scss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|tex)$/i;

/** 单次全局拖放最多当场收录的份数，多出的请分批。 */
export const MAX_DROP_FILES = 5;

export const captureBytes = (text: string): number => new TextEncoder().encode(text).length;

/** Sizes read in bytes until a kilobyte is worth mentioning at all. */
export function formatCaptureSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  const kilobytes = bytes / 1024;
  return kilobytes < 10 ? `${kilobytes.toFixed(1)} KB` : `${Math.round(kilobytes)} KB`;
}

export function titleFromFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.[^.]+$/, "") || trimmed;
}

/**
 * 拖放落点是否属于"有人在写字"的地方：输入框、编辑器正文都归它，
 * 全局浮层不跟它们抢——图片进笔记、文字进表单，各走各的旧链路。
 */
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox'], .milkdown, .ProseMirror";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(EDITABLE_SELECTOR));
}

/** 来源采集栏拥有自己的文字与文件投放格，全局采集器和伴星都要让路。 */
export function isSourceCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".capture-strip, .capture-form"));
}

/** 当前是否有模态对话框开着：有就别弹新窗，排队等下一轮。 */
export function hasOpenModal(): boolean {
  return Boolean(document.querySelector(
    "dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
  ));
}

const SEEN_LINKS_KEY = "ailearn:source-intake-seen-links";
const MAX_SEEN_LINKS = 100;

type SeenStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SeenStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * 问过（导入或忽略）的链接不再打扰。localStorage 持久化，
 * 重启也不对同一个链接弹第二遍；上限 100 个，只留最近的。
 */
export function readSeenLinks(storage: SeenStorage | null = defaultStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(SEEN_LINKS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

export function markLinkSeen(url: string, storage: SeenStorage | null = defaultStorage()): Set<string> {
  const seen = readSeenLinks(storage);
  seen.add(url);
  if (storage) {
    try {
      storage.setItem(SEEN_LINKS_KEY, JSON.stringify([...seen].slice(-MAX_SEEN_LINKS)));
    } catch {
      // 配额满了就只记这次会话，不挡主流程。
    }
  }
  return seen;
}
