import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRoomStore } from "../app/room-store";
import type { RoomIntent } from "../app/room-machine";
import { resolveSceneMotionMode } from "../scene/scene-motion";

/** Mockup nav icon paths, copied from desktop-pages-v3 `mockup.html`. */
const NAV_ICONS = {
  home: "M4 11.5 12 4l8 7.5M6.5 10.3V20h11v-9.7M10 20v-5h4v5",
  sources: "M5 3.5h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM8.5 8h7M8.5 12h7M8.5 16h4.5",
  notes: "M5 19.5 7.3 14 16 5.3a2 2 0 0 1 2.8 2.8L10.2 17 5 19.5Zm9-12.3 2.8 2.8M7.3 14l2.9 3",
  goals: "m12 3 8 9-8 9-8-9 8-9Zm0 5 3.5 4-3.5 4-3.5-4 3.5-4Z",
  // The second authored glyph (今日学习 was the first): the mockup's rail has no
  // 星图 chip, but the page is a real destination now. Same 24×24 / 1.7-stroke
  // outline language — a small constellation: three star nodes joined by two
  // lines, with the brightest star sitting higher, reading as "the map of
  // relations between stars" next to 理解 (its diamond) at 19px.
  graph: "M5.2 18.6 11.2 11.2 18.8 16.4M11.2 11.2l4.6-6.2M5.2 18.6m-1.9 0a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0M11.2 11.2m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M18.8 16.4m-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M15.8 5m-1.9 0a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0",
  // The only glyph here with no mockup counterpart. The mockup's rail has eight
  // chips and routes 复习 straight to page 14 (`data-target="14"`), so it never
  // draws a 今日学习 entry; this one is authored in the same 24×24 / 1.7-stroke
  // outline language — calendar frame, top hangers, month rule, then a marked
  // date cell — so 今日学习 and 复习 can sit side by side as two destinations.
  //
  // The date marker is deliberately off-centre with a rule beside it: a single
  // centred ring reads as a camera lens next to 来源 and 复习 at 19px.
  today: "M8 3v2.6M16 3v2.6M6.8 5.6h10.4a2.2 2.2 0 0 1 2.2 2.2v10.4a2.2 2.2 0 0 1-2.2 2.2H6.8a2.2 2.2 0 0 1-2.2-2.2V7.8a2.2 2.2 0 0 1 2.2-2.2ZM4.6 10.6h14.8M10.4 13.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4M14.6 15.5h1.4",
  review: "M19 8a7.5 7.5 0 1 0 .4 7M19 4v4h-4M12 8v4l2.5 1.7",
  search: "M16 10.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Zm-1 4.5 5 5",
  companion: "M12 3.5c.7 4.7 3.8 7.8 8.5 8.5-4.7.7-7.8 3.8-8.5 8.5-.7-4.7-3.8-7.8-8.5-8.5 4.7-.7 7.8-3.8 8.5-8.5Z",
  settings: "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm4 1.5v-3l-2-.6-.7-1.6 1-1.8-2.1-2.1-1.8 1-1.6-.7-.6-2h-3l-.6 2-1.6.7-1.8-1-2.1 2.1 1 1.8-.7 1.6-2 .6v3l2 .6.7 1.6-1 1.8 2.1 2.1 1.8-1 1.6.7.6 2h3l.6-2 1.6-.7 1.8 1 2.1-2.1-1-1.8.7-1.6 2-.6Z",
} as const;

type DirectoryItem = {
  readonly id: keyof typeof NAV_ICONS;
  readonly label: string;
  readonly intent: RoomIntent;
};

const DIRECTORY_ITEMS: readonly DirectoryItem[] = [
  { id: "home", label: "首页", intent: "home" },
  { id: "sources", label: "来源", intent: "open-sources" },
  { id: "notes", label: "笔记", intent: "open-notes" },
  { id: "goals", label: "学习卡", intent: "open-objectives" },
  // 星图 (page 19) sits with the understanding group: it is the topology view
  // of the same sources → notes → objectives chain the three chips above open.
  { id: "graph", label: "星图", intent: "graph" },
  // 今日学习 (page 14) and 复习 (page 15) are two different pages, and the rail
  // is the only place either one can be reached from. `continue` is the intent
  // `room-machine.ts` resolves to `{ surface: "study" }`, i.e. page 14.
  { id: "today", label: "今日学习", intent: "continue" },
  { id: "review", label: "复习", intent: "review" },
  { id: "search", label: "查找", intent: "search" },
  { id: "companion", label: "伴星", intent: "open-companion-center" },
  { id: "settings", label: "设置", intent: "open-settings" },
];

