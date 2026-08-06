"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { CardSetListItem } from "@/lib/api";
import type { StatusPresentation } from "@/lib/status-map";
import {
  clampFocus,
  commitDirection,
  deckLayout,
  rubberband,
  shouldRenderIndicators,
  type CarouselVariant,
} from "@/lib/card-set-carousel";
import { Icon } from "@/components/ui/icons";
import { DeckCover } from "./DeckCover";

/** 点击与拖拽判定：位移 < 6px 且持续 < 300ms 才算点击（§3.2）。 */
const TAP_MAX_DISTANCE = 6;
const TAP_MAX_DURATION = 300;
/** 拖拽/回弹期间 will-change 保留时长（transition 240ms + 300ms 冗余，§5.2）。 */
const SETTLE_WILL_CHANGE_MS = 540;
/** 松手前指针静止超过该时长，末段速度视为已衰减（§3.2「末段速度」）。 */
const VELOCITY_STALE_MS = 120;

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  moved: boolean;
  slotWidth: number;
  pendingDx: number;
  raf: number | null;
}

interface CardSetCarouselProps {
  sets: CardSetListItem[];
  focus: number;
  onFocusChange: (index: number) => void;
  onExpand: (setId: string) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError?: string | null;
  onLoadMore: () => void;
  statusPresentation: (set: CardSetListItem) => StatusPresentation;
  /** 每次递增触发一次焦点归还到焦点封面（收起后 G-2）；0 表示不主动聚焦。 */
  restoreFocusKey?: number;
}

/**
 * 卡组轮播 — 舞台 + transform 布局 + 三通道切换（箭头/键盘/拖拽）+ 指示器。
 *
 * 拖拽期间零 React re-render（§5.2）：dx 活在 ref，rAF 直写 CSS 变量
 * `--deck-dx`；释放后 onFocusChange 更新焦点位姿，240ms 吸附。
 * 焦点封面点击 → onExpand（父组件原地展开）；侧翼点击 → 只聚焦。
 */
