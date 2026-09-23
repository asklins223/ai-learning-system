// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { ObjectiveDetailSurface } from "./WorkspaceLibrarySurface";
import { useRoomStore } from "../../app/room-store";

/**
 * 详情页右栏（31 号文档 P17，批次 B8）。
 *
 * 实机量到这一栏 644px 高、里面只有一条来源，`flex: 1` 把那一条撑满整栏，
 * 于是用户在一栏的绿色里读到三次「0 条原文证据」：栏头总数、来源行、
 * 再下一行的「没有留当时引用的原文」。这一组断言钉的是"负面事实只说一次"，
 * 以及**有**证据时那个数照旧要报出来（不是把数字整条删掉）。
 *
 * 版面本身（栏高、空洞、栏头折行）在 jsdom 里量不到，那部分由
 * `tmp-objflow-v-b8p17.mjs` 在实机三档量。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function origin(evidenceSnapshotIds: string[]) {
  return {
    originId: "00000000-0000-4000-8000-00000000000c",
    kind: "note",
    noteId: "00000000-0000-4000-8000-00000000000d",
    noteVersionId: "00000000-0000-4000-8000-00000000000e",
    sourceSnapshotId: null,
    evidenceSnapshotIds,
    integrity: "verified",
    supportGrade: "primary",
  };
}

function detail(origins: Array<ReturnType<typeof origin>>) {
  return learningObjectiveSurfaceV3Schema.parse({
    version: 3,
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "惯性与质量",
      publicSummary: "质量是惯性大小的唯一量度。",
      knowledgeForm: "fact",
      cardStrategy: "why",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins, primaryNote: null, missingOrigin: false },
    personal: {
      initialValidation: null, activeRun: null, review: null,
      practiceTrailCount: 0, lastCanonicalAt: null,
    },
    personalState: { state: "unvalidated", activeRunId: null },
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: {
      kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始首次验证",
      start: {
        version: 2,
        originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
        goal: "stabilize", requestedTimeBudgetSeconds: 180, responsePreference: "adaptive",
      },
    },
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  });
}

function installApi(objective: unknown) {
  Object.defineProperty(window, "ailearn", {
    value: {
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
      objective: {
        list: vi.fn(async () => ok({ version: 3, items: [], total: 0, nextCursor: null, snapshotAt: new Date().toISOString() })),
        get: vi.fn(async () => ok(objective)),
      },
      room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
      learningRun: { start: vi.fn(async () => ok({ runId: "r", snapshotId: "s" })) },
    },
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeObjectiveId: null, activeRunId: null, surface: null });
  vi.restoreAllMocks();
});

const ledgerText = async () => {
  const aside = await waitFor(() => {
    const el = document.querySelector(".objective-brief__dossier");
    expect(el).not.toBeNull();
    return el;
  });
  return (aside as Element).textContent ?? "";
};

const SNAPSHOT_IDS = ["00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-000000000010"];

describe("证据栏在没有原文引用时", () => {
  it("「0 条原文证据」整栏只出现一次（总数那一处）", async () => {
    useRoomStore.setState({ invoke: vi.fn(), activeObjectiveId: OBJECTIVE_ID });
    installApi(detail([origin([])]));
    render(<ObjectiveDetailSurface />);

    const text = await ledgerText();
    const occurrences = text.split("0 条原文证据").length - 1;
    expect(occurrences, `整栏说了 ${occurrences} 次「0 条原文证据」：${text}`).toBe(1);
    // 来源行仍然要说清它自己那条事实，不能被一起删掉。
    expect(text).toContain("没有留当时引用的原文");
  });

  it("真有原文引用时，来源行照旧报出自己的条数", async () => {
    useRoomStore.setState({ invoke: vi.fn(), activeObjectiveId: OBJECTIVE_ID });
    installApi(detail([origin(SNAPSHOT_IDS)]));
    render(<ObjectiveDetailSurface />);

    await ledgerText();
    const row = document.querySelector(".v3-origin-row");
    // 拿掉的是"0 条"这句重复的负面事实，不是数字本身。
    expect(row?.textContent).toContain("2 条原文证据");
  });
});
