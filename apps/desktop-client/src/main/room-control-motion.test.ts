/**
 * 顶栏灵动岛的折叠时序：样式表与 `HudRoomControl.tsx` 是同一个事实的两半。
 *
 * B0 之后，折叠不是一帧消失而是「图标 110ms 淡出 → 槽位宽度再收 320ms（带 80ms
 * 起步延迟）」，合计 400ms。`COLLAPSE_BEFORE_NAVIGATE_MS` 必须盖得住它，否则点
 * 「设置中心」会在岛还没关完时就跳转，面板直接盖在折叠过程上——这正是 2026-09-18
 * 那次返工要解决的问题，只是预算变了。
 *
 * 这条为什么放在 main 侧：读源码要用 `node:fs`，而 `tsconfig.web.json` 的编译图里
 * 没有 Node 类型（先例见 `renderer-copy-guard.test.ts`）。
 *
 * 三条守卫都必须是「拿不到就喊」：静默跳过等于一条永远绿的空断言。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = "src/renderer/src/components/hud/hud-surface.css";
const TSX = "src/renderer/src/components/hud/HudRoomControl.tsx";

function read(relative: string): string {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  expect(path, `读不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
}

/** 只取 B0 那一段：文件有 6000 多行，别在整张表里瞎找。 */
function b0Section(css: string): string {
  const start = css.indexOf("B0 右上灵动岛");
  expect(start, "hud-surface.css 里找不到 B0 段（marker 被改名字了？）").toBeGreaterThan(-1);
  return css.slice(start);
}

/** 折叠态那条基础规则（不带 [data-expanded] 的那一条）——时序取的是目标规则。 */
function collapseRule(section: string): string {
  const selector = '.hud-surface .room-control > button:not(.room-control-trigger):not(.room-control-space) {';
  const at = section.indexOf(selector);
  expect(at, "找不到折叠态的槽位规则").toBeGreaterThan(-1);
  return section.slice(at, section.indexOf("}", at));
}

describe("顶栏灵动岛的折叠时序", () => {
  it("等待窗口盖得住 CSS 里的折叠预算", () => {
    const section = b0Section(read(CSS));
    const motion = Number(section.match(/--island-motion:\s*(\d+)ms/)?.[1] ?? NaN);
    const travel = collapseRule(section).match(/width\s+var\(--island-motion\)\s+\S+\s+(\d+)ms/);
    expect(motion, "解析不出 --island-motion").not.toBeNaN();
    // 缓动换成关键字、或延迟被删掉，都会让这条变 null —— 那就必须红，不能绿着放过。
    expect(travel, "折叠态槽位规则里找不到 `width var(--island-motion) <ease> <delay>`").not.toBeNull();
    const budget = motion + Number(travel![1]);

    const constant = Number(read(TSX).match(/COLLAPSE_BEFORE_NAVIGATE_MS\s*=\s*(\d+)/)?.[1] ?? NaN);
    expect(constant, "解析不出 COLLAPSE_BEFORE_NAVIGATE_MS").not.toBeNaN();
    expect(
      constant,
      `折叠动画要 ${budget}ms（收宽 ${motion} + 起步延迟 ${travel![1]}），等待窗口只有 ${constant}ms`,
    ).toBeGreaterThanOrEqual(budget + 16);
  });

  it("reduced-motion 那段排在宽度规则之后", () => {
    const section = b0Section(read(CSS));
    const reduce = section.indexOf("@media (prefers-reduced-motion");
    expect(reduce, "B0 段里没有 reduced-motion 覆盖").toBeGreaterThan(-1);
    // 同特异度下靠源码顺序决胜：挪到前面，reduce 下岛就照样滑，而且没有任何运行时报错。
    expect(reduce, "reduced-motion 块被挪到了折叠规则之前，reduce 下宽度动画会赢回来")
      .toBeGreaterThan(section.indexOf(".hud-surface .room-control > button:not("));
  });

  it("胶囊自己不带 transform 过渡——位移只能由布局产生", () => {
    const section = b0Section(read(CSS));
    const at = section.lastIndexOf(".hud-surface .room-control > button.room-control-space {");
    expect(at, "找不到胶囊规则").toBeGreaterThan(-1);
    const rule = section.slice(at, section.indexOf("}", at));
    const transition = rule.match(/transition:\s*([^;]+);/)?.[1] ?? "";
    expect(transition, "胶囊带了 transform 过渡，会和岛的位移抢时间轴").not.toContain("transform");
  });
});
