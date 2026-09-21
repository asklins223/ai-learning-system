// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 阅读态画的是"刚收到的那一帧"，不是"回读到的那一份"（批次 4.4 的实窗结论）。
 *
 * 为什么在真窗口里量到才信：作者那台机器的自动保存要过本机 debounce 才发出去
 * （实测量到敲完 3.5 秒 API 才看得见那段），而协同帧是改动一进活文档就发的。
 * 于是"帧叫醒一次 HTTP 回读"这条链读到的是**还没刷新**的那份——读的人看到的是
 * 上一次的正文，而且没有第二帧来纠它。jsdom 里把这条喂成"服务端仍返回旧正文"，
 * 界面就得画帧里那份。
 *
 * 另一半是**没做**的事，也就没有断言：编辑态不接这一帧（`liveRead` 按 `mode === "read"`
 * 判），那一屏的正文仍由"作者手上有未提交改动就不替换"那条守卫管。逐字符合并要的是
 * 把编辑器绑成 CRDT（`y-prosemirror`），那才是这条链的下一格。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const STALE = "服务端这一份还是旧的";
const FRESH = "帧里这一份是新的";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[] = [];

function stub() {
  listeners = [];
  window.ailearn = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: { getState: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { status: "authenticated", workspace: { workspaceId: "w-1" } } })) },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          primaryFocus: {
            state: "data",
            data: { objective: { content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null }, personal: { lastCanonicalAt: null }, sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } } } },
          },
        },
      })),
    },
    note: {
      // 一直返回旧正文：这就是那次抢跑的回读。
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: STALE,
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: true },
          currentVersion: { versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "hash-0", blocks: [{ ordinal: 0, type: "paragraph", content: STALE }] },
        },
      })),
      doc: {
        state: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { blocks: [], title: "", titleSource: "auto", revision: 0, backfilled: false, shareScope: "shared" } })),
        syncBlocks: vi.fn(async () => { throw new Error("gateway unavailable"); }),
        presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: true } })),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
        },
      })),
    },
    source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      unsubscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { closed: true } })),
      onEvent: (_id: string, listener: Listener) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter((entry) => entry !== listener); };
      },
    },
  } as unknown as typeof window.ailearn;
}

async function open(mode: "read" | "edit") {
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  for (let i = 0; i < 12; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
}

const deliverFrame = () => act(() => {
  for (const listener of listeners) {
    listener({
      data: {
        kind: "note_doc_event",
        noteId: NOTE_ID,
        event: { type: "blocks", blocks: [{ ordinal: 0, type: "paragraph", content: FRESH }], title: FRESH, titleSource: "auto" },
      },
    });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null, spaceIdentity: null, accountIdentity: null });
});

describe("阅读态用那一帧的正文", () => {
  it("回读还没刷新时，读的人看到的就是帧里那份", async () => {
    stub();
    useRoomStore.setState({ spaceIdentity: { name: "验收空间", role: "member", isPersonal: false }, accountIdentity: { email: "m@example.test", displayName: "小琳" } });
    await open("read");
    expect(document.body.textContent).toContain(STALE);
    deliverFrame();
    expect(document.body.textContent).toContain(FRESH);
    expect(document.querySelector(".title")?.textContent).toBe(FRESH);
  });

  it("没有帧可画时仍老实回显读到的那一份（不是空白，也不是上一篇）", async () => {
    stub();
    useRoomStore.setState({ spaceIdentity: { name: "验收空间", role: "member", isPersonal: false }, accountIdentity: { email: "m@example.test", displayName: "小琳" } });
    await open("read");
    expect(document.querySelector(".title")?.textContent).toBe(STALE);
    expect(document.querySelectorAll(".reading-body > p")).toHaveLength(1);
  });
});
