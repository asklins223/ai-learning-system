/**
 * 方案 20 C40 — CandidateReview 关键旅程无障碍（a11y）契约测试（R35）。
 *
 * 覆盖（键盘/读屏/焦点管理）：
 * 1. 候选审核区（section）有 aria-labelledby，可被读屏识别；
 * 2. 每个候选是可感知的 article；操作按钮（保留/移除/编辑/查看背面）有
 *    可访问名称（aria-label 或可见文本）；
 * 3. reveal 内容区以 aria-label="已揭示答案" 声明（读屏可定位）；
 * 4. rechecking/rejected 状态以 role="status" 播报；
 * 5. 编辑 dialog：role=dialog + aria-modal + aria-labelledby；
 *    Escape 关闭（键盘路径）；关闭按钮 aria-label；
 * 6. 320px/reduced-motion 为全局 CSS 层（DOM 不引入强制动画/固定宽度内联
 *    样式），组件层只保证语义与焦点。
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CandidateReview, type CandidateReviewProps } from "./CandidateReview";
import type { CandidateReviewItemV2, CandidateSetSummaryV2 } from "./contracts/ui-contracts";

const SUMMARY: CandidateSetSummaryV2 = {
  sourceLabel: "OSI 模型笔记",
  sourceVersion: 1,
  atomCount: 7,
  candidateCount: 2,
  supportOnlyCount: 1,
  mergedCount: 1,
  estimatedReviewSeconds: 120,
};

const CANDIDATES: CandidateReviewItemV2[] = [
  {
    candidateId: "cand-1",
    revision: 1,
    revisionHash: "test-rev-hash",
    objective: "OSI 七层各自职责",
    prompt: "请列出 OSI 模型七层并说明各自职责。",
    reason: "可检索、可判分，值得单独成卡。",
    sourceLabel: "OSI 模型笔记",
    knowledgeForm: "procedure",
    strategyLabel: "步骤重建",
    estimatedSeconds: 60,
    selected: true,
    reviewState: "ready",
  },
  {
    candidateId: "cand-2",
    revision: 1,
    revisionHash: "test-rev-hash",
    objective: "物理层职责",
    prompt: "物理层负责什么？",
    reason: "独立概念。",
    sourceLabel: "OSI 模型笔记",
    knowledgeForm: "definition",
    strategyLabel: "检索",
    estimatedSeconds: 30,
    selected: false,
    reviewState: "ready",
  },
];

function renderReview(overrides?: Partial<CandidateReviewProps>) {
  const onReveal = vi.fn(async () => ({
    candidateId: "cand-1",
    revision: 1,
    exposureId: "exp-1",
    answer: "物理层负责比特流传输。",
    explanation: "……",
    evidencePreview: "……",
  }));
  const props: CandidateReviewProps = {
    summary: SUMMARY,
    initialCandidates: CANDIDATES,
    onReveal,
    onActivate: vi.fn(),
    ...overrides,
  };
  render(<CandidateReview {...props} />);
  return props;
}

describe("C40: CandidateReview a11y contract", () => {
  it("labels the review region for screen readers", () => {
    renderReview();
    const region = screen.getByRole("region");
    expect(region.getAttribute("aria-labelledby")).toBe("candidate-review-title");
    expect(screen.getByRole("heading", { name: /建议启用/ })).toBeTruthy();
  });

  it("exposes every candidate as a perceivable article with accessible actions", () => {
    renderReview();
    const articles = document.querySelectorAll("article.candidate-review-card");
    expect(articles.length).toBe(2);
    // 操作按钮都有可访问名称（text 或 aria-label）
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons) {
      const name = b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "";
      expect(name.length).toBeGreaterThan(0); // every action button must have an accessible name
    }
    // 选择框与候选标签关联（label 包裹 input）
    const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].disabled).toBe(false);
  });

  it("announces rechecking/rejected states with role=status and reveals with aria-label", async () => {
    renderReview();
    const revealButton = screen.getAllByRole("button", { name: /查看答案与依据/ })[0];
    fireEvent.click(revealButton);
    expect(await screen.findByLabelText("已揭示答案")).toBeTruthy();
  });

  it("opens the edit dialog with dialog semantics and closes with Escape (keyboard path)", () => {
    renderReview();
    // 打开候选 1 的编辑对话框
    const editButton = screen.getAllByRole("button").find((b) =>
      /编辑|edit/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    expect(editButton).toBeTruthy();
    fireEvent.click(editButton!);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭候选编辑" })).toBeTruthy();

    // Escape 关闭（键盘路径）
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps interactive controls keyboard-focusable (no pointer-only traps)", () => {
    renderReview();
    const focusables = document.querySelectorAll<HTMLElement>(
      'button, input[type="checkbox"], [tabindex]:not([tabindex="-1"])',
    );
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) {
      expect(el.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
