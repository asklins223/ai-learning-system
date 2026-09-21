// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  learningRunPublicSnapshotV2Schema,
  learningRunResultV2Schema,
  getLearningRunResultResponseV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import { LearningRunSurface } from "./learning-run-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 结算页的结构回归（31-objective-flow-ui-review P5）。
 *
 * 出口按钮此前长在 `overflow:auto` 的报告列里，判定一多就把「返回书房」顶到
 * 折叠线以下——1440×810 实测按钮底边 789、纸面底边 755，用户看不到出口。
 * 这里钉住结构：出口是结算板的直接子节点，不在报告列内部。几何由 CDP 探针量
 * （scripts/tmp-objflow-s14-measure.mjs），jsdom 量不了。
 */

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const CARD_ID = "00000000-0000-4000-8000-000000000003";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000004";

const origin = { kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID } as const;
const returnTarget = { kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID } as const;

const completedSnapshot = () => learningRunPublicSnapshotV2Schema.parse({
  version: 2,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2: origin,
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
  returnTargetV2: returnTarget,
  phase: "completed",
  runRevision: 3,
  runtimeEpoch: 1,
  activeSecondsUsed: 96,
  timeBudgetSeconds: 180,
  activeTask: null,
  allowedActions: [],
  publishedTargetEligibility: "eligible",
});

const resultWithRubric = (rubricLength: number) => learningRunResultV2Schema.parse({
  version: 2,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2: origin,
  outcome: "demonstrated",
  demonstratedFacets: ["recall", "explain"],
  gapFacets: [],
  scheduleImpact: { kind: "created", dueAt: "2026-09-24T09:00:00+08:00", policyReason: "demonstrated" },
  returnTargetV2: returnTarget,
  assessment: {
    source: "assessment_critic",
    status: "completed",
    trustClass: "mastery_eligible",
    rubricResults: Array.from({ length: rubricLength }, (_, index) => ({
      rubricItemId: `rubric-${index + 1}`,
      facet: "recall",
      verdict: "covered",
      userFacingReason: `第 ${index + 1} 条说清了。`,
    })),
  },
});

function stubGateway(rubricLength: number) {
  const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ailearn = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: "00000000-0000-4000-8000-000000000009" },
      })),
    },
    learningRun: {
      get: vi.fn(async () => ok(completedSnapshot())),
      getDraft: vi.fn(async () => ok(null)),
      getResult: vi.fn(async () => ok(getLearningRunResultResponseV2Schema.parse({
        version: 2,
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        originV2: origin,
        returnTargetV2: returnTarget,
        status: "learning_result",
        httpStatus: 200,
        result: resultWithRubric(rubricLength),
      }))),
      getReturnContract: vi.fn(async () => ok(null)),
      revealTarget: vi.fn(async () => ok({})),
      recordActivityLease: vi.fn(async () => ok({ activeSecondsUsed: 96, runRevision: 3 })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "sub-1" })),
      onEvent: vi.fn(() => () => undefined),
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
}

function renderResult(rubricLength = 12) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stubGateway(rubricLength);
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
  render(<LearningRunSurface onExit={() => undefined} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null });
});

describe("LearningRunSurface · 结算页结构", () => {
  it("出口在结算板上，不在会滚动的报告列里", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    const actions = document.querySelector(".learning-run-result-actions");
    const report = document.querySelector(".learning-run-result-report");
    const board = document.querySelector(".learning-run-result-board");

    expect(actions).not.toBeNull();
    // 病根就是这个包含关系：报告列是 overflow:auto，出口一旦落在它内部就会被顶出折叠线。
    expect(report?.contains(actions as Node)).toBe(false);
    expect(actions?.parentElement).toBe(board);
  });

  it("判定再多也把出口留在板上：12 条 rubric 时报告列与出口是兄弟", async () => {
    renderResult(12);
    await waitFor(() => expect(document.querySelectorAll(".learning-run-result-rubric li").length).toBe(12));

    const board = document.querySelector(".learning-run-result-board");
    const children = [...(board?.children ?? [])].map((el) => el.className.split(" ").at(-1));
    expect(children).toEqual([
      "learning-run-result-summary",
      "learning-run-result-report",
      "learning-run-result-actions",
    ]);
  });

  it("两个出口都还在，且主出口是第一个", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-actions")).not.toBeNull());

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".learning-run-result-actions button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["返回书房", "查看理解目标"]);
    expect(buttons[0]?.className).toContain("primary");
    expect(screen.queryByText("已跳过")).toBeNull();
  });
});
