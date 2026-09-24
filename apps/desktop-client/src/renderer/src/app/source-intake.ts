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

/** 编辑中的笔记纸面挂这个属性，声明"纯图片的拖放归这一篇正文"。 */
export const NOTE_PAPER_IMAGE_DROP_ATTR = "data-note-paper-image-drop";

/**
 * 整份都是图片才返回文件，混进任何一个别的文件就返回空。
 *
 * 这条判据同时决定两件事：纸面要不要接住这一下，以及全局浮层要不要让路——
 * 两边各写一遍迟早会说出不一致的那句话。
 */
export function imageOnlyFiles(transfer: DataTransfer | null): File[] {
  if (!transfer || transfer.files.length === 0) return [];
  const files = Array.from(transfer.files);
  return files.every((file) => file.type.startsWith("image/")) ? files : [];
}

/**
 * 这个落点有没有主人：编辑器和表单收文字，笔记纸面收整份图片。
 *
 * 浮层在 dragenter 时问过同一个问题，才敢说"松开就收进来源库"。
 */
export function isOwnedDropTarget(target: EventTarget | null, transfer: DataTransfer | null): boolean {
  if (isEditableTarget(target) || isSourceCaptureTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(`[${NOTE_PAPER_IMAGE_DROP_ATTR}]`) && imageOnlyFiles(transfer).length > 0);
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