export type DirectoryRailMode = "auto" | "expanded" | "collapsed";

export const DIRECTORY_COLLAPSED_KEY = "ailearn.directory-rail.collapsed.v1";
export const DIRECTORY_RAIL_MODE_KEY = "ailearn.directory-rail.mode.v1";
export const DIRECTORY_RAIL_STATE_EVENT = "ailearn:directory-rail-state";
export const DIRECTORY_RAIL_MODE_EVENT = "ailearn:directory-rail-mode";
export const DIRECTORY_RAIL_TOGGLE_EVENT = "ailearn:directory-rail-toggle";

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(DIRECTORY_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function readDirectoryRailMode(): DirectoryRailMode {
  try {
    const stored = window.localStorage.getItem(DIRECTORY_RAIL_MODE_KEY);
    if (stored === "auto" || stored === "expanded" || stored === "collapsed") return stored;
    // Older builds only persisted the explicit bottom-island toggle. Treat an
    // untouched preference as responsive auto mode, while preserving a prior
    // manual collapse for users who already chose it.
    return readCollapsedPreference() ? "collapsed" : "auto";
  } catch {
    return "auto";
  }
}

type LayoutBox = {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type RailLayoutSnapshot = {
  readonly collapsed: boolean;
  readonly moving: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly box: LayoutBox;
  }>;
};

type SpringFrameFactory = (progress: number, time: number) => Keyframe;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function springProgress(time: number, strength = 6.4): number {
  const t = clamp01(time);
  return t === 1 ? 1 : 1 - (1 + strength * t) * Math.exp(-strength * t);
}

function springFrames(factory: SpringFrameFactory, count = 38, strength = 6.4): Keyframe[] {
  return Array.from({ length: count }, (_, index) => {
    const time = index / (count - 1);
    return { offset: time, ...factory(springProgress(time, strength), time) };
  });
}

function layoutBox(element: HTMLElement): LayoutBox {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function readRailLayout(rail: HTMLElement, collapsed: boolean): RailLayoutSnapshot {
  const moving = [
    rail,
    document.querySelector<HTMLElement>(".home-v2-hud"),
    document.querySelector<HTMLElement>(".hud-surface .content"),
    document.querySelector<HTMLElement>(".hud-surface .return-home"),
  ].filter((element): element is HTMLElement => Boolean(element));

  return {
    collapsed,
    moving: [...new Set(moving)].map((element) => ({ element, box: layoutBox(element) })),
  };
}

function visualGhost(element: HTMLElement, box: LayoutBox): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement;
  const sourceNodes = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll<HTMLElement>("*")];

  sourceNodes.forEach((source, index) => {
    const target = cloneNodes[index];
    if (!target) return;
    const computed = getComputedStyle(source);
    for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
      const property = computed.item(propertyIndex);
      target.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  });

  clone.classList.add("nav-morph-ghost");
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: "0",
    zIndex: "999",
    pointerEvents: "none",
    transform: "none",
    transformOrigin: "left bottom",
    animation: "none",
    transition: "none",
    overflow: "hidden",
    contain: "paint",
  });
  document.body.appendChild(clone);
  return clone;
}

function trackAnimation(
  animation: Animation,
  element: HTMLElement | SVGElement,
  previousTransformOrigin: string,
  activeAnimations: Animation[],
  afterCleanup?: () => void,
) {
  const previousInlineStyles = {
    transform: element.style.transform,
    opacity: element.style.opacity,
    clipPath: element.style.clipPath,
  };
  activeAnimations.push(animation);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    element.style.transformOrigin = previousTransformOrigin;
    element.style.transform = previousInlineStyles.transform;
    element.style.opacity = previousInlineStyles.opacity;
    element.style.clipPath = previousInlineStyles.clipPath;
    const index = activeAnimations.indexOf(animation);
    if (index >= 0) activeAnimations.splice(index, 1);
    afterCleanup?.();
  };
  animation.oncancel = cleanup;
  animation.onfinish = () => {
    // Commit the last frame before cancelling the WAAPI effect. Cancelling
    // directly can expose one stale CSS frame at the exact moment the rail
    // reaches its compact endpoint, which reads as a final flicker.
    try {
      (animation as Animation & { commitStyles?: () => void }).commitStyles?.();
    } catch {
      // Older Chromium builds may not expose commitStyles; the cleanup path
      // still restores the authored styles below.
    }
    animation.cancel();
  };
}

