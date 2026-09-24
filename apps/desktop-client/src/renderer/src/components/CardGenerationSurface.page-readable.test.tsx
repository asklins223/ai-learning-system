// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { useRoomStore } from "../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「伴星能不能读到学习卡生成这一屏」（doc 37）。
 *
 * 触发这件事的实机事故：用户问"为啥第四张学习卡这么慢"，她手上没有任何读页面的
 * 工具，于是去查了 `list_task_queue`（学习运行的任务表，与卡片生成无关），
 * 拿到"当前没有排着的任务"，再据此推出"系统这边没在跑东西，慢在模型/网络"。
 *
 * 所以这一组用例钉的是**她能不能从这份数据里说出"第四张还没写出来"**：
 * 屏上 3 条、计划 4 条，序号必须按屏幕顺序落地成条目。
 * 每条都同时读 DOM 与 store——两边同源才是这条用例的意义所在，
 * 只断言 store 会放过"登记了一份屏幕上没有的东西"。
 */

const randomUUID = (): string => globalThis.crypto.randomUUID();
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa4-4444-4444-8444-444444444444";

function stubGateway(options: { status: string; landed: number; planned: number; authored: number }) {
  const candidates = Array.from({ length: options.landed }, (_, index) => ({
    version: 1,
    candidateId: randomUUID(),
    planRevisionId: "3f2b6c1e-5d4a-4a55-9b77-1c2d3e4f5061",
    candidateRevisionId: randomUUID(),
    revision: 1,
    runId: RUN_ID,
    planVersion: 1,
    planObjectiveLocalId: `obj-${index + 1}`,
    recommendation: { recommended: true, reasonCodes: ["mechanism_gap"] },
    objective: {
      statement: `第${index + 1}张的目标陈述`,
      publicSummary: `候选概念${index + 1}`,
      knowledgeForm: "causal_model",
    },
    front: { cue: "要点", prompt: `第${index + 1}张的题面` },
    strategy: "why",
    transformationKind: "mechanism_reconstruction",
    estimatedReviewSeconds: 45,
    evidenceSetHash: "e".repeat(64),
    candidateEvidenceBindingPlanHash: "b".repeat(64),
    candidateRevisionHash: `hash-${index}`,
    qualityState: options.status === "review_ready" ? "passed" : "authored",
    practiceItem: null,
    reviewDecision: "undecided",
    publishState: "unpublished",
    isReviewReady: options.status === "review_ready",
  }));
  const run = {
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: options.status,
    cardContentEpoch: 1,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    recovery: null,
    progress: {
      plannedCards: options.planned,
      authored: options.authored,
      gatePassed: 0,
      gateFailed: 0,
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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
        data: {
          activeGenerationSummary: {
            state: "data",
            data: { ...run, route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID } },
          },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { noteId: NOTE_ID, title: "IndexTTS 2.5 让声音跨越语言", sourceId: null },
      })),
      cardGeneration: {
        getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: run })),
        getCandidates: vi.fn(async () => ({
          ok: true as const,
          workspaceEpoch: 1,
          data: {
            candidates,
            practiceQuota: { requiredCount: 0, metCount: 0 },
            total: candidates.length,
            page: 1,
            pageSize: 50,
            totalPages: 1,
          },
        })),
        decideCandidate: vi.fn(),
        revealCandidate: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: {} })),
        recordExposure: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: {} })),
        closeRun: vi.fn(),
        cancelRun: vi.fn(),
        retryRun: vi.fn(),
        activateCandidates: vi.fn(),
        getActivation: vi.fn(),
      },
    },
  };
  Object.defineProperty(window, "ailearn", { value: gateway, configurable: true });
  return gateway;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function renderSurface() {
  useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
  return render(<CardGenerationSurface />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({
    activeCardGenerationRunId: null,
    activeNoteRef: null,
    surface: null,
    returnTarget: null,
    pageReadableView: null,
  });
});

describe("生成中那一屏：登记给伴星读的就是屏幕上那一份", () => {
  it("进度与逐张清单一起进视图，且「第四张还没写出来」这件事读得出来", async () => {
    stubGateway({ status: "authoring", landed: 3, planned: 4, authored: 3 });
    renderSurface();

    // 先证明屏幕上真有这两样，否则"两边同源"这句断言是空的。
    const headline = await screen.findByText(/已写出 \d+ \/ \d+ 张候选/);
    expect(screen.getAllByTestId("card-generation-landing-item")).toHaveLength(3);

    // 标题是另一条异步读数（note.get），所以要等到它落进视图为止。
    await waitFor(() => expect(publishedView()?.title).toContain("IndexTTS 2.5"));
    const view = publishedView()!;
    expect(view.pageId).toBe("card_generation_progress");
    // 同一个数、同一个字符串：她念出来的那句进度就是屏幕上那一句的子串
    // （屏幕上那一行还把"最后更新"拼在后面，所以是包含而不是相等）。
    expect(view.metrics?.some((metric) => headline.textContent?.includes(metric.value))).toBe(true);
    expect(view.title).toBe(screen.getByRole("heading", { level: 2 }).textContent);
    expect(view.items?.map((item) => item.ordinal)).toEqual([1, 2, 3]);
    const onScreenConcepts = screen.getAllByText(/^候选概念\d$/).map((node) => node.textContent);
    expect(view.items?.map((item) => item.label)).toEqual(onScreenConcepts);
    // "第四张"的答案必须能从这份数据里推出来：屏上 3 条 vs 计划 4 条。
    expect(view.items).toHaveLength(3);
    expect(view.metrics?.find((metric) => metric.label === "进度")?.value).toContain("4");
  });

  it("还没读到 run 之前不登记（她不能读到上一屏的残留）", () => {
    useRoomStore.setState({ activeCardGenerationRunId: null });
    render(<CardGenerationSurface />);
    expect(publishedView()).toBeNull();
  });

  it("离开这一页时槽位让开", async () => {
    stubGateway({ status: "authoring", landed: 3, planned: 4, authored: 3 });
    const { unmount } = renderSurface();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });

  it("审核阶段登记的是逐张审核那份，序号覆盖整批候选", async () => {
    stubGateway({ status: "review_ready", landed: 4, planned: 4, authored: 4 });
    renderSurface();

    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.pageId).toBe("card_generation_review");
    expect(view.items?.map((item) => item.ordinal)).toEqual([1, 2, 3, 4]);
    expect(view.metrics?.find((metric) => metric.label === "候选")?.value).toBe("1 / 4");
  });
});
