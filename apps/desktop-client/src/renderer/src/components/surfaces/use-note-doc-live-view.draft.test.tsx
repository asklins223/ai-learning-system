// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteDocResult, peerUpdate, seedUpdate } from "../../test-support/note-doc-fixtures";
import { useNoteDocLiveView, type NoteDocLiveView } from "./use-note-doc-live-view";

/**
 * 本机草稿：刷新/崩溃/切篇不该丢掉"刚敲、还没交出去"的那几个字。
 *
 * 为什么在这一层测：丢字的那一段只存在于渲染进程——编辑器写的是那份共享文档，而
 * 自动保存要等一次往返（界面那 1.2 秒），文档与主进程之间这一步没走完就刷新，字就没了。
 * 所以这里量的是钩子本身：停笔之后有没有把增量落到本机、重挂载时接不接得回来、
 * 确认交出去之后清不清得掉。落盘的键（账号/空间/笔记）在主进程，那一侧另有专门用例。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_NOTE_ID = "33333333-3333-4333-8333-333333333333";
const FRAGMENT_KEY = "content";
const DRAFT_SAVED_AT = "2026-09-21T00:10:00.000Z";

let live: NoteDocLiveView | null = null;

/** 只做一件事：把钩子交出来的那一份挂到 `live` 上，外加三个能断言的读数。 */
function Probe({ noteId }: { readonly noteId: string | null }) {
  const view = useNoteDocLiveView(noteId, false, () => undefined);
  live = view;
  return (
    <>
      <span data-testid="body">{view.blocks.map((block) => block.content).join("｜")}</span>
      <span data-testid="dirty">{view.dirty ? "dirty" : "clean"}</span>
      <span data-testid="restored">{view.restoredDraft?.savedAt ?? ""}</span>
    </>
  );
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...Array.from(bytes)));
const unB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** 把几条增量并成一条（"服务端那份现在已经含这一条了"就用它拼）。 */
function mergeUpdates(updates: readonly string[]): string {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, unB64(update));
  const merged = b64(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return merged;
}

/**
 * `note.doc` 的替身。草稿那三条按 noteId 存一张表——真主进程用的是
 * (subjectId, workspaceId, noteId)，但那一段边界不在这一层，这里只需要它"只交出被问到
 * 那一篇的草稿"。
 */
function stubNoteDocApi(options: {
  readonly seedFor: (noteId: string) => string;
  readonly via?: "uploaded" | "queued" | "stream" | "unchanged";
}) {
  const drafts = new Map<string, { update: string; savedAt: string }>();
  const docApi = {
    state: vi.fn(async (input: { noteId: string }) => noteDocResult({ update: options.seedFor(input.noteId) })),
    syncUpdate: vi.fn(async () => ({
      ok: true as const,
      workspaceEpoch: 1,
      data: { via: options.via ?? "uploaded", revision: 2, savedAt: "2026-09-21T00:11:00.000Z" },
    })),
    draftSave: vi.fn(async (input: { noteId: string; update: string }) => {
      drafts.set(input.noteId, { update: input.update, savedAt: DRAFT_SAVED_AT });
      return { ok: true as const, workspaceEpoch: 1, data: { saved: true } };
    }),
    draftGet: vi.fn(async (input: { noteId: string }) => ({
      ok: true as const,
      workspaceEpoch: 1,
      data: { draft: drafts.get(input.noteId) ?? null },
    })),
    draftClear: vi.fn(async (input: { noteId: string }) => {
      drafts.delete(input.noteId);
      return { ok: true as const, workspaceEpoch: 1, data: { cleared: true } };
    }),
    presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: false } })),
  };
  window.ailearn = { note: { doc: docApi } } as unknown as typeof window.ailearn;
  return { docApi, drafts };
}

/** 起点、草稿都是异步读回来的，假时钟只挡定时器不挡微任务，所以单独冲洗几轮。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** 编辑器里敲一段：写进 fragment 就是文档产生了本机增量（与真打字同一条路）。 */
function type(text: string): void {
  const fragment = live?.fragment;
  if (!fragment) throw new Error("起点还没到，编辑器还没绑上文档");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

const body = (): string => document.querySelector('[data-testid="body"]')?.textContent ?? "";
const restored = (): string => document.querySelector('[data-testid="restored"]')?.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  live = null;
  window.ailearn = undefined as unknown as typeof window.ailearn;
});

