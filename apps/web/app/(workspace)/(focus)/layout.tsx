"use client";

import { AppShell } from "@/components/layout/AppShell";

/**
 * Focus shell — 顶部栏 + 全宽工作区，无侧栏。
 *
 * 适用路由：/cards/[id]、/notes/[id]、/sources/[id]
 *
 * 参见：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §7.1 + §7.4
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return <AppShell variant="focus">{children}</AppShell>;
}
