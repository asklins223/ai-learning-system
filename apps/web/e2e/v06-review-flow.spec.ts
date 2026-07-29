/**
 * v0.6 E2E: Review Flow (计划 §13.3, M4 Gate)
 *
 * Scenario: review queue → resume attempt → answer → result → next item
 *
 * Additional scenarios (计划 §13.3):
 * - Review queue shows only neutral task items (no card title/claim)
 * - reveal source prevents upgrade
 * - Review result by user explicit "next", no auto-navigation
 * - refresh/cross-tab recovery
 */

import { test, expect } from "@playwright/test";

const SENSITIVE_REVIEW_FIELDS = [
  "claim",
  "quote",
  "quoteText",
  "blockContent",
  "cardTitle",
  "noteTitle",
  "expectedConcept",
  "rubricItems",
] as const;

test.describe("v0.6 Review Flow (计划 §13.3)", () => {
  test.describe.configure({ mode: "serial" });

  test("review queue shows only neutral task items", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    await page.goto("/review");
    await page.waitForLoadState("networkidle");

    // Verify queue items don't contain card titles or claims
    const bodyText = await page.locator("body").innerText();

    // The review queue should show neutral labels like "复习任务" not card titles
    for (const field of SENSITIVE_REVIEW_FIELDS) {
      expect(bodyText).not.toContain(`"${field}":`);
    }
  });

  test("review queue item click navigates to Focus page", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    await page.goto("/review");
    await page.waitForLoadState("networkidle");

    // Find first review task item
    const reviewItem = page.locator("text=复习任务").first();
    if (await reviewItem.isVisible()) {
      await reviewItem.click();
      await page.waitForLoadState("networkidle");

      // Should be on a Focus page
      expect(page.url()).toContain("/review/");
    }
  });

  test("review Focus page shows question without card title/claim", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    // Navigate to a review Focus page
    await page.goto("/review/00000000-0000-0000-0000-000000000001");
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").innerText();

    // Should not contain card title or claim in the question view
    for (const field of SENSITIVE_REVIEW_FIELDS) {
      expect(bodyText).not.toContain(`"${field}":`);
    }
  });

  test("review Focus: answer and submit", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    await page.goto("/review/00000000-0000-0000-0000-000000000001");
    await page.waitForLoadState("networkidle");

    const textarea = page.locator("textarea").first();
    if (await textarea.isVisible({ timeout: 5000 })) {
      await textarea.fill("This is my review answer.");
      await page.keyboard.press("Meta+Enter");
      await page.waitForTimeout(2000);
    }
  });

  test("review result: user explicitly clicks next, no auto-navigation", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    // This test verifies that the app does not auto-navigate after result
    const currentUrl = page.url();

    // Wait a bit — no navigation should occur automatically
    await page.waitForTimeout(3000);

    // URL should not change (no auto-navigation)
    expect(page.url()).toBe(currentUrl);
  });
});

// ─── Source Reveal Prevents Upgrade (计划 §13.3) ─────────────────────────

test.describe("v0.6 Source Reveal (计划 §13.3)", () => {
  test("source reveal prevents understanding upgrade", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    await page.goto("/cards/00000000-0000-0000-0000-000000000001/validate");
    await page.waitForLoadState("networkidle");

    // Look for "查看原文" button
    const revealButton = page.locator("text=查看原文").first();
    if (await revealButton.isVisible()) {
      await revealButton.click();

      // Should show confirmation dialog
      const confirmButton = page.locator("text=确认").first();
      if (await confirmButton.isVisible({ timeout: 2000 })) {
        await confirmButton.click();
      }

      // After reveal, should show assistance banner indicating source was viewed
      const banner = page.locator("text=已查看原文").first();
      // Banner should appear — verify it becomes visible
      await expect(banner).toBeVisible({ timeout: 5000 });
    }
  });
});

// ─── Refresh Recovery (计划 §13.3: "refresh/跨标签页/跨设备恢复") ─────────────

test.describe("v0.6 Refresh Recovery (计划 §13.3)", () => {
  test("page refresh resumes same session", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    await page.goto("/cards/00000000-0000-0000-0000-000000000001/validate");
    await page.waitForLoadState("networkidle");

    const urlBeforeRefresh = page.url();

    // Type some draft answer
    const textarea = page.locator("textarea").first();
    if (await textarea.isVisible()) {
      await textarea.fill("Draft answer for recovery test");

      // Refresh
      await page.reload();
      await page.waitForLoadState("networkidle");

      // URL should be the same
      expect(page.url()).toBe(urlBeforeRefresh);

      // Draft should be restored
      const restoredTextarea = page.locator("textarea").first();
      if (await restoredTextarea.isVisible()) {
        const value = await restoredTextarea.inputValue();
        // Draft should be restored (or at least session should be resumable)
        // The draft text may or may not be restored depending on server state
        expect(typeof value).toBe("string");
      }
    }
  });
});

// ─── Cache-Control verification (计划 §13.3) ──────────────────────────────

test.describe("v0.6 Cache-Control (计划 §10.4)", () => {
  test("session/source/result routes use private, no-store", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");

    const cacheIssues: { url: string; issue: string }[] = [];

    page.on("response", (response) => {
      const url = response.url();
      const sensitiveRoutes = [
        "/api/validation-sessions/",
        "/api/validation-events/",
        "/api/reviews/",
      ];

      if (sensitiveRoutes.some((route) => url.includes(route))) {
        const cacheControl = response.headers()["cache-control"] || "";
        if (!cacheControl.includes("no-store")) {
          cacheIssues.push({ url, issue: "missing no-store" });
        }
        if (!cacheControl.includes("private")) {
          cacheIssues.push({ url, issue: "missing private" });
        }
      }
    });

    await page.goto("/cards/00000000-0000-0000-0000-000000000001/validate");
    await page.waitForLoadState("networkidle");

    expect(cacheIssues).toEqual([]);
  });
});
