// @vitest-environment jsdom

import { noteDocResult, seedUpdate } from "../../test-support/note-doc-fixtures";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objectiveListItemV3Schema, type ObjectiveListItemV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { NotebookSurface } from "./notebook-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 笔记页的那一颗主要动作（39d W4-2 第三刀）。
 *
 * 这一页过去只有"生成学习卡"一个动作，目标只是 meta 里的一行字（「学习卡：xxx」），
 * 于是"这一篇到底该做什么"要用户自己去列表里找。现在它按 `noteId` 读自己的目标，
 * 把服务端裁决好的那一个主行动画在正文上方。
 *
 * 这一组用例钉的是三件**没有别的层能替它证明**的事：
 *  1. 按钮上的动词与按下去的去处来自**同一个对象**（服务端那个 `primaryAction`）——
 *     这一页不另写词、也不自己拼一份 start；
 *  2. 这块是**增补**：读不到、读失败都不许把笔记本身顶掉（它过去整页只有笔记）；
 *  3. 取的是**这一篇**的目标，不是"最近更新的那一个"（同一次改动的服务端那一半
 *     已经有集测钉过，这里是桌面侧的最后一环）。
 *
 * 夹具走 `objectiveListItemV3Schema.parse`：合同与假数据漂移要红在这里，而不是红成
 * "页面上什么都没画"。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const OBJECTIVE_ID = "33333333-4333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const START = {
  version: 2,
  originV2: { kind: "today", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

/** 列表项夹具：默认"这一篇还没有学习记录"，各用例只覆盖自己要的那一格。 */
function listItem(overrides: Record<string, unknown> = {}): ObjectiveListItemV3 {
  return objectiveListItemV3Schema.parse({
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: null,
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteTitle: "物理笔记",
    createdAt: "2026-09-20T09:00:00.000Z",
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始学习", start: START },
    ...overrides,
  });
}

type Api = {
  objective: { list: ReturnType<typeof vi.fn> };
  learningRun: { start: ReturnType<typeof vi.fn> };
};

function installApi(list: () => Promise<unknown>): Api {
  const api: Api = {
    objective: { list: vi.fn(list) },
    learningRun: {
      start: vi.fn(async () => ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" })),
    },
  };
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      ...api,
      contract: { enabledRoutes: ["note.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })),
      },
      note: {
        get: vi.fn(async () => ok({
          noteId: NOTE_ID,
          title: "物理笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-24T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks: [{ ordinal: 1, type: "paragraph", content: "质量是惯性大小的唯一量度。" }],
          },
        })),
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedUpdate("物理笔记", []) })),
          syncUpdate: vi.fn(),
          presence: vi.fn(async () => ok({ shared: false })),
        },
      },
      capabilities: {
        get: vi.fn(async () => ok({
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
        })),
      },
      source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
      subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
  return api;
}

async function show(items: ObjectiveListItemV3[] | "fail") {
  const api = installApi(
    items === "fail"
      ? async () => { throw new Error("gateway offline"); }
      : async () => ok({
          version: 3,
          items,
          total: items.length,
          nextCursor: null,
          snapshotAt: new Date().toISOString(),
        }),
  );
  const invoke = vi.fn();
  useRoomStore.setState({ invoke, activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
  vi.useFakeTimers();
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  return { ...view, api, invoke, objectiveBlock: () => view.container.querySelector<HTMLElement>(".notebook-objective") };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, invoke: undefined, surface: null, activeRunId: null, activeObjectiveId: null });
});