export function CardSetCarousel({
  sets,
  focus,
  onFocusChange,
  onExpand,
  nextCursor,
  loadingMore,
  loadMoreError = null,
  onLoadMore,
  statusPresentation,
  restoreFocusKey = 0,
}: CardSetCarouselProps) {
  const router = useRouter();
  const [isMobile, setIsMobile] = useState(false);
  const [interactionPhase, setInteractionPhase] = useState<
    "idle" | "dragging" | "settling"
  >("idle");

  const stageRef = useRef<HTMLDivElement>(null);
  const coverRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);

  const variant: CarouselVariant = isMobile ? "mobile" : "desktop";
  const count = sets.length;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", update);
    return () => {
      mq.removeEventListener("change", update);
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    coverRefs.current = coverRefs.current.slice(0, count);
  }, [count]);

  /* 收起后焦点归还（G-2）：页面在 collapse 完成时递增 restoreFocusKey */
  useEffect(() => {
    if (restoreFocusKey > 0) {
      coverRefs.current[focus]?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreFocusKey]);

  /* ── 键盘（roving tabindex，焦点封面为单一 tab stop） ── */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      count === 0
      || !(event.target instanceof HTMLElement)
      || !event.target.closest("[data-ui='deck-cover']")
    ) {
      return;
    }
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = focus - 1;
        break;
      case "ArrowRight":
        next = focus + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    const clamped = clampFocus(next, count);
    if (clamped === focus) return;
    event.preventDefault();
    onFocusChange(clamped);
    coverRefs.current[clamped]?.focus();
  };

  /* ── 拖拽 / 滑动（pointer 事件 + setPointerCapture） ── */

  const applyDragOffset = useCallback((rawDx: number) => {
    let dx = rawDx;
    if (
      (focus === 0 && rawDx > 0)
      || (focus === count - 1 && rawDx < 0)
    ) {
      dx = rubberband(rawDx);
    }
    stageRef.current?.style.setProperty("--deck-dx", `${dx}px`);
  }, [focus, count]);

  const scheduleApply = useCallback((session: DragSession, dx: number) => {
    session.pendingDx = dx;
    if (session.raf === null) {
      session.raf = window.requestAnimationFrame(() => {
        session.raf = null;
        applyDragOffset(session.pendingDx);
      });
    }
  }, [applyDragOffset]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const coverEl = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-ui="deck-cover"]',
    );
    if (!coverEl) return;
    const stage = stageRef.current;
    if (!stage) return;
    const now = performance.now();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: now,
      lastX: event.clientX,
      lastTime: now,
      velocity: 0,
      moved: false,
      slotWidth: stage.getBoundingClientRect().width || 800,
      pendingDx: 0,
      raf: null,
    };
    // capture 设在封面按钮上：pointer 事件冒泡到舞台照常处理，
    // 同时 click 事件命中封面（设在舞台上会把 click 重定向到舞台，吞掉点击）。
    coverEl.setPointerCapture(event.pointerId);
    // 拖拽期间关闭封面 transform 过渡，rAF 直写 --deck-dx 1:1 跟手（§5.1）
    stage.classList.add("is-dragging");
    setInteractionPhase("dragging");
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) > TAP_MAX_DISTANCE) {
      session.moved = true;
    }
    if (!session.moved) return;

    const now = performance.now();
    const dt = now - session.lastTime;
    if (dt > 0) {
      session.velocity = (event.clientX - session.lastX) / dt;
    }
    session.lastX = event.clientX;
    session.lastTime = now;
    event.preventDefault();
    scheduleApply(session, dx);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (session.raf !== null) {
      window.cancelAnimationFrame(session.raf);
    }

    const dx = event.clientX - session.startX;
    const now = performance.now();
    const duration = now - session.startTime;
    const isTap = !session.moved
      && Math.abs(dx) < TAP_MAX_DISTANCE
      && duration < TAP_MAX_DURATION;
    suppressClickRef.current = !isTap;

    if (session.moved) {
      // 松手前指针已静止超过 VELOCITY_STALE_MS：末段速度视为衰减为 0（§3.2），
      // 避免「甩一下然后按住停顿再松手」用陈旧速度误提交。
      const velocity =
        now - session.lastTime > VELOCITY_STALE_MS ? 0 : session.velocity;
      // reduced-motion 去掉惯性/甩动判定（§5.4 G-1）：只按位移阈值提交。
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const direction = commitDirection(
        dx,
        reducedMotion ? 0 : velocity,
        session.slotWidth,
      );
      if (direction !== 0) {
        const target = clampFocus(focus + direction, count);
        if (target !== focus) onFocusChange(target);
      }
    }

    stageRef.current?.style.setProperty("--deck-dx", "0px");
    stageRef.current?.classList.remove("is-dragging");
    setInteractionPhase("settling");
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    settleTimerRef.current = window.setTimeout(() => {
      setInteractionPhase("idle");
    }, SETTLE_WILL_CHANGE_MS);
  };

  const cancelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (session.raf !== null) {
      window.cancelAnimationFrame(session.raf);
    }
    stageRef.current?.style.setProperty("--deck-dx", "0px");
    stageRef.current?.classList.remove("is-dragging");
    suppressClickRef.current = true;
    setInteractionPhase("settling");
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    settleTimerRef.current = window.setTimeout(() => {
      setInteractionPhase("idle");
    }, SETTLE_WILL_CHANGE_MS);
  };

  const handleCoverClick = (index: number) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (index === focus) {
      const set = sets[index];
      // §6.5 防御边界：cardCount=0 卡组不可展开，点击导航详情页承接 lifecycle
      if (set.cardCount > 0) {
        onExpand(set.id);
      } else {
        void router.push(`/card-sets/${set.id}`);
      }
    } else {
      onFocusChange(index);
      coverRefs.current[index]?.focus();
    }
  };

  /* ── 渲染 ── */

  if (count === 0) return null;

  const focusTitle = sets[focus]?.title?.trim() || "未命名学习卡组";
  const showIndicators = shouldRenderIndicators(count);
  // 拖拽：transition:none 跟手；回弹/吸附：恢复 transition（240ms 吸附，§5.2）
  const interactionClass =
    interactionPhase === "dragging"
      ? "is-dragging"
      : interactionPhase === "settling"
        ? "is-settling"
        : "";

  return (
    <section
      className={`deck-carousel ${interactionClass}`}
      data-ui="card-set-carousel"
      aria-label="学习卡组轮播"
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
    >
      <div className="deck-carousel-caption">
        <span aria-live="polite" aria-atomic="true">
          卡组 {focus + 1} / 已加载 {count} 组
        </span>
        <strong className="deck-carousel-focus-title">{focusTitle}</strong>
      </div>

      <div className="deck-stage-clip">
        <div className="deck-stage" ref={stageRef}>
          {sets.map((set, index) => {
            const pose = deckLayout(index, focus, count, { variant });
            const isFocus = index === focus;
            return (
              <DeckCover
                key={set.id}
                ref={(node) => {
                  coverRefs.current[index] = node;
                }}
                set={set}
                presentation={statusPresentation(set)}
                pose={pose}
                onClick={handleCoverClick(index)}
                ariaLabel={
                  isFocus
                    ? `展开卡组：${set.title?.trim() || "未命名学习卡组"}`
                    : `切换到卡组：${set.title?.trim() || "未命名学习卡组"}`
                }
              />
            );
          })}
        </div>
      </div>

      <div className="deck-carousel-controls">
        <button
          type="button"
          className="deck-carousel-arrow"
          data-ui="carousel-prev"
          aria-label="上一副卡组"
          disabled={focus === 0}
          onClick={() => {
            const target = clampFocus(focus - 1, count);
            onFocusChange(target);
            coverRefs.current[target]?.focus();
          }}
        >
          <Icon.Chevron aria-hidden="true" />
        </button>

        {showIndicators ? (
          <div
            className="deck-carousel-indicators"
            role="group"
            aria-label="跳到指定卡组"
          >
            {sets.map((set, index) => (
              <button
                key={set.id}
                type="button"
                className={index === focus ? "is-current" : undefined}
                data-ui="carousel-indicator"
                aria-label={`跳到第 ${index + 1} 组：${set.title?.trim() || "未命名学习卡组"}`}
                aria-current={index === focus ? "true" : undefined}
                onClick={() => {
                  onFocusChange(index);
                  coverRefs.current[index]?.focus();
                }}
              />
            ))}
          </div>
        ) : (
          <span className="deck-carousel-indicators-text" aria-hidden="true">
            {focus + 1} / {count}
          </span>
        )}

        <button
          type="button"
          className="deck-carousel-arrow"
          data-ui="carousel-next"
          aria-label="下一副卡组"
          disabled={focus === count - 1}
          onClick={() => {
            const target = clampFocus(focus + 1, count);
            onFocusChange(target);
            coverRefs.current[target]?.focus();
          }}
        >
          <Icon.Chevron aria-hidden="true" />
        </button>
      </div>

      {nextCursor && (
        <div className="deck-carousel-loadmore-wrap">
          {loadMoreError && (
            <p className="cards-loadmore-error" role="alert">
              {loadMoreError}
            </p>
          )}
          <button
            type="button"
            className="deck-carousel-loadmore"
            data-ui="carousel-load-more"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "正在加载…" : "加载更早的卡组"}
          </button>
        </div>
      )}
    </section>
  );
}
