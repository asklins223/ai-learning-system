import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import {
  COMPANION_FEED_MAX_CHARS,
  feedSelectionToCompanion,
  truncateFeedText,
} from "./companion-feed";
import "./companion-feed.css";

/**
 * 划选/拖拽投喂采集器（2026-09-18，设计文档 §二）。
 *
 * - 右键菜单：页面有文本选区时，把默认菜单换成「丢给伴星」浮层（纸面语言）；
 *   无选区不拦截，保留浏览器默认行为。
 * - 窗口级 drop：拖动文本（text/plain）松手即投喂——无需瞄准伴星，拖进窗口
 *   任意位置都算（SourceIntake 范式的窗口级版本）。
 *
 * 挂载在 App 根部，与伴星是否可见无关。
 */
export function CompanionFeedMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const text = (window.getSelection()?.toString() ?? "").trim();
      if (text.length === 0) return; // 无选区：保留默认右键菜单
      event.preventDefault();
      const x = Math.min(event.clientX, window.innerWidth - 160);
      const y = Math.min(event.clientY, window.innerHeight - 60);
      setMenu({ x, y, text: truncateFeedText(text) });
    };
    // capture 阶段关菜单；菜单自身内部的按下用 stopPropagation 拦住。
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      setMenu(null);
    };
    const onBlur = () => setMenu(null);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const hasPlainText = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("text/plain");
    const onDragOver = (event: DragEvent) => {
      if (hasPlainText(event)) event.preventDefault(); // 允许 drop
    };
    const onDrop = (event: DragEvent) => {
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
      role="menu"
      aria-label="把划选内容丢给伴星"
    >
      <button
        type="button"
        role="menuitem"
        className="companion-feed-menu__item"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          feedSelectionToCompanion({ text: menu.text, source: "selection" });
          setMenu(null);
        }}
      >
        <Send size={13} aria-hidden="true" />
        <span>丢给伴星</span>
        <span className="companion-feed-menu__count">{menu.text.length}/{COMPANION_FEED_MAX_CHARS}</span>
      </button>
    </div>
  );
}