describe("笔记页的主要动作", () => {
  it("按钮上就是服务端那个动词，下面跟着它那一句理由", async () => {
    const { objectiveBlock } = await show([listItem()]);
    const block = objectiveBlock()!;
    expect(block.querySelector("button")!.textContent).toBe("开始学习");
    expect(block.querySelector("p")!.textContent).toBe("开始学习，完成后会写回这一题的真实状态。");
  });

  it("按下去发的是 action 自带的那份 start，开出来的那一轮随即接上旅程界面", async () => {
    const { api, invoke, objectiveBlock } = await show([listItem()]);
    fireEvent.click(objectiveBlock()!.querySelector("button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    const input = api.learningRun.start.mock.calls[0][0] as { request: unknown };
    // 逐字节比：这一页若自己拼一份 start，最可能拼错的就是 origin 那一格
    // （无卡目标要 `today`，拼成 `card` 会在服务端 `target_evidence_missing` 上撞墙）。
    expect(input.request).toEqual(START);
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
  });

  it("上一轮没答完：动词换成「继续作答」，按下去不许再开一轮", async () => {
    const { api, invoke, objectiveBlock } = await show([listItem({
      personalState: { state: "learning", activeRunId: RUN_ID },
      primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: OBJECTIVE_ID },
    })]);
    const button = objectiveBlock()!.querySelector("button")!;
    expect(button.textContent).toBe("继续作答");
    expect(objectiveBlock()!.querySelector("p")!.textContent).toBe("上次保存的进度还在，不会从头再来。");
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invoke).toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("这一篇还没有目标：那一行整个不画，笔记照旧在纸上", async () => {
    const { container, objectiveBlock } = await show([]);
    expect(objectiveBlock()).toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });

  it("那一次读取失败不许把整篇笔记换成错误页", async () => {
    const { container, objectiveBlock } = await show("fail");
    expect(objectiveBlock()).toBeNull();
    expect(container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });

  it("读的是「这一篇」的目标，不是最近更新的那一个", async () => {
    const { api } = await show([listItem()]);
    const input = api.objective.list.mock.calls[0][0] as Record<string, unknown>;
    expect(input.noteId).toBe(NOTE_ID);
    expect(input.lifecycle).toBe("active");
    expect(input.limit).toBe(1);
  });

  it("只画服务端排在前面的那一个，同一篇上的第二个目标不并成第二颗按钮", async () => {
    const second = listItem({
      objectiveId: "66666666-4666-4666-8666-666666666666",
      primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: "66666666-4666-4666-8666-666666666666" },
    });
    // 夹具故意回两条：`limit: 1` 只是请求，服务端真回几条不由客户端保证——
    // 这一页必须只取第一条，否则"一个主要动作"这句话就是空的。
    const { objectiveBlock } = await show([listItem(), second]);
    const buttons = [...objectiveBlock()!.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["开始学习"]);
  });

  it("正文已有新版本 ⇒ 主动作附一枚「来源已有更新」，最新时不画", async () => {
    const stale = await show([listItem({ freshness: "source_outdated" })]);
    const lines = [...stale.objectiveBlock()!.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual(["来源已有更新", "开始学习，完成后会写回这一题的真实状态。"]);

    const fresh = await show([listItem({ freshness: "fresh" })]);
    expect([...fresh.objectiveBlock()!.querySelectorAll("p")].map((p) => p.textContent))
      .toEqual(["开始学习，完成后会写回这一题的真实状态。"]);
  });

  it("开轮次在飞的时候按钮禁用，一次点击不开出两条", async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = installApi(async () => ok({
      version: 3, items: [listItem()], total: 1, nextCursor: null, snapshotAt: new Date().toISOString(),
    }));
    api.learningRun.start.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    useRoomStore.setState({ invoke: vi.fn(), activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    vi.useFakeTimers();
    const view = render(<NotebookSurface />);
    for (let i = 0; i < 14; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    const button = view.container.querySelector<HTMLButtonElement>(".notebook-objective button")!;
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    release(ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(button.disabled).toBe(false);
  });

  it("开轮次失败：那一行不消失，但把为什么写在按钮下面", async () => {
    const api = installApi(async () => ok({
      version: 3, items: [listItem()], total: 1, nextCursor: null, snapshotAt: new Date().toISOString(),
    }));
    api.learningRun.start.mockRejectedValue(new Error("offline"));
    useRoomStore.setState({ invoke: vi.fn(), activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "read" } });
    vi.useFakeTimers();
    const view = render(<NotebookSurface />);
    for (let i = 0; i < 14; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    const block = view.container.querySelector(".notebook-objective")!;
    fireEvent.click(block.querySelector("button")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const alert = block.querySelector('[role="alert"]');
    // 取的是 `gatewayErrorMessage` 那一份唯一口径，不是这一页自己写的句子。
    expect(alert?.textContent).toBe("服务暂时没有返回可确认的结果。");
    // 也不能因为一次失败就把整行撤掉：她刚点过，行没了会被读成"没点上"。
    expect(block.querySelector("button")?.textContent).toBe("开始学习");
    expect(view.container.querySelector(".reading-body")?.textContent).toContain("质量是惯性大小的唯一量度。");
  });
});
