// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROGRESS_SEGMENTS,
  progressBandLabel,
  progressSegmentLabel,
  progressSegmentForOutcome,
  progressSegmentForState,
} from "./objective-progress-band";
import { ObjectiveProgressBand } from "./ObjectiveProgressBand";
import type { ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";

/**
 * 跨屏进度语言（31 号文档 §9.1，批次 B10）。
 *
 * 这一条的唯一合同是：**位置来自服务端已经裁决的那个值**，客户端不推
 * （`23-…:556/:574`，以及 `learning-objective-surface-contracts.ts:232-235`
 * 那句"不得在各客户端按各自优先级重新推导"）。所以本文件先钉"每个状态都必须
 * 有人认领"，再钉"三段带的画法"，最后钉"三屏用的是同一个组件"。
 */

const ALL_STATES: ObjectivePersonalStateV3[] = [
  "unvalidated", "learning", "stable", "fragile", "needs_repair",
  "due_review", "scheduled", "archived", "superseded", "outdated",
];

afterEach(cleanup);

describe("状态到位置的查表", () => {
  it("十个服务端状态每一个都被认领，且只落到 0/1/2 或 null", () => {
    for (const state of ALL_STATES) {
      const segment = progressSegmentForState(state);
      expect(segment, `${state} 没有被查表认领`).not.toBeUndefined();
      expect([0, 1, 2, null], `${state} 落到了三段之外`).toContain(segment);
    }
  });

  it("三段各至少有一个状态落在上面——不能有一段是空的", () => {
    const hit = new Set(ALL_STATES.map(progressSegmentForState).filter((s) => s !== null));
    expect([...hit].sort()).toEqual([0, 1, 2]);
  });

  it("认不出的状态不猜位置（DESIGN.md:178：宁可显示 —）", () => {
    expect(progressSegmentForState("server_invented_something_new")).toBeNull();
    expect(progressSegmentForState("")).toBeNull();
    expect(progressSegmentForOutcome(undefined)).toBeNull();
    expect(progressSegmentForOutcome("some_future_outcome")).toBeNull();
  });

  it("跳过与「暂时不会」不推进位置（与 DESIGN.md:152 不给印章同一口径）", () => {
    expect(progressSegmentForOutcome("skipped")).toBeNull();
    expect(progressSegmentForOutcome("declared_unable")).toBeNull();
    expect(progressSegmentForOutcome("demonstrated")).toBe(2);
    expect(progressSegmentForOutcome("practice_completed")).toBe(1);
  });
});

describe('第 2 段有两种情形（审计 F03）', () => {
  it('没交出去过任何东西时写「作答中」，交过才写「练过了」', () => {
    expect(progressSegmentLabel(1, false)).toBe('作答中');
    expect(progressSegmentLabel(1, true)).toBe('练过了');
    // 只有第 2 段有这一分裂：第 1 段本来就是"还没答过"，第 3 段必然交过。
    expect(progressSegmentLabel(0, false)).toBe('还没答过');
    expect(progressSegmentLabel(2, false)).toBe('说清了');
    expect(progressBandLabel(1, false)).toBe('走到第 2 段，共 3 段：作答中');
  });

  it('带子上当前那一格跟着换词，其余两格不动', () => {
    const { container } = render(<ObjectiveProgressBand segment={1} submitted={false} />);
    const labels = [...container.querySelectorAll('.objective-progress__label')].map((el) => el.textContent);
    expect(labels).toEqual(['还没答过', '作答中', '说清了']);
    expect(container.querySelector('.objective-progress')?.getAttribute('aria-label'))
      .toContain('作答中');
  });
});

describe("三条带的画法", () => {
  it("走到第 N 段就把第 1..N 格画满，current 只有一个", () => {
    const { container } = render(<ObjectiveProgressBand segment={1} />);
    const segs = [...container.querySelectorAll(".objective-progress__seg")];
    expect(segs.map((s) => s.getAttribute("data-lit"))).toEqual(["true", "true", "false"]);
    expect(segs.filter((s) => s.getAttribute("data-current") === "true")).toHaveLength(1);
    expect(segs[1].getAttribute("data-current")).toBe("true");
  });

  it("没有读数时一格都不画，但刻度还在，并且补一个 —", () => {
    const { container } = render(<ObjectiveProgressBand segment={null} />);
    const segs = [...container.querySelectorAll(".objective-progress__seg")];
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.getAttribute("data-lit") === "false")).toBe(true);
    // 拿 — 冒充"一格没有"是不够的：三段刻度必须仍然在场上。
    expect(segs.map((s) => s.textContent)).toEqual([...PROGRESS_SEGMENTS]);
    expect(container.querySelector(".objective-progress__none")?.textContent).toBe("—");
  });

  it("读屏听到的是一句位置，不是三个并排的名词", () => {
    const { container } = render(<ObjectiveProgressBand segment={2} />);
    expect(container.querySelector(".objective-progress")?.getAttribute("aria-label"))
      .toBe(`走到第 3 段，共 3 段：${PROGRESS_SEGMENTS[2]}`);
    expect(progressBandLabel(null)).toBe("这条目标上还没有可报的位置");
  });
});
