// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { useRoomStore } from "../app/room-store";

/**
 * 工作台两条主线的回归：
 * - 生成是后台任务，页面上的"返回笔记"始终把用户送回原笔记（以 run.sourceRef 为准）；
 * - run 进入 review_ready 时页面身份稳定切换到候选审核页，不落空、不死端。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";

function stubGateway(initialStatus: string, runOverride: { updatedAt?: string } = {}) {
  const state = {
    runStatus: initialStatus,
    // 默认"刚刚更新"；走字测试需要一个静置了一段时间的 run。
    updatedAt: runOverride.updatedAt ?? new Date().toISOString(),
    // 服务端聚合的逐候选进度；列表类读取没有，故默认 null。
    progress: null as { plannedCards: number; authored: number; gatePassed: number; gateFailed: number } | null,
    getCandidatesCalls: 0,
    eventHandlers: new Map<string, () => void>(),
  };
  const runSnapshot = () => ({
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: state.runStatus,
    cardContentEpoch: 1,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    progress: state.progress,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    recovery: null,
    createdAt: state.updatedAt,
    updatedAt: state.updatedAt,
  });
  const candidate = {
    candidateId: "cand-1",
    candidateRevisionId: "cand-rev-1",
    revision: 1,
    candidateRevisionHash: "hash",
    reviewDecision: "undecided",
    isReviewReady: true,
    candidateEvidenceBindingPlanHash: "plan-hash",
    publishState: "unpublished",
    qualityState: "passed",
    strategy: "why",
    transformationKind: "mechanism_reconstruction",
    planVersion: 1,
    estimatedReviewSeconds: 45,
    recommendation: { recommended: true, reasonCodes: ["mechanism_gap"] },
    objective: { statement: "为什么提取练习有效？", publicSummary: "提取练习", knowledgeForm: "causal_model" },
    front: { cue: "回忆一次提取练习", prompt: "请解释机制" },
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
          activeGenerationSummary: { state: "data", data: [{ ...runSnapshot(), route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID } }] },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { noteId: NOTE_ID, title: "提取练习笔记", sourceId: null },
      })),
      cardGeneration: {
        getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: runSnapshot() })),
        getCandidates: vi.fn(async () => {
          state.getCandidatesCalls += 1;
          // 已结束的 run 服务端不再交付可审核候选——工作台必须诚实面对空列表。
          const candidates = state.runStatus === "review_ready" ? [candidate] : [];
          return { ok: true as const, workspaceEpoch: 1, data: { candidates } };
        }),
      },
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
  useRoomStore.setState({ activeCardGenerationRunId: null, activeNoteRef: null, surface: null, returnTarget: null });
});

describe("CardGenerationSurface · 生成工作台", () => {
  it("生成中页渲染四阶段，返回笔记以 run.sourceRef 为准落回原笔记", async () => {
    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    const { container, getByRole } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelectorAll(".press-stage").length).toBe(4));
    expect(container.querySelector(".press-stage.active")?.textContent).toContain("正在做质量检查");

    fireEvent.click(getByRole("button", { name: "返回笔记" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("notebook"));
    expect(useRoomStore.getState().activeNoteRef).toMatchObject({ noteId: NOTE_ID, noteVersionId: VERSION_ID });
  });

  it("run 进入 review_ready 后页面身份稳定切到候选审核页", async () => {
    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(state.eventHandlers.has("sub-1")).toBe(true));
    expect(container.querySelector(".task-title h1")?.textContent).toBe("学习卡生成中");

    state.runStatus = "review_ready";
    state.eventHandlers.get("sub-1")?.();

    await waitFor(() => expect(container.querySelector(".task-title h1")?.textContent).toBe("候选卡审核"));
    await waitFor(() => expect(container.querySelector(".candidate-study-card h2")?.textContent).toContain("为什么提取练习有效"));
  });

  it("store 丢失 runId 时从 projection 自愈，不落空态", async () => {
    const { gateway } = stubGateway("checking");
    useRoomStore.setState({ activeCardGenerationRunId: null });
    const { container, queryByText } = render(<CardGenerationSurface />);

    await waitFor(() => expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID));
    await waitFor(() => expect(gateway.note.cardGeneration.getRun).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".press-stage")).not.toBeNull());
    expect(queryByText("还没有进行中的生成任务")).toBeNull();
  });

  it("已结束的 run 没有候选时不是死端：提供返回笔记入口", async () => {
    stubGateway("activated");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    const { getByText } = render(<CardGenerationSurface />);

    expect(await waitFor(() => getByText("没有可审核候选"))).toBeTruthy();
    fireEvent.click(screen.getAllByText("返回笔记")[0]);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("notebook"));
  });

  /**
   * 进度反馈：页面必须自己说出"第几步 / 当前在做什么 / 完成了几步 / 还剩几步 /
   * 整体百分之多少"，而不是只把裸状态码摆出来让用户自己换算。四段轨道是同一
   * 件事的另一半张脸 —— 所以"填满几段"和百分比必须是同一个数。
   */
  it("生成中页不亮读不到的步数，但候选计数照旧写出来", async () => {
    stubGateway("checking");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelector(".card-generation-progress")).not.toBeNull());
    const progress = container.querySelector(".card-generation-progress");
    expect(progress?.textContent).toContain("写完一批一次给齐");
    expect(progress?.textContent).toContain("正在做质量检查");
    // 0249 之后计数是实时读数，所以那句"中间计数要等这一批写完"已经不成立；
    // 步数依旧不报（`run.status` 还在管道的大事务里）。
    expect(progress?.textContent).not.toContain("中间计数");
    // 步数只在 meta 这一行，不与四段轨道的"已完成/待进行"圆点混淆。
    const meta = container.querySelector(".card-generation-progress__meta");
    expect(meta?.textContent).not.toContain("待进行");
    expect(meta?.textContent).not.toContain("已完成");
    expect(progress?.textContent).toContain("正在核对质量门与证据绑定");
    expect(progress?.textContent).toContain("最后更新");
    // checking 落在第三段：前两段已完成、第三段进行中、第四段待进行。
    const steps = [...container.querySelectorAll(".card-generation-progress__step")];
    expect(steps.map((step) => step.className.replace(/^.*is-/, ""))).toEqual(["done", "done", "current", "todo"]);
    expect(steps[0]?.textContent).toContain("读取笔记");
    expect(steps[0]?.textContent).toContain("已完成");
    expect(steps[2]?.textContent).toContain("对齐证据");
    expect(steps[2]?.textContent).toContain("进行中");
    expect(steps[3]?.textContent).toContain("待进行");
    const bar = container.querySelector('[role="progressbar"]');
    // 百分比 = 已完成阶段 ÷ 4 = 2 / 4，和上面两段实心金一一对应。
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
    expect(bar?.getAttribute("aria-valuemax")).toBe("100");
    expect(bar?.textContent).toContain("50");
    expect(bar?.textContent).toContain("整体进度");
  });

  /**
   * 2026-09-20 实走复盘 #2：`checking` 会一直停在同一个档位，用户读成"跳到完成了"。
   * 服务端现在随 run 详情下发逐候选计数，页面用它把当前阶段内部走出一小段，
   * 并把计数原样写在文案里，让百分比有出处。
   */
  it("当前阶段内部按服务端候选计数推进，并写出计数来源", async () => {
    const { state } = stubGateway("checking");
    state.progress = { plannedCards: 8, authored: 8, gatePassed: 2, gateFailed: 1 };
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelector(".card-generation-progress")).not.toBeNull());
    const progress = container.querySelector(".card-generation-progress");
    expect(progress?.textContent).toContain("已过质量门 2 / 8");
    expect(progress?.textContent).not.toContain("中间计数");
    const bar = container.querySelector('[role="progressbar"]');
    // 无计数时 checking 恒为 50；有过 2/8 道质量门才往上走一格。
    expect(Number(bar?.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
    expect(bar?.getAttribute("aria-valuetext")).toContain("已过质量门 2 / 8");
  });

  /**
   * 进度是事件驱动的，但「最后更新 N 分钟前」是墙上的钟在走：不推一个 tick，
   * 安静十分钟的 run 会永远停在"1 分钟前"，把诚实的服务端状态读成卡死的显示。
   */
  it("最后更新时间自己走字，不依赖新事件", async () => {
    vi.useFakeTimers();
    try {
      stubGateway("checking", { updatedAt: new Date(Date.now() - 60_000).toISOString() });
      useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
      render(<CardGenerationSurface />);

      // 初始 load 是异步的：先让 run 到位，再拨钟。
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText(/最后更新 1 分钟前/)).toBeTruthy();

      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(screen.getByText(/最后更新 2 分钟前/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 「刷新状态」此前点完什么都不说：状态没变时用户只能认为按钮坏了。
   * 现在它必须给出回执，且区分"推进了"和"仍是同一个状态"。
   */
  it("刷新状态后给出同步回执，并区分状态有没有变化", async () => {
    const { state } = stubGateway("planning");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelector(".card-generation-progress")).not.toBeNull());
    fireEvent.click(within(container).getByRole("button", { name: /刷新状态/ }));

    const unchanged = await waitFor(() => {
      const receipt = container.querySelector(".card-generation-board__sync-report");
      expect(receipt?.textContent).toContain("已刷新");
      return receipt;
    });
    expect(unchanged?.textContent).toContain("仍是「正在规划候选」");
    expect(unchanged?.textContent).not.toContain("这次生成到了");

    // 服务端推进到下一步之后，同一颗按钮必须说出来，而不是保持沉默。
    state.runStatus = "checking";
    fireEvent.click(within(container).getByRole("button", { name: /刷新状态/ }));
    await waitFor(() => expect(container.querySelector(".card-generation-board__sync-report")?.textContent).toContain("这次生成到了「正在做质量检查」"));
    // 进度头条跟着一起走：第 3 步、第三段进行中、百分比 50%。
    expect(container.querySelector(".card-generation-progress")?.textContent).toContain("写完一批一次给齐");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
  });
});

