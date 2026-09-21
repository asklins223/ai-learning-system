// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 笔记页的生成入口是状态同步，不是第二次启动：
 * - 本笔记有进行中的 run 时，按钮变成"去工作台看进度"，start 绝不被调用；
 * - 订阅事件到达时静默重读 projection，按钮跟随 run 的真实阶段；
 * - 没有 run 时才允许 start，成功后带着 runId 跳转工作台。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";
const OTHER_NOTE_ID = "11111111-1111-4111-8111-111111111112";
const OTHER_RUN_ID = "aaaaaaa2-2222-4222-8222-222222222222";

function generationSummary(status: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    updatedAt: new Date().toISOString(),
    recovery: null,
    route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID },
    ...overrides,
  };
}

function stubGateway(initialGenerationStatus: string | null, extraSummaries: object[] = [], options: { startRejects?: boolean } = {}) {
  const state = {
    generationStatus: initialGenerationStatus,
    projectionReads: 0,
    startCalls: 0,
    eventHandlers: new Map<string, () => void>(),
  };
  const projection = () => ({
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
    activeGenerationSummary: state.generationStatus || extraSummaries.length
      ? {
        state: "data",
        data: [
          ...extraSummaries,
          ...(state.generationStatus ? [generationSummary(state.generationStatus)] : []),
        ],
      }
      : { state: "empty" },
  });
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
      getProjection: vi.fn(async () => {
        state.projectionReads += 1;
        return { ok: true as const, workspaceEpoch: 1, data: projection() };
      }),
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
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash",
            blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }],
          },
        },
      })),
      cardGeneration: {
        start: vi.fn(async () => {
          state.startCalls += 1;
          if (options.startRejects) {
            // 服务端早已在跑这篇的批次，只是页面那一刻没看到。
            state.generationStatus = "review_ready";
            throw new Error("note_generation_in_flight");
          }
          return { ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } };
        }),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed", "card_generation.start": "allowed" },
          featureAvailability: {
            card_generation_v2: { state: "enabled" },
            companion_dialogue_v1: { state: "disabled" },
          },
        },
      })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn((_subscriptionId: string, handler: () => void) => {
        state.eventHandlers.set("sub-1", handler);
        return () => state.eventHandlers.delete("sub-1");
      }),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ surface: null, activeCardGenerationRunId: null, activeNoteRef: null, returnTarget: null });
});

describe("NotebookSurface · 学习卡生成状态同步", () => {
  it("本笔记有进行中的 run 时，入口变成查看进度且不重复 start", async () => {
    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("查看生成进度");

    fireEvent.click(entry);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(0);
  });

  /**
   * 2026-09-20 实走复盘 #5：projection 曾只带「最近更新的那一个」run，
   * 于是另一篇笔记一开跑，这篇的守卫就失效——同一篇笔记可以再点一次
   * 「生成学习卡」，每点一次多一批候选卡，旧批次又不会被任何环节标成废弃。
   */
  it("另一篇笔记的在制批次排在前面时，这篇自己的批次仍然生效", async () => {
    const otherNoteRun = generationSummary("authoring", {
      noteId: OTHER_NOTE_ID,
      runId: OTHER_RUN_ID,
      route: { kind: "note.cardGeneration", cardGenerationRunId: OTHER_RUN_ID },
    });
    const { state } = stubGateway("review_ready", [otherNoteRun]);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle, queryByText } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("审核学习卡");
    expect(queryByText("生成学习卡")).toBeNull();

    fireEvent.click(entry);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(0);
  });

  it("订阅事件触发静默重读，按钮跟随 run 阶段翻转到审核", async () => {    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("查看生成进度");
    const readsAfterMount = state.projectionReads;
    await waitFor(() => expect(state.eventHandlers.has("sub-1")).toBe(true));

    state.generationStatus = "review_ready";
    state.eventHandlers.get("sub-1")?.();

    const reviewed = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(reviewed.textContent).toContain("审核学习卡");
    expect(state.projectionReads).toBeGreaterThan(readsAfterMount);
    expect(state.startCalls).toBe(0);
  });

  it("没有 run 时入口是生成学习卡，start 成功后带 runId 跳转工作台", async () => {
    const { gateway, state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByText } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByText("生成学习卡"));
    expect(gateway.subscriptions.subscribe).not.toHaveBeenCalled();

    fireEvent.click(entry);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(1);
  });

  it("被服务端拒绝后重读状态：入口翻到真实阶段，不再反复撞同一个拒绝", async () => {
    const { state } = stubGateway(null, [], { startRejects: true });
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByText, getByRole, getByTitle } = render(<NotebookSurface />);

    fireEvent.click(await waitFor(() => getByText("生成学习卡")));

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("审核学习卡");
    expect(state.startCalls).toBe(1);

    // 再点入口是去看那一批，不是再开一次生成。
    fireEvent.click(entry);
    expect(state.startCalls).toBe(1);
  });
});
