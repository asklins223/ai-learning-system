import { useEffect, useRef, useState } from "react";
import { ChevronsRight, Gauge, House, Moon, Orbit, Settings2, Sun, UserRound, Volume2, VolumeX } from "lucide-react";
import { useRoomStore } from "../../app/room-store";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { HudAccountMenu } from "./HudAccountMenu";
import { useHudPageClasses } from "./use-hud-page";
import { SPACE_MENU_OPEN_EVENT, takePendingSpaceMenuRequest } from "./space-menu-events";

/**
 * 图标层全部使用 lucide（与全应用其他 surface 同一图标语言），只有学习空间的
 * 印章保留手绘 path——那是 mockup 合同自己画的图形（圆环 + 印章方），lucide
 * 没有对应物。
 */

const MOTION_MODE_LABEL = {
  full: "完整",
  lite: "轻量",
  off: "关闭",
} as const;

function SpaceSealIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 1 0 0-14.8ZM9.2 9.2h5.6v5.6H9.2Z" />
    </svg>
  );
}

/**
 * Room control island (mockup `controls()`), collapsed to one seal by default.
 *
 * The interaction is the previous island's: a single trigger circle sits at the
 * pill's right end, the pill's skin scales out of it through the right-anchored
 * 300ms morph, and the slots fade in 65ms behind it. The learning-space seal
 * opens 04B's `.home-menu` card. The motion-mode slot (mockup
 * 没有画它，但上一版灵动岛有) is restored so 动效等级和它的指示灯始终可触达.
 *
 * `readOnly` renders the pill already open (mockup 04A paints the decorative
 * `controls()` on the first-entry paper; nothing behind it has a space to act
 * on, so there is nothing to collapse into).
 *
 * 折叠入口（2026-09-18 交互修复，二次返工）：触发印章常驻药丸最右端的
 * 原位置——折叠时它是唯一圆点，展开后留在原地、图标换成双箭头，再点一下
 * 即从原位置缩回；不额外新增收起槽位。点空白与 Esc 保留。头像 / 设置这类
 * 要打开 surface 的槽位改为「先播放 300ms 折叠动画，动画走完再跳转」，
 * 避免设置面板瞬间盖住折叠过程。
 */

/** 药丸折叠动画 300ms，导航等它走完再发生，留一帧余量。 */
const COLLAPSE_BEFORE_NAVIGATE_MS = 320;

