/**
 * 当前桌面 Web 主流程验收。
 *
 * 这组用例刻意只使用现行 V2 路由和页面契约：先逐页巡检工作区，再从
 * 学习目标库进入档案页，走 CTA → LearningRun → 提交结算，同时覆盖伴星
 * 记忆、历史、日记和设置入口。它是浏览器端桌面 App 的发布前冒烟主线。
 */

import { test, expect } from "@playwright/test";
import {
  devCredentials,
  loginViaUI,
  TEST_CARD_ID,
} from "./helpers.ts";

const CREDENTIALS = devCredentials();

test.describe("桌面 Web 完整主流程", () => {
  test.describe.configure({ mode: "serial" });

  test("工作区页面矩阵无 5xx、客户端异常或退役 API 请求", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL || !CREDENTIALS, "E2E_BASE_URL/E2E_DEV_* 未配置");
    test.skip(test.info().project.name !== "desktop-1440", "桌面端矩阵只在 1440px 项目执行");
    test.setTimeout(180_000);

    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/") && response.status() >= 400) {
        failures.push(`api ${response.status()} ${url.pathname}`);
      }
    });

    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);
    // 登录页在建立会话前会探测一次 /api/auth/me，401 是预期的未登录响应；
    // 从这里开始才统计受保护工作区的业务错误。
    failures.length = 0;

    const routes: Array<{ path: string; ready: () => Promise<void> }> = [
      { path: "/", ready: async () => expect(page.locator("main").first()).toBeVisible() },
      { path: "/today", ready: async () => expect(page.getByRole("heading", { name: "今日变化" })).toBeVisible() },
      { path: "/notes", ready: async () => expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible() },
      { path: "/sources", ready: async () => expect(page.getByRole("heading", { name: "来源资料", exact: true })).toBeVisible() },
      { path: "/cards", ready: async () => expect(page.getByRole("heading", { name: "学习目标", exact: true })).toBeVisible() },
      { path: "/review", ready: async () => expect(page.getByRole("heading", { name: "复习", exact: true })).toBeVisible() },
      { path: "/search?q=地球", ready: async () => expect(page.getByRole("heading", { name: "搜索", exact: true })).toBeVisible() },
      { path: "/graph", ready: async () => expect(page.locator(".graph-v3")).toBeVisible() },
      { path: "/settings", ready: async () => expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible() },
      { path: "/companion/memory", ready: async () => expect(page.getByRole("heading", { name: "伴星记忆", exact: true })).toBeVisible() },
      { path: "/companion/conversations", ready: async () => expect(page.getByRole("heading", { name: "伴星交互档案", exact: true })).toBeVisible() },
      { path: "/companion/daily", ready: async () => expect(page.locator(".pet-note-page")).toBeVisible() },
      { path: "/companion/pet-profile", ready: async () => expect(page.getByRole("heading", { name: "桌宠人格", exact: true })).toBeVisible() },
    ];

    for (const route of routes) {
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await route.ready();
      await page.waitForLoadState("load").catch(() => undefined);
    }

    expect(
      failures,
      "工作区页面矩阵发现浏览器或 API 错误",
    ).toEqual([]);
  });

  test("学习目标 → LearningRun → 真实提交结算，并保持伴星入口可达", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL || !CREDENTIALS, "E2E_BASE_URL/E2E_DEV_* 未配置");
    test.skip(test.info().project.name !== "desktop-1440", "桌面主流程只在 1440px 项目执行");
    test.setTimeout(180_000);

    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);

    // 当前学习目标库是 V2 objective list，详情路由不再是 /cards/:id。
    await page.goto("/cards", { waitUntil: "domcontentloaded" });
    const objectiveLink = page.locator(".objective-library-row h3 a").first();
    await expect(objectiveLink).toBeVisible({ timeout: 30_000 });
    await objectiveLink.click();
    await expect(page).toHaveURL(/\/learning-cards\/[\w-]+$/);
    await expect(page.locator(".objective-detail-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "来源与证据" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "个人学习状态" })).toBeVisible();

    // 用稳定 seed 卡槽走正式 V2 CTA，避免列表排序受并行历史影响。
    await page.goto(`/learning-cards/${TEST_CARD_ID}`, { waitUntil: "domcontentloaded" });
    const cta = page.getByRole("button", { name: /开始验证|继续本次巩固|开始复习/ }).first();
    await expect(cta).toBeVisible({ timeout: 30_000 });
    await cta.click();
    await expect(page).toHaveURL(/\/learning-runs\/[0-9a-f-]{36}/, { timeout: 30_000 });

    const answer = page.locator("textarea").first();
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await answer.fill("我用自己的话说明这个概念，并给出一个能检验理解的例子。");
    const submit = page.getByRole("button", { name: /提交|完成作答|锁定/ }).first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();
    const finishCheckpoint = page.getByRole("button", { name: "按当前结果结束" });
    const finalResult = page.getByText(/本轮结果|证明了这项理解|证明了其中一部分|这次没有完全证明|本轮练习完成/).first();
    await expect.poll(
      async () => (await finishCheckpoint.isVisible().catch(() => false))
        || (await finalResult.isVisible().catch(() => false)),
      { timeout: 120_000 },
    ).toBe(true);
    // Critic 可能把这次回答判为 partial；这不是挂起，而是一个显式
    // checkpoint，必须走“按当前结果结束”才会产生最终结算。
    if (await finishCheckpoint.isVisible().catch(() => false)) {
      await finishCheckpoint.click();
    }
    await expect(finalResult).toBeVisible({ timeout: 30_000 });

    // 伴星模块不是另一套学习前台：历史页、记忆页和桌宠设置仍然可回达。
    await page.goto("/companion/memory", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "伴星记忆", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "对话历史" }).click();
    await expect(page).toHaveURL(/\/companion\/conversations$/);
    await expect(page.getByRole("heading", { name: "伴星交互档案", exact: true })).toBeVisible();
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    // 设置页是客户端 tab；等 hydration 完成后再操作桌面端导航，避免
    // 在服务端 HTML 已可见但 React 事件尚未接管的窗口内丢失 click。
    await page.waitForLoadState("load").catch(() => undefined);
    const settingsSectionPicker = page.getByLabel("当前设置分区");
    if (await settingsSectionPicker.isVisible().catch(() => false)) {
      await settingsSectionPicker.selectOption("pet");
    } else {
      const petTab = page.getByRole("tab", { name: /桌宠伴星/ });
      await expect(petTab).toBeVisible();
      await petTab.click();
      await expect(petTab).toHaveAttribute("aria-selected", "true");
    }
    await expect(page.getByText("桌面 AI 学习伴星")).toBeVisible();
  });
});