describe("笔记正文的本机草稿", () => {
  it("停笔才落盘：连着敲的两下只写一次，卸载那一次也写", async () => {
    vi.useFakeTimers();
    const seed = seedUpdate();
    const { docApi, drafts } = stubNoteDocApi({ seedFor: () => seed });
    const first = render(<Probe noteId={NOTE_ID} />);
    await settle();
    expect(live?.fragment).toBeTruthy();

    act(() => { type("第一下"); });
    await vi.advanceTimersByTimeAsync(200);
    act(() => { type("第二下"); });
    await vi.advanceTimersByTimeAsync(700);
    await settle();
    // 200ms 那一下只是把定时器往后推：不是每次按键都写盘。
    expect(docApi.draftSave).toHaveBeenCalledTimes(1);
    expect(drafts.get(NOTE_ID)).toBeTruthy();

    // 卸载（换页/刷新）时还压着的那几个字也要写下去：这条路上没有"下一次停笔"。
    act(() => { type("卸载前的一句"); });
    first.unmount();
    await settle();
    const written = drafts.get(NOTE_ID);
    expect(written).toBeTruthy();
    // 草稿是一条**增量**，要在共同的起点上才解得出（空文档上 apply 会因缺依赖挂起）。
    const doc = new Y.Doc();
    Y.applyUpdate(doc, unB64(seed));
    Y.applyUpdate(doc, unB64(written?.update ?? ""));
    const text = doc.getXmlFragment(FRAGMENT_KEY).toString();
    doc.destroy();
    expect(text).toContain("卸载前的一句");
  });

  it("刷新（重挂载）之后草稿还在：没交出去的那几个字接回来，并说一句", async () => {
    vi.useFakeTimers();
    const seed = seedUpdate();
    const { drafts } = stubNoteDocApi({ seedFor: () => seed });
    const first = render(<Probe noteId={NOTE_ID} />);
    await settle();
    expect(live?.fragment).toBeTruthy();

    act(() => { type("崩溃前敲的那句"); });
    await vi.advanceTimersByTimeAsync(700);
    await settle();
    expect(drafts.has(NOTE_ID)).toBe(true);
    first.unmount();

    // 刷新：渲染进程整个重来，只有主进程盘上那一份还在——而服务端的起点里没有这句话。
    render(<Probe noteId={NOTE_ID} />);
    await settle();
    expect(body()).toContain("崩溃前敲的那句");
    expect(restored()).toBe(DRAFT_SAVED_AT);
    // 接回来的必须是"待提交的增量"而不是画在屏幕上的一份死文本：自动保存照旧会送出去。
    expect(live?.dirty).toBe(true);
  });

  it("确认交出去之后草稿清掉", async () => {
    vi.useFakeTimers();
    const { docApi, drafts } = stubNoteDocApi({ seedFor: () => seedUpdate(), via: "uploaded" });
    render(<Probe noteId={NOTE_ID} />);
    await settle();
    act(() => { type("要交出去的一句"); });
    await vi.advanceTimersByTimeAsync(700);
    expect(drafts.has(NOTE_ID)).toBe(true);

    await act(async () => { await live?.flush(); });
    expect(docApi.draftClear).toHaveBeenCalledWith(expect.objectContaining({ noteId: NOTE_ID }));
    expect(drafts.has(NOTE_ID)).toBe(false);
    expect(live?.dirty).toBe(false);
  });

  it("没网（queued）时草稿留着：那几句字此刻只有本机这一份", async () => {
    vi.useFakeTimers();
    const { docApi, drafts } = stubNoteDocApi({ seedFor: () => seedUpdate(), via: "queued" });
    render(<Probe noteId={NOTE_ID} />);
    await settle();
    act(() => { type("没网时敲的一句"); });
    await vi.advanceTimersByTimeAsync(700);

    await act(async () => { await live?.flush(); });
    expect(docApi.draftClear).not.toHaveBeenCalled();
    expect(drafts.has(NOTE_ID)).toBe(true);
    // 判据与"待提交"那一位同源：没交出去就还是脏的。
    expect(live?.dirty).toBe(true);
  });

  it("已经并进文档的那一份草稿不当成新的：不恢复，顺手清掉", async () => {
    const seed = seedUpdate();
    // 服务端那份已经含这一条（提交成功、只是清草稿那一步没走完）。它比屏幕旧，
    // 判据是状态向量不是时间戳，所以这里不会变成"每次打开都提示恢复了草稿"。
    const received = peerUpdate(seed, { text: "服务端已经收到的一句" });
    const { docApi, drafts } = stubNoteDocApi({ seedFor: () => mergeUpdates([seed, received]) });
    drafts.set(NOTE_ID, { update: received, savedAt: DRAFT_SAVED_AT });

    render(<Probe noteId={NOTE_ID} />);
    await settle();
    expect(restored()).toBe("");
    expect(body()).toContain("服务端已经收到的一句");
    expect(docApi.draftClear).toHaveBeenCalled();
    expect(drafts.has(NOTE_ID)).toBe(false);
  });

  it("换一篇笔记时：上一篇没交出去的字先落到本机，且不会接进新的一篇", async () => {
    vi.useFakeTimers();
    const seedFor = (noteId: string): string =>
      noteId === NOTE_ID ? seedUpdate("标题A", ["A 的正文"]) : seedUpdate("标题B", ["B 的正文"]);
    const { drafts } = stubNoteDocApi({ seedFor });
    const view = render(<Probe noteId={NOTE_ID} />);
    await settle();

    // 还没到落盘节拍就切走：这是"切一篇笔记"唯一会丢字的地方。
    act(() => { type("A 里没交出去的一句"); });
    view.rerender(<Probe noteId={OTHER_NOTE_ID} />);
    await settle();
    expect(drafts.has(NOTE_ID)).toBe(true);

    expect(body()).toContain("B 的正文");
    expect(body()).not.toContain("A 里没交出去的一句");
    expect(restored()).toBe("");
  });
});
