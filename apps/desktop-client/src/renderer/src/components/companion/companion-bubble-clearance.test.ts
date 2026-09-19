import { describe, expect, it } from "vitest";
import {
  COMPANION_BUBBLE_FRAME_INSET,
  COMPANION_BUBBLE_RAIL_GAP,
  companionBubbleClearance,
} from "./companion-bubble-clearance";

const FRAME_1440 = { left: 0, right: 1440, top: 0, bottom: 810 };
/** 实测值（2026-09-19，1440×810 复习队列页）：目录栏展开态的一整列。 */
const RAIL_EXPANDED = { left: 22, right: 80, top: 84, bottom: 787 };
/** 同一页收起态：左下角一座小岛，x 仍然压着气泡的左缘。 */
const RAIL_COLLAPSED = { left: 22, right: 68, top: 742, bottom: 788 };
/** 实测值：座位在左时气泡未让位前的框（350×72，底边贴角色盒顶上方 14px）。 */
const BUBBLE_LEFT_SEAT = { left: 49, right: 399, top: 386, bottom: 458 };

describe("气泡与左侧目录栏的让位几何（2026-09-19）", () => {
  it("目录栏展开时把气泡推到它右缘之外，并保留一条间距", () => {
    const offset = companionBubbleClearance({
      bubble: BUBBLE_LEFT_SEAT,
      frame: FRAME_1440,
      rail: RAIL_EXPANDED,
    });
    expect(offset).toEqual({
      x: RAIL_EXPANDED.right + COMPANION_BUBBLE_RAIL_GAP - BUBBLE_LEFT_SEAT.left,
      y: 0,
    });
    expect(BUBBLE_LEFT_SEAT.left + offset.x).toBeGreaterThanOrEqual(RAIL_EXPANDED.right + COMPANION_BUBBLE_RAIL_GAP);
  });

  it("收起成左下角小岛后不再让位：两者的 x 仍然相交，靠垂直判定放行", () => {
    // 前提先钉住，否则这条测试会在"小岛其实不再压着气泡"时默默变成空断言。
    expect(RAIL_COLLAPSED.right).toBeGreaterThan(BUBBLE_LEFT_SEAT.left);
    expect(RAIL_COLLAPSED.top).toBeGreaterThan(BUBBLE_LEFT_SEAT.bottom);
    expect(companionBubbleClearance({
      bubble: BUBBLE_LEFT_SEAT,
      frame: FRAME_1440,
      rail: RAIL_COLLAPSED,
    })).toEqual({ x: 0, y: 0 });
  });

  it("气泡已经在内侧、与目录栏水平分开时不动", () => {
    expect(companionBubbleClearance({
      bubble: { ...BUBBLE_LEFT_SEAT, left: 120, right: 470 },
      frame: FRAME_1440,
      rail: RAIL_EXPANDED,
    })).toEqual({ x: 0, y: 0 });
  });

  it("座位在右时不经过目录栏，但仍被窗口右缘切掉：往内钳住并留出安全内缩", () => {
    // 实测 1440×810 右座位页：气泡 1121…1471，超出窗口 31px。
    const offset = companionBubbleClearance({
      bubble: { left: 1121, right: 1471, top: 386, bottom: 458 },
      frame: FRAME_1440,
      rail: RAIL_EXPANDED,
    });
    expect(offset).toEqual({ x: FRAME_1440.right - COMPANION_BUBBLE_FRAME_INSET - 1471, y: 0 });
  });

  it("内侧不够时只让出能给的那一段（不让出负数、也不把气泡推出右缘）", () => {
    const frame = { left: 0, right: 420, top: 0, bottom: 405 };
    const offset = companionBubbleClearance({
      bubble: { left: 49, right: 399, top: 300, bottom: 372 },
      frame,
      rail: RAIL_EXPANDED,
    });
    expect(offset.x).toBe(frame.right - COMPANION_BUBBLE_FRAME_INSET - 399);
    expect(offset.x).toBeGreaterThan(0);
  });

  it("通道已经完整可见、又没有障碍物时返回零偏移", () => {
    expect(companionBubbleClearance({
      bubble: { left: 100, right: 450, top: 200, bottom: 272 },
      frame: FRAME_1440,
      rail: null,
    })).toEqual({ x: 0, y: 0 });
  });

  it("头部通道顶出窗口上沿时下移，且顶边落在安全内缩上", () => {
    const bubble = { left: 100, right: 450, top: -20, bottom: 52 };
    const offset = companionBubbleClearance({ bubble, frame: FRAME_1440, rail: null });
    expect(offset).toEqual({ x: 0, y: COMPANION_BUBBLE_FRAME_INSET + 20 });
    expect(bubble.top + offset.y).toBe(COMPANION_BUBBLE_FRAME_INSET);
  });

  it("比可用宽度还宽的通道退化成居中，不制造左右溢出的假让位", () => {
    const frame = { left: 0, right: 720, top: 0, bottom: 405 };
    const offset = companionBubbleClearance({
      bubble: { left: 0, right: 900, top: 200, bottom: 272 },
      frame,
      rail: null,
    });
    expect(offset).toEqual({ x: (frame.left + frame.right) / 2 - 450, y: 0 });
  });

  it("退化成一个点的目录栏（挂载/卸载中）不作为障碍物", () => {
    expect(companionBubbleClearance({
      bubble: BUBBLE_LEFT_SEAT,
      frame: FRAME_1440,
      rail: { left: 22, right: 22, top: 84, bottom: 787 },
    })).toEqual({ x: 0, y: 0 });
  });
});
