"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileNav } from "./MobileNav";
import { TabletTopBar } from "./TabletTopBar";
import { MainBridgeHost } from "@/features/companion-bridge/MainBridgeHost";

/**
 * AppShell — 全局应用外壳。
 *
 * 显式 variant 替代 body:has 路由样式。
 *
 * - default：首页、列表、搜索、设置等 → 桌面侧栏 + 页面工作区
 * - focus：学习卡详情、笔记编辑 → 减少导航噪音，全宽工作区
 * - internal：benchmark → 保持统一 token，密度更高
 *
 * §9.1 互斥断点：
 * - <640px: 无桌面侧栏；BottomNav 可见；无 TabletTopBar
 * - 640–959px: 无桌面侧栏；无 BottomNav；TabletTopBar 可见 + Overlay Drawer
 * - 960–1279px: 72px 紧凑 Rail；无 TabletTopBar；无 BottomNav
 * - ≥1280px: 216px 完整 Sidebar；无 TabletTopBar；无 BottomNav
 *
 * §9.4 Focus Shell 硬约束：
 * - TopBar 不得成为 Main 左侧的横向 flex item
 * - 390px 下 FocusBar x=0, width=390px, height=56–64px
 * - 390px 下 workspace x=0, width=390px
 * - 每个 Focus 路由只能有一条可见顶栏
 */

export type AppShellVariant = "default" | "focus" | "internal";

/**
 * Next 只会自动预取进入视口的 Link。平板抽屉、账户菜单中的入口在关闭时
 * 不在视口内，首次打开设置或评测就可能临时下载整条路由。生产环境空闲后
 * 一次性预热静态工作区入口，让点击直接命中 App Router 的客户端缓存。
 */
const STATIC_WORKSPACE_ROUTES = [
  "/",
  "/review",
  "/cards",
  "/graph",
  "/search",
  "/notes",
  "/sources",
  "/today",
  "/settings",
  "/benchmark",
  "/companion/conversations",
  "/companion/memory",
  "/companion/memory/star-map",
  "/companion/daily",
] as const;

let workspacePrefetchState: "idle" | "scheduled" | "complete" = "idle";

// ─── QUAL-43/40/68 修复：用路由匹配表替代 15+ 布尔变量 ────────────────────
// 原代码使用 15+ 个布尔变量（isHomePage, isReviewPage, ...）做页面类型检测，
// 新增页面时容易遗漏，且嵌套三元表达式难以维护。
// 改为路由模式匹配表：每个路由模式包含 variant 约束、正则匹配和 page 标识。

interface RoutePattern {
  /** 限制的 variant（undefined 表示任意） */
  variant?: AppShellVariant;
  /** 路径正则匹配 */
  test: (pathname: string) => boolean;
  /** data-page 属性值 */
  page: string;
  /** 是否拥有自己的 Focus 头部（仅 focus variant） */
  ownsFocusHeader?: boolean;
  /** 是否使用无额外 padding 的沉浸式 Session 工作区 */
  session?: boolean;
}

const ROUTE_PATTERNS: RoutePattern[] = [
  // ── default variant 路由 ──
  { variant: "default", test: (p) => p === "/", page: "home" },
  { variant: "default", test: (p) => p === "/review", page: "review" },
  { variant: "default", test: (p) => p === "/cards", page: "cards" },
  { variant: "default", test: (p) => p === "/graph", page: "graph" },
  { variant: "default", test: (p) => p === "/notes", page: "notes" },
  { variant: "default", test: (p) => p === "/search", page: "search" },
  { variant: "default", test: (p) => p === "/sources", page: "sources" },
  { variant: "default", test: (p) => p === "/today", page: "today" },
  { variant: "default", test: (p) => p === "/companion/conversations", page: "companion-history" },
  { variant: "default", test: (p) => p === "/companion/memory" || p === "/companion/memory/star-map", page: "companion-memory" },
  { variant: "default", test: (p) => p === "/companion/daily", page: "companion-daily" },
  { variant: "default", test: (p) => p === "/settings", page: "settings" },
  // ── internal variant 路由 ──
  { variant: "internal", test: (p) => p === "/benchmark", page: "benchmark" },
  // ── focus variant 路由 ──
  { variant: "focus", test: (p) => /^\/cards\/[^/]+$/.test(p), page: "card-detail", ownsFocusHeader: true },
  {
    variant: "focus",
    test: (p) => /^\/learning-cards\/[^/]+$/.test(p),
    page: "learning-card-detail",
    ownsFocusHeader: true,
  },
  {
    variant: "focus",
    test: (p) => /^\/learning-runs\/[^/]+$/.test(p),
    page: "learning-run",
    ownsFocusHeader: true,
    session: true,
  },
    { variant: "focus", test: (p) => /^\/notes\/[^/]+$/.test(p), page: "note-editor", ownsFocusHeader: true },
  { variant: "focus", test: (p) => /^\/sources\/[^/]+$/.test(p), page: "source-detail", ownsFocusHeader: true },
];

