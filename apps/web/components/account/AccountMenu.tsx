"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Icon } from "@/components/ui/icons";
import { api, IDENTITY_CHANGED_EVENT } from "@/lib/api";

type AccountInfo = {
  email: string;
  role: string;
  displayName: string | null;
  avatarUrl: string | null;
  workspaceName: string;
};

interface DesktopPetApiShim {
  getPetModeEnabled?: () => Promise<{ ok?: boolean; enabled?: boolean }>;
  setPetModeEnabled?: (enabled: boolean) => Promise<{ ok?: boolean; enabled?: boolean }>;
}

/**
 * 2026-08-12（Owner 需求）：头像二级菜单内的桌宠快捷开关。
 * Electron 桌面应用显示（读/写 device-local petModeEnabled）；
 * 浏览器无 desktopAPI → 不渲染（桌宠仅桌面可用）。
 */
function AccountPetModeToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const desktopApi = typeof window !== "undefined"
    ? (window as unknown as { desktopAPI?: DesktopPetApiShim }).desktopAPI
    : undefined;

  useEffect(() => {
    if (!desktopApi?.getPetModeEnabled) {
      // 浏览器/无桌面能力：显示 disabled 开关（不静默隐藏——Owner 要求菜单
      // 里可见该入口，附"仅桌面应用可用"提示）。
      setEnabled(false);
      return;
    }
    let cancelled = false;
    void desktopApi.getPetModeEnabled()
      .then((result) => {
        if (!cancelled && typeof result?.enabled === "boolean") setEnabled(result.enabled);
      })
      .catch(() => setEnabled(false));
    return () => { cancelled = true; };
  }, [desktopApi]);

  if (!desktopApi?.setPetModeEnabled) {
    // 浏览器降级：菜单项可见但不可操作
    return (
      <div className="account-menu-pet-item" role="menuitem" aria-disabled="true" title="仅桌面应用可用">
        <span className="account-menu-pet-icon" aria-hidden="true">
          <Icon.Sparkle />
        </span>
        <div>
          <strong>桌宠伴星</strong>
          <small>仅桌面应用可用</small>
        </div>
        <label className="account-menu-pet-switch" aria-label="桌宠开关">
          <input type="checkbox" checked={false} disabled aria-label="桌宠开关" />
          <i aria-hidden="true" />
        </label>
      </div>
    );
  }

  if (enabled === null) return null;

  const toggle = (): void => {
    if (busy) return;
    setBusy(true);
    void desktopApi.setPetModeEnabled?.(!enabled)
      .then((result) => {
        if (typeof result?.enabled === "boolean") setEnabled(result.enabled);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <div className="account-menu-pet-item" role="menuitem">
      <span className="account-menu-pet-icon" aria-hidden="true">
        <Icon.Sparkle />
      </span>
      <div>
        <strong>桌宠伴星</strong>
        <small>桌面角色与语音对话</small>
      </div>
      <label className="account-menu-pet-switch" aria-label="桌宠开关">
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => toggle()}
          disabled={busy}
          aria-label="桌宠开关"
        />
        <i aria-hidden="true" />
      </label>
    </div>
  );
}

