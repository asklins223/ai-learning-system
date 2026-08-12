import { test, expect } from "../lib/fixtures";
import type { Page } from "@playwright/test";

/**
 * E2E: Review Attempt journey (LOOP-01/02, ADR-0004, ADR-0008 §6).
 *
 * v0.6 MIGRATION NOTICE: The review flow has fundamentally changed in v0.6.
 * The old flow (single "完成本轮" button → inline submission panel) has been
 * replaced by a list-based flow:
 *   /review shows a queue of tasks → click "开始" → navigates to
 *   /review/[scheduleId] focus page → question-first answering → submit.
 *
 * The selectors and test flow below need to be rewritten to match the v0.6 UI.
 * Until then, these tests will fail against the v0.6 review page.
 *
 * Original v0.5 flow:
 * 1. Login → navigate to review queue.
 * 2. Start an attempt ("完成本轮").
 * 3. Submit with outcome + answer + confidence.
 * 4. Verify the card is removed from queue and feedback shown.
 * 5. Test the "明天再看" (later) flow on the next card.
 *
 * Accessibility: keyboard-only execution for submit flow.
 * Error gate: no pageerror, no console.error/warn, no requestfailed.
 *
 * @pr
 */

/**
 * Wait for the review page to finish loading, then return whether the
 * queue is empty. The review page has three states:
 *   1. Loading (aria-label="正在加载复习队列", aria-busy="true")
 *   2. Error (text "复习队列暂时无法打开")
 *   3. Ready — either empty ("现在没有到期复习") or has reviews ("完成本轮")
 *
 * We race the loading state disappearing against a timeout, then check
 * for the empty state heading.
 */
async function waitForReviewReady(page: Page): Promise<void> {
  // Wait for loading state to disappear (or never appear if data loads fast).
  const loadingState = page.locator('[aria-label="正在加载复习队列"]');
  await expect(loadingState).not.toBeVisible({ timeout: 15_000 });

  // The seeded PR/nightly/RC profiles guarantee enough due reviews for all
  // lifecycle cases. An empty queue is therefore a fixture failure.
  const completeButton = page.getByRole("button", { name: "完成本轮" });
  await expect(completeButton).toBeVisible({ timeout: 10_000 });
}

// 2026-08-11：v0.5 流程 UI 已删除，本文件全部测试对 v0.6 review 页必失败。
// 标记 skip（报告中可见），等待按文件头 v0.6 MIGRATION NOTICE 重写。
test.describe.skip("Review Attempt lifecycle @pr (v0.5 UI 已废弃，待 v0.6 重写)", () => {
  test("submit flow: start → outcome → answer → submit → queue updates", async ({ authedPage }) => {
    const page = authedPage;

    // Navigate to review queue
    await page.goto("/review");
    await expect(page.getByRole("heading", { name: /复习|review/i }).first()).toBeVisible();

    // Wait for the page to finish loading.
    await waitForReviewReady(page);

    // Verify the first review card is visible
    const completeButton = page.getByRole("button", { name: "完成本轮" });
    await expect(completeButton).toBeEnabled();

    // Start attempt
    await completeButton.click();

    // Submission panel should appear
    const submissionPanel = page.locator(".review-submission-panel");
    await expect(submissionPanel).toBeVisible();
    await expect(page.getByRole("heading", { name: /离开原文|本轮回想/ })).toBeVisible();

    // Select outcome: 掌握 (correct)
    // The button accessible name is "掌握 能完整回忆关键点" (label + hint),
    // so we use a regex anchored to the start to avoid matching "部分掌握".
    const correctChip = page.getByRole("button", { name: /^掌握/ });
    await expect(correctChip).toBeVisible();
    await correctChip.click();
    await expect(correctChip).toHaveAttribute("aria-pressed", "true");

    // Fill answer
    const answerTextarea = page.locator(".review-submission-answer textarea");
    await expect(answerTextarea).toBeVisible();
    await answerTextarea.fill("我能回忆起关键点：这是测试中输入的回忆内容。");

    // Adjust confidence
    const confidenceSlider = page.locator(".review-submission-confidence input[type='range']");
    await confidenceSlider.fill("90");

    // Submit
    const submitButton = page.getByRole("button", { name: /提交结果|正在提交/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Verify feedback toast appears (dynamic message from buildSubmissionFeedback)
    await expect(page.locator(".review-feedback-toast")).toBeVisible({ timeout: 10_000 });
  });

  test("later flow: click 稍后再看 → queue updates", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");

    await waitForReviewReady(page);

    const laterButton = page.getByRole("button", { name: "稍后再看" });
    await expect(laterButton).toBeVisible();
    await expect(laterButton).toBeEnabled();

    const refreshedQueue = page.waitForResponse((response) =>
      response.url().includes("/api/reviews?status=pending")
      && response.request().method() === "GET",
    );
    await laterButton.click();

    // Verify feedback
    await expect(page.getByText("已移到稍后复习，队列已更新")).toBeVisible({ timeout: 10_000 });
    // The action immediately refreshes the queue. Let that tracked request
    // finish before the test context closes.
    expect((await refreshedQueue).ok()).toBeTruthy();
  });

  test("keyboard-only submit flow (accessibility)", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");

    await waitForReviewReady(page);

    // Tab to the "完成本轮" button and activate with Enter
    const completeButton = page.getByRole("button", { name: "完成本轮" });
    await completeButton.focus();
    await expect(completeButton).toBeFocused();
    await page.keyboard.press("Enter");

    // Tab through outcome options, select 掌握
    // The button accessible name is "掌握 能完整回忆关键点" (label + hint).
    const correctChip = page.getByRole("button", { name: /^掌握/ });
    await correctChip.focus();
    await expect(correctChip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(correctChip).toHaveAttribute("aria-pressed", "true");

    // Tab to textarea and fill
    const answerTextarea = page.locator(".review-submission-answer textarea");
    await answerTextarea.focus();
    await page.keyboard.type("键盘输入的回忆内容。");

    // Tab to submit button and press Enter
    const submitButton = page.getByRole("button", { name: /提交结果|正在提交/ });
    await submitButton.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(".review-feedback-toast")).toBeVisible({ timeout: 10_000 });
  });

  test("cancel submission returns to action buttons", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");

    await waitForReviewReady(page);

    // Start submit
    await page.getByRole("button", { name: "完成本轮" }).click();
    const submissionPanel = page.locator(".review-submission-panel");
    await expect(submissionPanel).toBeVisible();

    // Cancel
    await page.getByRole("button", { name: "取消" }).click();

    // Panel should be gone, action buttons should be back
    await expect(submissionPanel).not.toBeVisible();
    await expect(page.getByRole("button", { name: "完成本轮" })).toBeVisible();
    await expect(page.getByRole("button", { name: "稍后再看" })).toBeVisible();
  });

  test("outcome unable hides answer textarea", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");

    await waitForReviewReady(page);

    await page.getByRole("button", { name: "完成本轮" }).click();
    await expect(page.locator(".review-submission-panel")).toBeVisible();

    // Answer textarea should be visible by default (outcome=correct)
    const answerTextarea = page.locator(".review-submission-answer textarea");
    await expect(answerTextarea).toBeVisible();

    // Select 无法判断 — button accessible name is "无法判断 问题不适用或无法回答"
    await page.getByRole("button", { name: /^无法判断/ }).click();

    // Answer textarea should be hidden
    await expect(answerTextarea).not.toBeVisible();

    // Submit should still work without answer
    const submitButton = page.getByRole("button", { name: /提交结果|正在提交/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    await expect(page.locator(".review-feedback-toast")).toBeVisible({ timeout: 10_000 });
  });
});
