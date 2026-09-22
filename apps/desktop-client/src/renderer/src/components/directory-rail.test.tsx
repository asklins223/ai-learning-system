// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../app/room-store";
import { DirectoryRail, DIRECTORY_RAIL_MODE_KEY } from "./DirectoryRail";

/**
 * 目录栏的两条"闪"的证据都来自实窗（2026-09-22，1440×810，CDP 逐帧量）：
 * 一次收起里，幽灵那一列在前 190ms 就被吃掉 60%（clipPath inset 400px / 657px），
 * 而真目录栏要到 213ms 才开始离开 opacity 0——中间那 200ms 左侧整块什么都不画。
 * 另一半是"每次跳页都把这一列展开、1.9 秒后再收一次"，任务页只换到 30px。
 * 这里把两件事各自钉住。
 */

const RAIL_EXPANDED = { left: 22, top: 84, width: 58, height: 703 };
const RAIL_COLLAPSED = { left: 22, top: 741, width: 50, height: 46 };

type Frame = Record<string, string | number>;
const animated: { selector: string; frames: Frame[] }[] = [];

function rectOf(element: Element) {
  const base = element.classList.contains("hud-rail") && !element.classList.contains("nav-morph-ghost")
    ? (document.querySelector(".desktop-app")?.classList.contains("nav-collapsed") ? RAIL_COLLAPSED : RAIL_EXPANDED)
    // 幽灵永远画的是"收起之前"那一列。
    : element.classList.contains("nav-morph-ghost")
      ? RAIL_EXPANDED
      : { left: 400, top: 100, width: 800, height: 600 };
  return {
    ...base,
    right: base.left + base.width,
    bottom: base.top + base.height,
    x: base.left,
    y: base.top,
  };
}

function stubPaintSurface() {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rectOf(this) as unknown as DOMRect;
  };
  Element.prototype.animate = function animate(this: Element, keyframes: unknown) {
    const selector = this.classList.contains("nav-morph-ghost")
      ? "ghost"
      : this.classList.contains("hud-rail") ? "rail" : "other";
    animated.push({ selector, frames: keyframes as Frame[] });
    return {
      cancel() {},
      commitStyles() {},
      onfinish: null,
      oncancel: null,
      playState: "running",
    } as unknown as Animation;
  } as unknown as typeof Element.prototype.animate;
}

/** `inset(400.9px 0 0 0 round 22px)` → 被从顶部吃掉的比例。 */
function clippedFraction(frame: Frame, totalInset: number): number {
  const match = /inset\(([\d.]+)px/.exec(String(frame.clipPath ?? ""));
  return match ? Number(match[1]) / totalInset : 0;
}

function fractionAt(frames: Frame[], offset: number, totalInset: number): number {
  const sorted = [...frames].sort((a, b) => Number(a.offset) - Number(b.offset));
  let lower = sorted[0];
  let upper = sorted[sorted.length - 1];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    if (offset >= Number(sorted[index].offset) && offset <= Number(sorted[index + 1].offset)) {
      lower = sorted[index];
      upper = sorted[index + 1];
      break;
    }
  }
  const span = Number(upper.offset) - Number(lower.offset);
  const ratio = span === 0 ? 0 : (offset - Number(lower.offset)) / span;
  const from = clippedFraction(lower, totalInset);
  const to = clippedFraction(upper, totalInset);
  return from + ratio * (to - from);
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  animated.length = 0;
  stubPaintSurface();
  vi.useFakeTimers();
  window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "auto");
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  useRoomStore.setState({ surface: null });
});

describe("自动模式只在书房里收起这一列", () => {
  it("任务页开着时不再展开—收起循环：笔记详情页量到的是 30px 的正文位移", () => {
    useRoomStore.setState({ surface: "notebook" });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    advance(5_000);

    const app = document.querySelector<HTMLElement>(".desktop-app");
    expect(app?.dataset.directoryRail).toBe("expanded");
    expect(app?.classList.contains("nav-collapsed")).toBe(false);
  });

  it("回到书房仍然按原来的节奏收起，让场景露出来", () => {
    useRoomStore.setState({ surface: null });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    advance(1_000);
    expect(document.querySelector<HTMLElement>(".desktop-app")?.dataset.directoryRail).toBe("expanded");
    advance(2_000);
    expect(document.querySelector<HTMLElement>(".desktop-app")?.dataset.directoryRail).toBe("collapsed");
  });
});

describe("收起这一列的动画不留空帧", () => {
  it("幽灵被吃掉的比例与小岛长出来的比例同一条曲线", () => {
    useRoomStore.setState({ surface: null });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    advance(3_000);

    const ghost = animated.find((entry) => entry.selector === "ghost");
    const rail = animated.find((entry) => entry.selector === "rail");
    expect(ghost?.frames.length, "收起时应当有幽灵与小岛两段关键帧").toBeGreaterThan(3);
    expect(rail?.frames.length, "收起时应当有幽灵与小岛两段关键帧").toBeGreaterThan(3);

    const totalInset = RAIL_EXPANDED.height - RAIL_COLLAPSED.height;
    let worstGap = 0;
    let worstAt = 0;
    for (const frame of rail!.frames) {
      const offset = Number(frame.offset);
      const revealed = Number(frame.opacity);
      const eaten = fractionAt(ghost!.frames, offset, totalInset);
      if (eaten - revealed > worstGap) {
        worstGap = eaten - revealed;
        worstAt = offset;
      }
    }
    // 旧实现这里最大差 0.65（幽灵已让出 65% 的列、小岛 opacity 还是 0）。
    expect(worstGap, `t=${worstAt} 处左侧空出 ${(worstGap * 100).toFixed(0)}%`).toBeLessThanOrEqual(0.02);
    // 终点必须真的收起：常量曲线若被写成 0 也会满足上一条。
    expect(Number(rail!.frames[rail!.frames.length - 1].opacity)).toBe(1);
  });
});
