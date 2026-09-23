// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLibrarySurface } from "./source-library-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 同网址重复采集（审计 F33）。
 *
 * 现场是演示库里两条 bilibili 链接（带与不带 `spm_id_from`）各自长成一篇笔记和
 * 一叠卡——用户没有任何机会知道它们其实是同一篇材料。
 *
 * 这一组钉住界面的那半：命中重复时**默认不新建**、把既有那份端出来；
 * 只有用户明确说"仍然再采一次"，请求才带 `force` 出去。
 */

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const EXISTING = {
  source: {
    id: "s-old",
    workspaceId: "w-1",
    type: "url",
    title: "IndexTTS 2.5 让声音跨越语言",
    origin: "https://www.bilibili.com/opus/123",
    status: "ready",
    createdBy: "u-1",
    createdAt: "2026-09-17T11:00:00.000Z",
    updatedAt: "2026-09-17T11:00:00.000Z",
    noteCount: 1,
    metadata: {},
  },
  segments: [],
};

function installApi(create: ReturnType<typeof vi.fn>) {
  const gateway = {
    contract: { enabledRoutes: ["source.library"] },
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
    capabilities: {
      get: vi.fn(async () => ok({ actionCapabilities: { "source.create": "allowed" }, featureAvailability: {} })),
    },
    source: {
      list: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null })),
      create,
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

async function openCapture() {
  render(<SourceLibrarySurface />);
  fireEvent.click(await screen.findByRole("button", { name: "采集新来源" }));
  fireEvent.click(await screen.findByRole("radio", { name: "链接" }));
  const urlInput = document.querySelector<HTMLInputElement>(".capture-form input[type='url'], .capture-form input#capture-url")
    ?? document.querySelector<HTMLInputElement>(".capture-form input");
  expect(urlInput).not.toBeNull();
  fireEvent.change(urlInput!, { target: { value: "https://www.bilibili.com/opus/123?spm_id_from=333" } });
  return urlInput!;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeSourceId: null });
});

describe("采集栏：同网址第二次采集（审计 F33）", () => {
  it("命中重复：默认不新建，把既有那份端出来，提示里说清是哪一天采过", async () => {
    const create = vi.fn(async () => ok({
      ...EXISTING,
      duplicateOf: { sourceId: "s-old", title: EXISTING.source.title, createdAt: EXISTING.source.createdAt, status: "ready" },
    }));
    installApi(create);
    await openCapture();

    fireEvent.click(screen.getByRole("button", { name: "开始解析" }));

    const prompt = await screen.findByText(/就采过了/);
    expect(prompt.textContent).toContain(EXISTING.source.title);
    // 默认那条路是"打开已有来源"，"再采一次"是次级动作。
    expect(screen.getByRole("button", { name: "打开已有来源" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "仍然再采一次" })).toBeTruthy();
    // 第一次请求不带 force（服务端据此查重）。
    expect(create.mock.calls[0][0].request.force).toBeUndefined();
  });

  it("点了「仍然再采一次」：请求带 force 重发，才真的建新的一份", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(ok({
        ...EXISTING,
        duplicateOf: { sourceId: "s-old", title: EXISTING.source.title, createdAt: EXISTING.source.createdAt, status: "ready" },
      }))
      .mockResolvedValueOnce(ok({ ...EXISTING, source: { ...EXISTING.source, id: "s-new" }, duplicateOf: null }));
    installApi(create);
    await openCapture();

    fireEvent.click(screen.getByRole("button", { name: "开始解析" }));
    fireEvent.click(await screen.findByRole("button", { name: "仍然再采一次" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].request.force).toBe(true);
    // 第二次之后提示不再挂着（这次是真新建）。
    await waitFor(() => expect(screen.queryByText(/就采过了/)).toBeNull());
  });
});
