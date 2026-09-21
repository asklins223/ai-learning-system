// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 协同帧与"回读到的那一份"谁该上屏（批次 4.4 的实窗结论），两条方向相反的规则。
 *
 * **阅读态画那一帧。** 为什么在真窗口里量到才信：作者那台机器的自动保存要过本机
 * debounce 才发出去（实测量到敲完 3.5 秒 API 才看得见那段），而协同帧是改动一进
 * 活文档就发的。于是"帧叫醒一次 HTTP 回读"这条链读到的是**还没刷新**的那份——
 * 读的人看到的是上一次的正文，而且没有第二帧来纠它。jsdom 里把这条喂成"服务端
 * 仍返回旧正文"，界面就得画帧里那份。
 *
 * **编辑态：没动过就跟上那一份，动过就守住自己的字。** 两边都在这文件里钉着——
 * 前者关掉的是实测到的丢字（旧页一次提交把对方那句按块删掉），后者关掉的是
 * 反向的覆盖（别人的改动盖掉我没保存的句子）。逐字符合并仍要 `y-prosemirror`。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const STALE = "服务端这一份还是旧的";
const REMOTE = "别人刚交上来的那一份";
const FRESH = "帧里这一份是新的";
const MINE = "我正在写的那一句";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[] = [];

function notePayload(title: string, content: string) {
  return {
    ok: true as const,
    workspaceEpoch: 1,
    data: {
      noteId: NOTE_ID,
      title,
      sourceId: null,
      currentVersionId: VERSION_ID,
      shareScope: "shared",
      permissions: { canEdit: true, canSave: true, canShare: true },
      currentVersion: {
        versionNo: 1,
        updatedAt: new Date().toISOString(),
        contentHash: `hash-${content}`,
        blocks: [{ ordinal: 0, type: "paragraph", content }],
      },
    },
  };
}

/**
 * `reads` 不给 = 每次都返回同一份旧正文（模拟那次抢跑的回读）。
 * 给了序列 = 按次序一份一份返回，用来让"第二次回读确实带回新东西"可断言。
 */
function stub(reads: Array<[string, string]> = []) {
  listeners = [];
  let call = 0;
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
      get: vi.fn(async () => {
        const [title, content] = reads.length ? reads[Math.min(call, reads.length - 1)] : [STALE, STALE];
        call += 1;
        return notePayload(title, content);
      }),
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
  return { reads: () => call };
}

/** 让挂起的一串 Promise（含自动保存的 debounce）都跑掉。 */
async function settle(loops = 14) {
  for (let i = 0; i < loops; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
}

async function open(mode: "read" | "edit") {
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  await settle();
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

const titleValue = () => (document.getElementById("notebook-surface-title") as HTMLInputElement | null)?.value ?? null;

function memberRoom() {
  useRoomStore.setState({
    spaceIdentity: { name: "验收空间", role: "member", isPersonal: false },
    accountIdentity: { email: "m@example.test", displayName: "小琳" },
  });
}

function ownerRoom() {
  useRoomStore.setState({
    spaceIdentity: { name: "验收空间", role: "owner", isPersonal: false },
    accountIdentity: { email: "o@example.test", displayName: "Asklins" },
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null, spaceIdentity: null, accountIdentity: null });
});

describe("阅读态用那一帧的正文", () => {
  it("回读还没刷新时，读的人看到的就是帧里那份", async () => {
    stub();
    memberRoom();
    await open("read");
    expect(document.body.textContent).toContain(STALE);
    deliverFrame();
    expect(document.body.textContent).toContain(FRESH);
    expect(document.querySelector(".title")?.textContent).toBe(FRESH);
  });

  it("没有帧可画时仍老实回显读到的那一份（不是占位话，也不是上一篇）", async () => {
    stub();
    memberRoom();
    await open("read");
    expect(document.querySelector(".title")?.textContent).toBe(STALE);
    // 断正文那一段的字，不数 `p` 的个数：空正文也有一句"这一版正文还没有段落"占位，
    // 只数个数的那条写法对"读到的那份根本没画出来"是哑的。
    expect(document.querySelector(".reading-body > p")?.textContent).toBe(STALE);
  });
});

describe("编辑态：没动过就跟上新的一份，动过就守住自己的字", () => {
  /**
   * 判"作者手上有没有待提交的改动"只能跟**本机上一次交出去/接进来的那一份**比。
   * 此前它比的是"草稿 vs 那次 HTTP 读回来的正文"，而那份会过期（作者的自动保存要过
   * 本机 debounce 才进 API，实测量到 3.5 秒）——于是第二个人的页面既看不到对方那段、
   * 标签还写着「已同步」，他随手再敲一个字就把对方那句按块删了
   * （2026-09-22 两个真窗口实测：服务端里对方那段不见了）。
   *
   * 这两条一起钉住分界：没动 → 跟上（那次覆盖就没有发生的条件）；动了 → 我的字优先。
   * "动了"这一侧仍不接远端改动，逐字符合并要把编辑器绑成 CRDT（`y-prosemirror`）
   * 才做得到，届时这条要连着改。
   */
  it("我什么都没动时，远端那一帧直接进我这一屏", async () => {
    const { reads } = stub([[STALE, STALE], [REMOTE, REMOTE]]);
    ownerRoom();
    await open("edit");
    const readsBefore = reads();

    deliverFrame();
    await settle();
    expect(reads()).toBeGreaterThan(readsBefore);
    // 上屏的是帧里那份——既不是回读到的旧的，也不是编辑器里原来那段。
    expect(titleValue()).toBe(FRESH);
  });

  it("我改了标题时，远端那一帧与那次回读都不许动我写的字", async () => {
    const { reads } = stub([[STALE, STALE], [REMOTE, REMOTE]]);
    ownerRoom();
    await open("edit");
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    fireEvent.input(title, { target: { value: MINE } });
    await settle(2);
    const readsBefore = reads();

    deliverFrame();
    await settle();
    expect(reads()).toBeGreaterThan(readsBefore);
    expect(titleValue()).toBe(MINE);
  });
});
