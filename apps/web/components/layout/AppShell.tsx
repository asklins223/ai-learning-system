"use client";

import { ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileNav } from "./MobileNav";
import { TabletTopBar } from "./TabletTopBar";

/**
 * AppShell — 全局应用外壳。
 *
 * 显式 variant 替代 body:has 路由样式。
 * 参见：UI-REFACTOR-VISUAL-AUDIT-AND-REWORK-SPEC.md §7 / §9
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
] as const;

let workspacePrefetchState: "idle" | "scheduled" | "complete" = "idle";

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
  const isHomePage = variant === "default" && pathname === "/";
  const isReviewPage = variant === "default" && pathname === "/review";
  const isCardsPage = variant === "default" && pathname === "/cards";
  const isGraphPage = variant === "default" && pathname === "/graph";
  const isNotesPage = variant === "default" && pathname === "/notes";
  const isSearchPage = variant === "default" && pathname === "/search";
  const isSourcesPage = variant === "default" && pathname === "/sources";
  const isTodayPage = variant === "default" && pathname === "/today";
  const isSettingsPage = variant === "default" && pathname === "/settings";
  const isBenchmarkPage = variant === "internal" && pathname === "/benchmark";
  const isCardDetailPage =
    variant === "focus" && /^\/cards\/[^/]+$/.test(pathname);
  const isNoteEditorPage =
    variant === "focus" && /^\/notes\/[^/]+$/.test(pathname);
  const isSourceDetailPage =
    variant === "focus" && /^\/sources\/[^/]+$/.test(pathname);

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
      for (const href of STATIC_WORKSPACE_ROUTES) {
        router.prefetch(href);
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
      data-page={
        isHomePage
          ? "home"
          : isReviewPage
            ? "review"
            : isCardsPage
              ? "cards"
              : isGraphPage
                ? "graph"
              : isNotesPage
                ? "notes"
              : isSearchPage
                ? "search"
              : isSourcesPage
                ? "sources"
              : isTodayPage
                ? "today"
              : isSettingsPage
                ? "settings"
              : isBenchmarkPage
                ? "benchmark"
              : isCardDetailPage
                ? "card-detail"
              : isNoteEditorPage
                ? "note-editor"
              : isSourceDetailPage
                ? "source-detail"
              : undefined
      }
    >
      {/* §15.3: Skip link — 键盘用户跳到主内容 */}
      <a href="#main-content" className="skip-link">
        跳到主内容
      </a>

      {isFocus ? (
        /* §9.4 Focus Shell: 纵向两行 — FocusBar 全宽 + Main 全宽
         * 不得将 TopBar 和 Main 放入同一个横向 flex 容器 */
        <div className="app-shell-inner app-shell-inner--focus">
          {!isCardDetailPage && !isNoteEditorPage && !isSourceDetailPage && <TopBar />}
          <main
            id="main-content"
            className="workspace workspace--focus"
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
    </div>
  );
}