function animateFlip(
  element: HTMLElement,
  before: LayoutBox,
  after: LayoutBox,
  duration: number,
  activeAnimations: Animation[],
) {
  if (after.width <= 0 || after.height <= 0) return;
  const translateX = before.left - after.left;
  const translateY = before.top - after.top;
  const scaleX = before.width / after.width;
  const scaleY = before.height / after.height;
  if (
    Math.abs(translateX) < 0.5
    && Math.abs(translateY) < 0.5
    && Math.abs(scaleX - 1) < 0.005
    && Math.abs(scaleY - 1) < 0.005
  ) return;

  const previousTransformOrigin = element.style.transformOrigin;
  const animation = element.animate(
    springFrames((progress) => {
      const rest = 1 - progress;
      return {
        transformOrigin: "top left",
        transform: `translate3d(${translateX * rest}px, ${translateY * rest}px, 0) scale(${1 + (scaleX - 1) * rest}, ${1 + (scaleY - 1) * rest})`,
      };
    }),
    { duration, easing: "linear", fill: "both" },
  );
  trackAnimation(animation, element, previousTransformOrigin, activeAnimations);
}

function animateRailMorph(
  ghost: HTMLElement | null,
  rail: HTMLElement,
  beforeRail: LayoutBox,
  afterRail: LayoutBox,
  before: RailLayoutSnapshot,
  after: RailLayoutSnapshot,
  motionMode: "full" | "lite" | "off",
  activeAnimations: Animation[],
) {
  if (motionMode === "off" || before.collapsed === after.collapsed) {
    ghost?.remove();
    return;
  }

  const duration = motionMode === "full" ? 560 : 300;
  if (ghost) {
    // 收起时"小岛长出来"的进度与"整列被吃掉"的进度必须是同一条曲线。
    // 分成两条时实测有 ~200ms 里上半截已经不画、小岛还停在 opacity 0（190ms 处
    // 幽灵已被吃掉 60%，真目录栏 opacity 0.00），用户看到的不是收起动画而是闪一下。
    const collapseReveal = (time: number) => springProgress(clamp01((time - 0.38) / 0.62), 5.8);
    if (after.collapsed) {
      const inset = Math.max(0, beforeRail.height - afterRail.height);
      const translateX = afterRail.left - beforeRail.left;
      const translateY = afterRail.bottom - beforeRail.bottom;
      const scaleX = afterRail.width / beforeRail.width;
      const oldAnimation = ghost.animate(
        springFrames((_progress, time) => {
          const reveal = collapseReveal(time);
          return {
            transformOrigin: "left bottom",
            transform: `translate(${translateX * reveal}px, ${translateY * reveal}px) scaleX(${1 + (scaleX - 1) * reveal})`,
            clipPath: `inset(${inset * reveal}px 0 0 0 round ${22 - 7 * reveal}px)`,
            opacity: String(1 - clamp01((time - 0.7) / 0.3)),
          };
        },
        42,
      ),
        { duration, easing: "linear", fill: "both" },
      );
      trackAnimation(oldAnimation, ghost, "left bottom", activeAnimations, () => ghost.remove());

      const revealAnimation = rail.animate(
        springFrames((_, time) => {
          const reveal = collapseReveal(time);
          return {
            transformOrigin: "left bottom",
            transform: `scale(${0.9 + 0.1 * reveal})`,
            opacity: String(reveal),
          };
        }),
        { duration, easing: "linear", fill: "both" },
      );
      trackAnimation(revealAnimation, rail, "left bottom", activeAnimations);
    } else {
      const inset = Math.max(0, afterRail.height - beforeRail.height);
      const translateX = beforeRail.left - afterRail.left;
      const translateY = beforeRail.bottom - afterRail.bottom;
      const scaleX = beforeRail.width / afterRail.width;
      const revealAnimation = rail.animate(
        springFrames((progress) => {
          const rest = 1 - progress;
          return {
            transformOrigin: "left bottom",
            transform: `translate(${translateX * rest}px, ${translateY * rest}px) scaleX(${scaleX + (1 - scaleX) * progress})`,
            clipPath: `inset(${inset * rest}px 0 0 0 round ${15 + 7 * progress}px)`,
            opacity: String(0.72 + 0.28 * progress),
          };
        }),
        { duration, easing: "linear", fill: "both" },
      );
      trackAnimation(revealAnimation, rail, "left bottom", activeAnimations);

      const oldAnimation = ghost.animate(
        springFrames((progress, time) => ({
          opacity: String(1 - clamp01(time / 0.48)),
          transformOrigin: "left bottom",
          transform: `scale(${1 - 0.06 * progress})`,
        }),
        30,
      ),
        { duration: 360, easing: "linear", fill: "both" },
      );
      trackAnimation(oldAnimation, ghost, "left bottom", activeAnimations, () => ghost.remove());

      const chips = [...rail.querySelectorAll<HTMLElement>(".nav-chip")];
      chips.forEach((chip, index) => {
        const delay = 70 + (chips.length - 1 - index) * 17;
        const animation = chip.animate(
          springFrames((progress) => ({
            opacity: String(progress),
            transform: `translateY(${8 * (1 - progress)}px)`,
          }),
          26,
          6,
        ),
          { duration: 390, delay, easing: "linear", fill: "both" },
        );
        trackAnimation(animation, chip, "", activeAnimations);
      });
    }
  }

  for (const current of after.moving) {
    if (current.element === rail) continue;
    const previous = before.moving.find((item) => item.element === current.element);
    if (!previous || typeof current.element.animate !== "function") continue;
    animateFlip(
      current.element,
      previous.box,
      current.box,
      motionMode === "full" ? 520 : 280,
      activeAnimations,
    );
  }

  const arrow = rail.querySelector<SVGElement>(".nav-collapse svg");
  if (arrow && typeof arrow.animate === "function") {
    const animation = arrow.animate(
      [
        { transform: `rotate(${before.collapsed ? 180 : 0}deg)` },
        { transform: `rotate(${after.collapsed ? 180 : 0}deg)` },
      ],
      {
        duration: motionMode === "full" ? 480 : 240,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        fill: "both",
      },
    );
    trackAnimation(animation, arrow, "", activeAnimations);
  }
}

