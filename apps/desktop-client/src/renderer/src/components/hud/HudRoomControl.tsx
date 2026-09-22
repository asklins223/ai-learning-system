import { useEffect, useRef, useState } from "react";
import { ChevronsRight, Gauge, House, Moon, Orbit, Settings2, Sun, Volume2, VolumeX } from "lucide-react";
import { useRoomStore } from "../../app/room-store";
import { spaceRoleLabel } from "../../app/space-identity";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { HudAccountCard, accountAvatarSrcFor, accountInitial } from "./HudAccountCard";
import { HudAccountMenu } from "./HudAccountMenu";
import { useHudPageClasses } from "./use-hud-page";
import {
  SPACE_MENU_OPEN_EVENT,
  requestSpaceSwitchReceipt,
  takePendingSpaceMenuRequest,
  takePendingSpaceSwitchReceipt,
  SPACE_SWITCH_RECEIPT_EVENT,
} from "./space-menu-events";

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
 * `decorative` renders the pill already open (mockup 04A paints the decorative
 * `controls()` on the first-entry paper; nothing behind it has a space to act
 * on, so there is nothing to collapse into).
 *
 * 折叠入口（2026-09-18 交互修复，二次返工）：触发印章常驻药丸最右端的
 * 原位置——折叠时它是唯一圆点，展开后留在原地、图标换成双箭头，再点一下
 * 即从原位置缩回；不额外新增收起槽位。点空白与 Esc 保留。头像 / 设置这类
 * 要打开 surface 的槽位改为「先播完折叠动画再跳转」，避免设置面板瞬间盖住
 * 折叠过程（预算见下面那个常量，由样式表算出来钉住）。
 */

/**
 * 药丸折叠动画的等待窗口，导航等它走完再发生。
 *
 * 折叠现在是一段有预算的动画：图标 110ms 淡出，槽位宽度再收 320ms、并带 80ms
 * 起步延迟（`hud-surface.css` 末尾的 B0 段），合计 400ms。留 20ms 余量。
 * 这个数与那条 CSS 是同一个事实的两半，由 `src/main/room-control-motion.test.ts`
 * 从样式表里算出来钉住——改 CSS 时序而忘改这里，设置面板会盖在还没关完的岛上。
 */
const COLLAPSE_BEFORE_NAVIGATE_MS = 420;

