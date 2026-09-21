// @vitest-environment jsdom

import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningRunPublicSnapshotV2Schema } from "@ailearn/shared/learning-run-v2-contracts";
import { LearningRunSurface } from "./learning-run-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 作答界面的动作区回归（2026-09-20 实走复盘 #11 / #12）。
 *
 * 这个约 1900 行的主界面此前**没有任何组件测试**，所以"四个近义退出按钮堆在
 * 菜单里""第二级提示套在 details 里"这类问题能一路走到用户手上。本文件先把它
 * 钉住：动作区只有一个提示按钮、退出只有两个且都直接可见。
 */

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000005";
const VARIANT_ID = "00000000-0000-4000-8000-000000000006";

const activeTask = (hintLevels: number) => ({
  version: 1,
  taskId: TASK_ID,
  runId: RUN_ID,
  sequence: 1,
  intent: "explain",
  prompt: "为什么这套顺序不能换？",
  targetSummary: "发布流程的阶段取舍",
  activeVariant: {
    variantId: VARIANT_ID,
    purpose: "formal",
    interaction: { kind: "text_response", maxChars: 400 },
    templateTrustCeiling: "mastery_eligible",
    estimatedActiveSeconds: 60,
    publicPayloadHash: "a".repeat(64),
    inputSchemaHash: "b".repeat(64),
    disclosureProfileHash: "c".repeat(64),
    revision: 1,
  },
  availableAlternatives: [] as Array<Record<string, unknown>>,
  assistancePolicy: { hintLevels, exposureLowersTrust: true },
  status: "active",
  revision: 1,
});

const snapshot = (overrides: Record<string, unknown> = {}) => learningRunPublicSnapshotV2Schema.parse({
  version: 2,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2: { kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID },
  target: {
    objectiveId: OBJECTIVE_ID,
    objectiveRevision: 1,
    cardId: CARD_ID,
    publicationRevision: 1,
    cardRevision: 1,
    publicPayloadHash: "a".repeat(64),
    publicSummary: "发布流程的阶段取舍",
    semanticTargetFingerprint: "b".repeat(64),
    targetRevisionHash: "c".repeat(64),
  },
  returnTargetV2: { kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID },
  phase: "active",
  runRevision: 1,
  runtimeEpoch: 1,
  activeSecondsUsed: 12,
  timeBudgetSeconds: 180,
  activeTask: activeTask(2),
  allowedActions: [
    { version: 2, kind: "pause" },
    { version: 2, kind: "skip_run", confirmationRequired: true },
    { version: 2, kind: "request_hint", level: 1 },
    { version: 2, kind: "request_hint", level: 2 },
  ],
  publishedTargetEligibility: "eligible",
  ...overrides,
});

function stubGateway(base = snapshot()) {
  const state = {
    snapshots: [base],
    actions: [] as Array<{ kind: string; level?: number }>,
    submits: [] as unknown[],
    eventCallbacks: [] as Array<() => void>,
  };
  const current = () => state.snapshots[state.snapshots.length - 1];
  const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

  const gateway = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: "00000000-0000-4000-8000-000000000009" },
      })),
    },
    learningRun: {
      get: vi.fn(async () => ok(current())),
      getDraft: vi.fn(async () => ok(null)),
      saveDraft: vi.fn(async (input: { runId: string; taskId: string }) => ok({
        version: 2,
        runId: input.runId,
        taskId: input.taskId,
        variantId: VARIANT_ID,
        snapshotId: SNAPSHOT_ID,
        taskRevision: 1,
        draftRevision: 1,
        draftHash: "d".repeat(64),
      })),
      submit: vi.fn(async () => {
        state.submits.push({});
        return ok({
          version: 2,
          runId: RUN_ID,
          taskId: TASK_ID,
          snapshotId: SNAPSHOT_ID,
          artifactId: SNAPSHOT_ID,
          artifactRevision: 1,
          artifactStatus: "locked",
          assessment: { assessmentId: OBJECTIVE_ID, status: "queued" },
          runRevision: 2,
          taskRevision: 1,
          eventCursor: 1,
        });
      }),
      action: vi.fn(async (input: { request: { action: { kind: string; level?: number } } }) => {
        const action = input.request.action;
        state.actions.push({ kind: action.kind, level: action.level });
        if (action.kind === "request_hint") {
          return ok({
            actionResult: {
              kind: "hint_revealed",
              hintId: SNAPSHOT_ID,
              level: action.level,
              text: `第 ${action.level} 层提示：先说出被遮住的那一处。`,
              resultingTrustCeiling: "practice_only",
            },
            snapshot: current(),
          });
        }
        return ok({ actionResult: { kind: "state_changed" }, snapshot: current() });
      }),
      getResult: vi.fn(async () => ok({ kind: "not_ready" })),
      revealTarget: vi.fn(async () => ok({})),
      getReturnContract: vi.fn(async () => ok(null)),
      recordActivityLease: vi.fn(async () => ok({ activeSecondsUsed: 12, runRevision: 1 })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "sub-1" })),
      onEvent: vi.fn((_input: unknown, callback: () => void) => {
        state.eventCallbacks.push(callback);
        return () => undefined;
      }),
      unsubscribe: vi.fn(async () => ok({})),
    },
    navigation: {
      resolve: vi.fn(async () => ok({ current: { scope: "workspace", workspaceEpoch: 1, route: { kind: "review.queue" } } })),
      go: vi.fn(async () => ok({ current: { scope: "workspace", workspaceEpoch: 1, route: { kind: "review.queue" } } })),
    },
    capabilities: { get: vi.fn(async () => ok({
      actionCapabilities: {}, featureAvailability: {}, nativeCapabilities: { asr: "unavailable" },
    })) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ailearn = gateway;
  return { gateway, state };
}

