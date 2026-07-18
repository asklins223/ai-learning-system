"use client";

import { AppShell } from "@/components/layout/AppShell";

/**
 * Default shell — 侧栏 + 工作区 + 移动端底部导航。
 *
 * 适用路由：/（学习流）、/notes、/cards、/sources、/search、/graph、/today、/review、/settings
 *
 */
export default function DefaultLayout({ children }: { children: React.ReactNode }) {
  return <AppShell variant="default">{children}</AppShell>;
}
