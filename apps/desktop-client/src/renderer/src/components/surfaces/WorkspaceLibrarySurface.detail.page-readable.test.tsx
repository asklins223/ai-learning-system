// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import { ObjectiveDetailSurface } from "./WorkspaceLibrarySurface";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「挑战简报」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 这一页的三个负面事实（没有主笔记／没有可公开出处／还没选卡）必须**只说一次**，
 * 而且她说出口的那一句得是屏上真写着的那一句——所以每条断言都同时读 DOM 与 store。
 * `title` 这里取的是**这一张卡自己的名字**（外框那三个词都不是答案）。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function origin(overrides: Record<string, unknown> = {}) {
  return {
    originId: "00000000-0000-4000-8000-00000000000c",
    kind: "note",
    noteId: "00000000-0000-4000-8000-00000000000d",
    noteVersionId: "00000000-0000-4000-8000-00000000000e",
    sourceSnapshotId: null,
    evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
    integrity: "verified",
    supportGrade: "primary",
    ...overrides,
  };
}

function detail(origins: ReturnType<typeof origin>[], primaryNote: Record<string, unknown> | null, personal: Record<string, unknown> = {}) {
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
    sources: { origins, primaryNote, missingOrigin: false },
    personal: {
      initialValidation: null,
      activeRun: null,
      review: null,
      practiceTrailCount: 3,
      lastCanonicalAt: null,
      latestResult: null,
      ...personal,
    },
    personalState: { state: "unvalidated", activeRunId: null },
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: {
      kind: "create_run",
      objectiveId: OBJECTIVE_ID,
      label: "开始首次验证",
      start: {
        version: 2,
        originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 180,
        responsePreference: "adaptive",
      },
    },
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  });
}

function installApi(objective: unknown | null) {
  const api = {
    auth: {
      getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
    },
    objective: {
      get: vi.fn(async () => {
        if (objective === null) throw new Error("nope");
        return ok(objective);
      }),
    },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function metric(label: string): string | undefined {
  return publishedView()?.metrics?.find((entry) => entry.label === label)?.value;
}

/** 那一列三条事实：`<span>` 是名字，`<strong>` 是屏上写着的那个值。 */
function factLines(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const li of document.querySelectorAll(".objective-brief__departure ul li")) {
    const name = li.querySelector("span")?.textContent ?? "";
    map.set(name, li.querySelector("strong")?.textContent ?? null);
  }
  return map;
}

async function renderDetail(objective: unknown) {
  installApi(objective);
  useRoomStore.setState({ activeObjectiveId: OBJECTIVE_ID });
  render(<ObjectiveDetailSurface />);
  await waitFor(() => expect(publishedView()).not.toBeNull());
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeObjectiveId: null, pageReadableView: null });
  vi.restoreAllMocks();
});

