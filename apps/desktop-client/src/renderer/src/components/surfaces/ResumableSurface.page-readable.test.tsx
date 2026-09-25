// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumableSurface } from "./ResumableSurface";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「未完成的学习」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 这一页存在的理由（审计 F24）就是"数得出 10 却找不到那 10 条"——如果她读到的
 * 清单与屏幕上不是一份，那只是把同一个缺陷搬进了她的嘴里。所以每条断言都
 * **同时读 DOM 与 store**：只断言 store 会放过"登记了一份屏幕上没有的东西"，
 * 而这种错按 `usePageReadableView` 的性质根本不会红。
 */

const RUN_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function item(index: number, phase: string, conceptLabel: string | null) {
  return {
    runId: RUN_IDS[index],
    objectiveId: index === 0 ? null : RUN_IDS[index],
    phase,
    conceptLabel,
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

function stubGateway(activeRunSummary: Record<string, unknown> | null) {
  const gateway = {
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: activeRunSummary === null ? {} : { activeRunSummary },
      })),
    },
  };
  Object.defineProperty(window, "ailearn", { value: gateway, configurable: true });
  return gateway;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ pageReadableView: null });
});

describe("未完成的学习：她读到的就是屏幕上那一份", () => {
  it("标题、状态行、逐条清单、截断说明四样都与 DOM 逐字相同", async () => {
    stubGateway({
      state: "data",
      data: { activeCount: 25, items: [item(0, "paused", "轨道周期"), item(1, "active", "音色的跨语言迁移"), item(2, "assessing", null)] },
    });
    render(<ResumableSurface />);

    const headline = screen.getByRole("heading", { level: 2 });
    expect(headline.textContent).toBe("未完成的学习");
    const rows = await screen.findAllByText(/^未命名目标$|^轨道周期$|^音色的跨语言迁移$/);
    expect(rows).toHaveLength(3);
    await waitFor(() => expect(publishedView()).not.toBeNull());

    const view = publishedView()!;
    expect(view.pageId).toBe("resumable");
    expect(view.title).toBe(headline.textContent);
    expect(view.statusLine).toBe(screen.getByText(/^共 \d+ 项；挑一条接着走/).textContent);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(view.items?.map((entry) => entry.label)).toEqual(["轨道周期", "音色的跨语言迁移", "未命名目标"]);
    // 阶段字取自屏上那一行（`learningPhaseLabel`），不是数据库里的枚举原值。
    // 屏上那一行是「阶段 · 最近动过 X 前」三个串拼起来的，所以取" · "之前的那一段。
    const stageLines = screen.getAllByText(/· 最近动过/);
    expect(stageLines[0].textContent?.split(" · ")[0]).toBe("已暂停");
    expect(view.items?.[0]?.state).toBe(stageLines[0].textContent?.split(" · ")[0]);
    expect(view.metrics?.find((metric) => metric.label === "共")?.value).toBe("25 项");
    expect(view.metrics?.find((metric) => metric.label === "先列出")?.value).toBe("3 项");
    // 数得出更多时，她那侧也要读到"其余还没列出来"这一句，不能拿 3 条冒充 25 条。
    expect(view.notice).toBe(screen.getByText(/^这里先列出 \d+ 项，共 \d+ 项/).textContent);
  });

  it("投影里这一节读失败了：登记的是读不到，不是一个猜出来的数", async () => {
    stubGateway({ state: "error" });
    render(<ResumableSurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    expect(publishedView()!.statusLine).toBe("这批状态暂时读不到。");
    expect(publishedView()!.items).toBeUndefined();
    expect(publishedView()!.metrics?.find((metric) => metric.label === "共")?.value).toBe("0 项");
  });

  it("确实一条都没有时说的是空态，不是省略", async () => {
    stubGateway({ state: "empty" });
    render(<ResumableSurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    expect(publishedView()!.statusLine).toBe(screen.getByText("现在没有摊着的事。").textContent);
    expect(publishedView()!.items).toBeUndefined();
  });

  it("第一次读取还没回来之前不登记（她不能读到上一屏的残留）", async () => {
    let release: (value: unknown) => void = () => undefined;
    Object.defineProperty(window, "ailearn", {
      configurable: true,
      value: {
        auth: {
          getState: vi.fn(async () => ({
            ok: true as const,
            workspaceEpoch: 1,
            data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
          })),
        },
        room: { getProjection: vi.fn(() => new Promise((resolve) => { release = resolve; })) },
      },
    });
    const { unmount } = render(<ResumableSurface />);
    await waitFor(() => expect(screen.getByText("正在读取未完成的学习")).not.toBeNull());
    expect(publishedView()).toBeNull();
    // 读到之后才登记；卸载时槽位让开，不留这一页的残影给下一页。
    release({
      ok: true,
      workspaceEpoch: 1,
      data: { activeRunSummary: { state: "data", data: { activeCount: 1, items: [item(0, "paused", "轨道周期")] } } },
    });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});
