// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "./WorkspaceLibrarySurface";
import { retargetObjectiveLibraryView } from "./objective-library-view-state";

/**
 * 理解目标列表行（2026-09-20 实走复盘 #7）。
 *
 * 用户报告的是"作答之后回到列表，完全看不出哪张刚答过"——行上只有一行 8px
 * 灰字，`unvalidated` / `archived` / `superseded` 还共用同一个灰点。本文件把
 * 两件事钉住：状态 tag 用人话，行上带服务端签发的进展事实。
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
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: {
      kind: "create_run",
      objectiveId: OBJECTIVE_ID,
      label: "开始首次验证",
      start: CARD_START,
    },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>) {
  const objective = {
    list: vi.fn(async () => ok({ version: 3, items, total: items.length, nextCursor: null, snapshotAt: new Date().toISOString() })),
    get: vi.fn(async () => ok({})),
  };
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
    objective,
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  retargetObjectiveLibraryView("ws-1");
  vi.restoreAllMocks();
});

/**
 * 只看列表那一行。焦点卡片渲染的是同一个状态标签，按文本全局查会撞到两个，
 * 而"哪一处显示了它"正是本文件要钉的东西。
 */
function rowText(): string {
  return document.querySelector(".v3-goal-row")?.textContent ?? "";
}

async function openIndex(): Promise<void> {
  const toggle = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(".objective-expedition__index-toggle");
    expect(button).not.toBeNull();
    return button!;
  });
  fireEvent.click(toggle);
}

describe("理解目标列表行", () => {
  it("状态 tag 说人话，不把服务端枚举原样印到行上", async () => {
    installApi([listItem()]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await waitFor(() => expect(rowText()).toContain("还没正式答过"));
    expect(document.body.textContent).not.toContain("unvalidated");
  });

  it("答过一次的卡，在列表上就能看出来，不用点进详情", async () => {
    installApi([listItem({
      personalState: { state: "stable", activeRunId: null },
      progress: {
        practiceTrailCount: 2,
        lastCanonicalAt: new Date().toISOString(),
        reviewDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        initialValidation: "completed",
        validationNotBefore: null,
      },
    })]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await waitFor(() => expect(rowText()).toContain("已经答对过"));
    expect(rowText()).toContain("正式答过 · 今天");
    expect(rowText()).toContain("复习 5 天后");
  });

  it("看过答案的卡把「什么时候才能正式算」直接摆在行上", async () => {
    const notBefore = new Date(Date.now() + 20 * 3_600_000);
    installApi([listItem({
      progress: {
        practiceTrailCount: 0,
        lastCanonicalAt: null,
        reviewDueAt: null,
        initialValidation: "deferred",
        validationNotBefore: notBefore.toISOString(),
      },
      primaryAction: {
        kind: "practice_only",
        objectiveId: OBJECTIVE_ID,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: notBefore.toISOString(),
      },
    })]);
    render(<ObjectiveLibrarySurface />);

    await openIndex();
    await waitFor(() => expect(rowText()).toMatch(/后才能正式答/));
    // 时间点必须渲染成"月日 时分"，不能把 ISO 串漏到界面上。
    expect(rowText()).toMatch(/\d+月\d+日 \d{2}:\d{2} 后才能正式答/);
    expect(rowText()).not.toContain(notBefore.toISOString());
  });
});
