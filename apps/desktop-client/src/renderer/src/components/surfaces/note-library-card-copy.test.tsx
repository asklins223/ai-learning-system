// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteLibrarySurface } from "./note-library-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 书皮上那两行读数必须自洽（审计 F35）。
 *
 * 病是这么来的：同一张卡上一边写「版本 v1 · **1 段正文**」（直接数 `blocks.length`），
 * 一边用正文文本判空、写「这一版还没有正文段落，进入编辑继续写」。两句话互否，而
 * 那一版的"1 段"其实只是编辑器光标的落点（空段落）。
 *
 * 这一组钉住：段数与"有没有正文"同一处判定（`noteParagraphCount`），
 * 空版本说"还没有正文段落"，有正文的版本才报段数。
 */

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function installApi(blocks: readonly { ordinal: number; type: string; content: string }[]) {
  const noteRow = {
    id: "note-1",
    title: "轨道周期",
    titleSource: "manual",
    currentVersionId: "note-1-v1",
    firstImageBlock: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
  const api = {
    contract: { enabledRoutes: ["note.library", "note.detail"] },
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
    capabilities: {
      get: vi.fn(async () => ok({
        actionCapabilities: { "note.create": "allowed", "note.delete": "allowed", "note.restore": "allowed", "note.save": "allowed" },
        featureAvailability: {},
      })),
    },
    note: {
      list: vi.fn(async (input: { trashed?: boolean }) => ok(
        input.trashed
          ? { items: [], nextCursor: null, total: 0 }
          : { items: [noteRow], nextCursor: null, total: 1 },
      )),
      get: vi.fn(async () => ok({
        noteId: "note-1",
        title: "轨道周期",
        sourceId: null,
        currentVersionId: "note-1-v1",
        permissions: { canEdit: true, canSave: true },
        currentVersion: { versionId: "note-1-v1", versionNo: 1, updatedAt: "2026-09-20T00:00:00.000Z", contentHash: "h", blocks },
      })),
      doc: { state: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
    },
    source: { get: vi.fn() },
    subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, surface: null });
});

describe("书皮上的版本读数（审计 F35）", () => {
  it("版本里只有空段落：说「还没有正文段落」，不报「N 段正文」", async () => {
    installApi([{ ordinal: 1, type: "paragraph", content: "" }]);
    render(<NoteLibrarySurface />);

    await screen.findByText("轨道周期");
    await waitFor(() => expect(screen.getAllByText(/还没有正文段落/).length).toBeGreaterThan(0));
    // 反向：不能同时出现一个段数（互否的那一句）。
    expect(screen.queryByText(/\d+ 段正文/)).toBeNull();
  });

  it("有正文的版本：报段数，并且不出现「还没有正文段落」", async () => {
    installApi([
      { ordinal: 1, type: "paragraph", content: "地球公转一周约 365 天。" },
      { ordinal: 2, type: "paragraph", content: "" },
    ]);
    render(<NoteLibrarySurface />);

    await screen.findByText("轨道周期");
    // 空段落不算正文：两段里只有一段有字。
    await waitFor(() => expect(screen.getAllByText(/1 段正文/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/还没有正文段落/)).toBeNull();
  });
});
