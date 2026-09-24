// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 阅读页画出来的是不是编辑器里那一份（2026-09-24 对拍量出来的七类）。
 *
 * 病根只有一句：一块的 `content` 是**带结构的 Markdown 原文**（段内换行是 `\n`、
 * 粗体是 `**`、图片是 `![](...)`），而阅读页把它当一行纯文本画进 `<p>`。于是
 * 编辑器里换的行并成一行、`**重点**` 露着星号、段落里的图整张看不见、`---` 变成
 * 三个减号、整块列表压成一行。
 *
 * 这里刻意让实时文档那份是**空的**（`seedUpdate(title, [])`），正文于是走
 * `currentVersion.blocks` 那一支——喂给屏上的块与服务端 `note_blocks` 里存的是
 * 同一个形状（投影由 `note-doc-schema` 出，它的用例在 shared 那边），
 * 所以这一组钉的是"投影出来的形状到了屏上还剩什么"。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

type Block = { ordinal: number; type: string; content: string };

function installApi(blocks: readonly Block[], conceptLabel = "测试目标") {
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      contract: { enabledRoutes: ["note.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({
          primaryFocus: {
            state: "data",
            data: {
              objective: {
                content: { conceptLabel, publicSummary: "", sourceLabel: null },
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
          title: "阅读形状",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-24T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks,
          },
        })),
        // 空文档：正文于是来自已存版本那一支（见文件头）。
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedUpdate("阅读形状", []) })),
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
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
}

async function show(list: readonly Block[], conceptLabel?: string) {
  // `ordinal` 是块在整篇里的序号：页面拿它当 key，也拿它接画廊序号，撞号就会
  // 让后一块顶掉前一块（第一版夹具就是这么把"点第一张图"变成"开在 2/2"的）。
  installApi(list.map((item, ordinal) => ({ ...item, ordinal })), conceptLabel);
  vi.useFakeTimers();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  return {
    ...view,
    /** 正文那一叠块；页面上只有这一处会画它们。 */
    body: () => view.container.querySelector<HTMLElement>(".reading-body")!,
  };
}

const block = (type: string, content: string): Block => ({ ordinal: 0, type, content });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, surface: null });
});

