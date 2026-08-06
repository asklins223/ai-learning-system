/**
 * 卡组轮播纯函数单测（docs/plans/card-set-carousel-ui.md §3.1/§3.2/§5.1）。
 * 硬门禁 G-11：swipe 阈值单一来源（lib/card-set-carousel.ts 的 shouldCommit）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampFocus,
  commitDirection,
  deckLayout,
  DECK_COMMIT,
  DECK_MAX_WING,
  rubberband,
  shouldCommit,
  shouldRenderIndicators,
} from "../card-set-carousel.ts";

describe("deckLayout（§3.1 位姿表）", () => {
  it("focus（d=0）唯一可展开、可 tab、z=40", () => {
    const pose = deckLayout(3, 3, 10);
    assert.equal(pose.translateX, 0);
    assert.equal(pose.rotateZ, 0);
    assert.equal(pose.translateY, 0);
    assert.equal(pose.scale, 1);
    assert.equal(pose.opacity, 1);
    assert.equal(pose.zIndex, 40);
    assert.equal(pose.visible, true);
    assert.equal(pose.interactive, true);
    assert.equal(pose.tabIndex, 0);
    assert.equal(pose.ariaHidden, false);
  });

  it("desktop ±1 侧翼符合位姿表", () => {
    const left = deckLayout(2, 3, 10);
    assert.deepEqual(
      [left.translateX, left.rotateZ, left.translateY, left.scale, left.opacity, left.zIndex],
      [-250, -5.5, 16, 0.94, 1, 30],
    );
    assert.equal(left.visible, true);
    assert.equal(left.interactive, true);
    assert.equal(left.tabIndex, -1);
    // 侧翼是普通按钮：ariaHidden 保留 false（淡化由 CSS 纸张表达，非整体透明）
    assert.equal(left.ariaHidden, false);

    const right = deckLayout(4, 3, 10);
    assert.deepEqual(
      [right.translateX, right.rotateZ, right.translateY, right.scale, right.opacity, right.zIndex],
      [250, 5.5, 16, 0.94, 1, 30],
    );
  });

  it("desktop ±2 侧翼符合位姿表", () => {
    const left = deckLayout(1, 3, 10);
    assert.deepEqual(
      [left.translateX, left.rotateZ, left.translateY, left.scale, left.opacity, left.zIndex],
      [-430, -11, 42, 0.88, 1, 20],
    );
  });

  it("|d| ≥ 3 踢出合成层（aria-hidden + visibility hidden）", () => {
    for (const index of [0, 6, 9]) {
      const pose = deckLayout(index, 3, 10);
      assert.equal(pose.visible, false, `index ${index}`);
      assert.equal(pose.interactive, false);
      assert.equal(pose.tabIndex, -1);
      assert.equal(pose.ariaHidden, true);
      assert.equal(pose.opacity, 0);
    }
  });

  it("mobile 只保留 ±1 侧翼", () => {
    const wing = deckLayout(4, 3, 10, { variant: "mobile" });
    assert.deepEqual(
      [wing.translateX, wing.rotateZ, wing.translateY, wing.scale, wing.opacity],
      [150, 4, 14, 0.92, 1],
    );
    const far = deckLayout(5, 3, 10, { variant: "mobile" });
    assert.equal(far.visible, false);
  });

  it("越界索引返回不可交互空位姿", () => {
    const pose = deckLayout(10, 3, 10);
    assert.equal(pose.visible, false);
    assert.equal(pose.interactive, false);
  });

  it("DECK_MAX_WING 与设计档位一致", () => {
    assert.equal(DECK_MAX_WING.desktop, 2);
    assert.equal(DECK_MAX_WING.mobile, 1);
  });
});

describe("clampFocus", () => {
  it("夹在 [0, count-1] 内", () => {
    assert.equal(clampFocus(-1, 5), 0);
    assert.equal(clampFocus(0, 5), 0);
    assert.equal(clampFocus(2, 5), 2);
    assert.equal(clampFocus(4, 5), 4);
    assert.equal(clampFocus(9, 5), 4);
    assert.equal(clampFocus(2, 0), 0);
  });

  it("四舍五入非整数索引", () => {
    assert.equal(clampFocus(2.4, 5), 2);
    assert.equal(clampFocus(2.6, 5), 3);
  });
});

describe("shouldCommit / commitDirection（§3.2 阈值，G-11 单一来源）", () => {
  const slot = 800;

  it("位移超过 min(84, slot/4) 即提交", () => {
    assert.equal(shouldCommit(84, 0, slot), true);
    assert.equal(shouldCommit(83.9, 0, slot), false);
    assert.equal(shouldCommit(-84, 0, slot), true);
  });

  it("窄槽位下阈值取 slot/4", () => {
    const narrow = 280; // slot/4 = 70 < 84
    assert.equal(shouldCommit(70, 0, narrow), true);
    assert.equal(shouldCommit(69, 0, narrow), false);
  });

  it("位移不足时高速甩动仍提交", () => {
    assert.equal(shouldCommit(20, 0.6, slot), true);
    assert.equal(shouldCommit(20, 0.5, slot), false);
  });

  it("commitDirection 返回 -1/0/1 且方向取 dx（dx 为 0 取速度）", () => {
    // 拖左（dx<0）→ 下一副（+1）；拖右（dx>0）→ 上一副（-1），与牌组运动同向
    assert.equal(commitDirection(-100, 0, slot), 1);
    assert.equal(commitDirection(100, 0, slot), -1);
    assert.equal(commitDirection(10, 0, slot), 0);
    assert.equal(commitDirection(0, 0.6, slot), -1);
    assert.equal(commitDirection(0, -0.6, slot), 1);
  });

  it("端点外拖：方向 + clampFocus 夹回原点，不提交切换", () => {
    // focus=0 向右拖（本应回上一副，夹回 0）；focus=count-1 向左拖（夹回 count-1）
    const dirAtStart = commitDirection(100, 0, slot); // 拖右 → -1
    assert.equal(clampFocus(0 + dirAtStart, 5), 0);
    const dirAtEnd = commitDirection(-100, 0, slot); // 拖左 → +1
    assert.equal(clampFocus(4 + dirAtEnd, 5), 4);
  });

  it("阈值常量可被测试引用（避免组件重复硬编码）", () => {
    assert.equal(DECK_COMMIT.maxDragPx, 84);
    assert.equal(DECK_COMMIT.minVelocityPxPerMs, 0.5);
  });
});

describe("rubberband（§5.1 越界阻尼）", () => {
  it("越拖越软，位移收敛", () => {
    assert.equal(rubberband(0), 0);
    const small = rubberband(60);
    const large = rubberband(600);
    assert.ok(small < 60 && small > 0, `small=${small}`);
    assert.ok(large < 600 && large > 60, `large=${large}`);
  });

  it("符号保留", () => {
    assert.ok(rubberband(-100) < 0);
    assert.equal(rubberband(-100), -rubberband(100));
  });
});

describe("shouldRenderIndicators（§3.2 窗口退化）", () => {
  it("少量卡组渲染圆点", () => {
    assert.equal(shouldRenderIndicators(1), true);
    assert.equal(shouldRenderIndicators(12), true);
  });

  it("超过窗口退化（返回 false）", () => {
    assert.equal(shouldRenderIndicators(13), false);
  });

  it("空库不渲染", () => {
    assert.equal(shouldRenderIndicators(0), false);
  });
});
