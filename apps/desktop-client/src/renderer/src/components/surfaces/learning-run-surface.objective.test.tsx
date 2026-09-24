// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learningRunPublicSnapshotV2Schema } from "@ailearn/shared/learning-run-v2-contracts";
import { LearningRunSurface } from "./learning-run-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 客观题作答控件（2026-09-21 客观题方案批次 3）。
 *
 * 钉住三件事，每件都是"看起来能用、实际会把练习件白做"的形状：
 * 1. **没有预选**：选择题一进来不能替用户选第一项，判断题不能默认"对"——
 *    否则用户什么都没做就已经交了一个答案，判分结果全是噪声；
 * 2. 没作答时提交按钮不可用，选了之后提交带的是**结构化作答载荷**而不是一段文本；
 * 3. 题面标签是人话（选择题 / 判断题 / 配对题），不是 interaction kind 字面量。
 */

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000005";
const VARIANT_ID = "00000000-0000-4000-8000-000000000006";

const taskWith = (interaction: Record<string, unknown>) => ({
  version: 1,
  taskId: TASK_ID,
  runId: RUN_ID,
  sequence: 1,
  intent: "recall",
  prompt: "灭火器使用口诀的四个动作，哪个先做？",
  targetSummary: "灭火器使用四步顺序",
  activeVariant: {
    variantId: VARIANT_ID,
    purpose: "practice",
    interaction,
    templateTrustCeiling: "practice_only",
    estimatedActiveSeconds: 45,
    publicPayloadHash: "a".repeat(64),
    inputSchemaHash: "b".repeat(64),
    disclosureProfileHash: "c".repeat(64),
    revision: 1,
  },
  availableAlternatives: [] as Array<Record<string, unknown>>,
  assistancePolicy: { hintLevels: 2, exposureLowersTrust: true },
  status: "active",
  revision: 1,
});

const snapshotFor = (interaction: Record<string, unknown>) => learningRunPublicSnapshotV2Schema.parse({
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
    publicSummary: "灭火器使用四步顺序",
    semanticTargetFingerprint: "b".repeat(64),
    targetRevisionHash: "c".repeat(64),
  },
  returnTargetV2: { kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID },
  phase: "active",
  runRevision: 1,
  runtimeEpoch: 1,
  activeSecondsUsed: 5,
  timeBudgetSeconds: 180,
  activeTask: taskWith(interaction),
  allowedActions: [
    { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    { version: 2, kind: "pause" },
  ],
  publishedTargetEligibility: "practice_only",
});

const CHOICE = {
  kind: "single_choice",
  publicOptionIds: ["opt:b", "opt:a"],
  publicOptionLabels: {
    "opt:b": "提起灭火器，再拔掉保险销",
    "opt:a": "先拔保险销，再举起灭火器",
  },
};

function stubGateway() {
  const submits: unknown[] = [];
  const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
  window.ailearn = {
    contract: { enabledRoutes: ["learningRun.get", "learningRun.submit"] },
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: "00000000-0000-4000-8000-000000000009" },
      })),
    },
    learningRun: {
      get: vi.fn(async () => ok(snapshots.shift() ?? last)),
      getDraft: vi.fn(async () => ok(null)),
      saveDraft: vi.fn(async (input: { runId: string; taskId: string }) => ok({
        version: 2, runId: input.runId, taskId: input.taskId, variantId: VARIANT_ID,
        snapshotId: SNAPSHOT_ID, taskRevision: 1, draftRevision: 1, draftHash: "d".repeat(64),
      })),
      submit: vi.fn(async (input: { request: { payload: unknown } }) => {
        submits.push(input.request.payload);
        return ok({
          version: 2, runId: RUN_ID, taskId: TASK_ID, snapshotId: SNAPSHOT_ID,
          artifactId: SNAPSHOT_ID,
        });
      }),
      act: vi.fn(async () => ok({ version: 2, runId: RUN_ID, snapshotId: SNAPSHOT_ID })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "sub-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok(null)),
    },
  } as unknown as typeof window.ailearn;
  return { submits };
}

let snapshots: Array<ReturnType<typeof snapshotFor>> = [];
let last: ReturnType<typeof snapshotFor>;

const renderWith = async (interaction: Record<string, unknown>) => {
  last = snapshotFor(interaction);
  snapshots = [last];
  const gateway = stubGateway();
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
  render(<LearningRunSurface onExit={() => undefined} />);
  await waitFor(() => expect(screen.getAllByRole("radio").length).toBeGreaterThan(0));
  return gateway;
};

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null });
});

describe("客观题作答控件", () => {
  it("选择题：进来一个选项都没被选中，提交按钮不可用", async () => {
    await renderWith(CHOICE);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getByRole("button", { name: /提交/ }).hasAttribute("disabled")).toBe(true);
  });

  it("选择题：选一项后提交，交的是结构化作答而不是一段文本", async () => {
    const { submits } = await renderWith(CHOICE);
    fireEvent.click(screen.getByRole("radio", { name: /提起灭火器，再拔掉保险销/ }));
    const submit = screen.getByRole("button", { name: /提交/ });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(submits).toHaveLength(1));
    expect(submits[0]).toMatchObject({ kind: "choice", selectedOptionId: "opt:b" });
  });

  it("判断题：对/错都不预设，点「这条说法错」交的是 answer:false", async () => {
    const { submits } = await renderWith({
      kind: "true_false",
      proposition: "间隔越长的复习对长期记忆一定越好。",
    });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    fireEvent.click(screen.getByRole("radio", { name: "这条说法错" }));
    fireEvent.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(submits).toHaveLength(1));
    expect(submits[0]).toMatchObject({ kind: "true_false", answer: false });
  });

  it("题面标签说人话，不打印交互字面量", async () => {
    await renderWith(CHOICE);
    expect(document.querySelector(".learning-run-paper__question span")?.textContent).toContain("选择题");
    expect(document.body.textContent).not.toContain("single_choice");
  });

  it("题面主位是主题，那句作答指令只能当副行", async () => {
    // recall 题的 prompt 为 §7.3 泄题防护故意不含内容（run-planner.ts:210），
    // 全仓一字不变。它一旦回到 h2，纸面最大的字就落在零信息的那句上，
    // 而这张卡唯一会变的主题被挤到 14px——用户原话是"第一眼没看到题目"。
    await renderWith(CHOICE);
    const question = document.querySelector(".learning-run-paper__question");
    expect(question?.querySelector("h2")?.textContent).toBe("灭火器使用四步顺序");
    expect(question?.querySelector("p")?.textContent).toBe("灭火器使用口诀的四个动作，哪个先做？");
  });

  it("排序题每一行都带位置编号（P24）", async () => {
    // 排序题的全部认知负荷在「谁在第几位」。此前 <ol> 的 list-style 被关掉、也没有
    // 别的编号，屏幕上没有任何位置标记，而移动按钮在 500px 外的最右端。
    last = snapshotFor({
      kind: "ordering",
      publicTokenIds: ["tok:c", "tok:a", "tok:b"],
      publicTokenLabels: {
        "tok:c": "压下压把，左右扫射",
        "tok:a": "提起灭火器，颠倒几次",
        "tok:b": "拔掉保险销",
      },
    });
    snapshots = [last];
    stubGateway();
    useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
    render(<LearningRunSurface onExit={() => undefined} />);
    await waitFor(() => expect(document.querySelectorAll(".run-order-list > li").length).toBe(3));
    expect([...document.querySelectorAll(".run-order-index")].map((badge) => badge.textContent)).toEqual(["1", "2", "3"]);
  });
});
