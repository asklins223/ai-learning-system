"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  mobileBottomNavItems,
  exploreNavItems,
  mobileMineNavItems,
  isNavActive,
} from "@/lib/navigation";

/**
 * MobileNav — 移动端底部导航栏。
 *
 * 仅在 <640px 视口显示。5 个固定入口：
 *   学习流 / 复习 / 新建 / 探索 / 我的
 *
 * - "新建"打开 QuickCapture（暂用路由跳转占位）。
 * - "探索"点击展开二级面板（学习卡/理解星图/搜索）。
 * - "我的"点击展开二级面板（笔记/来源资料/今日变化/设置）。
 *
 */

type PanelType = "explore" | "mine" | null;

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [panel, setPanel] = useState<PanelType>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const exploreButtonRef = useRef<HTMLButtonElement>(null);
  const mineButtonRef = useRef<HTMLButtonElement>(null);

  /* 关闭面板：点击外部或路由变化 */
  useEffect(() => {
    if (!panel) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        !navRef.current?.contains(target)
      ) {
        setPanel(null);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [panel]);

  useEffect(() => {
    setPanel(null);
  }, [pathname]);

  /* 旋转设备或调整窗口跨出手机断点时立即收起二级面板。底栏由 CSS
     隐藏，但 React 状态若不清理，悬浮面板仍会残留到平板/桌面。 */
  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 639px)");
    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setPanel(null);
    };
    mobileQuery.addEventListener("change", handleBreakpointChange);
    return () => mobileQuery.removeEventListener("change", handleBreakpointChange);
  }, []);

  /* 菜单在底部导航之前渲染；打开后主动把键盘焦点送入菜单，
     否则从触发按钮按 Tab 会直接跳过整块二级导航。 */
  useEffect(() => {
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panel]);

  /* ESC 关闭面板 */
  useEffect(() => {
    if (!panel) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const trigger = panel === "explore" ? exploreButtonRef.current : mineButtonRef.current;
      setPanel(null);
      window.requestAnimationFrame(() => trigger?.focus());
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [panel]);

  const handleQuickCapture = useCallback(() => {
    if (pathname === "/today") {
      window.dispatchEvent(new CustomEvent("today:open-capture"));
      return;
    }
    router.push("/today#quick-capture");
  }, [pathname, router]);

  const handleItemClick = useCallback((item: typeof mobileBottomNavItems[number]) => {
    if (item.href === "#quick-capture") {
      handleQuickCapture();
      return;
    }

    // "探索"入口 — 切换面板
    if (item.mobileGroup === "explore") {
      setPanel((prev) => (prev === "explore" ? null : "explore"));
      return;
    }

    // "我的"入口 — 切换面板
    if (item.mobileGroup === "mine") {
      setPanel((prev) => (prev === "mine" ? null : "mine"));
      return;
    }

    setPanel(null);
    router.push(item.href);
  }, [handleQuickCapture, router]);

  /* 判断某项是否高亮 */
  function getItemActive(item: typeof mobileBottomNavItems[number]): boolean {
    if (item.href === "#quick-capture") return false;

    // "探索"入口：如果当前路由属于 explore 组则高亮
    if (item.mobileGroup === "explore") {
      return exploreNavItems.some((ei) => isNavActive(ei.href, pathname));
    }

    // "我的"入口：如果当前路由属于 mine 组则高亮
    if (item.mobileGroup === "mine") {
      return mobileMineNavItems.some((mi) => isNavActive(mi.href, pathname));
    }

    return isNavActive(item.href, pathname);
  }

  const panelItems = panel === "explore" ? exploreNavItems : panel === "mine" ? mobileMineNavItems : [];

  return (
    <>
      {/* 二级导航面板 */}
      {panel && panelItems.length > 0 && (
        <nav
          id="mobile-nav-panel"
          ref={panelRef}
          className="mobile-nav-panel"
          data-ui="mobile-nav-panel"
          aria-label={panel === "explore" ? "探索导航" : "个人导航"}
        >
          {panelItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`mobile-nav-panel-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
              aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
            >
              <span className="mobile-nav-panel-icon"><item.icon /></span>
              {item.label}
            </Link>
          ))}
        </nav>
      )}

      {/* 底部导航栏 */}
      <nav
        ref={navRef}
        className="mobile-nav"
        data-ui="mobile-nav"
        role="navigation"
        aria-label="主导航"
      >
        {mobileBottomNavItems.map((item) => {
          const active = getItemActive(item);
          const isCreate = item.href === "#quick-capture";
          const groupPanel = item.mobileGroup === "explore" || item.mobileGroup === "mine"
            ? item.mobileGroup
            : null;

          if (isCreate) {
            return (
              <button
                key="quick-capture"
                className="mobile-nav-item mobile-nav-item--create"
                onClick={handleQuickCapture}
                aria-label="新建"
                type="button"
              >
                <span className="mobile-nav-icon"><item.icon /></span>
                <span className="mobile-nav-label">{item.mobileLabel}</span>
              </button>
            );
          }

          if (!groupPanel) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`mobile-nav-item ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="mobile-nav-icon"><item.icon /></span>
                <span className="mobile-nav-label">{item.mobileLabel ?? item.label}</span>
              </Link>
            );
          }

          return (
            <button
              key={item.href}
              ref={groupPanel === "explore" ? exploreButtonRef : mineButtonRef}
              className={`mobile-nav-item ${active ? "active" : ""}`}
              onClick={() => handleItemClick(item)}
              aria-expanded={panel === groupPanel}
              aria-controls="mobile-nav-panel"
              type="button"
            >
              <span className="mobile-nav-icon"><item.icon /></span>
              <span className="mobile-nav-label">{item.mobileLabel ?? item.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
