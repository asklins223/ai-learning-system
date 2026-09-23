// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 生成入口的两条合同：
 * - 参数不再是写死的：学习目标/详略/上限/题型都由写作者选择并原样提交；
 * - 上一次生成已经结束时，选一个原因就变成"按反馈重生成"，请求带上 previousRunId
 *   与原因码（契约要求 min 1），不选原因则是普通生成。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";
const PREVIOUS_RUN_ID = "bbbbbbb2-2222-4222-8222-222222222222";

function stubGateway(latestRunStatus: string | null) {
  const state = { startRequests: [] as unknown[] };
  const gateway = {
    contract: { enabledRoutes: ["note.detail", "note.cardGeneration"] },
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
        data: { primaryFocus: { state: "empty" }, activeGenerationSummary: { state: "empty" } },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "提取练习笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          permissions: { canEdit: true, canSave: true },
          currentVersion: { versionId: VERSION_ID, versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "h", blocks: [{ ordinal: 1, type: "paragraph", content: "正文" }] },
        },
      })),
      versions: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, items: [], total: 0 } })),
      cardGeneration: {
        latestRun: vi.fn(async () => (latestRunStatus === null
          ? { ok: false as const, workspaceEpoch: 1, error: { code: "not_found", message: "还没有生成记录" } }
          : {
              ok: true as const,
              workspaceEpoch: 1,
              data: {
                version: 1,
                runId: PREVIOUS_RUN_ID,
                noteId: NOTE_ID,
                noteVersionId: VERSION_ID,
                status: latestRunStatus,
                cardContentEpoch: 1,
                currentPlanVersion: 1,
                reviewDraftRevision: 1,
                sourceOutdated: false,
                sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
                recovery: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })),
        start: vi.fn(async (input: { request: unknown }) => {
          state.startRequests.push(input.request);
          return { ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } };
        }),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "card_generation.start": "allowed" },
          featureAvailability: { card_generation_v2: { state: "enabled" } },
        },
      })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeNoteRef: null, recentNoteId: null, surface: null, returnTarget: null, activeCardGenerationRunId: null });
});

async function openSettings() {
  const toggle = await waitFor(() => screen.getByRole("button", { name: "规划学习卡" }));
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "安排这次出题" })).toBeTruthy());
}

describe("NotebookSurface · 生成参数与反馈重生成", () => {
  it("参数选择进入请求，不再写死", async () => {
    const { state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    fireEvent.click(screen.getByRole("button", { name: "深入" }));
    fireEvent.click(screen.getByRole("button", { name: "12 张" }));
    // 默认全选题型（= 交给 planner 按知识形态分配），点一下即取消该题型。
    fireEvent.click(screen.getByRole("button", { name: "对比辨析" }));

    expect(screen.getByText(/这些是每张卡的思考策略/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect(state.startRequests[0]).toMatchObject({
      learningGoal: "apply",
      detailThreshold: "deep",
      quantity: { kind: "adaptive", hardMaxCards: 12 },
    });
    expect((state.startRequests[0] as { preferredStrategies: string[] }).preferredStrategies)
      .toEqual(["recall", "cloze", "sequence", "why", "boundary", "application"]);
    // 方案确认后，请求保留选定的卡型集合。
  });

  it("上次生成已结束时，选原因即按反馈重生成并带上 previousRunId", async () => {
    const { state } = stubGateway("closed_without_activation");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSettings();
    await waitFor(() => expect(screen.getByText(/上次生成已结束，未激活/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "卡片太多" }));
    fireEvent.change(screen.getByLabelText("重新生成的补充说明"), { target: { value: "最多 5 张" } });

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect(state.startRequests[0]).toMatchObject({
      feedbackContext: {
        previousRunId: PREVIOUS_RUN_ID,
        reasonCodes: ["too_many"],
        optionalNote: "最多 5 张",
      },
    });
  });

  it("编辑态同样摸得到版本历史与生成设置（复盘 #15）", async () => {
    // 这两个面板的 state 一直在同一个组件里，此前只有阅读页摆出按钮，
    // 于是"边写边看有哪几版""改完设置直接再生成"都只能先退回只读。
    stubGateway(null);
    useRoomStore.setState({
      activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "edit" },
    });
    render(<NotebookSurface />);
    await waitFor(() => expect(document.querySelector('.notebook[data-mode="edit"]')).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "规划学习卡" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "安排这次出题" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    await waitFor(() => expect(screen.getByLabelText("笔记版本历史")).toBeTruthy());
    expect(screen.getByText(/还没有可列出的版本/)).toBeTruthy();
  });

  it("没有生成记录时不显示反馈区，也不带 feedbackContext", async () => {
    const { state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSettings();
    expect(screen.queryByText(/针对上次/)).toBeNull();
    expect(screen.queryByRole("button", { name: "卡片太多" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect((state.startRequests[0] as { feedbackContext?: unknown }).feedbackContext).toBeUndefined();
  });
});