export function AccountMenu({
  className = "",
  triggerClassName = "",
}: {
  className?: string;
  triggerClassName?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 64, left: 12 });

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const gutter = 12;
    const menuWidth = Math.min(310, Math.max(0, window.innerWidth - gutter * 2));
    const measuredHeight = menuRef.current?.getBoundingClientRect().height ?? 0;
    const menuHeight = Math.min(
      measuredHeight > 0 ? measuredHeight : 420,
      Math.max(0, window.innerHeight - gutter * 2),
    );
    const gap = window.innerWidth < 960 ? 8 : 11;
    const left = Math.min(
      Math.max(gutter, rect.right - menuWidth),
      Math.max(gutter, window.innerWidth - menuWidth - gutter),
    );
    const placeAbove =
      rect.bottom + gap + menuHeight > window.innerHeight - gutter &&
      rect.top - gap - menuHeight >= gutter;
    const preferredTop = placeAbove
      ? rect.top - gap - menuHeight
      : rect.bottom + gap;

    setMenuPosition({
      top: Math.round(
        Math.max(
          gutter,
          Math.min(preferredTop, window.innerHeight - menuHeight - gutter),
        ),
      ),
      left: Math.round(left),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 2026-08-11：seq 守卫——IDENTITY_CHANGED_EVENT 快速连续触发时，旧慢响应
    // 可能后到覆盖新数据（与 lib/use-current-user.ts 的 reloadSeqRef 同模式）。
    let seq = 0;
    const loadAccount = () => {
      const requestSeq = seq + 1;
      seq = requestSeq;
      return api
        .getMe()
        .then((result) => {
          if (cancelled || requestSeq !== seq) return;
          setAccount(result);
          setAvatarFailed(false);
          setLoadFailed(false);
        })
        .catch(() => {
          if (!cancelled && requestSeq === seq) setLoadFailed(true);
        });
    };
    void loadAccount();
    window.addEventListener(IDENTITY_CHANGED_EVENT, loadAccount);
    return () => {
      cancelled = true;
      window.removeEventListener(IDENTITY_CHANGED_EVENT, loadAccount);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    // 2026-08-11（性能专项）：resize/scroll 用 rAF 合并——updateMenuPosition
    // 内含 getBoundingClientRect + 多次 setState，高频滚动时逐事件执行开销大。
    let rafHandle = 0;
    const scheduleMenuPosition = () => {
      if (rafHandle !== 0) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = 0;
        updateMenuPosition();
      });
    };
    window.addEventListener("resize", scheduleMenuPosition);
    window.addEventListener("scroll", scheduleMenuPosition, true);
    updateMenuPosition();
    window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    });

    return () => {
      if (rafHandle !== 0) window.cancelAnimationFrame(rafHandle);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", scheduleMenuPosition);
      window.removeEventListener("scroll", scheduleMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      router.replace("/login");
    } catch {
      setLogoutError("退出失败，请检查网络后重试。");
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut, router]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    updateMenuPosition();
    setOpen(true);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? currentIndex <= 0
              ? items.length - 1
              : currentIndex - 1
            : currentIndex < 0 || currentIndex === items.length - 1
              ? 0
              : currentIndex + 1;
    items[nextIndex]?.focus();
  };

  const displayName = account?.displayName?.trim() || account?.email.split("@")[0] || (loadFailed ? "账户" : "加载中");
  const email = account?.email ?? (loadFailed ? "账户信息暂不可用" : "正在读取账户…");
  const workspace =
    account?.workspaceName ??
    (loadFailed ? "工作区信息暂不可用" : "正在读取工作区…");
  const roleLabel =
    account?.role === "owner"
      ? "Owner"
      : account?.role
        ? "Member"
        : "Personal Beta";
  const hasAvatar = Boolean(account?.avatarUrl) && !avatarFailed;
  const fallbackLetter = (account?.displayName?.trim() || account?.email?.trim() || "")
    .charAt(0)
    .toUpperCase();
  const hasFallbackLetter = fallbackLetter.length > 0;

  return (
    <>
      <div
        ref={rootRef}
        className={`account-menu ${className}`.trim()}
      >
        <button
          ref={triggerRef}
          type="button"
          className={`account-menu-trigger ${triggerClassName}`.trim()}
          onClick={() => {
            if (!open) updateMenuPosition();
            setOpen((current) => !current);
          }}
          onKeyDown={handleTriggerKeyDown}
          aria-label="打开用户菜单"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="workspace-account-menu"
        >
          {hasAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={account!.avatarUrl!}
              alt=""
              width={40}
              height={40}
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="account-menu-trigger-fallback" aria-hidden="true">
              {hasFallbackLetter ? (
                fallbackLetter
              ) : (
                <Icon.User className="account-menu-placeholder-icon" />
              )}
            </span>
          )}
          <i aria-hidden="true" />
        </button>
      </div>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id="workspace-account-menu"
            className="account-menu-popover"
            role="menu"
            aria-label="用户账户菜单"
            onKeyDown={handleMenuKeyDown}
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
            }}
          >
            <div className="account-menu-user">
              {hasAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={account!.avatarUrl!}
                  alt=""
                  width={54}
                  height={54}
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                <span className="account-menu-user-fallback" aria-hidden="true">
                  {hasFallbackLetter ? (
                    fallbackLetter
                  ) : (
                    <Icon.User className="account-menu-placeholder-icon" />
                  )}
                </span>
              )}
              <div>
                <span>个人中心</span>
                <strong>{displayName}</strong>
                <small>{email}</small>
              </div>
              <b>{roleLabel}</b>
            </div>

            <div className="account-menu-workspace">
              <span>当前工作区</span>
              <strong>{workspace}</strong>
            </div>

            <div className="account-menu-items">
              <AccountPetModeToggle />
              <Link href="/settings" role="menuitem">
                <span>
                  <Icon.Settings aria-hidden="true" />
                </span>
                <div>
                  <strong>账户与设置</strong>
                  <small>账户信息、数据与偏好</small>
                </div>
                <Icon.Chevron aria-hidden="true" />
              </Link>
              <Link href="/benchmark" role="menuitem">
                <span>
                  <Icon.Target aria-hidden="true" />
                </span>
                <div>
                  <strong>评测中心</strong>
                  <small>查看系统质量与学习指标</small>
                </div>
                <Icon.Chevron aria-hidden="true" />
              </Link>
            </div>

            <div className="account-menu-divider" />

            <button
              type="button"
              className="account-menu-logout"
              role="menuitem"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
            >
              <Icon.Logout aria-hidden="true" />
              <span>{loggingOut ? "退出中…" : "退出登录"}</span>
            </button>
            {logoutError && <p className="account-menu-logout-error" role="alert">{logoutError}</p>}

            <footer>
              <span>理解引擎</span>
              <small>Private Alpha · v0.5</small>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
