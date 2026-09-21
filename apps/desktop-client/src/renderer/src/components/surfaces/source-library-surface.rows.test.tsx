// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLibrarySurface } from "./source-library-surface";

/**
 * 来源目录的行（2026-09-20 实走复盘 #18）：「这份材料已经出过笔记」是它的进展，
 * 以前只是小字里第四段话（`关联 N 篇笔记 / 尚未建立笔记`），扫一眼看不出来。
 */

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const SOURCE = (
  id: string,
  title: string,
  noteCount: number,
  cardProgress: { pendingReviewRuns: number; activeObjectives: number } = { pendingReviewRuns: 0, activeObjectives: 0 },
) => ({
  id,
  title,
  type: "url",
  status: "ready",
  origin: "https://example.com/" + id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  noteCount,
  cardProgress,
});

function installApi() {
  const gateway = {
    contract: { enabledRoutes: ["source.library"] },
    auth: {
      getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })),
    },
    capabilities: {
      get: vi.fn(async () => ok({
        actionCapabilities: { "source.create": "allowed" },
        featureAvailability: {},
      })),
    },
    source: {
      list: vi.fn(async (input: { status?: string }) => ok(
        input.status === "archived"
          ? { items: [], total: 0, nextCursor: null }
          : { items: [SOURCE("s-1", "记忆研究综述", 2), SOURCE("s-2", "间隔重复论文", 0)], total: 2, nextCursor: null },      )),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
});

describe("来源目录的行", () => {
  it("生成了笔记的材料在状态列上就说得出来", async () => {
    installApi();
    render(<SourceLibrarySurface />);

    await waitFor(() => expect(document.querySelectorAll(".source-sheet").length).toBe(2));
    const [withNotes, withoutNotes] = [...document.querySelectorAll(".source-sheet")];
    expect(withNotes.querySelector(".source-state")?.textContent).toContain("已生成 2 篇笔记");
    expect(withoutNotes.querySelector(".source-state")?.textContent).toContain("还没生成笔记");
    // 同一件事不在行里说两遍。
    expect(withNotes.querySelector(".source-copy")?.textContent).not.toContain("笔记");
  });

  /**
   * 复盘 #18 后半：笔记出了卡没有，也要在行上说得出来。三档互斥，
   * 且没出笔记的材料不该出现卡片那一行（否则是替它编了一个进展）。
   */
  it("笔记出没出卡在状态列上是三档互斥的，没笔记的不显示这一行", async () => {
    installApi();
    const listed = { items: [
      SOURCE("s-1", "已有卡", 1, { pendingReviewRuns: 0, activeObjectives: 3 }),
      SOURCE("s-2", "等审核", 1, { pendingReviewRuns: 2, activeObjectives: 0 }),
      SOURCE("s-3", "出了笔记没出卡", 1, { pendingReviewRuns: 0, activeObjectives: 0 }),
      SOURCE("s-4", "还没笔记", 0),
    ], total: 4, nextCursor: null };
    const gateway = installApi();
    gateway.source.list = vi.fn(async () => ok(listed)) as unknown as typeof gateway.source.list;
    render(<SourceLibrarySurface />);

    await waitFor(() => expect(document.querySelectorAll(".source-sheet").length).toBe(4));
    const states = [...document.querySelectorAll(".source-sheet")].map((el) => el.querySelector(".source-state")?.textContent ?? "");
    expect(states[0]).toContain("已出 3 张学习卡");
    expect(states[1]).toContain("2 批学习卡待审核");
    expect(states[2]).toContain("还没出学习卡");
    expect(states[3]).toContain("还没生成笔记");
    expect(states[3]).not.toContain("学习卡");
  });
});
