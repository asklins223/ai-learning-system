// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLibrarySurface } from "./source-library-surface";

/**
 * 来源目录的行（2026-09-20 实走复盘 #18）：「这份材料已经出过笔记」是它的进展，
 * 以前只是小字里第四段话（`关联 N 篇笔记 / 尚未建立笔记`），扫一眼看不出来。
 */

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const SOURCE = (id: string, title: string, noteCount: number) => ({
  id,
  title,
  type: "url",
  status: "ready",
  origin: "https://example.com/" + id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  noteCount,
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
          : { items: [SOURCE("s-1", "记忆研究综述", 2), SOURCE("s-2", "间隔重复论文", 0)], total: 2, nextCursor: null },
      )),
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
});
