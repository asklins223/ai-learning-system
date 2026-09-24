// @vitest-environment jsdom

import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningRunPublicSnapshotV2Schema } from "@ailearn/shared/learning-run-v2-contracts";
import { LearningRunSurface } from "./learning-run-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 作答面的**边界**（审计 F26 余项）。
 *
 * 现场是"点了恢复之后任务区一直空白"：那一屏既没有题目、也没有加载态或错误态，
 * 还没有可用的退出控件（超过 15 秒）。主因（GSAP 时间线靠 rAF 走帧、窗口失焦时
 * `onComplete` 永不到达）已经用有界兜底修掉；这一份钉的是余下那半条方案——
 * "任务区立即挂载带 run ID 的加载/失败边界"：
 *
 * 1. 读_in flight 期间必须有一句人话的加载态，而且**现在就有一条退路**（不是等
 *    到数据回来才有按钮可点）；
 * 2. 读失败：可重试时给重试，不可重试时**至少**给退路——原来 `retryable=false`
 *    的失败只剩一行字，屏上没有任何可操作的东西；
 * 3. 没有 run 也要有去处（原来是"系统会冻结真实目标"这种内部词，且没有按钮）；
 * 4. 正控制：读取成功时这一屏确实换成题目，证明上面三条不是"永远显示边界"。
 */

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000005";
const VARIANT_ID = "00000000-0000-4000-8000-000000000006";

const snapshot = () => learningRunPublicSnapshotV2Schema.parse({
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
  publishedTargetEligibility: "eligible",
  allowedActions: [
    { version: 2, kind: "pause" },
    { version: 2, kind: "skip_run", confirmationRequired: true },
    { version: 2, kind: "request_hint", level: 1 },
  ],
  activeTask: {
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
    assistancePolicy: { hintLevels: 2, exposureLowersTrust: true },
    status: "active",
    revision: 1,
  },
});

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
const fail = (code: string, retry: "never" | "user_action" | "safe_retry" | "resync_first") => ({
  ok: false as const,
  workspaceEpoch: 1,
  error: { code, safeMessageKey: `error.${code}`, retry },
});

function stubGateway(get: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ailearn = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: "00000000-0000-4000-8000-000000000009" },
      })),
    },
    learningRun: {
      get,
      getDraft: vi.fn(async () => ok(null)),
      saveDraft: vi.fn(async () => ok({})),
      submit: vi.fn(async () => ok({})),
      action: vi.fn(async () => ok({ actionResult: { kind: "state_changed" }, snapshot: snapshot() })),
      getResult: vi.fn(async () => ok({ kind: "not_ready" })),
      revealTarget: vi.fn(async () => ok({})),
      getReturnContract: vi.fn(async () => ok(null)),
      recordActivityLease: vi.fn(async () => ok({ activeSecondsUsed: 12, runRevision: 1 })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "sub-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok({})),
    },
    navigation: {
      resolve: vi.fn(async () => ok({
        current: { scope: "workspace", workspaceEpoch: 1, route: { kind: "room.home" } },
      })),
      go: vi.fn(async () => ok({
        current: { scope: "workspace", workspaceEpoch: 1, route: { kind: "room.home" } },
      })),
    },
    capabilities: { get: vi.fn(async () => ok({
      actionCapabilities: {}, featureAvailability: {}, nativeCapabilities: { asr: "unavailable" },
    })) },
  };
}

function mount(get: ReturnType<typeof vi.fn>) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stubGateway(get);
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
  render(<LearningRunSurface />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null });
});

describe("LearningRunSurface · 加载/失败边界", () => {
  it("读取期间：一句人话的加载态，并且现在就有一条退路", async () => {
    const pending: { resolve?: (value: unknown) => void } = {};
    const get = vi.fn(() => new Promise((resolve) => { pending.resolve = resolve; }));
    mount(get);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("正在打开这一轮");
    // 内部标识不许上屏（用户读不出"LearningRun"是什么，也指不出是哪一屏坏了）。
    expect(status.textContent).not.toMatch(/LearningRun|runId|snapshot/i);

    const exit = screen.getByRole("button", { name: "先离开，回书桌" });
    fireEvent.click(exit);
    await waitFor(() => expect(useRoomStore.getState().activeRunId).toBeNull());

    pending.resolve?.(ok(snapshot()));
    await act(async () => undefined);
  });

  it("读取失败（可重试）：重试与退路同时在，不让人困在错误行前面", async () => {
    const get = vi.fn(async () => fail("api_unavailable", "safe_retry"));
    mount(get);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("学习服务暂时不可用");
    expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "先离开，回书桌" })).toBeTruthy();
  });

  it("读取失败（不可重试）：没有重试也必须有出口", async () => {
    const get = vi.fn(async () => fail("forbidden", "never"));
    mount(get);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("权限");
    expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
    const exit = screen.getByRole("button", { name: "先离开，回书桌" });
    fireEvent.click(exit);
    await waitFor(() => expect(useRoomStore.getState().activeRunId).toBeNull());
  });

  it("没有进行中的旅程：说清去哪开始，并给一个真的去处（不出现内部词）", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    stubGateway(vi.fn(async () => ok(snapshot())));
    useRoomStore.setState({ activeRunId: null });
    const invoke = vi.spyOn(useRoomStore.getState(), "invoke");
    render(<LearningRunSurface />);

    const empty = await screen.findByRole("status");
    expect(empty.textContent).not.toMatch(/LearningRun|系统/);
    fireEvent.click(screen.getByRole("button", { name: "回书桌" }));
    expect(invoke).toHaveBeenCalledWith("home");
  });

  it("正控制：读取成功时这一屏换成题目，边界不在", async () => {
    const get = vi.fn(async () => ok(snapshot()));
    mount(get);

    await screen.findByText("为什么这套顺序不能换？");
    expect(screen.queryByText(/正在打开这一轮/)).toBeNull();
    expect(screen.queryByRole("button", { name: "先离开，回书桌" })).toBeNull();
  });
});
