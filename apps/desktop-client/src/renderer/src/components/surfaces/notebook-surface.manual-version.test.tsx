// @vitest-environment jsdom

/**
 * 审计 F36：**「提交并确认」在正常写作节奏里一次都点不到**。
 *
 * 现场是这样断的：提示语让用户去点「提交并确认」，而屏上唯一的控件叫「立即保存」，
 * 它的渲染条件是 `canSave && dirty`——自动保存在停顿 1.2 秒后就把 `dirty` 清掉，
 * 于是这个按钮只在两次按键之间闪一下。⌘S 走同一个 `save()`，首行 `!dirty` 直接
 * return，**没有任何提示**，用户分不清是没生效还是没必要。版本历史因此永远只有
 * 建笔记那一个空 v1。
 *
 * 这一组钉住解耦后的三条：
 *  1. 按钮常驻（不脏时也在），名字与纸面提示、版本历史里那句是同一个；
 *  2. 没改动时点它给出可读回执，且**不**白造一个版本（`note.save` 不被调用）；
 *  3. ⌘S 在没改动时同样有回执，不再静默。
 *
 * 输入走标题字段：它是真实受控 input，与正文共用同一条「草稿 → 防抖 → 保存」链路。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteDocResult } from "../../test-support/note-doc-fixtures";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";

function stubGateway() {
  const state = { saveCalls: 0, syncUpdateCalls: 0 };
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
          currentVersionId: VERSION_ID,
          shareScope: "shared" as const,
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash-0",
            blocks: [{ ordinal: 1, type: "paragraph", content: "起点正文" }],
          },
        },
      })),
      // 手动定版那一步：把文档此刻定成一个可回去的版本。
      save: vi.fn(async () => {
        state.saveCalls += 1;
        return { ok: true as const, workspaceEpoch: 1, data: { savedAt: new Date().toISOString(), versionNo: 2 } };
      }),
      doc: {
        state: vi.fn(async () => noteDocResult()),
        syncUpdate: vi.fn(async () => {
          state.syncUpdateCalls += 1;
          return { ok: true as const, workspaceEpoch: 1, data: { via: "uploaded" as const, revision: 4, savedAt: new Date().toISOString() } };
        }),
        draftSave: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { saved: true } })),
        draftClear: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { cleared: true } })),
        draftGet: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { draft: null } })),
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

const saveLine = () => document.querySelector('.save-line [role="status"]')?.textContent ?? "";

async function renderEditor() {
  const stub = stubGateway();
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "edit" } });
  vi.useFakeTimers();
  render(<NotebookSurface />);
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
  return stub;
}

const typeTitle = async (value: string) => {
  const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
  await act(async () => {
    fireEvent.input(title, { target: { value } });
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 手动定版（审计 F36）", () => {
  it("按钮常驻：没有未提交改动时也在屏上，名字与纸面提示同一个", async () => {
    await renderEditor();

    const button = screen.getByRole("button", { name: "提交并确认" });
    expect(button).toBeTruthy();
    // 提示语里指的那个名字，屏上必须真有。
    expect(screen.getByText(/点「提交并确认」才存成一个可回去的版本/)).toBeTruthy();
  });

  it("没改动时点它给回执，不白造一个版本", async () => {
    const { state } = await renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "提交并确认" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(saveLine()).toContain("这已经是一个版本了");
    expect(state.saveCalls).toBe(0);
  });

  it("有改动时点它真的定出一版，回执写明已提交并确认", async () => {
    const { state } = await renderEditor();

    await typeTitle("改过的标题");
    fireEvent.click(screen.getByRole("button", { name: "提交并确认" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(state.saveCalls).toBe(1);
    expect(saveLine()).toContain("已提交并确认");
  });

  it("⌘S 在没改动时也给同一句回执，不再静默", async () => {
    await renderEditor();

    const title = document.getElementById("notebook-surface-title") as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(title, { key: "s", metaKey: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(saveLine()).toContain("这已经是一个版本了");
  });
});
