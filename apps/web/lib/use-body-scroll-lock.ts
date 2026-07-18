"use client";

import { useEffect } from "react";

export interface BodyScrollLockTarget {
  style: { overflow: string };
}

type ScrollLockRecord = {
  count: number;
  originalOverflow: string;
};

const scrollLockRegistry = new Map<BodyScrollLockTarget, ScrollLockRecord>();

/**
 * Acquire a reference-counted scroll lock and return an idempotent release.
 * Reference counting matters when one modal briefly opens above another: the
 * lower modal must not restore body scrolling while the upper one is active.
 */
export function acquireBodyScrollLock(target: BodyScrollLockTarget): () => void {
  const existing = scrollLockRegistry.get(target);
  if (existing) {
    existing.count += 1;
  } else {
    scrollLockRegistry.set(target, {
      count: 1,
      originalOverflow: target.style.overflow,
    });
  }
  target.style.overflow = "hidden";

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const record = scrollLockRegistry.get(target);
    if (!record) return;
    record.count -= 1;
    if (record.count > 0) return;

    target.style.overflow = record.originalOverflow;
    scrollLockRegistry.delete(target);
  };
}

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return acquireBodyScrollLock(document.body);
  }, [active]);
}