describe("挑战简报：她说出的每一句都是屏上写着的", () => {
  it("卡名、那一行状态、三条事实、出处清单全部与 DOM 逐字相同", async () => {
    await renderDetail(detail([origin()], { noteId: "00000000-0000-4000-8000-00000000000d", noteVersionId: "00000000-0000-4000-8000-00000000000e", title: "物理笔记" }));
    const view = publishedView()!;
    expect(view.pageId).toBe("goal_detail");
    expect(view.title).toBe(document.querySelector(".objective-brief__masthead h3")?.textContent);
    expect(view.statusLine).toBe(document.querySelector("#objective-next-action-state")?.textContent);
    const facts = factLines();
    expect(metric("正式验证")).toBe(facts.get("正式验证"));
    expect(metric("当前旅程")).toBe(facts.get("当前旅程"));
    expect(metric("复习安排")).toBe(facts.get("复习安排"));
    expect(metric("练习")).toBe(document.querySelector(".objective-brief__progress-heading span")?.textContent);
    expect(metric("卡型")).toBe(document.querySelector(".objective-card-type--brief strong")?.textContent);
    expect(metric("状态")).toBe(document.querySelector(".objective-brief__flags .v3-objective-state")?.textContent);
    // 出处行：`label` 就是那行的 `<strong>`，`state` 就是那行的 `<p>` 整句
    // （含"· N 条原文证据"那段）——两句都是屏上原样，不在视图里重新拼。
    const originRow = document.querySelector(".v3-origin-row")!;
    expect(view.items).toHaveLength(1);
    expect(view.items?.[0].label).toBe(originRow.querySelector("strong")?.textContent);
    expect(view.items?.[0].state).toBe(originRow.querySelector("p")?.textContent);
    expect(view.items?.[0].state).toContain("1 条原文证据");
    expect(view.notice).toBeUndefined();
  });

  it("没有主笔记时说的是那一句；有主笔记但没有出处时换成出处那一句", async () => {
    await renderDetail(detail([], null));
    expect(publishedView()!.notice).toBe(document.querySelector(".v3-primary-note--missing strong")?.textContent);
    expect(publishedView()!.items).toBeUndefined();
    // 同一份 store 上换一次挂载：先清掉上一个实例，否则槽位上是它留下的那一句。
    cleanup();
    useRoomStore.setState({ pageReadableView: null });
    await renderDetail(detail([], { noteId: "00000000-0000-4000-8000-00000000000d", noteVersionId: "00000000-0000-4000-8000-00000000000e", title: "物理笔记" }));
    expect(publishedView()!.notice).toBe(document.querySelector(".v3-origin-empty strong")?.textContent);
  });

  /**
   * 三条事实的中文是**分档表**查出来的（审计 F10 之后那些词都是逐字定过的），
   * 而默认的替身里 `initialValidation: null` ⇒ 三条都走兜底那一支，
   * 查表那几支今天就有用例覆盖不到（把枚举原值登记进去也照样绿）。
   */
  it("三条事实都非默认时，登记的仍是屏上那三个词", async () => {
    await renderDetail(detail([], { noteId: "00000000-0000-4000-8000-00000000000d", noteVersionId: "00000000-0000-4000-8000-00000000000e", title: "物理笔记" }, {
      initialValidation: { reminderId: "88888888-8888-4888-8888-888888888888", status: "deferred", qualificationNotBefore: null },
      activeRun: { runId: "99999999-9999-4999-8999-999999999999", phase: "assessing" },
      review: { status: "due", scheduleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1, dueAt: "2026-09-24T00:00:00.000Z" },
    }));
    const facts = factLines();
    const view = publishedView()!;
    expect(facts.get("正式验证")).toBe("等待开放");
    expect(view.metrics?.find((entry) => entry.label === "正式验证")?.value).toBe(facts.get("正式验证"));
    expect(view.metrics?.find((entry) => entry.label === "当前旅程")?.value).toBe(facts.get("当前旅程"));
    expect(facts.get("当前旅程")).toBe("回答已锁定，正在评估");
    expect(view.metrics?.find((entry) => entry.label === "复习安排")?.value).toBe("已经到期");
    expect(facts.get("复习安排")).toBe("已经到期");
  });

  it("还没选卡：登记的是外框那一格与空态那一句，不编任何一张卡", async () => {
    installApi(null);
    useRoomStore.setState({ activeObjectiveId: null });
    render(<ObjectiveDetailSurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.title).toBe(document.querySelector(".approved-surface h2")?.textContent ?? view.title);
    expect(view.statusLine).toBe(document.querySelector(".surface-state strong, .approved-surface .surface-state strong")?.textContent ?? view.statusLine);
    expect(view.metrics).toBeUndefined();
    expect(view.items).toBeUndefined();
    expect(view.notice).toContain("还没有选择学习卡");
  });

  it("详情读回来之前不登记（她不能读到上一张卡的简报）", async () => {
    let release: (value: unknown) => void = () => undefined;
    Object.defineProperty(window, "ailearn", {
      configurable: true,
      value: {
        auth: {
          getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
        },
        objective: { get: vi.fn(() => new Promise((resolve) => { release = resolve; })) },
      },
    });
    useRoomStore.setState({ activeObjectiveId: OBJECTIVE_ID });
    const { unmount } = render(<ObjectiveDetailSurface />);
    await waitFor(() => expect(document.body.textContent).toContain("正在读取目标详情"));
    expect(publishedView()).toBeNull();
    release(ok(detail([], null)));
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});
