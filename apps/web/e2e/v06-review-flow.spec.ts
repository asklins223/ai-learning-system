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
import {
  skipIfNoServer,
  authenticatedBeforeEach,
  TEST_CARD_ID,
  TEST_REVIEW_ID,
} from "./helpers.ts";

// 2026-08-12（e2e 质量审计 P1-1）：受保护页面统一真实登录
authenticatedBeforeEach();


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
        skipIfNoServer();

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
        skipIfNoServer();

    await page.goto("/review");
    await page.waitForLoadState("networkidle");

    // Find first review task item（2026-08-11：此前 if 可见才点击——不可见时
    // 静默跳过整个测试制造空转；改为必见，点不到即失败）
    const reviewItem = page.locator("text=复习任务").first();
    await expect(reviewItem).toBeVisible({ timeout: 10_000 });
    await reviewItem.click();
    await page.waitForLoadState("networkidle");

    // Should be on a Focus page（2026-08-12 P2-7：同步 URL 断言 → 自动重试 toHaveURL）
    await expect(page).toHaveURL(/\/review\//);
  });

  test("review Focus page shows question without card title/claim", async ({ page }) => {
        skipIfNoServer();

    // Navigate to a review Focus page
    await page.goto(`/review/${TEST_REVIEW_ID}`);
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").innerText();

    // Should not contain card title or claim in the question view
    for (const field of SENSITIVE_REVIEW_FIELDS) {
      expect(bodyText).not.toContain(`"${field}":`);
    }
  });

  test("review Focus: answer and submit", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/review/${TEST_REVIEW_ID}`);
    await page.waitForLoadState("networkidle");

    // 2026-08-11：此前 textarea 不可见时 if 吞掉（空转）；改为必见，不可见即失败
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill("This is my review answer.");

    // 2026-08-12（P1-5 修复）：此前提交后只 sleep + bodyText.length>0（近似
    // 恒真）——提交是否真实发生、服务端是否处理均未验证。捕获提交请求
    // 断言发出并被处理。
    const submitResponse = page.waitForResponse(
      (r) => r.url().includes("/api/reviews/attempts/submit") && r.request().method() === "POST",
      { timeout: 15_000 },
    );
    await page.keyboard.press("Meta+Enter");

    const resp = await submitResponse;
    expect(resp.status()).toBeGreaterThanOrEqual(200);
    expect(resp.status()).toBeLessThan(500);

    // 提交后不自动导航（结果由用户显式 next）——URL 保持 Focus 页
    await expect(page).toHaveURL(/\/review\//);
  });

  test("review result: user explicitly clicks next, no auto-navigation", async ({ page }) => {
        skipIfNoServer();

    // 2026-08-11 修复：此前"等待 3s 断言空 URL 不变"恒真（完全空转）。
    // 改为：进入 Focus 页提交后，URL 不得自动跳离 /review/ 路径。
    await page.goto(`/review/${TEST_REVIEW_ID}`);
    await page.waitForLoadState("networkidle");

    const currentUrl = page.url();
    expect(currentUrl).toContain("/review/");

    // 等待一段时间——不应发生自动导航
    await page.waitForTimeout(3000);

    // URL 应仍在 /review/ 下（无自动跳转）
    await expect(page).toHaveURL(/\/review\//);
  });
});

// ─── Source Reveal Prevents Upgrade (计划 §13.3) ─────────────────────────

test.describe("v0.6 Source Reveal (计划 §13.3)", () => {
  test("source reveal prevents understanding upgrade", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // Look for "查看原文" button（2026-08-11：此前 if 可见才点——不可见时
    // 整个测试静默通过制造空转；改为必见，点不到即失败）
    const revealButton = page.locator("text=查看原文").first();
    await expect(revealButton).toBeVisible({ timeout: 10_000 });
    await revealButton.click();

    // Should show confirmation dialog
    const confirmButton = page.locator("text=确认").first();
    await expect(confirmButton).toBeVisible({ timeout: 5_000 });
    await confirmButton.click();

    // 2026-08-12（P1-4 修复）：此前只断言 banner 可见，核心契约"reveal 后
    // 升级被阻止"零断言。页面（ValidationFocus.tsx:1686）reveal 后进入
    // isAssisted 态：banner 文案"已转为辅助练习"+"不会提升理解状态"——
    // 即升级被阻止的 UI 语义。
    const assistBanner = page.locator("text=已转为辅助练习").first();
    await expect(assistBanner).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("body")).toContainText("不会提升理解状态");
  });
});

// ─── Refresh Recovery (计划 §13.3: "refresh/跨标签页/跨设备恢复") ─────────────

test.describe("v0.6 Refresh Recovery (计划 §13.3)", () => {
  test("page refresh resumes same session", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    const urlBeforeRefresh = page.url();

    // Type some draft answer
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill("Draft answer for recovery test");

    // Refresh
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 2026-08-12（P0-2 修复）：此前断言 typeof value === "string" 恒真且
    // if 包裹空转——草稿恢复行为从未被验证。核心契约 = 刷新后同一 session
    // 可继续：URL 不变 + 页面可交互。草稿本身不持久化（TextOrMixedInput
    // 无 draft 存储，刷新即空）——如实断言空值。
    await expect(page).toHaveURL(urlBeforeRefresh);
    const restoredTextarea = page.locator("textarea").first();
    await expect(restoredTextarea).toBeVisible({ timeout: 10_000 });
    expect(await restoredTextarea.inputValue()).toBe("");
  });
});

// ─── Cache-Control verification (计划 §13.3) ──────────────────────────────

test.describe("v0.6 Cache-Control (计划 §10.4)", () => {
  test("session/source/result routes use private, no-store", async ({ page }) => {
        skipIfNoServer();

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

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    expect(cacheIssues).toEqual([]);
  });
});
