// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 阅读屏上的版本标签必须跟着**真正渲染的那一份**（审计 F35）。
 *
 * 病是这么来的：正文优先画实时文档（未定版），标签却一直写「版本 v1」与
 * 「不可变版本：v1」——而 v1 是创建时那个空版本。用户以为自己读的是已定版的内容，
 * 实际读的是还没定版的那一份；列表卡与详情面也因此各说一套。
 *
 * 这一组钉两种来源各说各的实话：
 *  - 正文来自实时文档 → "未定版的当前内容"（并写明已存到哪一版），不出现"不可变版本"；
 *  - 正文来自已存版本（没有实时文档）→ "版本 v1" / "不可变版本：v1 · hash"。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function installApi(docUpdate: string, versionBlocks: readonly { ordinal: number; type: string; content: string }[]) {
  const api = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
    room: {
      getProjection: vi.fn(async () => ok({
        primaryFocus: {
          state: "data",
          data: {
            objective: {
              content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null },
              personal: { lastCanonicalAt: null },
              sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
            },
          },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ok({
        noteId: NOTE_ID,
        title: "版本标签",
        sourceId: null,
        currentVersionId: VERSION_ID,
        shareScope: "shared",
        permissions: { canEdit: true, canSave: true, canShare: false },
        currentVersion: { versionId: VERSION_ID, versionNo: 1, updatedAt: "2026-09-20T00:00:00.000Z", contentHash: "hash-abcdef12", blocks: versionBlocks },
      })),
      doc: {
        state: vi.fn(async () => noteDocResult({ update: docUpdate })),
        syncUpdate: vi.fn(),
        presence: vi.fn(async () => ok({ shared: false })),
      },
    },
    capabilities: {
      get: vi.fn(async () => ok({
        actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
        featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
      })),
    },
    source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
    subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

async function settle(loops = 14) {
  for (let i = 0; i < loops; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, surface: null });
});

describe("阅读屏的版本标签（审计 F35）", () => {
  it("正文来自实时文档：写「未定版的当前内容」，不冒充「不可变版本」", async () => {
    // 实时文档有正文；已存的 v1 是空的（正是审计现场的形状）。
    installApi(seedUpdate("新标题", ["刚写进去的那一段"]), [{ ordinal: 1, type: "paragraph", content: "" }]);
    vi.useFakeTimers();
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    render(<NotebookSurface />);
    await settle();

    // 假时钟下 waitFor 会自旋：settle 已经把这一屏推到位，直接断言。
    expect(screen.getAllByText(/未定版的当前内容/).length).toBeGreaterThan(0);
    // 反向：这一屏不许出现"不可变版本"（那一版是空的，那句话是假的）。
    expect(screen.queryByText(/不可变版本/)).toBeNull();
    // 正文确实是实时文档里那一段。
    expect(screen.getByText("刚写进去的那一段")).toBeTruthy();
  });

  it("没有实时文档时读的是已存版本：照旧写「不可变版本：v1」", async () => {
    installApi(seedUpdate("起点", []), [{ ordinal: 1, type: "paragraph", content: "已定版的正文" }]);
    vi.useFakeTimers();
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    render(<NotebookSurface />);
    await settle();

    expect(screen.getAllByText(/不可变版本：v1/).length).toBeGreaterThan(0);
    expect(screen.getByText("已定版的正文")).toBeTruthy();
    expect(screen.queryByText(/未定版的当前内容/)).toBeNull();
  });
});
