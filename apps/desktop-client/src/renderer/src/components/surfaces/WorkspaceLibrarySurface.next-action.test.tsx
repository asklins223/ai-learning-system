// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { ObjectiveDetailSurface } from "./WorkspaceLibrarySurface";
import { useRoomStore } from "../../app/room-store";

/**
 * 详情页的主行动块（31 号文档 P15，批次 B8）。
 *
 * 新简报只有一个 `.objective-brief__launch` 主行动按钮，里面的
 * `<strong>` 写着「继续作答」，右边那颗 77×28 的按钮**也**写着「继续作答」。
 * 一个词占两行，真正能按的只有 5% 的面积。现在整块就是那颗按钮。
 *
 * 整块可点带来一个新的风险：按钮的可及名会变成纸上所有内容，读屏每次都要念完
 * 两句解释。所以这里同时钉住「名字只有动词、解释走 describedby」。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000007";
const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

// 走 schema.parse：夹具和合同一旦漂移，红在这里而不是红在页面上。
function detail(overrides: Record<string, unknown> = {}) {
  return learningObjectiveSurfaceV3Schema.parse({
    version: 3,
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "惯性与质量",
      publicSummary: "质量是惯性大小的唯一量度。",
      knowledgeForm: "fact",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins: [], primaryNote: null, missingOrigin: false },
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
    ...overrides,
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
    learningRun: {
      start: vi.fn(async (_input: { meta: unknown; commandId: string; request: unknown }) =>
        ok({ runId: RUN_ID, snapshotId: "00000000-0000-4000-8000-000000000008" })),
    },
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
  useRoomStore.setState({ activeObjectiveId: null, activeRunId: null, surface: null });
  vi.restoreAllMocks();
});

describe("详情页的主行动块", () => {
  it("那个动词只出现一次——标题不再和按钮抢同一个词", async () => {
    installApi(detail());
    stubRoom();
    render(<ObjectiveDetailSurface />);

    const block = await waitFor(() => {
      const el = document.querySelector(".objective-brief__launch");
      expect(el).not.toBeNull();
      return el;
    });
    const text = (block as Element).textContent ?? "";
    const occurrences = text.split("继续作答").length - 1;
    expect(occurrences, `「继续作答」在块里出现了 ${occurrences} 次：${text}`).toBe(1);
  });

  it("整块就是那颗按钮，按下去真的去接着跑这一轮", async () => {
    const api = installApi(detail());
    const { invoke } = stubRoom();
    render(<ObjectiveDetailSurface />);

    const block = await waitFor(() => {
      const el = document.querySelector(".objective-brief__launch");
      expect(el).not.toBeNull();
      return el;
    });
    expect(block!.tagName).toBe("BUTTON");
    fireEvent.click(block!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("validate"));
    // resume_run 不该再发起一个 run。
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("最近完成的结果可以重开，且再次挑战不会覆盖旧记录", async () => {
    const api = installApi(detail({
      personal: {
        initialValidation: null,
        activeRun: null,
        review: null,
        practiceTrailCount: 1,
        lastCanonicalAt: null,
        latestResult: { runId: RUN_ID, completedAt: "2026-09-20T17:12:00.000Z", outcome: "practice_completed" },
      },
      personalState: { state: "unvalidated", activeRunId: null },
      primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始学习", start: CARD_START },
    }));
    const { invoke } = stubRoom();
    render(<ObjectiveDetailSurface />);
    const previous = await waitFor(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("回看上次结果"));
      expect(button).toBeTruthy();
      return button!;
    });
    expect(document.body.textContent).toContain("练习已完成");
    expect(document.querySelector(".objective-brief__launch")?.textContent).toContain("再挑战一次");
    fireEvent.click(previous);
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("读屏只念动词，两句解释走 describedby——否则整块可读成一段纸", async () => {
    installApi(detail());
    stubRoom();
    render(<ObjectiveDetailSurface />);

    const byName = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[aria-labelledby="objective-next-action-verb"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(byName!.tagName).toBe("BUTTON");
    expect(byName!.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "objective-next-action-state",
      "objective-next-action-why",
    ]);
    for (const id of byName!.getAttribute("aria-describedby")!.split(" ")) {
      const described = document.getElementById(id);
      expect(described, `describedby 指向的 ${id} 不存在`).not.toBeNull();
      expect(described!.textContent?.trim(), `${id} 是空的，等于没解释`).not.toBe("");
    }
  });

  it("没有可执行动作时整块禁用，但两句解释照旧在纸上", async () => {
    installApi(detail({
      personalState: { state: "unvalidated", activeRunId: null },
      primaryAction: {
        kind: "wait_for_initial_validation",
        reminderId: "00000000-0000-4000-8000-00000000000b",
        qualificationNotBefore: "2026-10-01T09:00:00.000Z",
      },
    }));
    stubRoom();
    render(<ObjectiveDetailSurface />);

    const block = await waitFor(() => {
      const el = document.querySelector(".objective-brief__launch");
      expect(el?.textContent).toContain("现在还不能正式答");
      return el;
    });
    expect((block as HTMLButtonElement).disabled).toBe(true);
    // 复盘 #9：只留一个按不动的按钮，用户读到的是"产品坏了"。禁用态必须自带原因。
    const reason = document.getElementById("objective-next-action-why");
    expect((block as Element).getAttribute("aria-describedby")).toContain("objective-next-action-why");
    expect(reason?.textContent).toContain("才能开始正式验证");
  });
});