export function HudRoomControl({ decorative = false }: { readonly decorative?: boolean }) {
  /**
   * `decorative` 是 04A 首次进入那张纸上的装饰态药丸（还没有空间可操作）。
   * 它以前叫 `readOnly`，和「空间只读权限」同名——两件事撞在一个词上，
   * 读代码的人会以为它在表达成员权限，而空间权限走的是 capability 投影。
   */
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
  /** 顶栏常驻空间胶囊的唯一数据源：门禁每次读到已验证会话都会发布。 */
  const spaceIdentity = useRoomStore((state) => state.spaceIdentity);
  /** 账户槽位与设置页读同一个来源：门禁每次读到已验证会话都发布，与小空间胶囊同一时机。 */
  const account = useRoomStore((state) => state.accountIdentity);
  const avatarSrc = accountAvatarSrcFor(account, useRoomStore((state) => state.accountAvatar));
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const motionMode = resolveSceneMotionMode(motionModeRaw, useRoomStore((state) => state.reducedMotion));
  const [expanded, setExpanded] = useState(false);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [spaceNotice, setSpaceNotice] = useState<string | null>(null);
  /**
   * 切换成功回执。必须由这个常驻宿主持有：surface 自己的 state 活不过切换引起的
   * 门禁重挂载（设置页原先 setNotice 之后同一 tick 就被卸载，提示从未出现过）。
   */
  const [switchReceipt, setSwitchReceipt] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const spaceRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLButtonElement>(null);
  /** 「先折叠再跳转」的定时器；用户在窗口期内重新展开时必须撤销。 */
  const navigateTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (navigateTimerRef.current !== undefined) window.clearTimeout(navigateTimerRef.current);
  }, []);

  const isExpanded = decorative || onboardingOpen || expanded;

  useEffect(() => {
    if (decorative) return undefined;
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
  }, [decorative]);

  // 切换回执：药丸在切换引起的重挂载里取回停车值；若药丸没被卸载，则走 live 事件。
  useEffect(() => {
    const onReceipt = (event: Event) => {
      const name = (event as CustomEvent<{ workspaceName?: unknown }>).detail?.workspaceName;
      if (typeof name !== "string" || name.length === 0) return;
      setSwitchReceipt(name);
    };
    const parked = takePendingSpaceSwitchReceipt();
    if (parked) setSwitchReceipt(parked);
    window.addEventListener(SPACE_SWITCH_RECEIPT_EVENT, onReceipt);
    return () => window.removeEventListener(SPACE_SWITCH_RECEIPT_EVENT, onReceipt);
  }, []);

  useEffect(() => {
    if (switchReceipt === null) return undefined;
    const timer = window.setTimeout(() => setSwitchReceipt(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [switchReceipt]);

  // The island's own collapse rule: any open surface or the onboarding overlay
  // takes it back down to the seal.
  useEffect(() => {
    if (surface || onboardingOpen) {
      setSpaceMenuOpen(false);
      setAccountMenuOpen(false);
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
    if (!isExpanded || decorative) return undefined;
    const collapse = () => {
      setSpaceMenuOpen(false);
      setAccountMenuOpen(false);
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
      if (accountMenuOpen) {
        setAccountMenuOpen(false);
        window.requestAnimationFrame(() => accountRef.current?.focus({ preventScroll: true }));
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
  }, [isExpanded, decorative, spaceMenuOpen, accountMenuOpen]);

  const toggleExpanded = () => {
    if (isExpanded) {
      setSpaceMenuOpen(false);
      setAccountMenuOpen(false);
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
    setAccountMenuOpen(false);
    setExpanded(false);
  };

  /**
   * 胶囊两条路都做同一件事：展开药丸并把空间菜单打开；已经开着就收掉它。
   *
   * toggle 而不是"只开不关"（2026-09-22）：卡开着的时候那颗胶囊还亮着、还在原地，
   * 人的手感就是再点一下该收回去了。以前这里只写 `set(true)`，再点等于什么都没
   * 发生，只能去点空白或按 Esc——用户报"再次点击头像不能关闭回去浮窗"，空间这张
   * 卡其实同一条毛病。关卡时岛保持展开：岛是岛的开关，卡是卡的开关，两件事各管一次点击。
   */
  const openSpaceMenu = () => {
    setSpaceNotice(null);
    setAccountMenuOpen(false);
    if (spaceMenuOpen) {
      setSpaceMenuOpen(false);
      return;
    }
    setSpaceMenuOpen(true);
    setExpanded(true);
  };

  /** 账户小框与空间菜单互斥：同一个人一次只看一张卡，两张叠在一起没人读得懂。 */
  const openAccountMenu = () => {
    setSpaceMenuOpen(false);
    if (accountMenuOpen) {
      setAccountMenuOpen(false);
      return;
    }
    setAccountMenuOpen(true);
    setExpanded(true);
  };

  return (
    <>
      <div className="window-drag-region" aria-hidden="true" />
      <div
        ref={rootRef}
        className="room-control"
        role="group"
        aria-label="学习空间控制"
        data-expanded={isExpanded || undefined}
        inert={decorative || onboardingOpen || undefined}
      >
        {/* 常驻空间胶囊。审查里「切换学习空间没有持续感知」的直接对策：药丸一折叠
            就只剩一枚印章，屏幕上没有任何一处说明「我在哪个空间、我能不能改」。
            它故意不带 inert={!isExpanded}——折叠态也必须可见可点；只读态写成文字，
            不只靠颜色（a11y 合同：颜色不能是唯一载体）。 */}
        <button
          ref={spaceRef}
          type="button"
          className={spaceMenuOpen ? "room-control-space active" : "room-control-space"}
          data-readonly={spaceIdentity?.role === "member" || undefined}
          disabled={decorative}
          aria-expanded={spaceMenuOpen}
          aria-haspopup="true"
          aria-label={spaceIdentity
            ? `当前学习空间 ${spaceIdentity.name}，${spaceRoleLabel(spaceIdentity)}，打开空间菜单`
            : "正在读取你当前的学习空间"}
          title={spaceIdentity
            ? `${spaceIdentity.name} · ${spaceRoleLabel(spaceIdentity)}`
            : "学习空间"}
          onClick={openSpaceMenu}
        >
          <span className="room-control-space__seal"><SpaceSealIcon /></span>
          <span className="room-control-space__text">
            <b>{spaceIdentity?.name ?? "正在读取空间"}</b>
            <small>{spaceIdentity ? spaceRoleLabel(spaceIdentity) : "读取中…"}</small>
          </span>
        </button>
        <button
          type="button"
          className={destination === "room" ? "active" : undefined}
          disabled={decorative}
          inert={!isExpanded || undefined}
          aria-label="返回学习空间"
          title="返回学习空间总览"
          onClick={() => collapseThen(() => invoke("home"))}
        >
          <House aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={decorative}
          inert={!isExpanded || undefined}
          aria-label={theme === "day" ? "切换到夜间场景" : "切换到日间场景"}
          title={theme === "day" ? "夜间场景" : "日间场景"}
          onClick={toggleTheme}
        >
          {/* key 触发重挂载：日夜互换时图标做一个 200ms 的落位小动画。 */}
          {theme === "day"
            ? <Moon key="moon" className="room-control-icon-swap" aria-hidden="true" />
            : <Sun key="sun" className="room-control-icon-swap" aria-hidden="true" />}
        </button>
        <button
          type="button"
          disabled={decorative}
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
          disabled={decorative}
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
          disabled={decorative}
          inert={!isExpanded || undefined}
          aria-label="打开设置中心"
          title="设置中心"
          onClick={() => openSettings("appearance")}
        >
          <Settings2 aria-hidden="true" />
        </button>
        {/* 账户槽位以前只是一个 `UserRound` 图标，点下去直接跳到设置页：屏幕上没有
            任何一处回答「现在登录的是谁」，而换账号要的退出恰好无处可点。现在它是
            一张脸（有头像用头像，否则用与设置页同一套首字母印章），点开小框。 */}
        <button
          ref={accountRef}
          type="button"
          className={accountMenuOpen ? "room-control-account active" : "room-control-account"}
          disabled={decorative}
          inert={!isExpanded || undefined}
          aria-expanded={accountMenuOpen}
          aria-haspopup="true"
          aria-label={account
            ? `当前登录账号 ${account.displayName ?? account.email}（${account.email}），打开账户菜单`
            : "正在读取这台设备登录的账号"}
          title={account ? account.email : "账户"}
          onClick={openAccountMenu}
        >
          {avatarSrc
            ? <img className="room-control-account__photo" src={avatarSrc} alt="" aria-hidden="true" />
            : <span className="room-control-account__seal" aria-hidden="true">{accountInitial(account)}</span>}
        </button>
        {/* 触发印章常驻药丸最右端的原位置：折叠时它是唯一的圆点，展开后
            留在原地变为收起控制（图标换成指向收拢方向的双箭头），再点一下
            即缩回——折叠入口就是「原位置那颗印章」，不新增槽位。 */}
        <button
          ref={triggerRef}
          type="button"
          className="room-control-trigger"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "收起学习空间控制" : "展开学习空间控制"}
          title={isExpanded ? "收起" : "学习空间控制"}
          inert={decorative || undefined}
          onClick={toggleExpanded}
        >
          {isExpanded
            ? <ChevronsRight key="collapse" className="room-control-icon-swap" aria-hidden="true" />
            : <Orbit key="orbit" aria-hidden="true" />}
          <i className={`room-control-trigger__status room-control-trigger__status--${motionMode}`} aria-hidden="true" />
        </button>
      </div>
      {!decorative && isExpanded && spaceMenuOpen ? (
        <div ref={menuRef} className="room-control-menu">
          <HudAccountMenu
            notice={spaceNotice}
            onSwitched={(workspaceName) => {
              collapse();
              // 先停车再失效：门禁重挂载后药丸可能还没挂上监听，停车保证它取得到。
              requestSpaceSwitchReceipt(workspaceName);
              // The whole room is scoped to one verified workspace, so a switch
              // is a boundary change: reuse the gate's own invalidation path
              // rather than patching each surface's cursor by hand.
              publishGateInvalidation("stale_workspace");
            }}
          />
        </div>
      ) : null}
      {!decorative && isExpanded && accountMenuOpen ? (
        <div ref={menuRef} className="room-control-menu">
          <HudAccountCard onOpenAccount={() => openSettings("account")} />
        </div>
      ) : null}
      {switchReceipt !== null ? (
        <p className="room-control-receipt" role="status">
          已进入「{switchReceipt}」
        </p>
      ) : null}
    </>
  );
}
