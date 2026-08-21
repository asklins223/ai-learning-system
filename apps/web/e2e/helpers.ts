/**
 * v0.6 E2E 共享 helper（2026-08-12 e2e 质量审计收口）。
 *
 * - skipIfNoServer()：E2E_BASE_URL 未设置时跳过（本地无服务）——替代
 *   40+ 处重复的 test.skip(!process.env.E2E_BASE_URL, ...) 样板。
 * - loginViaUI()/devCredentials()：鉴权修复（P1-1）——v06 套件此前无任何
 *   登录/存储态，E2E_BASE_URL 设置后被 middleware 302 到 /login，
 *   accessibility 等测试实际扫的是登录页（错误覆盖）。凭据源与主套件
 *   （tests/e2e）同款：E2E_DEV_EMAIL/E2E_DEV_PASSWORD。
 * - TEST_CARD_ID/TEST_REVIEW_ID：seed 数据槽位常量（依赖 seed 数据的
 *   测试统一引用，避免散落硬编码 UUID）。
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

export const TEST_CARD_ID = "00000000-0000-0000-0000-000000000001";
export const TEST_OBJECTIVE_ID = "00000000-0000-0000-0000-000000000002";
export const TEST_REVIEW_ID = "00000000-0000-0000-0000-000000000001";

/** E2E_BASE_URL 未设置时跳过当前测试（本地无服务场景）。 */
export function skipIfNoServer(): void {
  test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
}

/** 与主套件同款的 dev 凭据源；未配置时返回 null（测试应显式 skip/失败，不得假绿）。 */
export function devCredentials(): { email: string; password: string } | null {
  const email = process.env.E2E_DEV_EMAIL;
  const password = process.env.E2E_DEV_PASSWORD;
  return email && password ? { email, password } : null;
}

/**
 * 真实 UI 登录流（不走 API 绕过）。login 页有 checkingSession 阶段
 * （"正在准备登录页面" 最长 1.8s），等 #email 出现后填写提交，
 * 以 URL 离开 /login 为成功判据。
 */
export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // A persisted session can redirect /login to the workspace before the
  // login form mounts. Treat that as a valid login instead of racing a second
  // navigation against the first redirect.
  await page.waitForLoadState("load").catch(() => undefined);
  if (new URL(page.url()).pathname !== "/login") {
    await expect.poll(
      async () => page.evaluate(async () => {
        const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
        return response.ok;
      }),
      { timeout: 45_000 },
    ).toBe(true);
    return;
  }
  await expect(page.locator("#email")).toBeVisible({ timeout: 45_000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /进入工作区|sign in|登录/i }).click();
  // The login action can commit a redirect before the assertion observes it.
  // Waiting for the navigation itself avoids a mobile-only race where the
  // following test navigation interrupts the still-pending /login transition.
  await page.waitForURL(
    (url) => new URL(url).pathname !== "/login",
    { timeout: 45_000, waitUntil: "domcontentloaded" },
  );
  await page.waitForLoadState("domcontentloaded");
  // Mobile browsers can commit the router transition before the new session
  // is observable by the next middleware request. Verify the cookie-backed
  // API surface before the test navigates to its target page.
  await expect.poll(
    async () => page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      return response.ok;
    }),
    { timeout: 45_000 },
  ).toBe(true);
  // The auth cookie can be observable before the redirect target's load event
  // finishes. Wait for that event so the caller's first page.goto cannot
  // interrupt the in-flight workspace navigation.
  await page.waitForLoadState("load").catch(() => undefined);
}

/**
 * 每个用例前置：无服务 → 跳过；无凭据 → 显式跳过（避免测登录页假绿）；
 * 否则真实登录。serial + workers=1 配置下开销可接受。
 */
export function authenticatedBeforeEach(): void {
  test.beforeEach(async ({ page }) => {
    if (!process.env.E2E_BASE_URL) return; // 各用例的 skipIfNoServer 会跳过
    const creds = devCredentials();
    if (!creds) {
      test.skip(true, "E2E_DEV_EMAIL/E2E_DEV_PASSWORD not set for authenticated v06 tests");
      return;
    }
    await loginViaUI(page, creds.email, creds.password);
  });
}
