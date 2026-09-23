// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * 出口按钮此前长在 `overflow:auto` 的报告列里，判定一多就把「返回学习空间」顶到
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

/** 相对今天算，别让断言随日历腐烂。 */
const dayOffset = (days: number) => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
};

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

const assessingSnapshot = () => learningRunPublicSnapshotV2Schema.parse({
  ...completedSnapshot(),
  phase: "assessing",
});

const resultWithRubric = (
  rubricLength: number,
  overrides: Record<string, unknown> = {},
) => learningRunResultV2Schema.parse({
  version: 2,
  runId: RUN_ID,
  snapshotId: SNAPSHOT_ID,
  originV2: origin,
  outcome: "demonstrated",
  demonstratedFacets: ["recall", "explain"],
  gapFacets: [],
  scheduleImpact: { kind: "created", dueAt: dayOffset(3), policyReason: "demonstrated" },
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
  ...overrides,
});

/** 一次「全说清但只算练习」的结算——31 号文档 P1 的原始形态。 */
const allCoveredPractice = () => resultWithRubric(4, {
  outcome: "practice_completed",
  demonstratedFacets: [],
  gapFacets: [],
  scheduleImpact: { kind: "none", reasonCode: "practice_only" },
  assessment: {
    source: "assessment_critic",
    status: "completed",
    trustClass: "practice_only",
    rubricResults: ["提", "拔", "握", "压"].map((step, index) => ({
      rubricItemId: `rubric-${index + 1}`,
      facet: "recall",
      verdict: "covered",
      userFacingReason: `${step} 那一步说清了。`,
    })),
  },
});

function stubGateway(resultPayload: unknown, rubricLength = 12, snapshotPayload = completedSnapshot()) {
  const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
  const result = resultPayload === undefined ? resultWithRubric(rubricLength) : resultPayload;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ailearn = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: "00000000-0000-4000-8000-000000000009" },
      })),
    },
    learningRun: {
      get: vi.fn(async () => ok(snapshotPayload)),
      getDraft: vi.fn(async () => ok(null)),
      getResult: vi.fn(async () => ok(getLearningRunResultResponseV2Schema.parse({
        version: 2,
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        originV2: origin,
        returnTargetV2: returnTarget,
        status: "learning_result",
        httpStatus: 200,
        result,
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

function renderResult(rubricLength = 12, resultPayload?: unknown, onExit = vi.fn(), snapshotPayload = completedSnapshot()) {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stubGateway(resultPayload, rubricLength, snapshotPayload);
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: OBJECTIVE_ID });
  render(<LearningRunSurface onExit={onExit} />);
  return onExit;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null, masterMuted: false, motionMode: "full", reducedMotion: false });
});

