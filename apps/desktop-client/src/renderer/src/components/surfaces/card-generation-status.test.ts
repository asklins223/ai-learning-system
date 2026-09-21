import { describe, expect, it } from "vitest";
import {
  cardGenerationEntryLabel,
  cardGenerationProgressView,
  cardGenerationRecoveryReasonLabel,
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
    expect(cardGenerationStatusLabel("mystery_token")).toBe("还在处理");
    expect(cardGenerationRecoveryReasonLabel("mystery_token")).toBe("需要后台再看一次才能继续");
  });

  /**
   * 2026-09-20 实走复盘 #2：这里曾经是 `["failed", 3]` ——兜底把没列出的状态一律
   * 算成"审核阶段"，于是进度条恒定 75%、前三行一起亮「已完成」，用户看到的
   * "从第 2 步直接跳完成"就是这么来的。说不出走到哪一步的状态现在返回 null。
   */
  it("阶段映射逐项枚举，说不出就返回 null 而不是兜底成最后一步", () => {
    expect({
      queued: cardGenerationStage("queued"),
      source_sealing: cardGenerationStage("source_sealing"),
      planning: cardGenerationStage("planning"),
      authoring: cardGenerationStage("authoring"),
      checking: cardGenerationStage("checking"),
      review_ready: cardGenerationStage("review_ready"),
      activating: cardGenerationStage("activating"),
      activated: cardGenerationStage("activated"),
    }).toEqual({
      queued: 0, source_sealing: 0, planning: 1, authoring: 1,
      checking: 2, review_ready: 3, activating: 4, activated: 4,
    });
    for (const status of ["failed", "stale", "cancelled", "needs_attention", "no_cards_recommended", "closed_without_activation", "mystery"]) {
      expect(cardGenerationStage(status), status).toBeNull();
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

  it("进度只在服务端确认的阶段上说话", () => {
    expect(cardGenerationProgressView("queued", null)).toEqual({
      stage: 0, percent: 0, detail: null, inFlight: false, eyebrow: "第 1 步 / 共 4 步",
    });
    expect(cardGenerationProgressView("review_ready", null)?.percent).toBe(75);
    expect(cardGenerationProgressView("activated", null)?.percent).toBe(100);
    // needs_attention / failed / stale 等走不到"第几步"的结论，进度块整体不渲染。
    for (const status of ["needs_attention", "failed", "stale", "cancelled", "no_cards_recommended", "closed_without_activation"]) {
      expect(cardGenerationProgressView(status, null), status).toBeNull();
    }
    expect(cardGenerationStageCount).toBe(4);
  });

  it("阶段内部按服务端候选计数推进，且计数文案与百分比同源", () => {
    const authoring = cardGenerationProgressView("authoring", {
      plannedCards: 8, authored: 4, gatePassed: 0, gateFailed: 0,
    });
    expect(authoring?.stage).toBe(1);
    expect(authoring?.detail).toBe("已写出 4 / 8 张候选");
    // 半程的第 2 阶段 = (1 + 0.5) / 4
    expect(authoring?.percent).toBe(38);

    const checking = cardGenerationProgressView("checking", {
      plannedCards: 8, authored: 8, gatePassed: 2, gateFailed: 1,
    });
    expect(checking?.detail).toBe("已过质量门 2 / 8");
    expect(checking?.percent).toBeGreaterThan(cardGenerationProgressView("checking", null)!.percent);

    // 阶段内绝不因为计数而越到下一阶段，也不谎报 100%。
    const almost = cardGenerationProgressView("authoring", {
      plannedCards: 8, authored: 8, gatePassed: 8, gateFailed: 0,
    });
    expect(almost?.percent).toBeLessThan(50);
    expect(almost?.stage).toBe(1);
  });

  it("同步回执说清楚这次重读读到了什么", () => {
    expect(cardGenerationSyncReportText(null, false)).toContain("没读到最新进度");
    expect(cardGenerationSyncReportText("planning", false)).toContain("仍是「正在规划候选」");
    expect(cardGenerationSyncReportText("checking", true)).toContain("这次生成到了「正在做质量检查」");
    // 状态没变时不能说成"已更新"——那正是用户抱怨"点了没用"的来源。
    expect(cardGenerationSyncReportText("planning", false)).not.toContain("这次生成到了");
  });

  it("在途时不报第几步（run.status 仍在大事务里，到提交才可见）", () => {
    // 2026-09-21 两次真跑实测：planning → 终态一步跨完。0249 把**候选计数**挪出了那个
    // 事务（下一条用例），但状态本身没挪——挪它要先解决重放语义，见计划 §21 的 A1。
    for (const status of ["planning", "authoring", "checking"]) {
      const view = cardGenerationProgressView(status, {
        plannedCards: 4, authored: 0, gatePassed: 0, gateFailed: 0,
      });
      expect(view?.inFlight, status).toBe(true);
      expect(view?.eyebrow, status).toBe("正在生成 · 写完一批一次给齐");
      expect(view?.eyebrow, status).not.toContain("步");
    }
  });

  it("planning 阶段里候选计数是真的在一格格走", () => {
    expect(cardGenerationProgressView("planning", {
      plannedCards: 0, authored: 0, gatePassed: 0, gateFailed: 0,
    })?.detail).toBe("正在规划这一批要出哪些目标");

    const steps = [1, 4, 8].map((authored) => cardGenerationProgressView("planning", {
      plannedCards: 8, authored, gatePassed: 0, gateFailed: 0,
    }));
    expect(steps.map((view) => view?.detail)).toEqual([
      "已写出 1 / 8 张候选", "已写出 4 / 8 张候选", "已写出 8 / 8 张候选",
    ]);
    const percents = steps.map((view) => view?.percent ?? 0);
    expect(percents[0]).toBeLessThan(percents[1] as number);
    expect(percents[1]).toBeLessThan(percents[2] as number);
    // 计数走，步数不走：两个读数同时"前进"会互相打脸。
    for (const view of steps) expect(view?.eyebrow).not.toContain("步");
  });

  it("到终态才报第几步，让轨道停在能说清的位置", () => {
    const done = cardGenerationProgressView("review_ready", {
      plannedCards: 4, authored: 4, gatePassed: 4, gateFailed: 0,
    });
    expect(done?.inFlight).toBe(false);
    expect(done?.eyebrow).toContain("共 4 步");
  });
});
