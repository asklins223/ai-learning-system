// @vitest-environment jsdom

import { noteDocResult, peerUpdate, seedUpdate } from "../../test-support/note-doc-fixtures";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 别人改了这一篇，我这屏该画什么（批次 4.4 的实窗结论，批次 C2 换成文档之后重写）。
 *
 * 形状变了但**要防的事故一件没变**：下行现在是一条 yjs 增量，界面这一侧就持有这份文档，
 * 阅读态与编辑态画的是同一份。于是过去那套"帧 vs 回读二选一""编辑态干脆不接帧"都没有
 * 存在理由了——那两个来源并存正是 2026-09-22 实测到的那次覆盖的根（第二个人的页面看不
 * 到对方那段、标签写着「已同步」，他随手敲一个字就把对方那句按块删掉）。
 *
 * 这里钉住的四件事：
 *  1. 正文只由这份文档给（帧把它推进了，屏上就是新的；那次回读还停在旧的也一样）。
 *  2. 没有帧时画的是这一篇自己的文档，不是占位话、也不是上一篇。
 *  3. 我没动过标题时，别人的改名直接上屏。
 *  4. 我改了标题时，别人的改名不许顶掉我那一段——而这一屏必须仍然标着"有未提交编辑"，
 *     否则自动保存不会再来第二次，我起的名字就凭空没了。
 *
 * 增量夹具必须是**从同一起点改出来的**（见 `note-doc-fixtures` 的说明）：另建一篇塞进来
 * 在 CRDT 里是并发插入，合出来是两块，用例绿了也证明不了真窗口里的那次合并。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const SEED_TITLE = "起点标题";
const STALE = "这一段还没人动过";
const FRESH = "别人刚写进来的那一段";
const RENAMED = "别人改的那个名字";
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
 * 起点正文与回读正文给**同一句话**：生产里这两份同源（都来自这一篇），分开给就会让
 * "屏上画的是文档投影"这件事永远看不出来——它和回读那份不一样时，谁在上面都说不清。
 */
