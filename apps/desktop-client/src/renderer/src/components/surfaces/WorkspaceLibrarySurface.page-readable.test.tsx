// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "./WorkspaceLibrarySurface";
import { resetObjectiveLibraryView, retargetObjectiveLibraryView, writeObjectiveLibraryView } from "./objective-library-view-state";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「学习卡」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 这一页的特殊之处是**远征册默认收着**：收着时屏幕上只有焦点卡与纸上远征图，
 * 每个区域最多露两颗节点。所以本文件钉的第一件事是"登记的是当前露出来的那一份清单"，
 * 第二件事才是逐字相同——把册子里没露面的行登记进去，她会报出一屏根本没显示的东西。
 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function listItem(index: number, overrides: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-00000000000${index}`;
  return {
    objectiveId: id,
    surfaceRevision: 1,
    conceptLabel: `卡 ${index}`,
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: "why",
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteTitle: "物理笔记",
    createdAt: new Date().toISOString(),
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: id, label: "开始首次验证", start: CARD_START },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>, options: { nextCursor?: string | null } = {}) {
  const api = {
    auth: {
      getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
    },
    objective: {
      list: vi.fn(async () => ok({
        version: 3,
        items,
        total: items.length,
        nextCursor: options.nextCursor ?? null,
        snapshotAt: new Date().toISOString(),
      })),
      get: vi.fn(async () => ok({})),
    },
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
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

function filterValue(label: string): string | undefined {
  return publishedView()?.filters?.find((entry) => entry.label === label)?.value;
}

async function renderLibrary(items: Array<Record<string, unknown>>, options?: { nextCursor?: string | null }) {
  installApi(items, options);
  render(<ObjectiveLibrarySurface />);
  await waitFor(() => expect(publishedView()).not.toBeNull());
}

async function openIndex(): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>(".objective-expedition__index-toggle");
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
  await waitFor(() => expect(document.querySelector(".v3-goal-list")).not.toBeNull());
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  resetObjectiveLibraryView();
  useRoomStore.setState({ pageReadableView: null, activeObjectiveId: null, activeRunId: null });
  vi.restoreAllMocks();
});

describe("学习卡列表：登记的是当前露出来的那一份", () => {
  it("册子收着：焦点卡的卡型/状态、区域计数、远征图节点全部与 DOM 逐字相同", async () => {
    await renderLibrary([listItem(1)]);
    const view = publishedView()!;
    expect(view.pageId).toBe("goals");
    expect(view.title).toBe(document.querySelector(".approved-surface h2")?.textContent);
    expect(view.statusLine).toBe(document.querySelector(".objective-expedition__mode-copy")?.textContent);
    const focusFlags = [...document.querySelectorAll(".objective-expedition__focus-flags strong")]
      .map((node) => node.textContent);
    expect(metric("卡型")).toBe(focusFlags[0]);
    expect(metric("状态")).toBe(document.querySelector(".objective-expedition__focus-flags .v3-objective-state")?.textContent);
    expect(metric("远征册")).toBe(document.querySelector(".objective-expedition__index-toggle small")?.textContent);
    // 区域那一格里屏上写的是「需要验证、复习或修补 · 1 个」，登记的是后面那段计数。
    const readyRegionSmall = document.querySelector(
      '.objective-quest-region[data-region="ready"] header small',
    )?.textContent;
    expect(metric("待挑战")).toBe(readyRegionSmall?.split(" · ")[1]);
    expect(view.items?.map((entry) => entry.label)).toEqual(
      [...document.querySelectorAll(".objective-quest-node strong")].map((node) => node.textContent),
    );
    // 一个目标都露得下：不该编出一句"另有 N 个"。
    expect(view.notice).toBeUndefined();
  });

  it("某个区域露不下时，登记的就是屏上那句「另有 N 个目标在远征册」", async () => {
    await renderLibrary([listItem(1), listItem(2), listItem(3)]);
    const line = [...document.querySelectorAll(".objective-quest-region__more")].map((node) => node.textContent);
    expect(line.length).toBeGreaterThan(0);
    expect(publishedView()!.notice).toBe(line[0]);
    // 条目仍然只有露出来的那两颗（区域各两颗、总共 3 个目标 → 待挑战这一区露 2）。
    expect(publishedView()!.items).toHaveLength(2);
  });

  it("打开远征册：清单换成册子里那一列，逐字相同，并说出「已读到全部目标」", async () => {
    // 三张卡：收着时远征图只露两颗，打开后册子里是三行——数量差是这一页的关键事实。
    await renderLibrary([listItem(1), listItem(2), listItem(3)]);
    expect(publishedView()!.items).toHaveLength(2);
    await openIndex();
    await waitFor(() => expect(publishedView()!.items).toHaveLength(3));
    await waitFor(() => expect(publishedView()!.notice).toBe("已读到全部目标"));
    const view = publishedView()!;
    expect(view.items?.map((entry) => entry.label)).toEqual(
      [...document.querySelectorAll(".v3-goal-row__title")].map((node) => node.textContent),
    );
    expect(view.items?.map((entry) => entry.state)).toEqual(
      [...document.querySelectorAll(".v3-goal-row .v3-objective-state")].map((node) => node.textContent),
    );
    // 没输入关键词、没筛选项时，不登记 filters。
    expect(view.filters).toBeUndefined();
  });

  it("搜一个搜不到的词：登记关键词，并说屏上那句「没有匹配目标」", async () => {
    await renderLibrary([listItem(1)]);
    await openIndex();
    const input = document.querySelector<HTMLInputElement>(".v3-goal-search input")!;
    fireEvent.change(input, { target: { value: "不存在的词" } });
    await waitFor(() => expect(publishedView()!.notice).toMatch(/已载入范围内没有匹配目标/));
    const view = publishedView()!;
    expect(filterValue("关键词")).toBe(input.value);
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(
      `${document.querySelector(".v3-goal-list__empty strong")?.textContent}：${document.querySelector(".v3-goal-list__empty span")?.textContent}`,
    );
  });

  it("一张卡都没有：登记的是空态那一句，不带任何清单", async () => {
    await renderLibrary([]);
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(view.statusLine).toBe(document.querySelector(".approved-surface .surface-state strong")?.textContent ?? view.statusLine);
    expect(view.notice).toContain("还没有活跃目标");
  });

  /**
   * 关键词与筛选项是**持久化**的（翻回来还在），所以"册子收着、条件还留着"是一个真能
   * 到达的状态，不是假想：收着的时候屏上没有那两样，就不许登记。
   */
  it("册子收着时即使留有筛选条件也不登记 filters，打开才登记", async () => {
    retargetObjectiveLibraryView("ws-1");
    writeObjectiveLibraryView({ query: "卡", filter: "all" });
    await renderLibrary([listItem(1)]);
    expect(publishedView()!.filters).toBeUndefined();
    await openIndex();
    await waitFor(() => expect(filterValue("关键词")).toBe("卡"));
    expect(document.querySelector<HTMLInputElement>(".v3-goal-search input")!.value).toBe("卡");
  });

  it("第一次读取没回来之前不登记，卸载时槽位让开", async () => {
    let release: (value: unknown) => void = () => undefined;
    Object.defineProperty(window, "ailearn", {
      configurable: true,
      value: {
        auth: {
          getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
        },
        objective: { list: vi.fn(() => new Promise((resolve) => { release = resolve; })), get: vi.fn() },
        room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
      },
    });
    const { unmount } = render(<ObjectiveLibrarySurface />);
    await waitFor(() => expect(document.body.textContent).toContain("正在读取学习卡"));
    expect(publishedView()).toBeNull();
    release(ok({ version: 3, items: [listItem(1)], total: 1, nextCursor: null, snapshotAt: new Date().toISOString() }));
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});
