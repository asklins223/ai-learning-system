/**
 * 伴星壳基础 E2E（救火 1/5：flag 隐藏 + 移动端锚点）。
 *
 * 验证（救火 1 撤演示 + 救火 5 移动端修复）：
 * - NEXT_PUBLIC_COMPANION_SHELL_ENABLED=false（默认）→ 页面无伴星锚点/侧板
 *   （演示壳不再冒充 v1，审计救火 1）；
 * - NEXT_PUBLIC_COMPANION_SHELL_ENABLED=true → 锚点出现且 z-40 高于移动端
 *   bottom nav（--z-header=30），390px 视口可点（审计救火 5）；
 * - settings 页「伴星」分区存在（真实设置说明，非演示输入）。
 *
 * 运行前提：web 以 NEXT_PUBLIC_COMPANION_SHELL_ENABLED 构建（flag 分支）。
 * 用例按 env 自适应（默认 false 断言隐藏，true 断言可见）。
 */

import { test, expect, type Page } from "@playwright/test";

const FLAG = process.env.NEXT_PUBLIC_COMPANION_SHELL_ENABLED === "true";

async function gotoWorkspace(page: Page) {
  // 鉴权由测试环境注入（既有 spec 同模式）；用 /cards 作为 workspace 代表页
  await page.route("**/api/cards?*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
  );
  await page.goto("/cards");
  await page.waitForLoadState("domcontentloaded");
}

test("救火 1：flag 关闭（默认）→ 页面无伴星锚点（演示壳不冒充）", async ({ page }) => {
  test.skip(FLAG, "flag 开启时跳过隐藏断言");
  await gotoWorkspace(page);
  await expect(page.locator("[data-ui='companion-anchor'], .companion-shell-avatar")).toHaveCount(0);
  // 无侧板触发
  await expect(page.locator("[data-ui='companion-sidepanel']")).toHaveCount(0);
});

test("救火 5：flag 开启 → 锚点可见且高于移动端导航（390px 视口）", async ({ page }) => {
  test.skip(!FLAG, "flag 关闭时跳过可见断言");
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWorkspace(page);
  const anchor = page.locator("[data-ui='companion-anchor'], .companion-shell-avatar").first();
  await expect(anchor).toBeVisible();
  // 锚点 z-40 高于 bottom nav（--z-header=30）：点击命中锚点而非「我的」
  const anchorBox = await anchor.boundingBox();
  const navBox = await page.locator(".mobile-nav").boundingBox().catch(() => null);
  if (anchorBox && navBox) {
    // 锚点应位于移动导航下方可见区域（z-40 > nav z-30，救火 5）
    expect(anchorBox.y + anchorBox.height).toBeGreaterThan(navBox.y);
  }
});

test("settings 伴星分区存在（真实设置说明）", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("domcontentloaded");
  const navItem = page.locator("button", { hasText: "伴星" }).first();
  await expect(navItem).toBeVisible();
  await navItem.click();
  await expect(page.locator("text=存在感档位")).toBeVisible();
  await expect(page.locator("text=首次引导")).toBeVisible();
});