function stub() {
  listeners = [];
  let call = 0;
  const seed = seedUpdate(SEED_TITLE, [STALE]);
  const syncUpdate = vi.fn(async (_input: { noteId: string; update: string }) => ({ ok: true as const, workspaceEpoch: 1, data: { via: "stream", revision: null, savedAt: new Date().toISOString() } }));
  const state = vi.fn(async () => noteDocResult({ update: seed }));
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
        call += 1;
        // 永远回同一份旧正文：模拟那次抢在作者自动保存之前的回读（实窗量到 3.5 秒）。
        return notePayload(STALE, STALE);
      }),
      doc: {
        state,
        syncUpdate,
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
  return { seed, reads: () => call, syncUpdate, state };
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

const deliverFrame = (stubbed: { seed: string }, changes: { text?: string; title?: string }) => act(() => {
  const update = peerUpdate(stubbed.seed, changes);
  for (const listener of listeners) {
    listener({ data: { kind: "note_doc_event", noteId: NOTE_ID, event: { type: "update", update } } });
  }
});

const titleValue = () => (document.getElementById("notebook-surface-title") as HTMLInputElement | null)?.value ?? null;
/** 保存状态那一枚标签就是 `dirty` 的脸：脏=「草稿」，干净=「已同步」。 */
const saveTag = () => document.querySelector(".tag.red")?.textContent?.trim() ?? null;
const readingParagraphs = () => Array.from(document.querySelectorAll(".reading-body p")).map((node) => node.textContent?.trim() ?? "");

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

describe("阅读态画这一篇自己的文档", () => {
  it("对端改了那一段：回读还停在旧的，读的人看到的也必须是新的", async () => {
    const stubbed = stub();
    memberRoom();
    await open("read");
    // 起点先上屏：这一句同时也是"帧根本没 apply"时的对照组。
    expect(readingParagraphs()).toEqual([STALE]);
    const readsBefore = stubbed.reads();

    deliverFrame(stubbed, { text: FRESH, title: RENAMED });
    // 回读是 debounce 之后才叫醒的（400ms），所以这里推得比那一格久。
    await settle(8);

    // 只有一段：对端改的就是那一段，合并不是"再添一句"。块数涨了就是两份历史没同源。
    expect(readingParagraphs()).toEqual([FRESH]);
    expect(document.querySelector(".title")?.textContent).toBe(RENAMED);
    // 叫醒一次回读仍然要做（版本号、权限只能从那次回读取），但它不是正文的来源。
    expect(stubbed.reads()).toBeGreaterThan(readsBefore);
  });

  it("没有帧时画的就是这份文档，不是占位话、也不是上一篇", async () => {
    stub();
    memberRoom();
    await open("read");
    expect(readingParagraphs()).toEqual([STALE]);
    // 断具体那句话，不数 `p` 的个数：空正文也有一句"这一版正文还没有段落"占位，
    // 只数个数的那条写法对"根本没画出来"是哑的。
    expect(document.body.textContent).not.toContain("这一版正文还没有段落");
  });
});

describe("编辑态：标题跟着别人那份走，我改的那一段不被顶掉", () => {
  it("我没动过标题时，别人的改名直接上屏，且这一屏不算脏", async () => {
    const stubbed = stub();
    ownerRoom();
    await open("edit");
    expect(titleValue()).toBe(SEED_TITLE);
    expect(saveTag()).toBe("已同步");

    deliverFrame(stubbed, { title: RENAMED });
    await settle(2);

    expect(titleValue()).toBe(RENAMED);
    // 跟上别人的改名不能顺手把这一屏标成"我有待提交的改动"——那一标就再也下不来，
    // 而且下一次自动保存会把别人的名字原样送回服务端。
    expect(saveTag()).toBe("已同步");
  });

  it("我改了标题时，别人的改名不许动我写的字，且仍然标着未提交", async () => {
    const stubbed = stub();
    ownerRoom();
    await open("edit");
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    fireEvent.input(title, { target: { value: MINE } });
    await settle(2);

    deliverFrame(stubbed, { title: RENAMED });
    await settle(2);

    expect(titleValue()).toBe(MINE);
    // 这一条是上一句的配套：守住我的字之后必须仍然承认"还没交出去"。少了它，"守住"
    // 与"已经把这份覆盖掉了"在屏上长得一样，而前者要是让界面读成干净，改名就丢了。
    expect(saveTag()).toBe("草稿");
    expect(document.body.textContent).not.toContain(RENAMED);
  });

  it("对端的帧一直接着来，本机那一次自动保存也不能被一直往后推", async () => {
    // 这一段量的是三件已经各自钉住的事：① 帧与回读来回搅动时那一次提交真的发生了；
    // ② 交出去的是**我这一份文档**的增量（里面能读到我刚写的标题）；③ 起点只取一次，
    // 也就是这份文档不会在搅动里被重建。②背后那个缺陷是"投影吃到旧值"——
    // `setLocalTitle` 与 `flush` 在同一次保存里把 `dirty` 真真假假翻两轮，React 批量后
    // 不产生渲染，memo 交出改写之前的标题；把本地改动也推进投影的版本号就治了它
    // （摘掉那一行这条用例就红，实测过）。
    // 如实记一句：自动保存的定时器**换成不含身份的依赖**这一件事，本用例并没有量到——
    // 拿旧依赖跑它照样是绿的，也就是说"帧把提交一直往后推"这个猜测在 jsdom 里
    // 没被复现。真实窗口里那句"永远停在草稿"到底是谁造成的，仍以量测为准。
    const stubbed = stub();
    ownerRoom();
    await open("edit");
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    fireEvent.input(title, { target: { value: MINE } });

    // 20 轮 × 100ms：整段都比分母（1.2s 的 debounce）密，"帧 → 回读 → 一个新的 `data`"
    // 这一串就一直在重挂定时器。只在 churn **当中**读数（不给它一段安静窗口），
    // 否则旧写法也会在被测窗口之后自己补上那一次提交，那条变异就不红了。
    for (let round = 0; round < 20; round += 1) {
      deliverFrame(stubbed, { text: `${FRESH}${round}` });
      await settle(1);
    }
    await settle(3);

    expect(stubbed.syncUpdate).toHaveBeenCalledTimes(1);
    // 交出去的必须是**我改的那一次**：一条 yjs 增量里能读到我刚写的标题，说明它是从
    // 这一份文档里出来的，不是别的东西。（渲染层没有 Buffer，这里同一条 btoa 反着走。）
    const sent = stubbed.syncUpdate.mock.calls[0]![0] as { noteId: string; update: string };
    expect(sent.noteId).toBe(NOTE_ID);
    const decoded = new TextDecoder("utf-8", { fatal: false })
      .decode(Uint8Array.from(atob(sent.update), (character) => character.charCodeAt(0)));
    expect(decoded).toContain(MINE);
    // 这一条钉的是投影不能吃到旧值：`setLocalTitle` 与 `flush` 在同一次保存里把 `dirty`
    // 真真假假翻两轮，React 批量之后不产生渲染，memo 就会交出改写之前的标题——症状是
    // "我那一次改名交出去了，屏幕却又回到别人那一份"。
    expect(titleValue()).toBe(MINE);
    expect(stubbed.state).toHaveBeenCalledTimes(1);
  });

  it("我刚交出去的那个标题，不能在下一次重画时被读回旧的那一份", async () => {
    // 这一屏没有帧来"顺手刷一次投影"，量的就是投影自己跟不跟得上：`setLocalTitle` 刚把
    // 标题写进文档，同一个 tick 里 `flush` 又把 `dirty` 从真拨回假 —— React 批量之后
    // 一次渲染都不发生，靠 `dirty` 当依赖的 memo 就会继续交出改写之前那一份投影。
    // 如实记一句：这句当初是靠"摘掉 `record()` 里那句 `setRevision` 就变红"立住的，
    // 今天再用那个变异跑它**已经不复现**（异步 awaits 把 `dirty` 分成两次渲染，投影自己
    // 就跟上了）。也就是说这一条量的是"标题不许被读回旧的"这个结果，而不是那行代码。
    const stubbed = stub();
    ownerRoom();
    await open("edit");
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    fireEvent.input(title, { target: { value: MINE } });
    await settle(30);
    expect(stubbed.syncUpdate).toHaveBeenCalledTimes(1);
    expect(titleValue()).toBe(MINE);
    expect(saveTag()).toBe("已同步");
  });
});