function NavIcon({ id }: { readonly id: keyof typeof NAV_ICONS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_ICONS[id]} />
    </svg>
  );
}

/**
 * `readOnly` is the first-entry scene (mockup 04A): the rail is drawn, but there
 * is no space bound yet, so every destination behind it would open a page with
 * nothing to read. The collapse toggle stays live — it is a local preference,
 * not a destination.
 */
export function DirectoryRail({ readOnly = false }: { readonly readOnly?: boolean } = {}) {
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const [mode, setMode] = useState<DirectoryRailMode>(readDirectoryRailMode);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const previousLayoutRef = useRef<RailLayoutSnapshot | null>(null);
  const activeAnimationsRef = useRef<Animation[]>([]);
  const collapsed = mode === "collapsed" || (mode === "auto" && autoCollapsed);

  useLayoutEffect(() => {
    setPortalHost(document.querySelector<HTMLElement>(".desktop-app"));
  }, []);

  useEffect(() => {
    // 「自动」是给书房首页让位用的：收起后场景才露得出来。任务页开着时整列
    // 只值 30px（笔记详情页正文左缘实测 expanded 365px / collapsed 335px），
    // 换到的空间没有东西可露，代价却是每次跳页都把这一列展开、1.9 秒后再收起——
    // 实窗量到一趟导航两次形变，用户读到的就是"目录栏一直闪"。所以有页面开着时
    // 不自动收，回书房才收。
    if (mode !== "auto" || surface) {
      setAutoCollapsed(false);
      return undefined;
    }
    setAutoCollapsed(false);
    const timer = window.setTimeout(() => setAutoCollapsed(true), 1900);
    return () => window.clearTimeout(timer);
  }, [mode, surface]);

  useLayoutEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    const rail = railRef.current;
    if (!app || !rail) return;

    const previousLayout = previousLayoutRef.current;
    const beforeRail = layoutBox(rail);
    for (const animation of activeAnimationsRef.current) animation.cancel();
    activeAnimationsRef.current = [];
    document.querySelectorAll<HTMLElement>(".nav-morph-ghost").forEach((ghost) => ghost.remove());
    const shouldAnimate = Boolean(previousLayout)
      && motionMode !== "off"
      && previousLayout?.collapsed !== collapsed;
    const ghost = shouldAnimate ? visualGhost(rail, beforeRail) : null;
    app.dataset.directoryRail = collapsed ? "collapsed" : "expanded";
    app.dataset.directoryRailMode = mode;
    // The ported V3.1 stylesheet drives the bottom-island morph from the same
    // `nav-collapsed` class the mockup puts on `.scene`.
    app.classList.toggle("nav-collapsed", collapsed);
    const nextLayout = readRailLayout(rail, collapsed);

    if (previousLayout) {
      animateRailMorph(
        ghost,
        rail,
        beforeRail,
        layoutBox(rail),
        previousLayout,
        nextLayout,
        motionMode,
        activeAnimationsRef.current,
      );
    } else {
      ghost?.remove();
    }
    previousLayoutRef.current = nextLayout;

    try {
      window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, mode);
      window.localStorage.setItem(DIRECTORY_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Preference persistence is progressive enhancement.
    }
    window.dispatchEvent(new CustomEvent(DIRECTORY_RAIL_STATE_EVENT, {
      detail: { collapsed, mode },
    }));
  }, [collapsed, mode, motionMode]);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    return () => {
      for (const animation of activeAnimationsRef.current) animation.cancel();
      activeAnimationsRef.current = [];
      if (app) {
        delete app.dataset.directoryRail;
        delete app.dataset.directoryRailMode;
        app.classList.remove("nav-collapsed");
      }
    };
  }, []);

  useEffect(() => {
    const onToggle = (event: Event) => {
      const next = (event as CustomEvent<{ collapsed?: unknown }>).detail?.collapsed;
      setMode((current) => {
        if (typeof next === "boolean") return next ? "collapsed" : "expanded";
        return current === "collapsed" ? "expanded" : "collapsed";
      });
    };
    const onMode = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: unknown }>).detail?.mode;
      if (next === "auto" || next === "expanded" || next === "collapsed") setMode(next);
    };
    window.addEventListener(DIRECTORY_RAIL_TOGGLE_EVENT, onToggle);
    window.addEventListener(DIRECTORY_RAIL_MODE_EVENT, onMode);
    return () => {
      window.removeEventListener(DIRECTORY_RAIL_TOGGLE_EVENT, onToggle);
      window.removeEventListener(DIRECTORY_RAIL_MODE_EVENT, onMode);
    };
  }, []);

  const activeId = useMemo<DirectoryItem["id"]>(() => {
    if (!surface) return "home";
    if (surface === "study") return "today";
    if (surface.startsWith("source-")) return "sources";
    if (surface.startsWith("note")) return "notes";
    if (surface.startsWith("objective") || surface === "card-generation") return "goals";
    if (surface === "graph") return "graph";
    if (surface === "review" || surface === "validation") return "review";
    if (surface === "search") return "search";
    if (surface === "companion-center") return "companion";
    if (surface === "settings") return "settings";
    return "home";
  }, [surface]);

  const portalTarget = portalHost ?? document.body;
  return createPortal(
    <nav ref={railRef} className="hud-rail" aria-label="学习空间目录">
      {DIRECTORY_ITEMS.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-chip${item.id === "settings" ? " settings-chip" : ""}${active ? " active" : ""}`}
            data-label={item.label}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            title={collapsed ? item.label : undefined}
            disabled={readOnly}
            onClick={() => invoke(item.intent)}
          >
            <NavIcon id={item.id} />
          </button>
        );
      })}
      <button
        type="button"
        className="nav-collapse"
        aria-label={collapsed ? "展开目录" : "收起目录"}
        aria-expanded={!collapsed}
        onClick={() => setMode(collapsed ? "expanded" : "collapsed")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="m7 9 5 5 5-5" />
        </svg>
      </button>
      <span className="nav-island-copy">学习空间目录</span>
    </nav>,
    portalTarget,
  );
}
