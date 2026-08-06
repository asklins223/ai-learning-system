/**
 * 卡组轮播（Card Set Carousel）纯函数 — docs/plans/card-set-carousel-ui.md。
 *
 * 位姿、焦点约束、拖拽提交阈值、橡皮筋阻尼全部集中在本文件，供组件与
 * node --test 单测共享（硬门禁 G-11：swipe 阈值单一来源）。
 *
 * 布局常量：封面竖版 300×420（63:88 扑克牌比例），位姿完全由
 * d = index − focus 驱动（§3.1 表格）。
 */

export type CarouselVariant = "desktop" | "mobile";

/** 拖拽提交阈值（§3.2）：`|Δx| ≥ min(maxDragPx, slotWidth/4)` 或末段速度 > 0.5px/ms。 */
export const DECK_COMMIT = {
  maxDragPx: 84,
  minVelocityPxPerMs: 0.5,
} as const;

/** 移动端只保留 ±1 侧翼（§4.3）；桌面 ±2。 */
export const DECK_MAX_WING: Record<CarouselVariant, number> = {
  desktop: 2,
  mobile: 1,
};

/** 橡皮筋阻尼系数（§5.1）：dx·(1 − 1/(1+|dx|/280))。 */
const RUBBERBAND_SOFTEN = 280;

export interface DeckPose {
  /** 相对舞台中心的水平偏移（px，右为正）。 */
  translateX: number;
  /** 绕封面中心旋转（deg）。 */
  rotateZ: number;
  /** 垂直下沉量（px，正值向下，构成下凹弧线）。 */
  translateY: number;
  scale: number;
  opacity: number;
  zIndex: number;
  /** 是否进入可见渲染窗口（|d| ≤ maxWing）；否则 `visibility: hidden` + `aria-hidden`。 */
  visible: boolean;
  /** 是否可交互（点击 / 拖拽）。 */
  interactive: boolean;
  /** roving tabindex：仅焦点卡组可 tab。 */
  tabIndex: number;
  ariaHidden: boolean;
}

/** 单侧翼位姿常量（§3.1 / §4.3）。 */
interface WingPose {
  translateX: number;
  rotateZ: number;
  translateY: number;
  scale: number;
  opacity: number;
}

const WING_POSE: Record<CarouselVariant, readonly WingPose[]> = {
  desktop: [
    { translateX: 250, rotateZ: 5.5, translateY: 16, scale: 0.94, opacity: 1 },
    { translateX: 430, rotateZ: 11, translateY: 42, scale: 0.88, opacity: 1 },
  ],
  mobile: [
    { translateX: 150, rotateZ: 4, translateY: 14, scale: 0.92, opacity: 1 },
  ],
};

const FOCUS_Z = 40;

/**
 * 计算一张封面的位姿。d = index − focus：
 * - d=0 焦点：唯一可展开，z 40；
 * - |d|=1/2 侧翼：点击只聚焦不展开，z 30/20；
 * - |d|>maxWing：不渲染交互（aria-hidden + visibility hidden）。
 *
 * 侧翼位姿的 opacity 保持 1：整体透明会让文字对比度必挂 WCAG 1.4.3。
 * 「后退」的视觉层级由 z-index / scale / translateY 弧线 + CSS 淡化纸张
 * （.deck-cover--wing）共同表达。
 */
export function deckLayout(
  index: number,
  focus: number,
  count: number,
  options: { variant?: CarouselVariant } = {},
): DeckPose {
  const variant = options.variant ?? "desktop";
  if (index < 0 || index >= count) {
    return {
      translateX: 0,
      rotateZ: 0,
      translateY: 0,
      scale: 0,
      opacity: 0,
      zIndex: 0,
      visible: false,
      interactive: false,
      tabIndex: -1,
      ariaHidden: true,
    };
  }

  const d = index - focus;
  const maxWing = DECK_MAX_WING[variant];

  if (d === 0) {
    return {
      translateX: 0,
      rotateZ: 0,
      translateY: 0,
      scale: 1,
      opacity: 1,
      zIndex: FOCUS_Z,
      visible: true,
      interactive: true,
      tabIndex: 0,
      ariaHidden: false,
    };
  }

  const ad = Math.abs(d);
  if (ad > maxWing) {
    return {
      translateX: 0,
      rotateZ: 0,
      translateY: 0,
      scale: 0,
      opacity: 0,
      zIndex: FOCUS_Z - ad * 10,
      visible: false,
      interactive: false,
      tabIndex: -1,
      ariaHidden: true,
    };
  }

  const side = d < 0 ? -1 : 1;
  const wing = WING_POSE[variant][ad - 1];
  return {
    translateX: side * wing.translateX,
    rotateZ: side * wing.rotateZ,
    translateY: wing.translateY,
    scale: wing.scale,
    opacity: wing.opacity,
    zIndex: FOCUS_Z - ad * 10,
    visible: true,
    interactive: true,
    tabIndex: -1,
    ariaHidden: false,
  };
}

/** 将焦点索引约束到 [0, count-1]（空列表返回 0）。 */
export function clampFocus(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

/**
 * 拖拽释放是否应提交切换（§3.2）：`|Δx| ≥ min(84px, 槽宽/4)` 或末段速度 > 0.5px/ms。
 */
export function shouldCommit(
  dx: number,
  velocity: number,
  slotWidth: number,
): boolean {
  const distanceThreshold = Math.min(DECK_COMMIT.maxDragPx, slotWidth / 4);
  return (
    Math.abs(dx) >= distanceThreshold
    || Math.abs(velocity) > DECK_COMMIT.minVelocityPxPerMs
  );
}

/**
 * 拖拽释放后的目标切换方向：-1（上一副）/ 0（回弹）/ 1（下一副）。
 * 与 shouldCommit 共享同一套阈值，避免组件内重复实现。
 *
 * 方向语义与牌组运动一致：`--deck-dx` 跟随手指，拖左（dx<0）把右侧卡组拉到
 * 中央 → 下一副（+1）；拖右（dx>0）→ 上一副（-1）。端点外拖只回弹不提交。
 */
export function commitDirection(
  dx: number,
  velocity: number,
  slotWidth: number,
): -1 | 0 | 1 {
  if (!shouldCommit(dx, velocity, slotWidth)) return 0;
  const source = dx !== 0 ? dx : velocity;
  return source < 0 ? 1 : -1;
}

/**
 * 越界橡皮筋阻尼（§5.1）：dx·(1 − 1/(1+|dx|/280))。
 * 应用于已到端点仍向外拖的位移，让封面被「拉住」再回弹。
 */
export function rubberband(dx: number): number {
  if (dx === 0) return 0;
  const sign = dx < 0 ? -1 : 1;
  const magnitude = Math.abs(dx);
  return sign * magnitude * (1 - 1 / (1 + magnitude / RUBBERBAND_SOFTEN));
}

/**
 * 指示器是否渲染成圆点行。卡组数超过 maxDots（窗口宽度放不下）时返回 false，
 * UI 退化为可见题注「卡组 x / 已加载 n 组」+ 前后箭头（§3.2）。
 */
export function shouldRenderIndicators(count: number, maxDots = 12): boolean {
  return count > 0 && count <= maxDots;
}