function renderRun(base = snapshot()) {
  // 秒表按设计只在"可见且有焦点"时走（与服务端租约同规则）；jsdom 默认无焦点。
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const harness = stubGateway(base);
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
  render(<LearningRunSurface onExit={() => undefined} />);
  return harness;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null });
});

describe("LearningRunSurface · 动作区", () => {
  it("退出只有两个，且都直接可见：稍后再做 + 暂时不会", async () => {
    renderRun();

    // getByRole 只看得见可访问树里的元素：藏在折叠 details 里的按钮查不到，
    // 正是这次要修的形态。
    await waitFor(() => expect(screen.getByRole("button", { name: "稍后再做" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "暂时不会" })).toBeTruthy();
    // skip_task 已从服务端签发与界面同时删除；end 在 active 阶段不再签发。
    expect(screen.queryByRole("button", { name: "跳过这一步" })).toBeNull();
    expect(screen.queryByRole("button", { name: "安全退出" })).toBeNull();
    // 两个退出都在明面上，不该再有折叠菜单。
    expect(screen.queryByRole("button", { name: "更多选择" })).toBeNull();
  });

  it("提示只有一个按钮：点一次放一层，文案跟着变，放到最后一层就禁用", async () => {
    const { state } = renderRun();
    const label = (text: RegExp) => screen.getAllByRole("button").find((button) => text.test(button.textContent ?? ""));

    const first = await waitFor(() => label(/^给我一点提示/));
    expect(first).toBeTruthy();
    // 第二级不再是另一个按钮，也不藏在「更多选择」里。
    expect(label(/第 2 级提示/)).toBeUndefined();
    expect(label(/查看第/)).toBeUndefined();

    fireEvent.click(first!);
    await waitFor(() => expect(state.actions[0]).toEqual({ kind: "request_hint", level: 1 }));

    const second = await waitFor(() => label(/^再看一层提示/));
    expect(second).toBeTruthy();
    // 两级同框：第一层的话术仍在屏上。
    expect(document.body.textContent).toContain("第 1 层提示");

    fireEvent.click(second!);
    await waitFor(() => expect(state.actions[1]).toEqual({ kind: "request_hint", level: 2 }));
    expect(document.body.textContent).toContain("第 2 层提示");

    const done = await waitFor(() => label(/提示已经给完/));
    expect(done).toBeTruthy();
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(state.actions.filter((action) => action.kind === "request_hint")).toHaveLength(2);
  });

  it("提示正文只占一列：正文与「只计练习分」都装进同一个容器", async () => {
    const { state } = renderRun();
    const label = (text: RegExp) => screen.getAllByRole("button").find((button) => text.test(button.textContent ?? ""));

    fireEvent.click((await waitFor(() => label(/^给我一点提示/)))!);
    await waitFor(() => expect(state.actions[0]).toEqual({ kind: "request_hint", level: 1 }));

    // 面板是 `auto minmax(0,1fr)` 两列网格（图标占第一列），所以直接子项必须**恰好**
    // 两个：多出来的那个会被自动排到第二行第一列，而 `auto` 列按它的 max-content
    // 撑满整块面板，正文列被压到十几像素——实机上就是一条竖排单字（2026-09-21 截图）。
    const panel = document.querySelector(".learning-run-hint")!;
    expect(panel.children).toHaveLength(2);

    const body = panel.querySelector(".learning-run-hint__body")!;
    expect(body).toBeTruthy();
    expect(body.querySelector(".learning-run-hint__levels")).toBeTruthy();
    // 降级说明也在正文容器里，不是面板的第三个直接子项。
    expect(body.querySelector("small")?.textContent).toContain("只计练习分");
  });

  it("专注时间逐秒推进，服务端读数只会抬高它、绝不把钟拨回去", async () => {
    const { state } = renderRun();
    const clockText = () => document.querySelector(".learning-run-clock b")?.textContent ?? "";

    await waitFor(() => expect(clockText()).toBe("00:12"), { timeout: 2_000 });
    await waitFor(() => expect(clockText()).toBe("00:15"), { timeout: 6_000 });
    // 进度条按 D2 撤掉：没有上限可展示时，一条不走的轨道只会被读成卡死。
    expect(document.querySelector(".learning-run-clock__track")).toBeNull();

    // 租约回传更小的值（失焦期间不计时，服务端会落后）：本地已走的不能被抹掉。
    state.snapshots.push(snapshot({ activeSecondsUsed: 5 }));
    act(() => { state.eventCallbacks.forEach((callback) => callback()); });
    await waitFor(() => expect(clockText()).not.toBe("00:05"), { timeout: 3_000 });

    // 更大的服务端读数是权威（这段时间被补记了）。
    state.snapshots.push(snapshot({ activeSecondsUsed: 40 }));
    act(() => { state.eventCallbacks.forEach((callback) => callback()); });
    await waitFor(() => expect(clockText()).toBe("00:40"), { timeout: 3_000 });
  }, 20_000);

  /**
   * 60 分钟绝对超时。
   *
   * 注意契约边界：`activeSecondsUsed` 的上限是 180 秒（服务端只按专注租约计时），
   * 所以"到 60 分钟"这件事**只能**由本地秒表判断——这里用假定时器把 1 秒一跳
   * 快进掉，不去伪造一个越界的快照。
   */
  it("满 60 分钟自动结束：绕过确认弹窗，且只结束一次", async () => {
    vi.useFakeTimers();
    try {
      const { state } = renderRun(snapshot({ activeSecondsUsed: 179 }));
      // 先让挂载期的快照读取落地，秒表的 1 秒 interval 才会被创建；
      // 在假定时器下这步必须显式冲一次微任务，否则推进的是"还不存在的定时器"。
      await act(async () => { await Promise.resolve(); });
      await act(async () => { vi.advanceTimersByTime(3_601_000); });

      const exits = state.actions.filter((action) => action.kind === "skip_run");
      expect(exits).toHaveLength(1);
      // 自动结束不该先弹一个等用户点的确认框。
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();

      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(state.actions.filter((action) => action.kind === "skip_run")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 复盘 #8：没有麦克风时，语音替代项必须**看得见但点不了**，并把原因写在旁边。
   * 直接把入口藏起来，用户只会以为"根本没有换一种方式这回事"。
   */
  it("没有可用麦克风时，换用语音的按钮被禁用并说明原因", async () => {
    const withVoice = snapshot({
      activeTask: {
        ...activeTask(1),
        availableAlternatives: [{
          alternativeId: VARIANT_ID,
          family: "voice",
          estimatedActiveSeconds: 75,
          maximumPurpose: "formal",
        }],
      },
      allowedActions: [
        { version: 2, kind: "pause" },
        { version: 2, kind: "skip_run", confirmationRequired: true },
        { version: 2, kind: "switch_variant", alternativeId: VARIANT_ID },
      ],
    });
    renderRun(withVoice);

    const button = await waitFor(() => screen.getByRole("button", { name: /换一种方式/ }));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // jsdom 没有 navigator.mediaDevices → 探测结论是"这个窗口不支持录音"。
    await waitFor(() => expect(document.body.textContent).toContain("现在还不能改用语音作答"));
    expect(document.body.textContent).toContain("录音");
  });

  /**
   * 复盘 #6：提交之后到结果回来之前，界面不能只剩一行字。
   */
  it("提交后保留所答内容并显示等待时长，不提前给出返回按钮", async () => {
    const { gateway } = renderRun();
    // waitFor 只在回调抛错时重试，所以里面放断言而不是返回元素。
    const textarea = await waitFor(() => {
      const found = document.querySelector(".run-text-editor textarea");
      expect(found).toBeTruthy();
      return found;
    }, { timeout: 4_000 });

    fireEvent.change(textarea!, { target: { value: "先选研究对象，再列式。" } });
    const submitButton = await waitFor(() => screen.getByRole("button", { name: /提交回答/ })) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    fireEvent.click(submitButton);

    await waitFor(() => expect(gateway.learningRun.submit).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    await waitFor(() => expect(document.body.textContent).toContain("你交上去的回答"), { timeout: 4_000 });
    expect(document.body.textContent).toContain("先选研究对象，再列式。");
    expect(document.querySelector(".learning-run-assessing__wait")?.textContent).toMatch(/已等待 \d+s/);
    // 真正要钉住的是"不能再交一次"：答案已在服务端锁定，重复提交只会撞 409。
    expect(screen.queryByRole("button", { name: /提交回答/ })).toBeNull();
    expect(document.querySelector(".run-text-editor textarea")).toBeNull();
  }, 20_000);

  it("看过提示就当场说明计分降级，不再事后才知道", async () => {
    renderRun();
    const button = await waitFor(() => screen.getAllByRole("button").find((item) => /^给我一点提示/.test(item.textContent ?? "")));
    fireEvent.click(button!);
    await waitFor(() => expect(document.body.textContent).toContain("只计练习分"));
  });
});
