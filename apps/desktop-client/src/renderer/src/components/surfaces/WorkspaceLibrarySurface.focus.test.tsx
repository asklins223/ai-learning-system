// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "./WorkspaceLibrarySurface";
import { retargetObjectiveLibraryView } from "./objective-library-view-state";
import { useRoomStore } from "../../app/room-store";

/**
 * 列表焦点卡那颗按钮（31 号文档 P9）。
 *
 * 病是这么来的：按钮上印的是服务端签发的动词（「继续作答」「开始首次验证」），
 * `onClick` 却只调 `openObjective`——按下去只是把详情页打开。用户以为已经开始了，
 * 结果还站在列表上；同一个动词在详情页里又真的会开始旅程。本文件钉住
 * 「按钮上的词 = 按下去发生的事」，并且钉住列表行不再冒充开始入口。
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

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteTitle: "物理笔记",
    createdAt: new Date().toISOString(),
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0, lastCanonicalAt: null, reviewDueAt: null,
      initialValidation: null, validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始首次验证", start: CARD_START },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>, page: { total?: number; nextCursor?: string | null } = {}) {
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
    objective: {
      list: vi.fn(async () => ok({
        version: 3, items, total: page.total ?? items.length,
        nextCursor: page.nextCursor ?? null, snapshotAt: new Date().toISOString(),
      })),
      get: vi.fn(async () => ok({})),
    },
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
    // 给 start 标注入参类型：不标的话 vi.fn 推成零参，下面读 calls[0][0] 在
    // typecheck 里是 `Tuple type '[]' has no element at index '0'`，而 vitest
    // 不做类型检查——测试照样绿着把这条类型错带进仓库。
    learningRun: {
      start: vi.fn(async (_input: {
        meta: unknown;
        commandId: string;
        request: { originV2: { cardId: string; objectiveId: string } };
      }) => ok({ runId: RUN_ID, snapshotId: "00000000-0000-4000-8000-000000000008" })),
    },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function stubRoom() {
  const invoke = vi.fn();
  // 只换 invoke；setActiveRunId / setActiveObjectiveId 用真的，这样断言
  // 「activeRunId 被写进去了」量的仍是实际行为。
  useRoomStore.setState({ invoke });
  return { invoke };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  retargetObjectiveLibraryView("ws-1");
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null });
  vi.restoreAllMocks();
});

describe("列表焦点卡的主行动", () => {
  it('写着「开始首次验证」就真的去 start，而不是打开详情页', async () => {
    const api = installApi([listItem()]);
    const { invoke } = stubRoom();
    render(<ObjectiveLibrarySurface />);

    const button = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(".v3-goal-focus__action");
      expect(b?.textContent).toContain("开始首次验证");
      return b;
    });
    fireEvent.click(button!);

    await waitFor(() => expect(api.learningRun.start).toHaveBeenCalledTimes(1));
    const sent = api.learningRun.start.mock.calls[0][0];
    expect(sent.request.originV2.cardId).toBe("00000000-0000-4000-8000-000000000003");
    expect(sent.commandId).toContain("start-objective-run");
    // 关键的那一条：它不该被当成"打开详情"。
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["validate"]);
    expect(invoke).not.toHaveBeenCalledWith("open-objective");
  });

  it('写着「继续作答」就把已有的 run 接着跑起来，也不发起新 run', async () => {
    const api = installApi([listItem({
      personalState: { state: "in_progress", activeRunId: RUN_ID },
      primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: OBJECTIVE_ID },
    })]);
    const { invoke } = stubRoom();
    render(<ObjectiveLibrarySurface />);

    const button = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(".v3-goal-focus__action");
      expect(b?.textContent).toContain("继续作答");
      return b;
    });
    fireEvent.click(button!);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("validate"));
    expect(api.learningRun.start).not.toHaveBeenCalled();
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    expect(invoke).not.toHaveBeenCalledWith("open-objective");
  });

  it("详情页仍然是另一条路：只有「先看这条目标的详情」那颗才走 open-objective", async () => {
    installApi([listItem()]);
    const { invoke } = stubRoom();
    render(<ObjectiveLibrarySurface />);

    const detail = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(".v3-goal-focus__detail");
      expect(b).not.toBeNull();
      return b;
    });
    fireEvent.click(detail!);
    expect(invoke).toHaveBeenCalledWith("open-objective");
  });

  it("列表行不再冒充开始入口——右边写的是它带你去哪", async () => {
    installApi([listItem()]);
    render(<ObjectiveLibrarySurface />);

    await waitFor(() => expect(document.querySelector(".v3-goal-row")).not.toBeNull());
    const next = document.querySelector(".v3-goal-row__next")?.textContent ?? "";
    expect(next).toContain("进入详情");
    // 服务端的动词只该出现在焦点卡那颗真会执行它的按钮上。
    expect(next).not.toContain("开始首次验证");
  });
});

describe("读取计数的说法", () => {
  /**
   * 31 号文档 P12 撤回后留下的那一条：`已载入 16 / 16 条` 里的斜杠让人以为外面
   * 还有一个更大的池子没读进来，而 `nextCursor` 为 null 时并没有。搜索框的
   * placeholder 同理——它承诺的范围要跟着实际范围走。
   */
  const counter = async () => {
    await waitFor(() => expect(document.querySelector(".v3-goal-ledger__header p")).not.toBeNull());
    return document.querySelector(".v3-goal-ledger__header p")?.textContent ?? "";
  };

  it("全部读完时只说总数，不再摆一个 16 / 16", async () => {
    installApi([listItem(), listItem({ objectiveId: "00000000-0000-4000-8000-000000000002" })]);
    render(<ObjectiveLibrarySurface />);

    const text = await counter();
    expect(text).toContain("共 2 条");
    expect(text).not.toContain("已载入");
    expect(document.querySelector(".v3-goal-search input")?.getAttribute("placeholder")).toBe("搜索全部理解目标");
  });

  it("确实还有下一页时才报「已载入 X / Y」，placeholder 也收回已载入范围", async () => {
    installApi([listItem()], { total: 40, nextCursor: "cursor-2" });
    render(<ObjectiveLibrarySurface />);

    const text = await counter();
    expect(text).toContain("已载入 1 / 40 条");
    expect(text).not.toContain("共 40 条");
    expect(document.querySelector(".v3-goal-search input")?.getAttribute("placeholder")).toBe("搜索已载入目标");
  });
});
