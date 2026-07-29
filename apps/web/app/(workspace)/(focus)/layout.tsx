"use client";

import { AppShell } from "@/components/layout/AppShell";

/**
 * Focus shell — 顶部栏 + 全宽工作区，无侧栏。
 *
 * 适用路由：/cards/[id]、/cards/[id]/validate、/review/[scheduleId]、
 * /notes/[id]、/sources/[id]
 *
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return <AppShell variant="focus">{children}</AppShell>;
}
