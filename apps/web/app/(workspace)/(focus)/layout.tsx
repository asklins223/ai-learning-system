"use client";

import { AppShell } from "@/components/layout/AppShell";

/**
 * Focus shell — 顶部栏 + 全宽工作区，无侧栏。
 *
 * 适用路由：/cards/[id]、/learning-runs/[runId]、/learning-runs/new、
 * /notes/[id]、/notes/[id]/card-generation-v2、/sources/[id]、/card-sets/[id]
 *
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return <AppShell variant="focus">{children}</AppShell>;
}