/** 根据当前 pathname 和 variant 匹配路由模式 */
function matchRoute(pathname: string, variant: AppShellVariant): RoutePattern | null {
  return ROUTE_PATTERNS.find(
    (r) => (!r.variant || r.variant === variant) && r.test(pathname),
  ) ?? null;
}

interface AppShellProps {
  children: ReactNode;
  variant?: AppShellVariant;
}

export function AppShell({ children, variant = "default" }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const showSidebar = variant === "default" || variant === "internal";
  const showMobileNav = variant === "default";
  const showTabletTopBar = variant === "default" || variant === "internal";
  const isFocus = variant === "focus";

  // QUAL-43/40/68 修复：使用路由匹配表替代 15+ 布尔变量
  const matchedRoute = matchRoute(pathname, variant);
  const pageName = matchedRoute?.page;
  const hasOwnedFocusHeader = matchedRoute?.ownsFocusHeader === true;
  const isSessionPage = matchedRoute?.session === true;

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      workspacePrefetchState !== "idle"
    ) {
      return;
    }

    workspacePrefetchState = "scheduled";
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;

    const prefetchWorkspaceRoutes = () => {
      workspacePrefetchState = "complete";
      // PERF-67 修复：分批预热路由，避免 10 个并发 prefetch 争抢带宽。
      // 每批 3 个路由，间隔 200ms，总耗时约 800ms 完成 10 个路由的预热。
      const BATCH_SIZE = 3;
      const BATCH_INTERVAL_MS = 200;
      for (let i = 0; i < STATIC_WORKSPACE_ROUTES.length; i += BATCH_SIZE) {
        const batch = STATIC_WORKSPACE_ROUTES.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);
        setTimeout(() => {
          for (const href of batch) {
            router.prefetch(href);
          }
        }, batchIndex * BATCH_INTERVAL_MS);
      }
    };

    const requestIdle = (
      window as unknown as {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;

    if (typeof requestIdle === "function") {
      idleHandle = requestIdle.call(window, prefetchWorkspaceRoutes, {
        timeout: 1_800,
      });
    } else {
      timeoutHandle = window.setTimeout(prefetchWorkspaceRoutes, 300);
    }

    return () => {
      // React Strict Mode 会在开发态重放 effect；这里也保证真实卸载发生在
      // idle 回调前时，后续 AppShell 仍有机会重新安排预取。
      if (workspacePrefetchState !== "scheduled") return;
      if (idleHandle !== undefined) {
        const cancelIdle = (
          window as unknown as {
            cancelIdleCallback?: (handle: number) => void;
          }
        ).cancelIdleCallback;
        cancelIdle?.call(window, idleHandle);
      }
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      workspacePrefetchState = "idle";
    };
  }, [router]);

  return (
    <div
      className="app-canvas"
      data-ui="app-shell"
      data-variant={variant}
      data-page={pageName}
    >
      {/* §15.3: Skip link — 键盘用户跳到主内容 */}
      <a href="#main-content" className="skip-link">
        跳到主内容
      </a>

      {isFocus ? (
        /* §9.4 Focus Shell: 纵向两行 — FocusBar 全宽 + Main 全宽
         * 不得将 TopBar 和 Main 放入同一个横向 flex 容器 */
        <div className="app-shell-inner app-shell-inner--focus">
          {!hasOwnedFocusHeader && <TopBar />}
          <main
            id="main-content"
            className={`workspace workspace--focus${isSessionPage ? " workspace--session" : ""}`}
            tabIndex={-1}
            data-page-root
          >
            {children}
            <div data-ui="page-end" aria-hidden="true" />
          </main>
        </div>
      ) : (
        /* Default / Internal Shell */
        <div className="app-shell-inner">
          {/* §9.3: 640–959px 平板 TopBar + Overlay Drawer */}
          {showTabletTopBar && <TabletTopBar />}
          {showSidebar && <Sidebar />}
          <main
            id="main-content"
            className="workspace"
            tabIndex={-1}
            data-page-root
          >
            {children}
            <div data-ui="page-end" aria-hidden="true" />
          </main>
        </div>
      )}

      {/* 移动端底部导航：仅 default */}
      {showMobileNav && <MobileNav />}

      {/* F#7（🟡13）：Pet → Main 表面命令宿主（无 UI；浏览器无 preload 时 fail
          closed）。此前放在函数体作表达式语句，创建的元素被丢弃、宿主从未挂载；
          现移入返回的 .app-canvas 树内实际渲染。 */}
      <MainBridgeHost />
    </div>
  );
}
