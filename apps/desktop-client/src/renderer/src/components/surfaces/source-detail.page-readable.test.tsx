// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceDetailSurface } from "./source-detail-surface";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「来源详情」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 挑这一页登记的理由：她最常被问的是"这份材料解析得怎么样了""它长出了几篇笔记"，
 * 而这两件事**只有这一屏说得清**（来源库那一屏只有整堆的计数）。
 * 每条断言都同时读 DOM 与 store：视图字段写错**不会红**，症状只是"她说的与屏幕上不是一句"。
 */

const SOURCE_ID = "00000000-0000-4000-8000-0000000000bb";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 7, data });

function sourceWith(status: string) {
  return {
    id: SOURCE_ID,
    workspaceId: WORKSPACE_ID,
    type: "text",
    title: "惯性那一章",
    origin: null,
    status,
    createdBy: USER_ID,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    noteCount: 0,
    cardCount: 0,
    metadata: null,
  };
}

function segment(ordinal: number, segmentType: string, text: string) {
  return {
    id: `33333333-3333-4333-8333-00000000000${ordinal}`,
    sourceId: SOURCE_ID,
    workspaceId: WORKSPACE_ID,
    ordinal,
    text,
    charStart: ordinal * 100,
    charEnd: ordinal * 100 + text.length,
    segmentType,
  };
}

function note(id: string, title: string, hasVersion: boolean) {
  return {
    id,
    title,
    kind: "note",
    currentVersionId: hasVersion ? `44444444-4444-4444-8444-00000000000${id.slice(-1)}` : null,
    updatedAt: "2026-09-23T00:00:00.000Z",
    createdAt: "2026-09-21T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    blocks: [],
    wordCount: 0,
  };
}

function installApi(options: {
  status?: string;
  segments?: ReturnType<typeof segment>[];
  notes?: ReturnType<typeof note>[];
  noteTotal?: number;
} = {}) {
  const api = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: WORKSPACE_ID, name: "理解空间" },
        workspaceEpoch: 7,
      })),
    },
    capabilities: {
      get: vi.fn(async () => ok({
        actionCapabilities: {
          "source.update": "allowed",
          "source.archive": "allowed",
          "source.createNote": "allowed",
        },
      })),
    },
    source: {
      get: vi.fn(async () => ok({
        source: sourceWith(options.status ?? "ready"),
        segments: options.segments ?? [segment(0, "heading", "# 惯性定律"), segment(1, "paragraph", "质量越大，惯性越大。")],
      })),
      listNotes: vi.fn(async () => ok({
        items: options.notes ?? [note("n-1", "牛顿第一定律整理", true), note("n-2", "课上没讲清的那一段", false)],
        total: options.noteTotal ?? 2,
        nextCursor: null,
        snapshotAt: "2026-09-24T00:00:00.000Z",
      })),
    },
  };
  window.ailearn = api as unknown as typeof window.ailearn;
  return api;
}

/** 页签那一列里有两处「片段 N」写法（页签与批注里的「片段 02」），所以按容器取。 */
function chapterTab(prefix: string): string | null {
  const tab = [...document.querySelectorAll(".chapter-tabs span")].find((node) => node.textContent?.startsWith(prefix));
  return tab?.textContent ?? null;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function renderSurface() {
  useRoomStore.setState({ activeSourceId: SOURCE_ID });
  return render(<SourceDetailSurface />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeSourceId: null, pageReadableView: null });
});

