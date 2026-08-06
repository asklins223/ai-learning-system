/**
 * 生成进度文案格式化 — 单元测试。
 *
 * supervisor_agent_v1 引擎的 run.progress 使用 unit="percent"、total=100
 * 表达整体完成百分比。此前前端把 "0/100 percent" 原样拼进中文文案，
 * 出现 "提炼卡片 0/100 percent；你可以继续编辑…" 这类展示问题。
 *
 * 这里直接测 generationProgressLabel 与 generationRunMessage：
 * - percent 单位显示为 "N%"（不是 "N/100 percent"）
 * - 旧引擎的计数进度（如 "blocks"）仍显示为 "完成数/总数"
 * - total<=0 时回退到"等待首个进度"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generationProgressLabel,
  generationRunMessage,
  measuredCoverageLabel,
  measuredGenerationPercent,
} from "../../components/note-editor/note-editor-utils.ts";
import type { CardGenerationRunView } from "../../lib/api-types.ts";

function activeRun(progress: CardGenerationRunView["progress"]): CardGenerationRunView {
  return {
    runId: "run-1",
    noteId: "note-1",
    noteVersionId: "nv-1",
    status: "running",
    stage: "running",
    stateVersion: 0,
    sequence: 1,
    engineMode: "supervisor_agent_v1",
    shellVersion: "v1",
    shellStage: "generating",
    sourceSnapshot: { noteVersionId: "nv-1", versionNo: 3, contentHash: "h" },
    progress,
    coverage: {
      sourceUnitsCompleted: 0,
      sourceUnitsTotal: 1,
      imagesCompleted: 0,
      imagesTotal: 0,
      sourceCoverageBps: 0,
      imageCoverageBps: 10_000,
    },
    warnings: [],
    actions: { retryable: false, restartable: false, cancellable: true },
    result: null,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    finishedAt: null,
  };
}

describe("generationProgressLabel", () => {
  it("percent 单位按百分比展示", () => {
    assert.equal(generationProgressLabel({ completed: 0, total: 100, unit: "percent" }), "0%");
    assert.equal(generationProgressLabel({ completed: 43, total: 100, unit: "percent" }), "43%");
    assert.equal(generationProgressLabel({ completed: 100, total: 100, unit: "percent" }), "100%");
  });

  it("percent 数值钳制在 0-100 之间", () => {
    assert.equal(generationProgressLabel({ completed: 120, total: 100, unit: "percent" }), "100%");
    assert.equal(generationProgressLabel({ completed: -5, total: 100, unit: "percent" }), "0%");
  });

  it("计数单位（如旧引擎 blocks）显示为 完成数/总数", () => {
    assert.equal(generationProgressLabel({ completed: 3, total: 20, unit: "blocks" }), "3/20");
  });

  it("total<=0 时回退到等待首个进度", () => {
    assert.equal(generationProgressLabel({ completed: 0, total: 0, unit: "percent" }), "等待首个进度");
  });
});

describe("generationRunMessage", () => {
  it("进行中的 percent 进度不泄漏英文 unit", () => {
    const message = generationRunMessage(activeRun({ completed: 0, total: 100, unit: "percent" }));
    assert.equal(message, "提炼卡片 · 0%；你可以继续编辑，新修改会进入下一版本。");
    assert.ok(!message.includes("percent"), "不应把英文 unit 拼进中文文案");
  });

  it("进度推进时显示对应百分比", () => {
    const message = generationRunMessage(activeRun({ completed: 43, total: 100, unit: "percent" }));
    assert.ok(message.includes("43%"));
  });

  it("计数进度保持 完成数/总数 格式", () => {
    const message = generationRunMessage(activeRun({ completed: 3, total: 20, unit: "blocks" }));
    assert.equal(message, "提炼卡片 · 3/20；你可以继续编辑，新修改会进入下一版本。");
  });
});

describe("measuredCoverageLabel 保持稳定", () => {
  it("覆盖率展示仍为 完成数/总数 · 百分比", () => {
    assert.equal(measuredCoverageLabel(0, 1, 0), "0/1 · 0%");
    assert.equal(measuredCoverageLabel(0, 1, null), "0/1 · 待测量");
  });
});

describe("measuredGenerationPercent — 真实进度推导", () => {
  const baseMetrics = {
    bundles: { planned: 1, assigned: 1, decided: 0, required: 1 },
    childTasks: { pending: 2, running: 2, completed: 1, failed: 0 },
    candidates: { extracted: 3, canonical: 1, eligible: 0, rejected: 0 },
    draft: { version: 1, producedByRole: null },
    critic: { status: null, hardIssues: 0, softIssues: 0 },
    verify: { passedChecks: 0, totalChecks: 0 },
    semanticIndex: { mode: "vector", status: "ready" },
    usageTokens: 0,
  };

  function runWith(stage: string, patch: Partial<typeof baseMetrics> = {}, status = "running"): CardGenerationRunView {
    return {
      ...activeRun({ completed: 0, total: 100, unit: "percent" }),
      status: status as CardGenerationRunView["status"],
      stage,
      shellStage: stage,
      metrics: { ...baseMetrics, ...patch },
    };
  }

  it("generating 阶段按 childTasks 完成比例推进，不跳变到 100", () => {
    // 1/5 完成 → 15 + 55 * 0.2 ≈ 26
    assert.equal(measuredGenerationPercent(runWith("generating")), 26);
    // 全部完成仍停在 generating 的 70，而非 100
    assert.equal(
      measuredGenerationPercent(runWith("generating", {
        childTasks: { pending: 0, running: 0, completed: 5, failed: 0 },
      })),
      70,
    );
  });

  it("preparing 阶段用 bundles 领取/决策比例", () => {
    // baseMetrics: assigned 1 / (planned 1 + required 1) = 0.5 → 15 * 0.5 ≈ 8
    assert.equal(measuredGenerationPercent(runWith("preparing")), 8);
    // planned 2 required 1 已领取 1 → (1)/(3) ≈ 33% → 15 * 0.33 ≈ 5
    assert.equal(
      measuredGenerationPercent(runWith("preparing", {
        bundles: { planned: 2, assigned: 1, decided: 0, required: 1 },
      })),
      5,
    );
  });

  it("checking 阶段用 verify checks 比例", () => {
    assert.equal(
      measuredGenerationPercent(runWith("checking", {
        verify: { passedChecks: 4, totalChecks: 8 },
      })),
      79, // 70 + 18 * 0.5
    );
  });

  it("publishing 阶段在结果未落库时为中间值，有结果则到 100", () => {
    assert.equal(measuredGenerationPercent(runWith("publishing")), 95); // 88 + 12 * 0.6
    const withResult = runWith("publishing");
    withResult.result = { cardId: "c1", cardSetId: null };
    assert.equal(measuredGenerationPercent(withResult), 100);
  });

  it("succeeded 终态固定 100", () => {
    const run = runWith("publishing");
    run.result = { cardId: "c1", cardSetId: null };
    assert.equal(measuredGenerationPercent({ ...run, status: "succeeded" }), 100);
  });

  it("无 metrics（旧引擎）回退合成百分比，活动 run 钳制到 95 以下", () => {
    const run = activeRun({ completed: 100, total: 100, unit: "percent" });
    assert.equal(measuredGenerationPercent(run), 95);
    assert.equal(measuredGenerationPercent({ ...run, status: "succeeded" }), 100);
  });
});
