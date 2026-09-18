import { describe, expect, it } from "vitest";
import {
  cardGenerationEntryLabel,
  cardGenerationRecoveryReasonLabel,
  cardGenerationShowsProgress,
  cardGenerationStage,
  cardGenerationStageCount,
  cardGenerationStatusLabel,
  cardGenerationSyncReportText,
  isCardGenerationInFlight,
  isCardGenerationReviewOpen,
  isCardGenerationReviewStage,
  isLiveGenerationForNote,
  isNoteGenerationLive,
} from "./card-generation-status";
import type { CardGenerationActiveSummaryV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { isCardGenerationReviewOpen as sharedIsCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";

const summary = (overrides: Partial<CardGenerationActiveSummaryV1>): CardGenerationActiveSummaryV1 => ({
  version: 1,
  runId: "aaaaaaa1-1111-4111-8111-111111111111",
  noteId: "bbbbbbb1-1111-4111-8111-111111111111",
  noteVersionId: "ccccccc1-1111-4111-8111-111111111111",
  status: "checking",
  currentPlanVersion: 1,
  reviewDraftRevision: 1,
  updatedAt: "2026-09-17T00:00:00.000Z",
  recovery: null,
  route: { kind: "note.cardGeneration", cardGenerationRunId: "aaaaaaa1-1111-4111-8111-111111111111" },
  ...overrides,
});

describe("card-generation-status", () => {
  it("未知状态不臆造含义", () => {
    expect(cardGenerationStatusLabel("mystery_token")).toBe("服务端处理中");
    expect(cardGenerationRecoveryReasonLabel("mystery_token")).toBe("服务端需要进一步处理");
  });

  it("四阶段覆盖全部运行状态且单调", () => {
    for (const [status, stage] of [
      ["queued", 0],
      ["source_sealing", 0],
      ["planning", 1],
      ["authoring", 1],
      ["checking", 2],
      ["review_ready", 3],
      ["failed", 3],
    ] as const) {
      expect(cardGenerationStage(status)).toBe(stage);
    }
  });

  it("服务端活跃名单里的状态都可作为笔记页的入口", () => {
    for (const status of ["queued", "source_sealing", "planning", "authoring", "checking", "review_ready", "needs_attention", "activating"]) {
      expect(isNoteGenerationLive(status)).toBe(true);
    }
    // 终态不是"进行中"——激活/关闭/取消后应允许再次生成。
    for (const status of ["activated", "closed_without_activation", "cancelled", "failed", "stale", "no_cards_recommended"]) {
      expect(isNoteGenerationLive(status)).toBe(false);
    }
  });

  it("入口文案按状态指向工作台，从不说『生成学习卡』", () => {
    const labels = [
      cardGenerationEntryLabel("checking"),
      cardGenerationEntryLabel("review_ready"),
      cardGenerationEntryLabel("needs_attention"),
      cardGenerationEntryLabel("activating"),
    ];
    for (const label of labels) {
      expect(label).not.toContain("生成学习卡");
    }
    expect(cardGenerationEntryLabel("review_ready")).toBe("审核学习卡");
  });

  it("in-flight 与 review-stage 的覆盖关系符合业务语义", () => {
    // 纯工作期：只在转，不在审核页。
    for (const status of ["queued", "source_sealing", "planning", "authoring", "checking"]) {
      expect(isCardGenerationInFlight(status)).toBe(true);
      expect(isCardGenerationReviewStage(status)).toBe(false);
    }
    // activating 双态：页面还在审核版式，同时服务端正在提交激活（转圈）。
    expect(isCardGenerationInFlight("activating")).toBe(true);
    expect(isCardGenerationReviewStage("activating")).toBe(true);
    // 审核页静态状态。
    for (const status of ["review_ready", "no_cards_recommended", "needs_attention", "activated", "closed_without_activation"]) {
      expect(isCardGenerationReviewStage(status)).toBe(true);
      expect(isCardGenerationInFlight(status)).toBe(false);
    }
  });

  it("isLiveGenerationForNote 只认本笔记的活跃任务", () => {
    const own = summary({});
    const other = summary({ noteId: "ddddddd1-1111-4111-8111-111111111111" });
    const terminal = summary({ status: "cancelled" });
    expect(isLiveGenerationForNote(own, own.noteId)).toBe(true);
    expect(isLiveGenerationForNote(other, own.noteId)).toBe(false);
    expect(isLiveGenerationForNote(terminal, terminal.noteId)).toBe(false);
    expect(isLiveGenerationForNote(null, own.noteId)).toBe(false);
  });

  /**
   * needs_attention 不是审核队列的终点：deck gate 失败时 worker 会保留通过门禁的
   * 候选，用户必须还能决定它们。审核页、API review / activate / close 共用同一个
   * 谓词，所以这里既锁值，也锁「客户端用的就是共享的那一份」。
   */
  it("审核开放态包含 needs_attention，且与共享定义一致", () => {
    expect(isCardGenerationReviewOpen("review_ready")).toBe(true);
    expect(isCardGenerationReviewOpen("needs_attention")).toBe(true);
    for (const status of ["queued", "planning", "checking", "activating", "activated", "cancelled", "failed", "stale", "no_cards_recommended", "closed_without_activation"]) {
      expect(isCardGenerationReviewOpen(status)).toBe(false);
    }
    for (const status of ["review_ready", "needs_attention", "planning", "cancelled", "mystery"]) {
      expect(isCardGenerationReviewOpen(status)).toBe(sharedIsCardGenerationReviewOpen(status));
    }
  });

  it("进度条只在服务端还在推进或已交付审核时出现", () => {
    for (const status of ["queued", "source_sealing", "planning", "authoring", "checking", "activating", "review_ready"]) {
      expect(cardGenerationShowsProgress(status)).toBe(true);
    }
    // needs_attention 会被 cardGenerationStage 映射到"审核"那一步，但它并没有走到
    // 那里 —— 进度条必须闭嘴，否则"第 4 / 4 步"是一句假话。
    for (const status of ["needs_attention", "failed", "stale", "cancelled", "activated", "closed_without_activation", "no_cards_recommended"]) {
      expect(cardGenerationShowsProgress(status)).toBe(false);
    }
    expect(cardGenerationStageCount).toBe(4);
  });

  it("同步回执说清楚这次重读读到了什么", () => {
    expect(cardGenerationSyncReportText(null, false)).toContain("没有读到服务端状态");
    expect(cardGenerationSyncReportText("planning", false)).toContain("仍是「正在规划候选」");
    expect(cardGenerationSyncReportText("checking", true)).toContain("推进到「正在做质量检查」");
    // 状态没变时不能说成"已更新"——那正是用户抱怨"点了没用"的来源。
    expect(cardGenerationSyncReportText("planning", false)).not.toContain("推进到");
  });
});
