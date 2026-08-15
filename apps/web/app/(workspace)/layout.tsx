"use client";

import { useEffect } from "react";
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
 * F2（性能）：改为乐观渲染——初始视为已登录，SSR 直接输出 children，
 * 真实内容不被一次串行的 `getMe()` 网络往返锁死，LCP 不再被阻塞。
 *
 * 安全权衡：无 cookie 的首次访问由服务端 middleware 在进入 workspace 前
 * 拦截并跳转 /login（服务端兜底）；此处 getMe() 失败（cookie 已失效/
 * 过期）时才由前端兜底跳转。两者配合：SSR 无鉴权等待，失效登录态仍会被
 * 前端及时发现并恢复。真正的资源鉴权始终由各 API 的请求级校验保障，
 * 本 layout 只是一层导航门而非安全边界。
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let cancelled = false;
    void api.getMe()
      .then(() => {
        // 登录有效：无需任何操作。
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <>{children}</>;
}
