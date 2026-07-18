"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * 工作区鉴权门 — 仅检查登录状态，不渲染 AppShell。
 *
 * AppShell 由子 route group 的 layout 决定 variant：
 * - (default)/layout.tsx → <AppShell variant="default">
 * - (focus)/layout.tsx   → <AppShell variant="focus">
 * - (internal)/layout.tsx → <AppShell variant="internal">
 *
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    void api.getMe()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div
        className="workspace-auth-loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="workspace-auth-loading__status">
          <i aria-hidden="true" />
          正在进入学习空间…
        </span>
      </div>
    );
  }

  return <>{children}</>;
}
