// @vitest-environment jsdom

import { noteDocResult, peerUpdate, seedUpdate } from "../../test-support/note-doc-fixtures";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * Regression test for the save-line flicker: after a failed save the page used
 * to re-arm the autosave debounce (dirty stayed true, saving was false), so
 * every AUTOSAVE_DELAY_MS it retried and flipped the save-line between
 * "正在保存…" and "这次没保存上，本机草稿仍在" — a steady flicker. The error
 * state is now sticky: exactly one attempt, a stable failure notice, and
 * autosave resumes only on a new keystroke or the retry button.
 *
 * 输入走标题字段：它是真实的受控 input，和正文共用同一条「草稿 → 防抖 → 保存」
 * 链路，又不依赖编辑器的内部实现。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

function stubGatewayWithFailingSave() {
  const state = { saveAttempts: 0 };
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
          title: "测试笔记",
          sourceId: null,
          currentVersionId: "v-0",
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash-0",
            blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }],
          },
        },
      })),
      // 自动保存现在走文档增量（批次 4.4），所以"提交失败"要钉在这一条路上；
      // 还挂在 `save` 上的话，这个用例测的就已经不是页面真正走的那条路了。
      doc: {
        state: vi.fn(async () => noteDocResult()),
        syncUpdate: vi.fn(async () => {
          state.saveAttempts += 1;
          throw new Error("gateway unavailable");
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

async function renderFailingEditor() {
  const stub = stubGatewayWithFailingSave();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "edit" } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  // 数据加载与 Milkdown 的异步创建都要靠推进假时钟来冲洗微任务。
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
  return stub;
}

const saveLine = () => document.querySelector(".save-line [role=\"status\"]")?.textContent ?? "";
const typeTitle = async (value: string) => {
  const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
  await act(async () => {
    fireEvent.input(title, { target: { value } });
  });
};

// Globals are not enabled in this project, so @testing-library's automatic
// cleanup never registers. Without this, the previous test's DOM (and its
// live React tree) stays mounted and steals the queries and input events.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 保存失败后的稳定态", () => {
  it("保存失败不再无限重试，失败提示保持稳定", async () => {
    const { state } = await renderFailingEditor();

    await typeTitle("测试笔记T");

    // One debounced attempt happens; it fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(state.saveAttempts).toBe(1);
    expect(saveLine()).toContain("这次没保存上");

    // 失败那一档，动作行只留一颗可点的按钮：主按钮自己变成「重试保存」。原来这里
    // 并排挂着「提交并确认」与「重试保存」两颗，都调同一个 `save("manual")`，
    // 看不出该点哪个——而"提交"那个名字还额外暗示正文没存住。
    const actionLabels = [...document.querySelectorAll(".notebook-actions--editor button")]
      .map((button) => button.textContent ?? "");
    expect(actionLabels).toContain("重试保存");
    expect(actionLabels.filter((label) => label.includes("保存"))).toEqual(["重试保存"]);

    // The pre-fix page re-armed the debounce and retried on every tick — the
    // flicker. The error must be sticky: many ticks, still exactly one attempt,
    // and the save-line never flips back to "正在保存…".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(state.saveAttempts).toBe(1);
    expect(saveLine()).toContain("这次没保存上");
    expect(saveLine()).not.toContain("正在保存");
  });

  it("失败后再次输入会清除错误态并恢复自动保存", async () => {
    const { state } = await renderFailingEditor();

    await typeTitle("测试笔记T");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(state.saveAttempts).toBe(1);

    // A new keystroke clears the sticky error, so the debounce re-arms and a
    // second attempt fires after the delay.
    await typeTitle("测试笔记TT");
    expect(saveLine()).not.toContain("这次没保存上");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(state.saveAttempts).toBe(2);
  });
});
