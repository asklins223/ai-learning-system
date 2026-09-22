// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 在场那一排要真的长在笔记页上（批次 4.4）。
 *
 * 组件测试只证明「给它名单它会画头像」，钩子测试只证明「帧来了它会变成名单」——
 * 中间那一环（笔记页把钩子的名单和自己的名字交给组件）两边都管不到。这一条钉的是它：
 * 谁把 `presencePeers` 或 `presenceName` 的接线改了，这里立刻红。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[] = [];
let subscribe: ReturnType<typeof vi.fn>;
let presence: ReturnType<typeof vi.fn>;

function stub() {
  listeners = [];
  subscribe = vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } }));
  presence = vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: true } }));
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
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "这一篇已经共享给空间",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: true },
          currentVersion: { versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "hash-0", blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }] },
        },
      })),
      doc: {
        state: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { blocks: [], title: "", titleSource: "auto", revision: 0, backfilled: false, shareScope: "shared" } })),
        syncBlocks: vi.fn(async () => { throw new Error("gateway unavailable"); }),
        presence,
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
      subscribe,
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

/** 一帧"还有别人开着这一篇"——从主进程那条订阅通道进来，和真实路径同一个形状。 */
const deliverPresence = (states: unknown[]) => act(() => {
  for (const listener of listeners) {
    listener({ data: { kind: "note_doc_event", noteId: NOTE_ID, event: { type: "presence", states } } });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null, spaceIdentity: null, accountIdentity: null });
});

describe("笔记页上的在场名单", () => {
  it("阅读态：对端一报状态，笔记页上就出现他的头像和人数", async () => {
    stub();
    useRoomStore.setState({
      spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false },
      accountIdentity: { email: "owner@ailearn.local", displayName: "Asklins" },
    });
    await open("read");
    expect(document.body.textContent ?? "").not.toContain("人在看");
    await deliverPresence([{ clientId: 7, state: { name: "小琳" } }]);
    expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(2);
    expect(document.body.textContent ?? "").toContain("2 人在看");
  });

  it("编辑态也在同一行里（写的人最该知道谁还开着这一篇）", async () => {
    stub();
    useRoomStore.setState({
      spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false },
      accountIdentity: { email: "owner@ailearn.local", displayName: "Asklins" },
    });
    await open("edit");
    await deliverPresence([{ clientId: 7, state: { name: "小琳" } }]);
    expect(document.body.textContent ?? "").toContain("2 人在看");
  });

  it("没有显示名时报邮箱 @ 前那一段：实窗量到满屏的「?」就是这个缺省造成的", async () => {
    stub();
    useRoomStore.setState({
      spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false },
      // 演示账号 owner@ailearn.local 就没有显示名——量那次对端整排都是「?」。
      accountIdentity: { email: "owner@ailearn.local", displayName: null },
    });
    await open("read");
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({
      // 报名字与报块是同一条 awareness（本机替换整份）：光标还没进正文就是 null。
      state: JSON.stringify({ name: "owner", block: null }),
    }));
    await deliverPresence([{ clientId: 7, state: { name: "小琳" } }]);
    const own = document.querySelectorAll(".notebook-presence__peer")[0];
    expect(own.getAttribute("aria-label")).toBe("owner（你）");
    expect(own.textContent).toBe("O");
  });

  it("个人空间里既不订阅也不出现这一排（那里没有长连接）", async () => {
    stub();
    useRoomStore.setState({
      spaceIdentity: { name: "我的空间", role: "owner", isPersonal: true },
      accountIdentity: { email: "owner@ailearn.local", displayName: "Asklins" },
    });
    await open("edit");
    expect(subscribe).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").not.toContain("人在看");
  });
});
