// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRecoveryNotice } from "./RunRecoveryNotice";
import { useRoomStore } from "../app/room-store";

/**
 * 首页恢复弹层的数量与出路（审计 F26 余项、与 F24 同族）。
 *
 * F24 修掉了"数得出 10 项、列出来 1 项"里"列不出来"那半；这半条说的是**数字本身**：
 * 徽标以前数的是"这一屏列出了几行"（`items.length`），而服务端同一份投影里另有一个
 * `activeCount`（真实总数，投影一节最多带 20 条）。34 项时徽标会写 21，首页那张卡
 * 写 34——两个数出自同一次读取，却互相不认识。
 *
 * 钉三件事：徽标用总数；被截断时明说"先列出 N 项，共 M 项"；这一屏任何时候都有一条
 * 通往完整清单的出口（不然"其余 14 项"依然无处可去）。
 */

let homeProjection: { projection: unknown; loading: boolean; failure: string | null; reload: () => void } = {
  projection: null, loading: false, failure: null, reload: () => undefined,
};

vi.mock("../app/home-projection", () => ({
  useHomeProjection: () => homeProjection,
}));

const runItem = (index: number) => ({
  runId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  objectiveId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  phase: "paused",
  conceptLabel: `目标 ${index}`,
  updatedAt: "2026-09-23T00:00:00.000Z",
});

function projectionWithActiveRuns(activeCount: number, itemCount: number) {
  return {
    version: 1,
    workspaceEpoch: 3,
    snapshotAt: "2026-09-24T00:00:00.000Z",
    dashboardRevision: 1,
    mode: "personal",
    primaryFocus: { state: "empty" },
    queueSummary: { state: "empty" },
    sanitizedReviewSummary: { state: "empty" },
    activeRunSummary: {
      state: "data",
      data: { activeCount, items: Array.from({ length: itemCount }, (_, i) => runItem(i + 1)) },
    },
    activeGenerationSummary: { state: "empty" },
    recentObjectiveSummary: { state: "empty" },
    recentActivitySummary: { state: "empty" },
    captureCapability: { state: "enabled" },
    sectionStates: {},
  };
}

afterEach(() => {
  cleanup();
  homeProjection = { projection: null, loading: false, failure: null, reload: () => undefined };
  useRoomStore.setState({ activeRunId: null, surface: null, onboardingOpen: false });
});

describe("首页恢复弹层 · 数量与出路（F26 余项）", () => {
  it("徽标写的是服务端那个总数，被截断时明说并给完整清单的入口", () => {
    homeProjection = { projection: projectionWithActiveRuns(34, 20), loading: false, failure: null, reload: () => undefined };
    const invoke = vi.spyOn(useRoomStore.getState(), "invoke");
    render(<RunRecoveryNotice />);
    fireEvent.click(screen.getByText("继续未完成的学习"));

    // 徽标=34（不是 20，也不是"20 条 run + 1 个生成任务"那种自造的加法）。
    const summaryText = screen.getByText("继续未完成的学习").closest("summary")?.textContent ?? "";
    expect(summaryText).toContain("34");
    expect(summaryText).not.toMatch(/\b20\b|\b21\b/);

    expect(screen.getByText(/先列出 20 项，共 34 项/)).toBeTruthy();
    // 标题那句也必须用同一个总数：徽标改了、标题没改，就又是两个数。
    expect(screen.getByText("有 34 条进行中的学习")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "看全部" }));
    expect(invoke).toHaveBeenCalledWith("open-resumable");
  });

  it("没被截断时不写「先列出」，但完整清单的入口照旧在", () => {
    homeProjection = { projection: projectionWithActiveRuns(2, 2), loading: false, failure: null, reload: () => undefined };
    render(<RunRecoveryNotice />);
    fireEvent.click(screen.getByText("继续未完成的学习"));

    expect(screen.queryByText(/先列出/)).toBeNull();
    const summaryText = screen.getByText("继续未完成的学习").closest("summary")?.textContent ?? "";
    expect(summaryText).toContain("2");
    expect(screen.getByRole("button", { name: "看全部" })).toBeTruthy();
  });
});