describe("来源详情：她读到的与屏幕上的是同一份", () => {
  it("标题、结构那句、meta 两格、页签两个数、笔记清单全部与 DOM 逐字相同", async () => {
    installApi();
    renderSurface();
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).not.toBeNull());
    await waitFor(() => expect(publishedView()).not.toBeNull());

    const view = publishedView()!;
    expect(view.pageId).toBe("source_detail");
    expect(view.title).toBe(screen.getByRole("heading", { level: 2 }).textContent);
    expect(view.statusLine).toBe(document.querySelector(".folio-page.right > p.sub")?.textContent);
    const meta = [...document.querySelectorAll(".article-copy .meta span")].map((node) => node.textContent);
    expect(view.metrics).toEqual([
      { label: "状态", value: meta[1] },
      { label: "类型", value: meta[0] },
      { label: "片段", value: expect.stringMatching(/^\d+$/) },
      { label: "关联笔记", value: expect.stringMatching(/^\d+$/) },
    ]);
    // 两个数是页签上那两格里的那个数（不是在这儿重算一份）。
    expect(chapterTab("片段")).toContain(view.metrics![2].value);
    expect(chapterTab("笔记")).toContain(view.metrics![3].value);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.items?.map((entry) => entry.label)).toEqual(
      [...document.querySelectorAll(".note-links span")].map((node) => node.textContent),
    );
    expect(view.items?.map((entry) => entry.state)).toEqual(
      [...document.querySelectorAll(".note-links small")].map((node) => node.textContent?.split(" · ")[0]),
    );
    // 屏上既没截断、也没回执：这一格就该空着，不能替她编一句。
    expect(view.notice).toBeUndefined();
  });

  it("还没解析出正文：登记的是屏上那句解释，不是零个片段", async () => {
    installApi({ status: "processing", segments: [], notes: [], noteTotal: 0 });
    renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    // 两条"屏上确实这么写着"的句子同时成立时，先说正文（它是这一页的主内容）。
    expect(view.notice).toBe(screen.getByText(/^正在解析这份材料/).textContent);
    expect(view.metrics?.find((metric) => metric.label === "片段")?.value).toBe("0");
  });

  it("有正文没笔记：说的是屏上那句「没有笔记」，不是省略成空清单", async () => {
    installApi({ notes: [], noteTotal: 0 });
    renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(screen.getByText(/还没有基于这份材料建立的笔记/).textContent);
  });

  it("只列出最近几篇时，notice 与屏上那一行逐字相同", async () => {
    installApi({ noteTotal: 7 });
    renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    expect(publishedView()!.notice).toBe(screen.getByText(/^共 \d+ 篇，这里列出最近/).textContent);
  });

  it("没有选来源：登记的只有「这一页还没打开任何东西」，不带任何一份材料的名字", async () => {
    installApi();
    useRoomStore.setState({ activeSourceId: null });
    render(<SourceDetailSurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.statusLine).toBe(screen.getByText("还没有选择来源").textContent);
    expect(view.items).toBeUndefined();
    expect(view.metrics).toEqual([]);
    expect(view.notice).toContain("还没有选择来源");
  });

  it("读到之前不登记，卸载时槽位让开", async () => {
    useRoomStore.setState({ activeSourceId: SOURCE_ID });
    let releaseGet: (value: unknown) => void = () => undefined;
    window.ailearn = {
      auth: {
        getState: vi.fn(async () => ok({
          status: "authenticated",
          workspace: { workspaceId: WORKSPACE_ID, name: "理解空间" },
          workspaceEpoch: 7,
        })),
      },
      capabilities: {
        get: vi.fn(async () => ok({ actionCapabilities: {} })),
      },
      source: {
        get: vi.fn(() => new Promise((resolve) => { releaseGet = resolve; })),
        listNotes: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null, snapshotAt: "2026-09-24T00:00:00.000Z" })),
      },
    } as unknown as typeof window.ailearn;
    const { unmount } = render(<SourceDetailSurface />);
    await waitFor(() => expect(screen.getByText("正在读取来源详情")).not.toBeNull());
    expect(publishedView()).toBeNull();
    releaseGet(ok({ source: sourceWith("ready"), segments: [] }));
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});

/**
 * 39d §19：伴星在笔记页照着「来源片段 00」（那是首段**序号**）念出过"只挂了 1 段"这种
 * 自相矛盾的话。这一屏当初是同一族写法（批注 `片段 02` 是序号、页签 `片段 2` 是条数），
 * 旧用例甚至专门写了"按容器取"来绕开这份歧义——绕开就是没判。现在把它钉住。
 */
describe("页边批注：段号与段数不再共用「片段」这两个字", () => {
  it("批注说「第 N 段，共 2 段」，整屏不再有补零的「片段 0X」", async () => {
    installApi();
    renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const clip = document.querySelector<HTMLElement>(".margin-note b");
    expect(clip).not.toBeNull();
    expect(clip!.textContent).toMatch(/^第 \d+ 段，共 2 段$/);
    expect(document.body.textContent).not.toMatch(/片段 0\d/);
  });

  it("页签那一格仍然是条数（钉住「只改了批注」这一半）", async () => {
    installApi();
    renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    expect(chapterTab("片段")).toBe("片段 2");
  });
});
