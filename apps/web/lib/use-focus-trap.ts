"use client";

import { useEffect, type RefObject } from "react";

/**
 * F-029: 焦点陷阱 hook — 将 Tab 键焦点限制在对话框内循环。
 *
 * 用法：
 *   const ref = useRef<HTMLDivElement>(null);
 *   useFocusTrap(ref, isOpen);
 *
 * 当 isOpen 为 true 时：
 * - 首次聚焦容器内第一个可聚焦元素
 * - Tab/Shift+Tab 在容器内循环
 * - 关闭时恢复焦点到打开前的元素
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  isActive: boolean,
) {
  useEffect(() => {
    if (!isActive) return;
    const container = containerRef.current;
    if (!container) return;
    const activeContainer: HTMLElement = container;

    // 记录打开前的焦点元素，关闭后恢复
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 可聚焦元素选择器
    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const originalTabIndex = activeContainer.getAttribute("tabindex");
    const getFocusable = () =>
      Array.from(activeContainer.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) =>
          element.offsetParent !== null &&
          !element.closest("[inert]") &&
          getComputedStyle(element).visibility !== "hidden",
      );

    // 首次聚焦
    const focusable = getFocusable();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      activeContainer.tabIndex = -1;
      activeContainer.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const currentFocusable = getFocusable();
      if (currentFocusable.length === 0) {
        e.preventDefault();
        activeContainer.tabIndex = -1;
        activeContainer.focus();
        return;
      }
      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    activeContainer.addEventListener("keydown", handleKeyDown);

    return () => {
      activeContainer.removeEventListener("keydown", handleKeyDown);
      if (originalTabIndex === null) {
        activeContainer.removeAttribute("tabindex");
      } else {
        activeContainer.setAttribute("tabindex", originalTabIndex);
      }
      // 恢复焦点
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, isActive]);
}
