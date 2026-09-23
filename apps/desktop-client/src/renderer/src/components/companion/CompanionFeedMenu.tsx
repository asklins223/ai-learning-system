import { useEffect, useRef, useState } from "react";
import { Copy, Send } from "lucide-react";
import { hasOpenModal, isEditableTarget, isSourceCaptureTarget } from "../../app/source-intake";
import {
  COMPANION_FEED_MAX_CHARS,
  feedSelectionToCompanion,
  truncateFeedText,
} from "./companion-feed";
import "./companion-feed.css";

function canFeed(): boolean {
  const hud = document.querySelector(".companion-hud");
  return Boolean(hud && !hud.closest('.companion-absent, [aria-hidden="true"]')) && !hasOpenModal();
}

function ownedDropTarget(target: EventTarget | null): boolean {
  return isEditableTarget(target) || isSourceCaptureTarget(target);
}

/**
 * 划选/拖拽投喂采集器（2026-09-18，设计文档 §二）。
 *
 * - 右键菜单：非编辑区有文本选区时，提供「丢给伴星」与复制；编辑区和无选区
 *   保留浏览器默认行为。
 * - 窗口级 drop：拖动文本（text/plain）松手即投喂——无需瞄准伴星，拖进窗口
 *   任意位置都算（SourceIntake 范式的窗口级版本）。
 *
 * 挂载在 App 根部，只有伴星交互台在场且落点无人接管时才启用。
 */
export function CompanionFeedMenu() {
  /**
   * `text` 是**实际要送出去**的那段（已截断），`selectedChars` 是用户真的选中的字数。
   * 以前只存截断后的文本，于是选了 5000 字时计数写着「2000/2000」——
   * 看起来像"正好装满"，而不是"你的话被切了一半"。
   */
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; fullText: string; selectedChars: number } | null>(null);
  const [copyError, setCopyError] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || !canFeed() || isEditableTarget(event.target)) {
        setMenu(null);
        return;
      }
      const text = (window.getSelection()?.toString() ?? "").trim();
      if (text.length === 0) {
        setMenu(null);
        return; // 无选区：保留默认右键菜单
      }
      event.preventDefault();
      originFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCopyError(false);
      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 330));
      const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 110));
      setMenu({ x, y, text: truncateFeedText(text), fullText: text, selectedChars: text.length });
    };
    // capture 阶段关菜单；菜单自身内部的按下用 stopPropagation 拦住。
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      setMenu(null);
    };
    const onBlur = () => setMenu(null);
    // Esc 关掉：这是个由鼠标打开的浮层，但键盘用户也有权不碰鼠标就把它收掉。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && menuRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        originFocusRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    const hasPlainText = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("text/plain");
    const onDragOver = (event: DragEvent) => {
      if (!event.defaultPrevented && canFeed() && !ownedDropTarget(event.target) && hasPlainText(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented || !canFeed() || ownedDropTarget(event.target)) return;
      const text = event.dataTransfer?.getData("text/plain") ?? "";
      if (text.trim().length === 0) return;
      event.preventDefault();
      feedSelectionToCompanion({ text: truncateFeedText(text), source: "drop" });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!menu) return null;
  return (
    <div
      ref={menuRef}
      className="companion-feed-menu"
      style={{ left: menu.x, top: menu.y }}
      role="group"
      aria-label="划选文本操作"
    >
      <button
        type="button"
        className="companion-feed-menu__item"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          if (canFeed()) feedSelectionToCompanion({ text: menu.text, source: "selection" });
          setMenu(null);
        }}
      >
        <Send size={13} aria-hidden="true" />
        <span>丢给伴星</span>
        {/* 计数按"选了多少"说，不按"切完之后多少"说：截断是这条链真正会发生的事
            （`truncateFeedText` 在显示之前就跑了），以前用户永远只看到 2000/2000。 */}
        <span className="companion-feed-menu__count">
          {menu.selectedChars > COMPANION_FEED_MAX_CHARS
            ? `已选 ${menu.selectedChars} 字，只送前 ${COMPANION_FEED_MAX_CHARS} 字`
            : `${menu.selectedChars}/${COMPANION_FEED_MAX_CHARS}`}
        </span>
      </button>
      <button
        type="button"
        className="companion-feed-menu__item"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          void (async () => {
            try {
              if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(menu.fullText);
              else if (!document.execCommand("copy")) throw new Error("copy unavailable");
              setMenu(null);
              originFocusRef.current?.focus({ preventScroll: true });
            } catch {
              setCopyError(true);
            }
          })();
        }}
      >
        <Copy size={13} aria-hidden="true" />复制选中内容
      </button>
      {copyError ? <span className="companion-feed-menu__error" role="status">复制失败，请用 ⌘C</span> : null}
    </div>
  );
}