describe("LearningRunSurface · 新结果过关演出", () => {
  it("新完成的正式 demonstrated 播放一次，可按 Esc 立即跳过", async () => {
    renderResult(2, resultWithRubric(2), vi.fn(), assessingSnapshot());
    await waitFor(() => expect(document.querySelector(".learning-run-ceremony")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".learning-run-ceremony")).toBeNull());
    expect(document.querySelector(".learning-run-result-board")).not.toBeNull();
  });

  it("历史 demonstrated 与新完成的 practice_completed 都不播放正式过关", async () => {
    renderResult(2, resultWithRubric(2));
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());
    expect(document.querySelector(".learning-run-ceremony")).toBeNull();
    cleanup();

    renderResult(2, allCoveredPractice(), vi.fn(), assessingSnapshot());
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());
    expect(document.querySelector(".learning-run-ceremony")).toBeNull();
  });

  it("关闭动效或偏好减少动效时直接显示结果，不等待演出", async () => {
    useRoomStore.setState({ motionMode: "off" });
    renderResult(2, resultWithRubric(2), vi.fn(), assessingSnapshot());
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());
    expect(document.querySelector(".learning-run-ceremony")).toBeNull();
    cleanup();

    useRoomStore.setState({ motionMode: "full", reducedMotion: true });
    renderResult(2, resultWithRubric(2), vi.fn(), assessingSnapshot());
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());
    expect(document.querySelector(".learning-run-ceremony")).toBeNull();
  });
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
      "learning-run-arrival",
      "learning-run-arrival-evidence",
      "learning-run-result-report",
      "learning-run-result-actions",
    ]);
  });

  it("两个出口都还在，且主出口是第一个", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-actions")).not.toBeNull());

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".learning-run-result-actions button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["返回学习空间", "查看理解目标"]);
    expect(buttons[0]?.className).toContain("primary");
  });

  it("结果到达后会留在报告页，只有用户点击出口才离开", async () => {
    const onExit = renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回学习空间" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // ---- B1：结算页的反馈必须兑现（31 号文档 P1 / P3 / P6）----

  it("四条判定全说清时，直接列出真实评分理由，且不再报任何缺口", async () => {
    renderResult(12, allCoveredPractice());
    await waitFor(() => expect(document.querySelector("[data-role='proved-this-time']")).not.toBeNull());

    expect(document.querySelector("[data-role='proved-this-time']")?.textContent).toContain("提 那一步说清了。");
    const rows = [...document.querySelectorAll(".learning-run-result-evidence > div")]
      .map((d) => d.textContent ?? "");
    // 「还需补上」里不许出现这次已经说清的 facet——旧行为是同屏四行「说清了」
    // 加一句「还需补上：回忆」。
    const gapRow = rows.find((text) => text.startsWith("还差什么"));
    expect(gapRow).toBe("还差什么可以按原路线继续正式挑战。");
    expect(document.querySelector(".learning-run-arrival-evidence")?.textContent)
      .toContain("提 那一步说清了。");
  });

  it("练习结算的解释说清「为什么不写进理解账本」，不再用一句自我否定占位", async () => {
    renderResult(12, allCoveredPractice());
    await waitFor(() => expect(document.querySelector("[data-role='proved-this-time']")).not.toBeNull());

    const ledger = [...document.querySelectorAll(".learning-run-result-evidence > div")]
      .find((d) => d.textContent?.startsWith("本次掌握"));
    expect(ledger?.textContent).toContain("这次是练习，所以不写进理解账本。");
    expect(ledger?.textContent).not.toContain("还没有形成");
  });

  it("练习结果首屏不再只剩「练习完成」，会直接给出收获、缺口与下一步", async () => {
    renderResult(12, allCoveredPractice());
    await waitFor(() => expect(document.querySelector(".learning-run-arrival-evidence")).not.toBeNull());

    expect(document.querySelector(".learning-run-arrival__seal")?.textContent).toBe("练习有收获");
    expect(screen.getByRole("heading", { name: "这次练习，已经看见你会了什么" })).toBeTruthy();
    const compact = document.querySelector(".learning-run-arrival-evidence")?.textContent ?? "";
    expect(compact).toContain("做对了什么提 那一步说清了。");
    expect(compact).toContain("还差什么可以按原路线继续正式挑战。");
    expect(compact).toContain("下一步");
  });

  it("静音时只收起伴星动作口吻，不会把核心学习反馈一起藏掉", async () => {
    useRoomStore.setState({ masterMuted: true });
    renderResult(12, allCoveredPractice());
    await waitFor(() => expect(document.querySelector(".learning-run-arrival-evidence")).not.toBeNull());

    expect(document.querySelector(".learning-run-result-companion")).toBeNull();
    expect(document.querySelector(".learning-run-arrival-evidence")?.textContent).toContain("提 那一步说清了。");

    fireEvent.click(screen.getByRole("button", { name: /翻开本次发现/ }));
    expect(document.querySelector(".learning-run-discovery__front")?.textContent).not.toContain("伴星发现");
    expect(document.querySelector(".learning-run-discovery__front")?.textContent).toContain("来自本次真实评分证据");
  });

  it("rubric 判定有缺口但 gapFacets 为空时，摘要与明细使用同一结论", async () => {
    const practiceWithRubricGap = resultWithRubric(1, {
      outcome: "practice_completed",
      demonstratedFacets: [],
      gapFacets: [],
      scheduleImpact: { kind: "none", reasonCode: "practice_only" },
      assessment: {
        source: "assessment_critic",
        status: "completed",
        trustClass: "practice_only",
        rubricResults: [{
          rubricItemId: "rubric-gap",
          facet: "boundary",
          verdict: "missing",
          userFacingReason: "还没有说明成立边界。",
        }],
      },
    });
    renderResult(1, practiceWithRubricGap);
    await waitFor(() => expect(document.querySelector(".learning-run-arrival-evidence")).not.toBeNull());

    expect(document.querySelector(".learning-run-arrival-evidence")?.textContent).toContain("边界");
    const detail = [...document.querySelectorAll(".learning-run-result-evidence > div")]
      .find((row) => row.textContent?.startsWith("还差什么"));
    expect(detail?.textContent).toContain("边界");
    expect(detail?.textContent).not.toContain("没有留下待补");
  });

  it.each([
    ["skipped", "这次先放着"],
    ["declared_unable", "这次说了暂时不会"],
  ])("%s 不配印章（DESIGN.md:152），槽位上只留一行安静的话", async (outcome, quietCopy) => {
    renderResult(12, resultWithRubric(0, {
      outcome,
      demonstratedFacets: [],
      gapFacets: [],
      scheduleImpact: { kind: "none", reasonCode: outcome === "skipped" ? "skipped" : "record_only" },
      assessment: undefined,
    }));
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    expect(document.querySelector(".learning-run-arrival__seal")).toBeNull();
    expect(document.querySelector(".learning-run-arrival__quiet")?.textContent).toBe(quietCopy);
  });

  it("真正成立的结果仍然有印章——上面那条不是把印章整个删掉", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    expect(document.querySelector(".learning-run-arrival__seal")?.textContent).toBe("掌握完成");
    expect(document.querySelector(".learning-run-arrival__quiet")).toBeNull();
  });

  // ---- B3：下次到期不能再读成「刚刚」（31 号文档 P4）----

  it("结算页那条带子和列表/详情是同一个对象，位置读本次的结论", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    const band = document.querySelector(".learning-run-arrival .objective-progress");
    expect(band, "结算页没有那条进度带").not.toBeNull();
    expect(band?.getAttribute("data-segment")).toBe("2");
    expect([...band!.querySelectorAll(".objective-progress__seg")].map((s) => s.getAttribute("data-lit")))
      .toEqual(["true", "true", "true"]);
  });

  it("全说清但只算练习时，带子停在「练过了」而不是「说清了」", async () => {
    // 这条正是 P1 的原始形态：四条 rubric 全 covered，但结论是 practice_completed。
    // 带子如果按 rubric 自己数，就会在这里撒一个更好看的谎。
    renderResult(12, allCoveredPractice());
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    const band = document.querySelector(".learning-run-arrival .objective-progress");
    expect(band?.getAttribute("data-segment")).toBe("1");
    expect(band?.getAttribute("aria-label")).toContain("练过了");
  });

  it("三天后的复习写「3 天后」，不是「刚刚」", async () => {
    renderResult();
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    const schedule = [...document.querySelectorAll(".learning-run-result-evidence > div")]
      .find((d) => d.textContent?.startsWith("学习状态变化"));
    expect(schedule?.textContent).toContain("下次到期 3 天后。");
    expect(schedule?.textContent).not.toContain("刚刚");
  });

  it("明天的复习写「明天」", async () => {
    renderResult(12, resultWithRubric(1, {
      scheduleImpact: { kind: "created", dueAt: dayOffset(1), policyReason: "demonstrated" },
    }));
    await waitFor(() => expect(document.querySelector(".learning-run-result-board")).not.toBeNull());

    const schedule = [...document.querySelectorAll(".learning-run-result-evidence > div")]
      .find((d) => d.textContent?.startsWith("学习状态变化"));
    expect(schedule?.textContent).toContain("下次到期 明天。");
  });
});
