// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { ObjectiveDetailSurface } from "./WorkspaceLibrarySurface";
import { useRoomStore } from "../../app/room-store";

/**
 * 卷宗里的「主笔记」入口（审计 F05）。
 *
 * 病是这么来的：这颗按钮只 `invoke("open-notebook")`，**不带指的是哪一篇**——阅读面
 * 于是按 store 里残留的 `activeNoteRef`（或首页焦点目标的主笔记）打开。实测在非焦点
 * 目标 `IndexTTS 2.5 GRPO 后训练机制` 上点"主笔记 IndexTTS…"，打开的是另一个目标的
 * `E2E Test Note — Key Science Concepts`。
 *
 * 这一组钉住：入口自己把身份交出去——点谁开谁；先访问别的笔记再回来也不串。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "00000000-0000-4000-8000-000000000042";
const VERSION_ID = "00000000-0000-4000-8000-000000000043";
const RUN_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_VERSION_ID = "00000000-0000-4000-8000-0000000000ab";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function detail(primaryNote: { noteId: string; noteVersionId: string; title: string } | null) {
  return learningObjectiveSurfaceV3Schema.parse({
    version: 3,
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "GRPO 后训练机制",
      publicSummary: "用组内相对优势替代价值函数。",
      knowledgeForm: "fact",
      cardStrategy: "why",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins: [], primaryNote, missingOrigin: false },
    personal: {
      initialValidation: null,
      activeRun: { runId: RUN_ID, phase: "checkpoint" },
      review: null,
      practiceTrailCount: 0,
      lastCanonicalAt: null,
    },
    personalState: { state: "learning", activeRunId: RUN_ID },
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: OBJECTIVE_ID },
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  });
}

function installApi(objective: unknown) {
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
    objective: {
      list: vi.fn(async () => ok({ version: 3, items: [], total: 0, nextCursor: null, snapshotAt: new Date().toISOString() })),
      get: vi.fn(async () => ok(objective)),
    },
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
    learningRun: { start: vi.fn() },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function stubRoom() {
  const invoke = vi.fn();
  useRoomStore.setState({ invoke, activeObjectiveId: OBJECTIVE_ID });
  return { invoke };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeObjectiveId: null, activeNoteRef: null, surface: null });
  vi.restoreAllMocks();
});

describe("卷宗的「主笔记」（审计 F05）", () => {
  it("点谁开谁：按这颗按钮上写的那一篇设 ref，再导航", async () => {
    installApi(detail({ noteId: NOTE_ID, noteVersionId: VERSION_ID, title: "IndexTTS 2.5 让声音跨越语言" }));
    const { invoke } = stubRoom();
    render(<ObjectiveDetailSurface />);

    const button = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>("button.v3-primary-note");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(button);

    expect(useRoomStore.getState().activeNoteRef).toEqual({ noteId: NOTE_ID, noteVersionId: VERSION_ID });
    expect(invoke).toHaveBeenCalledWith("open-notebook");
  });

  it("先访问过别的笔记也不会串：ref 每次由入口自己写", async () => {
    installApi(detail({ noteId: NOTE_ID, noteVersionId: VERSION_ID, title: "这篇的笔记" }));
    stubRoom();
    // 上一次留下的、属于另一篇的 ref。
    useRoomStore.setState({ activeNoteRef: { noteId: OTHER_NOTE_ID, noteVersionId: OTHER_VERSION_ID } });
    render(<ObjectiveDetailSurface />);

    const button = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>("button.v3-primary-note");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(button);

    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(NOTE_ID);
  });

  it("没有关联主笔记时不给按钮：只有一句说明，不拿别的笔记顶上", async () => {
    installApi(detail(null));
    stubRoom();
    render(<ObjectiveDetailSurface />);

    await waitFor(() => expect(document.querySelector(".v3-primary-note--missing")).not.toBeNull());
    expect(document.querySelector<HTMLButtonElement>("button.v3-primary-note")).toBeNull();
  });
});
