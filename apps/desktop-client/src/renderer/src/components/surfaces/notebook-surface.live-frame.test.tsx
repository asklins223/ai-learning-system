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
 * **编辑态不接那一帧，也不接回读来的新正文。** 这条在下面按"现状取证"钉住：
 * 守卫的一句话同时挡住两件不同的事（我没保存 / 是服务端前进了），所以编辑态
 * 收到远端改动时停在旧文字上。阅读态没有草稿，才有资格直接画那一帧。
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

describe("编辑态不跟远端改动（这条是现状的取证，不是许可）", () => {
  /**
   * `notebook-surface` 里那条守卫写的是"草稿与服务端那份不一致就不动草稿"，
   * 而这**一句话同时在说两件不同的事**：① 我手上有没交出去的字（该不动），
   * ② 我没动，是服务端自己往前走了（该跟上）。它在两者之间分不开——所以编辑态
   * 收到远端改动时永远停在旧文字上，页面上还会显出一枚「草稿」。
   *
   * 这条用例因此是**特征刻画**：它钉的是"今天就是这样"，两向都钉——
   * 脏与不脏的两种输入得到同一个结果（不换），而回读确实发生了。
   * 把编辑器绑成 CRDT（`y-prosemirror`）时应连同这条一起改掉；那之前别把它
   * 当成"未保存内容受保护"的证据：保护是 ① 那半，② 那半是同一个分支顺带挡住的。
   */
  for (const [label, dirty] of [["我改了标题", true], ["我什么都没动", false]] as const) {
    it(`${label}时，远端改动到了编辑态这一屏仍然不动（回读确实跑了）`, async () => {
      const { reads } = stub([[STALE, STALE], [REMOTE, REMOTE]]);
      ownerRoom();
      await open("edit");
      if (dirty) {
        const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
        fireEvent.input(title, { target: { value: MINE } });
        await settle(2);
      }
      const readsBefore = reads();

      deliverFrame();
      await settle();
      expect(reads()).toBeGreaterThan(readsBefore);
      expect(titleValue()).toBe(dirty ? MINE : STALE);
    });
  }
});
