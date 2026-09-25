// @vitest-environment jsdom

/**
 * 「来源片段」这四个字在一块屏上曾经表示**两个数**（2026-09-25 真窗口量到）：
 * 资料卡片写 `来源片段 00`（那是首段的**序号**，0 基补零），页眉同一行写 `来源片段 72`（那是**条数**）。
 * 她照着念就念出了「来源片段屏上只挂了 1 段（标着「来源片段 00」）」——一句自相矛盾的话。
 *
 * 现在卡片说人话：`第 1 段来源片段`。这一组钉三件事：
 * ① 屏上不再有「来源片段 NN」这种把序号当计数的写法；② 页眉那个**计数**仍然是条数；
 * ③ 给她的视图里那一条与屏上**逐字相同**（两边各写一句迟早分叉，而分叉不报错——
 *    `usePageReadableView` 不合合同只是不发布，症状仅仅是"她偶尔读不到这一页"）。
 */
import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const SOURCE_ID = "33333333-4333-4333-8333-333333333333";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

/** 三段片段：序号 0/1/2，条数 3——正好把"序号"和"条数"这两个数分开。 */
function installApi() {
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      contract: { enabledRoutes: ["note.detail", "source.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({
          primaryFocus: {
            state: "empty",
            data: null,
          },
        })),
      },
      note: {
        get: vi.fn(async () => ok({
          noteId: NOTE_ID,
          title: "来源卡片这一格",
          sourceId: SOURCE_ID,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-25T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks: [{ ordinal: 0, type: "paragraph", content: "正文一段。" }],
          },
        })),
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedUpdate("来源卡片这一格", []) })),
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
      source: {
        get: vi.fn(async () => ok({
          sourceId: SOURCE_ID,
          source: { title: "某篇来源", url: null, kind: "web", status: "parsed" },
          segments: [
            { segmentId: "s0", ordinal: 0, text: "第一段：不赶进度、专注打磨。", status: "parsed" },
            { segmentId: "s1", ordinal: 1, text: "第二段。", status: "parsed" },
            { segmentId: "s2", ordinal: 2, text: "第三段。", status: "parsed" },
          ],
        })),
      },
      subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
}

async function show() {
  installApi();
  const published = vi.fn();
  useRoomStore.setState({
    activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" },
    publishPageReadableView: published,
  });
  vi.useFakeTimers();
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  return { ...view, published };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, surface: null });
});

describe("「来源片段」在一块屏上只许表示一个数", () => {
  it("资料卡片说「第 1 段来源片段」，不再写补零的序号", async () => {
    const { container } = await show();
    const clip = container.querySelector<HTMLElement>(".source-clips .clip b")!;
    expect(clip.textContent).toBe("第 1 段来源片段");
    // 反面对策：旧的"序号当计数"那一种写法整屏都不该再出现。
    expect(container.textContent).not.toMatch(/来源片段 0\d/);
  });

  it("页眉那一格仍然是条数（3 段），两个数不再共用四个字", async () => {
    const { container } = await show();
    const meta = [...container.querySelectorAll("span")].map((n) => n.textContent?.trim());
    expect(meta).toContain("来源片段 3");
    expect(meta.filter((t) => t === "来源片段 3").length).toBe(1);
  });

  it("给她的视图里那一条与屏上逐字相同", async () => {
    const { container, published } = await show();
    const calls = published.mock.calls;
    // 分母自证：一次都没发布的话，"两边一致"就是空话。
    expect(calls.length).toBeGreaterThan(0);
    const view = calls[calls.length - 1][1] as {
      items?: Array<{ label: string; state: string }>;
    };
    const clip = container.querySelector<HTMLElement>(".source-clips .clip b")!;
    expect(view.items?.[0]?.state).toBe(clip.textContent);
  });
});
