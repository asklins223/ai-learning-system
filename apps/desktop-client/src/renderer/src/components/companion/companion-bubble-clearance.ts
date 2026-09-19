import type { Rect } from "./companion-home-placement";

/**
 * 消息气泡与左侧目录栏的让位几何（2026-09-19）。
 *
 * 缺陷不是"气泡压住了目录栏"，而是反过来。任务页左座位
 * （`HUD_PAGES[*].companion.seat === "left"`）只按目录栏的 80px 栏宽
 * （`COMPANION_RAIL_GUTTER`）给**角色盒**让位，那 80px 对角色本体够用，却不够它头顶那张
 * 350px 宽的气泡——气泡以角色盒中线居中，比角色盒（`clamp(184px, 17vw, 252px)`）宽出约
 * 52px，左缘正好落进目录栏里。实测 1440×810 复习队列页：气泡 `49…399`、目录栏 `22…80`，
 * 压住 31px。
 *
 * 目录栏有两种形态，差别**全在垂直位置**上，所以判定必须先过垂直、再过水平：
 *   - 展开：贴左缘的一整列（22…80 × 84…窗口底 23px），与头部通道必然同处一条水平带；
 *   - 收起：左下角一座小岛（22…68 × 窗口底 22…68）。它和气泡**水平仍然相交**，但垂直不相交
 *     —— "收起后不必再让位"这件事只能从垂直判定得出，只看 x 会让气泡在目录栏收起后
 *     还缩在内侧。
 *
 * 让位方向只有一条：目录栏永远贴着窗口左缘，往左让等于把气泡推出窗口，所以水平方向一律
 * 往内侧（右）走。内侧不够时（窄窗）让出能给的那一段，剩下的由帧内钳位兜住。
 */
export const COMPANION_BUBBLE_RAIL_GAP = 12;

/**
 * 头部通道与窗口边缘之间要保持的间距。它与目录栏无关，是"始终完整可见"这一条的另一半：
 * 座位在右时气泡以角色盒中线居中，右缘会直接越过窗口右缘（实测 1440×810 右座位页超出
 * 31px）——那条路不经过目录栏，但同样得让。
 */
export const COMPANION_BUBBLE_FRAME_INSET = 8;

export type CompanionClearanceOffset = { readonly x: number; readonly y: number };

function spansOverlap(startA: number, endA: number, startB: number, endB: number, gap: number): boolean {
  return endA + gap > startB && startA - gap < endB;
}

/**
 * 一个轴上"挪到指定位置、但必须落在安全区里"的解，与 `companion-home-placement` 的
 * `axisCorrection` 同一套语义；装不下时才退化成居中（那时没有正解，只有最小伤害）。
 */
function axisOffset(start: number, end: number, preferred: number, safeStart: number, safeEnd: number): number {
  if (end - start > safeEnd - safeStart) return (safeStart + safeEnd) / 2 - (start + end) / 2;
  return Math.min(Math.max(preferred, safeStart - start), safeEnd - end);
}

export function companionBubbleClearance(input: {
  readonly bubble: Rect;
  readonly frame: Rect;
  readonly rail: Rect | null;
  readonly gap?: number;
  readonly inset?: number;
}): CompanionClearanceOffset {
  const gap = input.gap ?? COMPANION_BUBBLE_RAIL_GAP;
  const inset = input.inset ?? COMPANION_BUBBLE_FRAME_INSET;
  const { bubble, frame } = input;
  // 退化成一个点的框（目录栏还在挂载/正在卸载）不算障碍物。
  const rail = input.rail && input.rail.right > input.rail.left && input.rail.bottom > input.rail.top
    ? input.rail
    : null;
  const blocked = rail !== null
    && spansOverlap(bubble.left, bubble.right, rail.left, rail.right, gap)
    && spansOverlap(bubble.top, bubble.bottom, rail.top, rail.bottom, gap);
  return {
    x: Math.round(axisOffset(
      bubble.left,
      bubble.right,
      blocked && rail ? rail.right + gap - bubble.left : 0,
      frame.left + inset,
      frame.right - inset,
    )),
    y: Math.round(axisOffset(bubble.top, bubble.bottom, 0, frame.top + inset, frame.bottom - inset)),
  };
}
