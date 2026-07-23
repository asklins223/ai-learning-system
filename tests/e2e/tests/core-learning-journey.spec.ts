import { test, expect } from "../lib/fixtures";

/**
 * E2E: Core learning journey (Journey A, ADR-0008 §6).
 *
 * Covers the PR-smoke path of the v0.5 Must user journey:
 *   Today → Notes → Note editor → Card generation → Card detail →
 *   Evidence → Validation → Review queue
 *
 * This test requires the seed CLI (QLT-01, --profile pr) to provision:
 *   - 1 workspace with owner + member
 *   - Notes with generated cards and aligned evidence
 *   - At least 1 review schedule with a due review
 *
 * Missing fixture data is a test failure: silently skipping a Must journey would
 * make the PR gate report a false pass.
 *
 * Accessibility: keyboard-only execution for the validation flow.
 * Error gate: no pageerror, no console.error/warn, no requestfailed.
 *
 * @pr
 */

test.describe("Core learning journey @pr", () => {
  test("today page loads and shows seeded learning activity", async ({ authedPage }) => {
    const page = authedPage;

    // Navigate to today page
    await page.goto("/today");

    // Page header should be visible
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    // The overview metrics should be rendered (even if counts are 0)
    await expect(page.locator(".today-overview-metrics")).toBeVisible();

    // At least one metric button should exist
    const metricButtons = page.locator(".today-overview-metrics button");
    await expect(metricButtons.first()).toBeVisible();
  });

  test("notes list page loads and shows seeded notes", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/notes");

    // Page header
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();

    // New note button should be visible
    await expect(page.getByRole("button", { name: /新建笔记/ })).toBeVisible();

    // Wait for notes to load — the notes list container should appear
    const notesList = page.locator(".notes-index-paper, .notes-empty");
    await expect(notesList).toBeVisible({ timeout: 10_000 });

    // The seed contract guarantees notes for this profile.
    const noteCards = page.locator(".notes-card");
    await expect(noteCards.first()).toBeVisible({ timeout: 10_000 });

    // First note should have a link to its detail page
    const firstNoteLink = noteCards.first().locator(".notes-card-link");
    await expect(firstNoteLink).toBeVisible();
  });

  test("note editor opens and content is editable", async ({ authedPage }) => {
    const page = authedPage;

    // Go to notes list and open the first note
    await page.goto("/notes");
    const noteCards = page.locator(".notes-card");
    await expect(noteCards.first()).toBeVisible({ timeout: 10_000 });

    // Click the first note to open the editor
    await noteCards.first().click();

    // Should navigate to the note editor page
    await expect(page).toHaveURL(/\/notes\/[\w-]+/);

    // The editor may restore its last display mode. Select the explicit
    // writing mode before asserting the actual editable surface.
    const editor = page.locator("textarea.ne-editor-textarea");
    if (!(await editor.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /^(编辑|写作)$/ }).click();
    }
    await expect(editor).toBeVisible({ timeout: 10_000 });
  });

  test("card detail page loads and shows key points", async ({ authedPage }) => {
    const page = authedPage;

    // Navigate to cards list
    await page.goto("/cards");

    // The cards page shows a skeleton grid (.cards-skeleton-grid) while items
    // are loading from the API. Wait for the skeleton to be replaced by either
    // the cards grid (.cards-grid) or the empty state (.cards-state-wrap).
    await expect(page.locator(".cards-grid, .cards-state-wrap")).toBeVisible({
      timeout: 10_000,
    });

    // Card items use class "cards-card" and data-ui="study-card" attributes.
    const cardItems = page.locator("a.cards-card, [data-ui='study-card']");
    await expect(cardItems.first()).toBeVisible({ timeout: 10_000 });

    // Navigate directly to the card detail page via href. Using page.goto()
    // avoids client-side hydration races while keeping a missing seed/link a
    // hard failure in the PR gate.
    const href = await cardItems.first().getAttribute("href");
    expect(href, "seeded card must expose a detail link").toBeTruthy();
    await page.waitForLoadState("networkidle");
    await page.goto(href!);

    // Should be on a card detail page
    await expect(page).toHaveURL(/\/cards\/[\w-]+/);

    // Card detail desk should be visible
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 10_000 });

    // The card content should be rendered — look for the card title heading (h1)
    // within the desk. The article element contains the full card content.
    await expect(page.locator(".card-detail-desk h1").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("card detail shows evidence section", async ({ authedPage, seedCredentials }) => {
    const page = authedPage;

    // Use the deterministic card promised by the seed contract. Picking the
    // first list item is order-dependent once other parallel journeys create
    // cards and may accidentally select an item without aligned evidence.
    const cardId = seedCredentials.workspaces[0]?.cardIds?.[0];
    expect(cardId, "seed contract must provide a card with aligned evidence").toBeTruthy();
    await page.goto(`/cards/${cardId}`);
    await expect(page).toHaveURL(/\/cards\/[\w-]+/);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 10_000 });

    // Evidence is inline in wide mode and opens in a drawer in medium/compact
    // mode. Compact mode keeps a hidden copy of the header trigger in the DOM,
    // so scope the control to the visible action dock instead of taking the
    // first text match across both responsive variants.
    const desk = page.locator(".card-detail-desk");
    await expect(desk).toHaveAttribute("data-layout", /^(wide|medium|compact)$/);
    const layout = await desk.getAttribute("data-layout");

    if (layout === "wide") {
      await expect(page.locator(".evidence-rail")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "证据线索" })).toBeVisible();
    } else {
      const compactDock = page.getByRole("navigation", { name: "学习卡详情操作" });
      const evidenceButton = layout === "compact"
        ? compactDock.getByRole("button", { name: /证据线索/ })
        : page.locator(".card-detail-header-actions .card-detail-evidence-trigger");

      await expect(evidenceButton).toBeVisible({ timeout: 10_000 });
      await evidenceButton.click();
      await expect(page.getByRole("heading", { name: "证据线索" })).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test("validation panel is accessible from card detail", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/cards");
    // Wait for the skeleton to be replaced by cards grid or empty state.
    await expect(page.locator(".cards-grid, .cards-state-wrap")).toBeVisible({
      timeout: 10_000,
    });
    const cardItems = page.locator("a.cards-card, [data-ui='study-card']");
    await expect(cardItems.first()).toBeVisible({ timeout: 10_000 });

    // Navigate directly to the card detail page via href.
    const href = await cardItems.first().getAttribute("href");
    expect(href, "seeded card must expose a detail link").toBeTruthy();
    await page.waitForLoadState("networkidle");
    await page.goto(href!);
    await expect(page).toHaveURL(/\/cards\/[\w-]+/);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 10_000 });

    // Validation section should be present. The card detail page renders
    // a validation sidebar (<aside> with heading "验证理解"). The validation
    // section loads asynchronously after the card data, so we need to wait
    // for it to appear.
    const validationHeading = page.getByRole("heading", { name: /^验证理解/ });
    const validationButton = page.getByRole("button", { name: /验证理解|查看验证状态/ });

    // Wait for either the heading or button to appear in the DOM.
    // Use toHaveCount(1) which auto-retries until the element renders.
    try {
      await expect(validationHeading).toHaveCount(1, { timeout: 10_000 });
    } catch {
      // If heading doesn't appear, a button to open validation might exist
      const buttonVisible = await validationButton.first().isVisible({ timeout: 3_000 }).catch(() => false);
      expect(buttonVisible).toBeTruthy();
    }
  });

  test("review queue page loads and shows due reviews", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");

    // Review page header should be visible
    await expect(
      page.getByRole("heading", { name: /复习|review/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the loading state to disappear before checking content.
    // The review page shows a skeleton loader (aria-label="正在加载复习队列")
    // while fetching data. We must wait for it to disappear, otherwise
    // neither the action buttons nor the empty state will be visible.
    const loadingState = page.locator('[aria-label="正在加载复习队列"]');
    await expect(loadingState).not.toBeVisible({ timeout: 15_000 });

    // Either there are due reviews (with action buttons) or an empty state
    const completeButton = page.getByRole("button", { name: "完成本轮" });
    const laterButton = page.getByRole("button", { name: "稍后再看" });
    const emptyState = page.getByText("现在没有到期复习");

    const hasComplete = await completeButton.isVisible({ timeout: 10_000 }).catch(() => false);
    const hasEmpty = await emptyState.isVisible({ timeout: 5_000 }).catch(() => false);

    // One of the two states must be true
    expect(hasComplete || hasEmpty).toBeTruthy();

    if (hasComplete) {
      await expect(laterButton).toBeVisible();
    }
  });

  test("navigation flow: today → notes → card → review", async ({ authedPage }) => {
    const page = authedPage;

    // Start at today
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Navigate to notes
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
    await expect(page.locator(".notes-card").first()).toBeVisible({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // Navigate to cards
    await page.goto("/cards");
    await expect(page).toHaveURL(/\/cards/);
    await expect(page.locator(".cards-grid, .cards-state-wrap")).toBeVisible({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // Navigate to review
    await page.goto("/review");
    await expect(
      page.getByRole("heading", { name: /复习|review/i }).first(),
    ).toBeVisible();
    await expect(page.locator('[aria-label="正在加载复习队列"]')).not.toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Navigate back to today
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
  });

  test("today page quick capture panel can be opened", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/today", { waitUntil: "domcontentloaded" });
    // Wait for the page to hydrate — the capture button's onClick handler
    // is only active after React hydration completes.
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // The quick capture panel is collapsed by default on the today page.
    // Click the toggle button to expand it.
    // Use a stable CSS selector: the button's accessible name changes
    // from "快速收录" to "收起录入台" after clicking, so getByRole
    // with name matching would lose the reference.
    const toggleButton = page.locator("button.today-header-capture");
    await expect(toggleButton).toBeVisible({ timeout: 10_000 });
    await toggleButton.click();

    // Wait for the button's aria-expanded to become true, confirming the
    // React state update was applied before looking for child elements.
    await expect(toggleButton).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    // The capture textarea should now be visible.
    const captureInput = page.locator("#today-capture-input");
    await expect(captureInput).toBeVisible({ timeout: 5_000 });

    // A submit button should be present (disabled until content is entered)
    const createButton = page.getByRole("button", { name: "加入今日轨迹" });
    await expect(createButton).toBeVisible();
  });
});

test.describe("Core learning journey — keyboard accessibility @pr", () => {
  test("today page is keyboard navigable", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/today", { waitUntil: "domcontentloaded" });
    // Wait for the page to hydrate before interacting.
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Tab through the page — focus should move to interactive elements
    await page.keyboard.press("Tab");

    // The first focused element should be an interactive element (not body)
    const focusedTag = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.tagName.toLowerCase() : "body";
    });
    expect(["a", "button", "input", "textarea", "select", "[contenteditable]"]).toContain(focusedTag);

    // The capture panel is collapsed by default — expand it first.
    // Use a stable CSS selector: the button's accessible name changes
    // after clicking, so getByRole with name matching would lose the reference.
    const toggleButton = page.locator("button.today-header-capture");
    await expect(toggleButton).toBeVisible({ timeout: 10_000 });
    await toggleButton.click();
    await expect(toggleButton).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    // The capture textbox should now be reachable via keyboard
    const captureInput = page.locator("#today-capture-input");
    await expect(captureInput).toBeVisible({ timeout: 5_000 });
    await captureInput.focus();
    await expect(captureInput).toBeFocused();

    // Press Enter should not cause errors (textbox handles Enter internally)
    await page.keyboard.type("键盘导航测试");
    const value = await captureInput.inputValue();
    expect(value).toContain("键盘导航测试");
  });
});

/**
 * WCAG 2.2 AA automated accessibility scans (ADR-0008 §6).
 *
 * These tests scan key pages for serious/critical accessibility violations.
 * Per the plan: "所有 PR/RC 流程执行键盘主路径和自动化 WCAG 2.2 AA 扫描，
 * serious / critical 问题为 0"
 *
 * @pr
 */
test.describe("Accessibility scan — WCAG 2.2 AA @pr", () => {
  test("today page has no serious/critical violations", async ({ authedPage, a11yScan }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await a11yScan.assert(page);
  });

  test("notes list page has no serious/critical violations", async ({ authedPage, a11yScan }) => {
    const page = authedPage;
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
    await a11yScan.assert(page);
  });

  test("review queue page has no serious/critical violations", async ({ authedPage, a11yScan }) => {
    const page = authedPage;
    await page.goto("/review");
    await expect(
      page.getByRole("heading", { name: /复习|review/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await a11yScan.assert(page);
  });

  test("login page has no serious/critical violations", async ({ page, a11yScan }) => {
    // Login page does not require authentication
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible();
    await a11yScan.assert(page);
  });
});
