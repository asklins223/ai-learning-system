// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 阅读态也得看得见「仅自己可见 / 已共享给空间」（批次 4.5）。
 *
 * 为什么单独钉这一条：那一位原先只挂在编辑态的顶栏里，而**只读成员永远进不了编辑态**
 * ——他恰恰是最需要知道"这篇是只给自己看还是已经拿出去"的人。实窗量过一次：切进协作空间
 * 打开一篇私有笔记，编辑态有徽标和按钮，阅读态什么都没有，界面不报错，只是少一块。
 * 断言因此按两个方向做：阅读态必须出现；个人空间必须不出现（否则这条守卫就成了
 * "永远渲染"，另一头的假开关又回来了）。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

function stub(noteOver: Record<string, unknown> = {}) {
  const setShare = vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, shareScope: "shared", changed: true, updatedAt: new Date().toISOString() } }));
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
          title: "这段只有作者看得见",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "private",
          permissions: { canEdit: true, canSave: true, canShare: true },
          currentVersion: { versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "hash-0", blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }] },
          ...noteOver,
        },
      })),
      setShareScope: setShare,
      doc: {
        state: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { blocks: [], title: "", titleSource: "auto", revision: 0, backfilled: false, shareScope: "private" } })),
        syncBlocks: vi.fn(async () => { throw new Error("gateway unavailable"); }),
        presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: false } })),
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
  } as unknown as typeof window.ailearn;
  return { setShare };
}

async function open(mode: "read" | "edit") {
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

const byText = (text: string) => [...document.querySelectorAll("*")].some((n) => n.children.length === 0 && (n.textContent ?? "").trim() === text);

describe("笔记页的归属状态", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useRoomStore.setState({ activeNoteRef: null, spaceIdentity: null });
  });

  it("阅读态也报这一位的归属，并给得出动作", async () => {
    stub();
    useRoomStore.setState({ spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false } });
    await open("read");
    expect(byText("仅自己可见")).toBe(true);
    expect(byText("共享给空间")).toBe(true);
  });

  it("个人空间里这一位整个不出现（没有人可共享）", async () => {
    stub();
    useRoomStore.setState({ spaceIdentity: { name: "我的空间", role: "owner", isPersonal: true } });
    await open("read");
    expect(byText("仅自己可见")).toBe(false);
    expect(byText("共享给空间")).toBe(false);
  });

  it("编辑态仍然看得见（这一位不该只活在一侧）", async () => {
    stub();
    useRoomStore.setState({ spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false } });
    await open("edit");
    expect(byText("仅自己可见")).toBe(true);
  });

  it("成员（不能写）在阅读态看到的是禁用 + 原因，不是空白", async () => {
    stub({ permissions: { canEdit: false, canSave: false, canShare: false } });
    useRoomStore.setState({ spaceIdentity: { name: "验收空间", role: "member", isPersonal: false } });
    await open("read");
    expect(byText("仅自己可见")).toBe(true);
    const button = [...document.querySelectorAll("button")].find((n) => (n.textContent ?? "").trim() === "共享给空间");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("title")).toContain("只有写下这篇的人");
  });
});