/**
 * 打包冒烟旅程（scripts/smoke-packaged.mjs）用真实 DOM 断言页 12/13，所以把它的
 * 选择器与文案在这里钉成契约：任何一侧漂移都先在 CI 的组件测试里失败，而不是等
 * 到打包后的机器上才发现脚本又在等一个已经不存在的元素。
 */
describe("CardGenerationSurface · packaged 冒烟选择器契约", () => {
  it("页 12 暴露 .card-generation-board 与页脚", async () => {
    stubGateway("checking");
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelector(".card-generation-board")).not.toBeNull());
    expect(container.querySelector(".card-generation-board__footer")).not.toBeNull();
    expect(container.querySelector(".card-generation-board__header button")).not.toBeNull();
    expect(container.querySelector(".task-title h1")?.textContent).toBe("学习卡生成中");
  });

  it("页 13 暴露候选纸面、回执与脚本依赖的全部动作", async () => {
    // 自带的桩：只有它会走完「保留 → 加入待激活 → 激活 → 回执」这条链，
    // 也就是打包冒烟旅程真正依赖的那条链。
    const state = { decision: "undecided", activated: false };
    const runSnapshot = () => ({
      version: 1,
      runId: RUN_ID,
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      status: "review_ready",
      cardContentEpoch: 1,
      currentPlanVersion: 1,
      reviewDraftRevision: 1,
      sourceOutdated: false,
      sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
      recovery: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const candidate = () => ({
      candidateId: "cand-1",
      candidateRevisionId: "cand-rev-1",
      revision: 1,
      candidateRevisionHash: "hash",
      reviewDecision: state.decision,
      isReviewReady: true,
      candidateEvidenceBindingPlanHash: "plan-hash",
      publishState: state.activated ? "activated" : "unpublished",
      qualityState: "passed",
      strategy: "why",
      transformationKind: "mechanism_reconstruction",
      planVersion: 1,
      estimatedReviewSeconds: 45,
      recommendation: { recommended: true, reasonCodes: ["mechanism_gap"] },
      objective: { statement: "为什么提取练习有效？", publicSummary: "提取练习", knowledgeForm: "causal_model" },
      front: { cue: "回忆一次提取练习", prompt: "请解释机制" },
    });
    window.ailearn = {
      contract: { enabledRoutes: ["note.detail", "note.cardGeneration"] },
      auth: { getState: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } } })) },
      room: { getProjection: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { activeGenerationSummary: { state: "data", data: [{ ...runSnapshot(), route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID } }] } } })) },
      note: {
        get: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, title: "提取练习笔记", sourceId: null } })),
        cardGeneration: {
          getRun: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: runSnapshot() })),
          getCandidates: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { candidates: [candidate()] } })),
          review: vi.fn(async () => {
            state.decision = "keep";
            return { ok: true as const, workspaceEpoch: 1, data: runSnapshot() };
          }),
          activate: vi.fn(async () => {
            state.activated = true;
            return {
              ok: true as const,
              workspaceEpoch: 1,
              data: { version: 1, runId: RUN_ID, mappings: [{ candidateId: "cand-1", objectiveId: "obj-1" }] },
            };
          }),
        },
      },
      subscriptions: {
        subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
        onEvent: vi.fn(() => () => {}),
        unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
      },
    } as unknown as typeof window.ailearn;
    useRoomStore.setState({ activeCardGenerationRunId: RUN_ID, activeNoteRef: null });
    const { container } = render(<CardGenerationSurface />);

    await waitFor(() => expect(container.querySelector(".candidate-review-table")).not.toBeNull());
    expect(container.querySelector(".candidate-study-card")).not.toBeNull();
    expect(container.querySelector(".candidate-review-slip")).not.toBeNull();
    expect(container.querySelector(".candidate-card__meta")?.textContent).toContain("待审核");

    // 脚本用的动作文案：保留 / 不保留 / 查看答案与证据 / 结束本次审核 / 返回笔记。
    for (const label of ["保留", "不保留", "查看答案与证据", "结束本次审核", "返回笔记"]) {
      expect(within(container).getByRole("button", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }

    // 未决候选的后果必须写在脸上：以前点「激活」会静默把它们打成"未选中"丢弃。
    expect(container.querySelector(".candidate-review-slip__actions")?.textContent)
      .toContain("还有 1 张没有决定");

    // 保留之后 meta 行给出「已保留 · 在激活队列里」，脚本用这句话判断提交成功。
    fireEvent.click(within(container).getByRole("button", { name: /^保留/ }));
    await waitFor(() => expect(container.querySelector(".candidate-card__meta")?.textContent).toContain("已保留"));
    await waitFor(() => expect(container.querySelector(".candidate-review-slip__actions")?.textContent)
      .not.toContain("没有决定"));

    // 保留即排队：不再有「加入待激活」勾选框，直接出现带数量的激活按钮
    // （2026-09-20 实走复盘 #1：既要保留又要勾选，而计数只统计已保留的勾选，
    //  先勾后不保留会静默激活 0 张）。
    expect(container.querySelector(".candidate-activation-choice")).toBeNull();
    const activateButton = await waitFor(() => within(container).getByRole("button", { name: /^激活 \d+ 个目标/ }));
    expect(activateButton.textContent).toContain("激活 1 个目标");
    fireEvent.click(activateButton);

    // 真实回执：.candidate-review-slip__receipt 里的「已确认 N 个目标映射」。
    await waitFor(() => expect(container.querySelector(".candidate-review-slip__receipt")?.textContent).toContain("已确认 1 个目标映射"));
  });
});
