// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumableSurface } from "./ResumableSurface";
import { useRoomStore } from "../../app/room-store";

/**
 * 「未完成的学习」这一页（审计 F24）。
 *
 * 病是这么来的：首页书桌报「10 项可恢复」，点进去是「今日学习」——那是**日志**
 * （已经发生的事），里面没有任何一条可恢复的 run。数据库里确实躺着 8 个 active +
 * 2 个 paused，只是没有任何一屏把它们列出来。
 *
 * 这一组钉住：每条要能说出"哪一件事 · 走到哪 · 上次验证在什么时候"；「继续」要真的
 * 把那条 run 挂上并进作答面；读不到时不许把数量猜成 0；投影只带 20 条时如实说。
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OBJECTIVE_ID = "22222222-2222-4222-8222-222222222222";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 3, data });

function projection(activeRunSummary: unknown) {
  return {
    version: 1,
    workspaceEpoch: 3,
    snapshotAt: "2026-09-24T00:00:00.000Z",
    dashboardRevision: 1,
    mode: "personal",
    primaryFocus: { state: "empty" },
    queueSummary: { state: "empty" },
    sanitizedReviewSummary: { state: "empty" },
    activeRunSummary,
    activeGenerationSummary: { state: "empty" },
    recentObjectiveSummary: { state: "empty" },
    recentActivitySummary: { state: "empty" },
    captureCapability: { state: "enabled" },
    sectionStates: {},
  };
}

function installApi(summary: unknown, options: { fail?: boolean } = {}) {
  const getProjection = vi.fn(async () => {
    if (options.fail) throw new Error("投影读不到");
    return ok(projection(summary));
  });
  (window as unknown as { ailearn: unknown }).ailearn = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" }, workspaceEpoch: 3 })) },
    room: { getProjection },
  };
  return { getProjection };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null });
});

describe("未完成的学习（审计 F24）", () => {
  it("每条说清哪一件事、走到哪、最近动过什么时候，并给一个继续", async () => {
    installApi({
      state: "data",
      data: {
        activeCount: 2,
        items: [
          { runId: RUN_ID, objectiveId: OBJECTIVE_ID, phase: "paused", conceptLabel: "Earth's orbital period", updatedAt: "2026-09-21T00:00:00.000Z" },
          { runId: "33333333-3333-4333-8333-333333333333", objectiveId: "44444444-4444-4444-8444-444444444444", phase: "active", conceptLabel: null, updatedAt: "2026-09-23T00:00:00.000Z" },
        ],
      },
    });
    render(<ResumableSurface />);

    await screen.findByText("Earth's orbital period");
    // 阶段用的是作答面同一份文案（同一条 run 在两个面上同一个词）。
    expect(screen.getByText(/已暂停/)).toBeTruthy();
    expect(screen.getAllByText(/最近动过/).length).toBeGreaterThan(0);
    // 没写概念名的目标回退成"未命名目标"，不是空白。
    expect(screen.getByText("未命名目标")).toBeTruthy();
    expect(screen.getByText(/共 2 项/)).toBeTruthy();
  });

  it("「继续」把那条 run 挂上并进作答面", async () => {
    installApi({
      state: "data",
      data: { activeCount: 1, items: [{ runId: RUN_ID, objectiveId: OBJECTIVE_ID, phase: "paused", conceptLabel: "轨道周期", updatedAt: "2026-09-23T00:00:00.000Z" }] },
    });
    render(<ResumableSurface />);

    fireEvent.click(await screen.findByRole("button", { name: /继续「轨道周期」/ }));

    await waitFor(() => expect(useRoomStore.getState().activeRunId).toBe(RUN_ID));
    // objectiveId 交给作答面自己从 run 里解（`invoke` 会清掉外部挂的那个）。
    expect(useRoomStore.getState().surface).toBe("validation");
  });

  it("投影说空的：明说没有摊着的事，不列假行", async () => {
    installApi({ state: "empty" });
    render(<ResumableSurface />);
    await screen.findByText("没有未完成的学习");
    expect(screen.queryByRole("button", { name: /继续「/ })).toBeNull();
  });

  it("投影这一节读失败：报错并可重试，不给一个猜出来的 0", async () => {
    const { getProjection } = installApi({ state: "error", reason: "upstream_unavailable" });
    render(<ResumableSurface />);
    await screen.findByText("未完成的学习暂时读不到");
    const before = getProjection.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(getProjection.mock.calls.length).toBeGreaterThan(before));
  });

  it("只列出 20 条时如实说：这里先列 N 项，共 M 项", async () => {
    installApi({
      state: "data",
      data: {
        activeCount: 22,
        items: Array.from({ length: 20 }, (_, index) => ({
          runId: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
          objectiveId: OBJECTIVE_ID,
          phase: "active",
          conceptLabel: `目标 ${index + 1}`,
          updatedAt: "2026-09-23T00:00:00.000Z",
        })),
      },
    });
    render(<ResumableSurface />);
    await screen.findByText("目标 1");
    expect(screen.getByText(/这里先列出 20 项，共 22 项/)).toBeTruthy();
  });
});
