"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { useTheme } from "@/components/ThemeProvider";
import { api, IDENTITY_CHANGED_EVENT } from "@/lib/api";
import { primaryNavItems, exploreNavItems, mineNavItems, isNavActive } from "@/lib/navigation";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";

/**
 * 侧栏导航分组。
 * - 主导航：学习 + 复习
 * - 探索：学习卡 + 理解星图
 * - 我的：笔记 + 来源资料 + 学习动态
 * 共享配置来自 navigation.ts，不在此重复维护。
 */
const navMainItems = primaryNavItems;
const navExploreItems = exploreNavItems;
const navMineItems = mineNavItems;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme, mounted } = useTheme();
  /* 使用共享的 isNavActive 替代内联判断 */

  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [userLoadFailed, setUserLoadFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);
  // R-026: 从后端获取真实用户信息，不再硬编码 owner 邮箱和角色
  const [userInfo, setUserInfo] = useState<{
    userId: string;
    workspaceId: string;
    email: string;
    role: string;
    displayName: string | null;
    avatarUrl: string | null;
    workspaceName: string;
    workspaceType: string;
    isPersonal: boolean;
    personalWorkspaceId: string | null;
  } | null>(null);

  const reloadUserInfo = useCallback(() => {
    api.getMe().then((info) => {
      setUserInfo(info);
      setUserLoadFailed(false);
    }).catch(() => setUserLoadFailed(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.getMe().then((info) => {
      if (!cancelled) {
        setUserInfo(info);
        setUserLoadFailed(false);
      }
    }).catch(() => {
      if (!cancelled) setUserLoadFailed(true);
    });
    void load();
    window.addEventListener(IDENTITY_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(IDENTITY_CHANGED_EVENT, load);
    };
  }, []);

  /* click outside → close */
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleFocusIn(e: FocusEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [menuOpen]);

  /* esc → close */
  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      dropdownRef.current
        ?.querySelector<HTMLElement>('button:not([disabled]), a[href]')
        ?.focus();
    });
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        userTriggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleEsc);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [menuOpen]);

  /* close on route change */
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      router.replace("/login");
    } catch {
      setLogoutError("退出失败，请重试。");
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, router]);

  /* R-026 / PROFILE-01: 从后端获取真实用户信息，优先使用 displayName */
  const userEmail = userInfo?.email ?? (userLoadFailed ? "账户信息暂不可用" : "正在读取账户…");
  const workspaceName = userInfo?.workspaceName ?? (userLoadFailed ? "工作区信息暂不可用" : "正在读取工作区…");
  const displayName = userInfo?.displayName?.trim()
    || userInfo?.email.split("@")[0]
    || (userLoadFailed ? "账户" : "加载中");
  const avatarChar = displayName.charAt(0).toUpperCase();
  const roleLabel = userInfo ? (userInfo.role === "owner" ? "所有者" : "成员") : null;
  const canCreateContent = Boolean(
    userInfo && (userInfo.role === "owner" || userInfo.isPersonal),
  );

  return (
    <aside className="sidebar" data-ui="desktop-sidebar">
      <Link href="/" className="brand" aria-label="返回今日学习">
        <span className="brand-logo">理</span>
        <span className="brand-copy">
          <span className="brand-title-row">
            <span className="brand-title">理解引擎</span>
            <span className="brand-dot" aria-hidden="true" />
          </span>
          <span className="brand-subtitle">个人理解工作台</span>
        </span>
      </Link>

      <nav className="nav" aria-label="主导航">
        {/* 主导航：学习 + 复习 */}
        {navMainItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
            aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
            aria-label={item.label}
            data-label={item.label}
          >
            <span className="nav-icon"><item.icon /></span>
            {item.label}
          </Link>
        ))}

        {canCreateContent ? (
          <Link
            href="/#quick-capture"
            className="sidebar-capture"
            aria-label="快速收录一份学习材料"
            data-label="快速收录"
          >
            <span className="sidebar-capture-icon" aria-hidden="true"><Icon.Plus /></span>
            <span className="sidebar-capture-copy">
              <strong>快速收录</strong>
              <small>文本、代码或链接</small>
            </span>
            <Icon.Arrow className="sidebar-capture-arrow" aria-hidden="true" />
          </Link>
        ) : (
          <span
            className="sidebar-capture is-disabled"
            aria-label="快速收录仅对工作区所有者开放"
            aria-disabled="true"
            data-label="仅所有者可收录"
          >
            <span className="sidebar-capture-icon" aria-hidden="true"><Icon.Lock /></span>
            <span className="sidebar-capture-copy">
              <strong>快速收录</strong>
              <small>{userInfo ? "仅所有者可添加" : "正在确认权限"}</small>
            </span>
          </span>
        )}

        {/* 探索分组 */}
        <div className="nav-group">
          <div className="nav-group-label">探索</div>
          {navExploreItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
              aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
              aria-label={item.label}
              data-label={item.label}
            >
              <span className="nav-icon"><item.icon /></span>
              {item.label}
            </Link>
          ))}
        </div>

        {/* 我的分组 */}
        <div className="nav-group">
          <div className="nav-group-label">我的</div>
          {navMineItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${isNavActive(item.href, pathname) ? "active" : ""}`}
              aria-current={isNavActive(item.href, pathname) ? "page" : undefined}
              aria-label={item.label}
              data-label={item.label}
            >
              <span className="nav-icon"><item.icon /></span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="sidebar-bottom">

        {/* ---- User Area with Dropdown ---- */}
        <div className="user-area" ref={menuRef}>
          {/* Dropdown Panel */}
          {menuOpen && (
            <div
              ref={dropdownRef}
              id="sidebar-account-popover"
              className="user-dropdown"
              role="dialog"
              aria-label="账户与工作区"
            >
              {/* User header */}
              <div className="dropdown-user-header">
                <div className="dropdown-avatar-wrap">
                  {userInfo?.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="dropdown-avatar-image"
                      src={userInfo.avatarUrl}
                      alt=""
                    />
                  ) : (
                    <span className="dropdown-avatar">{avatarChar}</span>
                  )}
                </div>
                <div className="dropdown-user-info">
                  <span className="dropdown-user-kicker">个人中心</span>
                  <div className="dropdown-user-name">
                    <strong>{displayName}</strong>
                    {roleLabel && <span className="dropdown-badge">{roleLabel}</span>}
                  </div>
                  <span className="dropdown-user-email">{userEmail}</span>
                </div>
              </div>

              {/* ADR-0009: 工作区切换器 */}
              <WorkspaceSwitcher currentUser={userInfo} onSwitched={reloadUserInfo} />

              <div className="dropdown-menu-list">
                <div className="dropdown-menu-label">偏好与账户</div>
                <button
                  className="dropdown-menu-item"
                  type="button"
                  onClick={(event) =>
                    toggleTheme({
                      x: event.clientX,
                      y: event.clientY,
                    })
                  }
                  disabled={!mounted}
                >
                  <Icon.Appearance className="dropdown-menu-icon" />
                  <span>{theme === "day" ? "切换到夜间" : "切换到日间"}</span>
                  <small className="dropdown-menu-value">当前{theme === "day" ? "日间" : "夜间"}</small>
                </button>
                <Link href="/settings" className="dropdown-menu-item no-underline text-inherit">
                  <Icon.Settings className="dropdown-menu-icon" />
                  <span>设置</span>
                </Link>
              </div>

              <div className="dropdown-divider" />

              <div className="dropdown-menu-list">
                <div className="dropdown-menu-label">工作区工具</div>
                <Link href="/benchmark" className="dropdown-menu-item no-underline text-inherit">
                  <Icon.Target className="dropdown-menu-icon" />
                  <span>评测</span>
                </Link>
              </div>

              <div className="dropdown-divider" />

              {/* Logout */}
              <div className="dropdown-menu-list">
                <button
                  type="button"
                  className="dropdown-menu-item logout"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  aria-busy={loggingOut}
                >
                  <Icon.Logout className="dropdown-menu-icon" />
                  <span>{loggingOut ? "退出中…" : "退出登录"}</span>
                </button>
                {logoutError && <p className="dropdown-logout-error" role="alert">{logoutError}</p>}
              </div>

              {/* Footer */}
              <div className="dropdown-footer">
                <span className="dropdown-footer-version">理解引擎 v0.5</span>
              </div>
            </div>
          )}

          {/* User Row (trigger button) */}
          <button
            type="button"
            ref={userTriggerRef}
            className={`user-row ${menuOpen ? "open" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="用户菜单"
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-controls="sidebar-account-popover"
            aria-busy={!userInfo && !userLoadFailed}
            data-label={`个人中心 · ${displayName}`}
          >
            <div className="user-avatar-wrap">
              {userInfo?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="avatar-image"
                  src={userInfo.avatarUrl}
                  alt=""
                />
              ) : (
                <span className="avatar">{avatarChar}</span>
              )}
            </div>
            <span className="user-meta">
              <strong>{displayName}</strong>
              <span>{workspaceName}</span>
            </span>
            <span className={`chevron ${menuOpen ? "open" : ""}`}>
              <Icon.Chevron className="chevron-icon" />
            </span>
          </button>
        </div>
      </div>

    </aside>
  );
}
