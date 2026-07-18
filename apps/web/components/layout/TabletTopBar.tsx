"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { useTheme } from "@/components/ThemeProvider";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import {
  primaryNavItems,
  exploreNavItems,
  mineNavItems,
  isNavActive,
} from "@/lib/navigation";

/**
 * TabletTopBar — 640–959px 平板 Default Shell 顶部栏。
 *
 * §9.3:
 * - 56–60px 全宽 TopBar：品牌/页面位置、搜索或主要动作、菜单按钮
 * - 菜单打开 304–336px Overlay Drawer；最大宽度 viewport - 32px
 * - Drawer 覆盖正文而不推动正文；关闭时不占布局、不截获点击，焦点返回菜单按钮
 */
export function TabletTopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme, mounted } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useModalIsolation(drawerRef, drawerOpen);
  useFocusTrap(drawerRef, drawerOpen);
  useBodyScrollLock(drawerOpen);

  /* 关闭抽屉：路由变化 */
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  /* 抽屉打开时若设备旋转或窗口跨出平板断点，必须同步卸载遮罩并由
     下方滚动锁 effect 恢复 body；否则隐藏的平板顶栏会留下整页锁定。 */
  useEffect(() => {
    const tabletQuery = window.matchMedia("(min-width: 640px) and (max-width: 959px)");
    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setDrawerOpen(false);
    };
    tabletQuery.addEventListener("change", handleBreakpointChange);
    return () => tabletQuery.removeEventListener("change", handleBreakpointChange);
  }, []);

  /* ESC 关闭抽屉，焦点返回菜单按钮 */
  useEffect(() => {
    if (!drawerOpen) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [drawerOpen]);

  /* 点击遮罩关闭 */
  const handleScrimClick = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const { api } = await import("@/lib/api");
      await api.logout();
      router.replace("/login");
    } catch {
      setLogoutError("退出失败，请重试。");
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, router]);

  return (
    <>
      <div className="tablet-topbar" data-ui="tablet-topbar">
        <button
          type="button"
          ref={menuButtonRef}
          className="tablet-topbar-menu"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={drawerOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={drawerOpen}
          aria-controls="tablet-navigation-drawer"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {drawerOpen ? (
              <path d="M18 6L6 18M6 6l12 12" />
            ) : (
              <>
                <path d="M3 12h18M3 6h18M3 18h18" />
              </>
            )}
          </svg>
        </button>

        <Link href="/" className="tablet-topbar-brand" aria-label="理解引擎首页">
          <span className="tablet-topbar-logo">理</span>
          <span className="tablet-topbar-title">理解引擎</span>
          <span className="tablet-topbar-dot" aria-hidden="true" />
        </Link>
      </div>

      {/* Overlay Drawer — §9.3 */}
      {drawerOpen && (
        <div className="tablet-drawer-scrim" onClick={handleScrimClick}>
          <aside
            id="tablet-navigation-drawer"
            ref={drawerRef}
            className="tablet-drawer"
            data-ui="tablet-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="tablet-drawer-header">
              <Link href="/" className="tablet-drawer-brand" aria-label="理解引擎首页">
                <span className="tablet-drawer-logo">理</span>
                <span>
                  <strong>理解引擎</strong>
                  <small>PERSONAL STUDY DESK</small>
                </span>
              </Link>
              <button
                className="tablet-drawer-close"
                type="button"
                onClick={handleScrimClick}
                aria-label="关闭菜单"
              >
                <Icon.Close />
              </button>
            </header>

            <nav className="tablet-drawer-nav" aria-label="主导航">
              {primaryNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`tablet-drawer-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
                  aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
                >
                  <span className="tablet-drawer-icon"><item.icon /></span>
                  {item.label}
                </Link>
              ))}

              <div className="tablet-drawer-group-label">探索</div>
              {exploreNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`tablet-drawer-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
                  aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
                >
                  <span className="tablet-drawer-icon"><item.icon /></span>
                  {item.label}
                </Link>
              ))}

              <div className="tablet-drawer-group-label">我的</div>
              {mineNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`tablet-drawer-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
                  aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
                >
                  <span className="tablet-drawer-icon"><item.icon /></span>
                  {item.label}
                </Link>
              ))}

              <div className="tablet-drawer-divider" />

              <div className="tablet-drawer-group-label">偏好</div>
              <button
                className="tablet-drawer-item"
                type="button"
                onClick={(event) =>
                  toggleTheme({
                    x: event.clientX,
                    y: event.clientY,
                  })
                }
                disabled={!mounted}
              >
                <span className="tablet-drawer-icon">
                  <Icon.Appearance />
                </span>
                <span>{theme === "day" ? "切换到夜间" : "切换到日间"}</span>
                <small className="tablet-drawer-item-value">当前{theme === "day" ? "日间" : "夜间"}</small>
              </button>

              <Link
                href="/settings"
                className={`tablet-drawer-item ${isNavActive("/settings", pathname) ? "active" : ""}`}
                aria-current={isNavActive("/settings", pathname) ? "page" : undefined}
              >
                <span className="tablet-drawer-icon"><Icon.Settings /></span>
                设置
              </Link>
              <Link
                href="/benchmark"
                className={`tablet-drawer-item ${isNavActive("/benchmark", pathname) ? "active" : ""}`}
                aria-current={isNavActive("/benchmark", pathname) ? "page" : undefined}
              >
                <span className="tablet-drawer-icon"><Icon.Target /></span>
                评测
              </Link>

              <div className="tablet-drawer-divider" />

              <button
                type="button"
                className="tablet-drawer-item logout"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                aria-busy={loggingOut}
              >
                <span className="tablet-drawer-icon"><Icon.Logout /></span>
                {loggingOut ? "退出中…" : "退出登录"}
              </button>
              {logoutError && <p className="tablet-logout-error" role="alert">{logoutError}</p>}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
