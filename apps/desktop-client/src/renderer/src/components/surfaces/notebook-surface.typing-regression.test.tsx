// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { noteDocResult } from "../../test-support/note-doc-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 编辑器的输入回归：编辑模式挂出的必须是真编辑器（Milkdown/ProseMirror），
 * 且输入不会把页面打崩——历史版本里正文是一个受控 textarea，其函数式更新
 * 闭包引用了 React 事件结束后会被置空的 `currentTarget`，一次按键就能让页面
 * 在渲染阶段解引用 null 而白屏。编辑器换成 Milkdown 后正文不再经过受控
 * state，但仍要钉住同一件事：打字、自动保存、页面存活。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

function stubGatewayForNote(initialBlocks: readonly { ordinal: number; type: string; content: string }[]) {
  // 标题和正文都要进桩状态：自动保存之后页面会回读，桩不落盘的话页面永远
  // 看到「未保存」的差异，收敛测试就会假阳性。
  const state = { title: "测试笔记", blocks: [...initialBlocks], saveCount: 0 };
  const gateway = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          primaryFocus: {
            state: "data",
            data: {
              objective: {
                content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null },
                personal: { lastCanonicalAt: null },
                sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
              },
            },
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
          title: state.title,
          sourceId: null,
          currentVersionId: `v-${state.saveCount}`,
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1 + state.saveCount,
            updatedAt: new Date().toISOString(),
            contentHash: `hash-${state.saveCount}`,
            blocks: state.blocks.map((block, index) => ({ ...block, ordinal: index + 1 })),
          },
        },
      })),
      // 自动保存走的是文档增量（批次 4.4）。这条用例测的是"敲字之后恰好提交一次、
      // 页面不塌"，mock 必须挂在页面真的会调的那个口上，否则它绿的是旧路。
      doc: {
        state: vi.fn(async () => noteDocResult()),
        // 现在是"标题写进文档 meta + 一条增量上行"：mock 要挂在页面真会调的那个口上，
        // 否则它绿的是已经不存在的那条路。
        syncUpdate: vi.fn(async () => {
          state.saveCount += 1;
          state.title = "已提交的标题";
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: {
              via: "uploaded" as const,
              revision: state.saveCount,
              savedAt: new Date().toISOString(),
            },
          };
        }),
        presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: false } })),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: {
            card_generation_v2: { state: "disabled" },
            companion_dialogue_v1: { state: "disabled" },
          },
        },
      })),
    },
    source: {
      get: vi.fn(async () => ({
        ok: false as const,
        error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
      })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

async function renderEditor(blocks: readonly { ordinal: number; type: string; content: string }[]) {
  const stub = stubGatewayForNote(blocks);
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "edit" } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  // 数据加载与 Milkdown 的异步创建都要靠推进假时钟来冲洗微任务。
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(100);
  return stub;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 编辑器挂载与输入", () => {
  it("编辑模式挂出 Milkdown 编辑器，页面存活", async () => {
    await renderEditor([{ ordinal: 1, type: "paragraph", content: "第一段内容。" }]);

    const paper = document.querySelector('.notebook[data-mode="edit"]');
    expect(paper).toBeTruthy();
    const body = document.getElementById("notebook-surface-body");
    expect(body).toBeTruthy();
    // 编辑器等起点 apply 完才挂：先挂就是先画一份自己的文档、再被起点换掉，那正是
    // 这批要消灭的形状。上面那串假时钟已经把起点冲进去了，所以这里同步断言。
    // 不用 `waitFor`：这个文件开着 fake timers，testing-library 的轮询推不动，
    // 元素**已经在了**它也会等到超时——那是一条假红；同步断言红了就是真没挂上。
    const prosemirror = body?.querySelector(".ProseMirror[contenteditable='true']");
    expect(prosemirror).toBeTruthy();
    expect(prosemirror?.getAttribute("aria-label")).toBe("笔记正文编辑区");
  });

  it("标题输入触发一次自动保存并收敛，页面不被卸载", async () => {
    const { state } = await renderEditor([{ ordinal: 1, type: "paragraph", content: "hello" }]);

    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    expect(title).toBeTruthy();

    fireEvent.input(title, { target: { value: "测试笔记T" } });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(state.saveCount).toBe(1);
    // The page is still mounted: the editor is the crash's own witness.
    expect(document.getElementById("notebook-surface-body")).toBeTruthy();
    expect(document.querySelector('.notebook[data-mode="edit"]')).toBeTruthy();
  });
});