describe("阅读页画的是编辑器里那一份", () => {
  it("段内换行画成换行，不再并成一行", async () => {
    const { body } = await show([block("paragraph", "修改笔记。12312\n123123123123")]);
    const paragraph = body().querySelector("p")!;
    // 结构是"字 / 换行 / 字"三节：并成一行就是中间那一节没了（HTML 会把裸 `\n` 折成空格）。
    expect([...paragraph.childNodes].map((node) => node.nodeName)).toEqual(["#text", "BR", "#text"]);
    expect([...paragraph.childNodes].map((node) => node.textContent)).toEqual(["修改笔记。12312", "", "123123123123"]);
  });

  it("行内四种标记画成结构，屏上不露标记符号", async () => {
    const { body } = await show([
      block("paragraph", "前 **重点** 与 *斜* 与 ~~作废~~ 与 `代码`"),
      block("paragraph", "详见 [说明页](https://example.com/a)"),
    ]);
    const paragraph = body().querySelector("p")!;
    expect([...paragraph.querySelectorAll("strong, em, del, code")].map((node) => node.tagName))
      .toEqual(["STRONG", "EM", "DEL", "CODE"]);
    expect([...paragraph.querySelectorAll("strong, em, del, code")].map((node) => node.textContent))
      .toEqual(["重点", "斜", "作废", "代码"]);
    expect(paragraph.textContent).not.toContain("**");
    expect(paragraph.textContent).not.toContain("~~");
    const link = body().querySelector("a")!;
    expect(link.textContent).toBe("说明页");
    expect(link.getAttribute("href")).toBe("https://example.com/a");
  });

  it("非网页协议的链接不画成能点的，照原文留成字", async () => {
    const { body } = await show([block("paragraph", "[坑](javascript:alert(1))")]);
    const paragraph = body().querySelector("p")!;
    expect(paragraph.querySelector("a")).toBeNull();
    expect(paragraph.textContent).toBe("[坑](javascript:alert(1))");
  });

  it("段落里的图片画出来，并且进的是整篇那一副画廊", async () => {
    const { body } = await show([
      block("paragraph", "上图：![示意图](https://example.com/a.png)，如下"),
      block("paragraph", "![](https://example.com/b.png)"),
    ]);
    const images = [...body().querySelectorAll("img")];
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("alt")).toBe("示意图");
    // 点开第一张：进的是整篇画廊（带位次与左右切换），不是只放大这一张的单体灯箱。
    fireEvent.click(images[0]!);
    const lightbox = document.body.querySelector(".image-lightbox");
    expect(lightbox).not.toBeNull();
    expect(lightbox?.querySelector(".image-lightbox-counter")?.textContent).toBe("1 / 2");
    expect(lightbox?.querySelector(".image-lightbox-next")).not.toBeNull();
  });

  it("分隔线画成一条线，不是三个减号", async () => {
    const { body } = await show([block("paragraph", "---")]);
    expect(body().querySelector("hr.reading-rule")).not.toBeNull();
    expect(body().textContent).not.toContain("---");
  });

  it("列表一项一行、各带记号", async () => {
    const { body } = await show([block("list", "第一点\n第二点\n第三点")]);
    const lines = body().querySelectorAll("p.list-block .list-line");
    expect(lines).toHaveLength(3);
    expect([...lines].map((line) => line.textContent)).toEqual(["第一点", "第二点", "第三点"]);
  });

  it("引用多行仍是多行，并带编辑器那道左竖线", async () => {
    const { body } = await show([block("quote", "第一行\n第二行")]);
    const quote = body().querySelector("p.quote")!;
    expect(quote.querySelectorAll("br")).toHaveLength(1);
    expect(quote.className).toContain("quote");
  });

  it("表格单元里也走行内解析，且转义过的竖线不另起一列", async () => {
    const { body } = await show([block("paragraph", "| 列甲 | 列乙 |\n| --- | --- |\n| **粗** | a\\|b |")]);
    const table = body().querySelector("table.md-table")!;
    const cells = [...table.querySelectorAll("tbody td")];
    expect(cells).toHaveLength(2);
    expect(cells[0]?.querySelector("strong")?.textContent).toBe("粗");
    expect(cells[0]?.textContent).not.toContain("**");
    expect(cells[1]?.textContent).toBe("a|b");
    // 分隔行是语法不是内容：跟着画就多出一整行减号。
    expect(table.querySelector("tbody")?.textContent).not.toContain("---");
  });

  it("反斜杠转义还原成它挡着的字符", async () => {
    const { body } = await show([block("paragraph", "干杯\\~-bilibili")]);
    expect(body().querySelector("p")!.textContent).toBe("干杯~-bilibili");
  });

  it("老版本存的 HTML 块塌缩成正文，不露标签", async () => {
    const { body } = await show([block("heading", "<h1>欧姆定律</h1>")]);
    const heading = body().querySelector("h3")!;
    expect(heading.textContent).toBe("欧姆定律");
  });

  it("概念句的高亮切在显示文本上，标记符号不把它挤错位", async () => {
    // 偏移量以前按 `content` 原文算：那句里带着 `**`，切片就会从标记符号中间开始，
    // 高亮盖错字（旧实现框进来的是 `**欧姆定律**是结论`）。渲染与偏移现在同源于
    // `noteInlineDisplayText`。
    const { body } = await show(
      [block("paragraph", "开头的话。**欧姆定律**是结论。结尾的话")],
      "欧姆定律",
    );
    const marked = [...body().querySelectorAll("p .mark")].map((node) => node.textContent ?? "");
    expect(marked.join("")).toBe("欧姆定律是结论。");
    expect(marked.some((text) => text.includes("*"))).toBe(false);
    // 高亮不许拆掉结构：那四个字仍然是粗体，高亮叠在它里面。
    expect(body().querySelector("strong .mark")?.textContent).toBe("欧姆定律");
  });
});
