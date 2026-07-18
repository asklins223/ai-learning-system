"use client";

import { useEffect, type RefObject } from "react";

type InertRecord = { count: number; originallyInert: boolean };

/* 多个模态可能短暂叠加。引用计数避免后关闭的底层模态过早解除
   另一个仍在显示的模态所需的背景隔离。 */
const inertRegistry = new Map<HTMLElement, InertRecord>();

function acquireInert(element: HTMLElement) {
  const record = inertRegistry.get(element);
  if (record) {
    record.count += 1;
  } else {
    inertRegistry.set(element, {
      count: 1,
      originallyInert: element.hasAttribute("inert"),
    });
  }
  element.setAttribute("inert", "");
}

function releaseInert(element: HTMLElement) {
  const record = inertRegistry.get(element);
  if (!record) return;
  record.count -= 1;
  if (record.count > 0) return;
  if (!record.originallyInert) element.removeAttribute("inert");
  inertRegistry.delete(element);
}

/**
 * 让 aria-modal 对话框之外的兄弟子树真正不可交互。
 * 从模态节点逐层走到 body，只隔离每层的兄弟，不会把模态自己的祖先
 * 设为 inert；既适用于 portal，也适用于嵌在应用壳内的抽屉。
 */
export function useModalIsolation(
  modalRef: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const modal = modalRef.current;
    if (!modal) return;

    const isolated: HTMLElement[] = [];
    let branch: HTMLElement = modal;
    let parent = branch.parentElement;

    while (parent && parent !== document.documentElement) {
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || sibling.contains(modal)) continue;
        if (!(sibling instanceof HTMLElement)) continue;
        if (sibling.matches("script, style, link, meta")) continue;
        acquireInert(sibling);
        isolated.push(sibling);
      }
      branch = parent;
      parent = parent.parentElement;
    }

    return () => {
      for (let index = isolated.length - 1; index >= 0; index -= 1) {
        releaseInert(isolated[index]);
      }
    };
  }, [active, modalRef]);
}
