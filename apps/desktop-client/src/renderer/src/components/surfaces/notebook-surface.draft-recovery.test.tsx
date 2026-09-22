// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { peerUpdate, seedUpdate } from "../../test-support/note-doc-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 刷新/崩溃之后本机草稿接回来的那一屏。
 *
 * 要钉住三件事，都是"用户看得见"的那一半：接回来的字真的在编辑器里（不是只改了状态）、
 * 纸面上有一句说明（不是弹窗打断）、确认交出去之后那句话自己消失。落盘与键那两半在
 * 主进程（`note-doc-cache-store.test.ts` / `desktop-ipc-note-doc.test.ts`）。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const DRAFT_SAVED_AT = "2026-09-21T00:10:00.000Z";
const DRAFT_TEXT = "崩溃前敲的那句";

function stubGatewayForNote(options: { readonly draft: { update: string; savedAt: string } | null }) {
  const state = { title: "测试笔记", saveCount: 0 };
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
            blocks: [{ ordinal: 1, type: "paragraph", content: "服务端那一份" }],
          },
        },
      })),
      doc: {
        // 起点里**没有**草稿那句话：这正是"刷新之后字没了"的样子。
        state: vi.fn(async () => noteDocResult(seed)),
        syncUpdate: vi.fn(async () => {
          state.saveCount += 1;
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: { via: "uploaded" as const, revision: state.saveCount, savedAt: new Date().toISOString() },
          };
        }),
        draftGet: vi.fn(async () => ({
          ok: true as const,
          workspaceEpoch: 1,
          data: { draft: options.draft },
        })),
        draftSave: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { saved: true } })),
        draftClear: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { cleared: true } })),
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
  return { gateway };
}

/** 同一份起点上长出来的草稿：与真客户端上行的那一条同形（只含起点之后多出来的操作）。 */
const seed = seedUpdate();
const draft = { update: peerUpdate(seed, { text: DRAFT_TEXT }), savedAt: DRAFT_SAVED_AT };

function noteDocResult(update: string) {
  return { ok: true as const, workspaceEpoch: 1, data: { update, revision: 3, backfilled: false, shareScope: "shared" as const } };
}

async function renderEditor() {
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "edit" } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  // 数据加载与 Milkdown 的异步创建都要靠推进假时钟来冲洗微任务。
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(100);
}

const bodyText = (): string => document.getElementById("notebook-surface-body")?.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 本机草稿恢复", () => {
  it("接回没交出去的那几个字，并在纸面上说一句（不是弹窗）", async () => {
    const { gateway } = stubGatewayForNote({ draft });
    await renderEditor();

    // 字在编辑器里：恢复必须发生在编辑器绑上文档之前，否则先画一份没有它的、再被换掉。
    expect(bodyText()).toContain(DRAFT_TEXT);
    // 说明是一句话，不是一次打断。
    expect(document.body.textContent).toContain("本机草稿已恢复");
    expect(document.body.textContent).toContain("还没交上去的改动");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(gateway.note.doc.draftGet).toHaveBeenCalledWith(expect.objectContaining({ noteId: NOTE_ID }));
  });

  it("确认交出去之后那句话自己消失，草稿也清掉", async () => {
    const { gateway } = stubGatewayForNote({ draft });
    await renderEditor();
    expect(document.body.textContent).toContain("本机草稿已恢复");

    // 恢复出来的是"待提交的增量"，所以自动保存（1.2 秒）会把它送出去；交出去之后
    // 提示不该继续挂着——它说的是"还没交上去"。
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(gateway.note.doc.syncUpdate).toHaveBeenCalled();
    expect(gateway.note.doc.draftClear).toHaveBeenCalledWith(expect.objectContaining({ noteId: NOTE_ID }));
    expect(document.body.textContent).not.toContain("本机草稿已恢复");
  });

  it("没有草稿时不提这一句：一句永远挂着的提示等于没有提示", async () => {
    stubGatewayForNote({ draft: null });
    await renderEditor();
    expect(document.body.textContent).not.toContain("本机草稿已恢复");
  });
});