export function HudRoomControl({ readOnly = false }: { readonly readOnly?: boolean }) {
  const invoke = useRoomStore((state) => state.invoke);
  const destination = useRoomStore((state) => state.destination);
  const surface = useRoomStore((state) => state.surface);
  const theme = useRoomStore((state) => state.theme);
  const toggleTheme = useRoomStore((state) => state.toggleTheme);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const toggleMasterMuted = useRoomStore((state) => state.toggleMasterMuted);
  const motionModeRaw = useRoomStore((state) => state.motionMode);
  const cycleMotionMode = useRoomStore((state) => state.cycleMotionMode);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setHudPage = useRoomStore((state) => state.setHudPage);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const motionMode = resolveSceneMotionMode(motionModeRaw, useRoomStore((state) => state.reducedMotion));
  const [expanded, setExpanded] = useState(false);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [spaceNotice, setSpaceNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const spaceRef = useRef<HTMLButtonElement>(null);
  /** 「先折叠再跳转」的定时器；用户在窗口期内重新展开时必须撤销。 */
  const navigateTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (navigateTimerRef.current !== undefined) window.clearTimeout(navigateTimerRef.current);
  }, []);

  const isExpanded = readOnly || onboardingOpen || expanded;

  useEffect(() => {
    if (readOnly) return undefined;
    // Same-commit requests (gate turns the room over with a failed invite)
    // dispatched before this listener existed; they are parked and consumed
    // here instead of being lost.
    const parked = takePendingSpaceMenuRequest();
    const onRequest = (event: Event) => {
      // 一次请求只生效一次：live 事件被这里接住时，把停车副本一并清掉。
      // 否则副本滞留，之后 gate 失效让药丸重挂载时会被当作新请求消费，
      // 菜单带着过期的邀请码错误自发弹开。
      takePendingSpaceMenuRequest();
      const notice = (event as CustomEvent<{ notice?: unknown }>).detail?.notice;
      setSpaceNotice(typeof notice === "string" ? notice : null);
      setSpaceMenuOpen(true);
      setExpanded(true);
    };
    if (parked) onRequest(new CustomEvent(SPACE_MENU_OPEN_EVENT, { detail: { notice: parked.notice } }));
    window.addEventListener(SPACE_MENU_OPEN_EVENT, onRequest);
    return () => window.removeEventListener(SPACE_MENU_OPEN_EVENT, onRequest);
  }, [readOnly]);

  // The island's own collapse rule: any open surface or the onboarding overlay
  // takes it back down to the seal.
  useEffect(() => {
    if (surface || onboardingOpen) {
      setSpaceMenuOpen(false);
      setExpanded(false);
    }
  }, [onboardingOpen, surface]);

  // Mockup 04B hangs its chrome on `page-04 space-returning` (collapsed rail,
  // the space bubble). While the learning-space menu is open the shell
  // republishes page 04 over whatever surface is running; closing hands the
  // page identity back to the surface that published it — no remount involved.
  useEffect(() => {
    if (!spaceMenuOpen) return undefined;
    const previousPage = useRoomStore.getState().hudPage;
    setHudPage("space");
    return () => {
      setHudPage(previousPage === "space" ? "home" : previousPage);
    };
  }, [setHudPage, spaceMenuOpen]);

  // Mirrors the store's published page (including the override above) onto
  // `.desktop-app`, so the 04B chrome lands even if a future surface forgets
  // to call `useHudPage` itself.
  useHudPageClasses();

  useEffect(() => {
    if (!isExpanded || readOnly) return undefined;
    const collapse = () => {
      setSpaceMenuOpen(false);
      setExpanded(false);
    };
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      // The space menu is a sibling of the pill (it is positioned by the
      // generated `.home-menu` rule), so "outside" has to name both boxes —
      // otherwise the pointerdown that means to press a menu row unmounts the
      // menu before the click ever fires.
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      collapse();
    };
    // Capture phase, so Escape closes the island instead of also returning the
    // room to the home preset one handler later.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (spaceMenuOpen) {
        setSpaceMenuOpen(false);
        window.requestAnimationFrame(() => spaceRef.current?.focus({ preventScroll: true }));
        return;
      }
      collapse();
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [isExpanded, readOnly, spaceMenuOpen]);

  const toggleExpanded = () => {
    if (isExpanded) {
      setSpaceMenuOpen(false);
      setExpanded(false);
      return;
    }
    // 窗口期内反悔（刚点了头像又立刻展开）就取消待执行的跳转。
    if (navigateTimerRef.current !== undefined) {
      window.clearTimeout(navigateTimerRef.current);
      navigateTimerRef.current = undefined;
    }
    setSpaceNotice(null);
    setExpanded(true);
  };

  /** 先收起药丸，等折叠动画播完再执行 action，让跳转发生在收拢之后。 */
  const collapseThen = (action: () => void) => {
    if (navigateTimerRef.current !== undefined) window.clearTimeout(navigateTimerRef.current);
    setSpaceMenuOpen(false);
    setExpanded(false);
    navigateTimerRef.current = window.setTimeout(() => {
      navigateTimerRef.current = undefined;
      action();
    }, COLLAPSE_BEFORE_NAVIGATE_MS);
  };

  const openSettings = (section: "account" | "appearance") => {
    collapseThen(() => {
      setSettingsSection(section);
      invoke("open-settings");
    });
  };

  const collapse = () => {
    setSpaceMenuOpen(false);
    setExpanded(false);
  };

  return (
    <>
      <div className="window-drag-region" aria-hidden="true" />
      <div
        ref={rootRef}
        className="room-control"
        role="group"
        aria-label="房间控制"
        data-expanded={isExpanded || undefined}
        inert={readOnly || onboardingOpen || undefined}
      >
        <button
          type="button"
          className={destination === "room" ? "active" : undefined}
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label="返回理解书房"
          title="返回房间总览"
          onClick={() => collapseThen(() => invoke("home"))}
        >
          <House aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label={theme === "day" ? "切换到夜间书房" : "切换到日间书房"}
          title={theme === "day" ? "夜间书房" : "日间书房"}
          onClick={toggleTheme}
        >
          {/* key 触发重挂载：日夜互换时图标做一个 200ms 的落位小动画。 */}
          {theme === "day"
            ? <Moon key="moon" className="room-control-icon-swap" aria-hidden="true" />
            : <Sun key="sun" className="room-control-icon-swap" aria-hidden="true" />}
        </button>
        <button
          type="button"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label={masterMuted ? "取消总静音" : "开启总静音"}
          title={masterMuted ? "取消总静音" : "总静音"}
          aria-pressed={masterMuted}
          onClick={toggleMasterMuted}
        >
          {masterMuted
            ? <VolumeX key="muted" className="room-control-icon-swap" aria-hidden="true" />
            : <Volume2 key="sound" className="room-control-icon-swap" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="room-control-motion"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label={`当前${MOTION_MODE_LABEL[motionMode]}动效，切换动效模式`}
          title={`动效：${MOTION_MODE_LABEL[motionMode]}`}
          aria-pressed={motionMode !== "full"}
          onClick={cycleMotionMode}
        >
          <Gauge aria-hidden="true" />
          {/* 动效模式指示灯：完整=绿、轻量=琥珀、关闭=灰，点击循环切换。 */}
          <i className={`motion-dot motion-dot--${motionMode}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label="打开设置中心"
          title="设置中心"
          onClick={() => openSettings("appearance")}
        >
          <Settings2 aria-hidden="true" />
        </button>
        <button
          ref={spaceRef}
          type="button"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          className={spaceMenuOpen ? "active" : undefined}
          aria-label={spaceMenuOpen ? "收起学习空间菜单" : "打开学习空间菜单"}
          aria-expanded={spaceMenuOpen}
          aria-haspopup="true"
          title="学习空间"
          onClick={() => {
            setSpaceNotice(null);
            setSpaceMenuOpen((open) => !open);
          }}
        >
          <SpaceSealIcon />
        </button>
        <button
          type="button"
          disabled={readOnly}
          inert={!isExpanded || undefined}
          aria-label="打开账户中心"
          title="账户中心"
          onClick={() => openSettings("account")}
        >
          <UserRound aria-hidden="true" />
        </button>
        {/* 触发印章常驻药丸最右端的原位置：折叠时它是唯一的圆点，展开后
            留在原地变为收起控制（图标换成指向收拢方向的双箭头），再点一下
            即缩回——折叠入口就是「原位置那颗印章」，不新增槽位。 */}
        <button
          ref={triggerRef}
          type="button"
          className="room-control-trigger"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "收起房间控制" : "展开房间控制"}
          title={isExpanded ? "收起" : "房间控制"}
          inert={readOnly || undefined}
          onClick={toggleExpanded}
        >
          {isExpanded
            ? <ChevronsRight key="collapse" className="room-control-icon-swap" aria-hidden="true" />
            : <Orbit key="orbit" aria-hidden="true" />}
          <i className={`room-control-trigger__status room-control-trigger__status--${motionMode}`} aria-hidden="true" />
        </button>
      </div>
      {!readOnly && isExpanded && spaceMenuOpen ? (
        <div ref={menuRef} className="room-control-menu">
          <HudAccountMenu
            notice={spaceNotice}
            onSwitched={() => {
              collapse();
              // The whole room is scoped to one verified workspace, so a switch
              // is a boundary change: reuse the gate's own invalidation path
              // rather than patching each surface's cursor by hand.
              publishGateInvalidation("stale_workspace");
            }}
          />
        </div>
      ) : null}
    </>
  );
}
