"use client";

import { AppShell } from "@/components/layout/AppShell";

/**
 * Internal shell — 侧栏 + 高密度工作区。
 *
 * 适用路由：/benchmark
 *
 * 参见：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §7.1
 */
export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return <AppShell variant="internal">{children}</AppShell>;
}
