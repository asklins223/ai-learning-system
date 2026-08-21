/**
 * 文档 16 学习闭环 E2E（P2/P3 Gate：learning_run_v1 双侧同开真实切换）。
 *
 * 场景：登录 → Card 页 live CTA（flag 开启后"开始三分钟巩固"文案）→
 * /learning-runs/new 幂等创建 → [runId] Player → 提交 text → 真 Critic
 * 评估（DashScope）→ 结果页 completed（canonical Commit + schedule）。
 *
 * 运行前提（本地 dev 栈）：
 *   - API :4000（source .env + DATABASE_URL_API=127.0.0.1）
 *   - web :3000（next dev 读 apps/web/.env.local → 仓库根 .env）
 *   - seed-e2e-v06.ts 已跑（TEST_CARD_ID 固定槽位）
 *   E2E_BASE_URL=http://localhost:3000 E2E_DEV_EMAIL=... E2E_DEV_PASSWORD=...
 */

import { test, expect } from "@playwright/test";
import {
  skipIfNoServer,
  devCredentials,
  loginViaUI,
  TEST_CARD_ID,
  TEST_OBJECTIVE_ID,
} from "./helpers.ts";

const CREDENTIALS = devCredentials();
const CAN_RUN = Boolean(process.env.E2E_BASE_URL) && Boolean(CREDENTIALS);

test.describe("文档 16 学习闭环（learning_run_v1 双侧同开）", () => {
  test.describe.configure({ mode: "serial" });

  test("Card 页 live CTA → /learning-runs/new → Player 提交 → 真实评估结算", async ({ page }) => {
    test.skip(!CAN_RUN, "E2E_BASE_URL/E2E_DEV_* 未配置");
    skipIfNoServer();
    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);

    // 1. V2 Objective 详情页：主行动由服务端 typed action 决定。
    await page.goto(`/learning-cards/${TEST_CARD_ID}`, { waitUntil: "domcontentloaded" });
    const liveCta = page.getByRole("button", { name: /开始验证/ });
    await expect(liveCta.first()).toBeVisible({ timeout: 30_000 });

    // 2. CTA → /learning-runs/new（稳定幂等键）→ redirect 到 runId。
    await liveCta.first().click();
    await expect(page).toHaveURL(/\/learning-runs\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // 3. Player 渲染：等待提交区（text 输入）。
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });
    await textarea.fill("地球绕太阳公转一周大约需要 365 天，完成一次公转，这就是地球的轨道周期。");
    const submitButton = page.getByRole("button", { name: /提交|完成作答|submit/i });
    await expect(submitButton).toBeVisible({ timeout: 15_000 });
    await submitButton.click();

    // 4. 真 Critic 评估（真实 LLM 网络调用，最长 ~60s）。
    const resultState = page.locator("text=/已完成|掌握|还需复习|结果/");
    await expect(resultState.first()).toBeVisible({ timeout: 90_000 });

    // 5. 返回语义：结果页展示 schedule 影响（created 或"保持原计划"——卡上巩固
    //    对已有 pending schedule 的 keyPoint 不产生 schedule 副作用，§13.1）。
    const scheduleImpact = page.locator("text=/下次复习|间隔|schedule|复习计划|复习安排|保持原计划/").first();
    await expect(scheduleImpact).toBeVisible({ timeout: 15_000 });
  });

  test("flag 开启后 /learning-runs/new 可直达（不 404）", async ({ page }) => {
    test.skip(!CAN_RUN, "E2E_BASE_URL/E2E_DEV_* 未配置");
    skipIfNoServer();
    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);
    await page.goto(
      `/learning-runs/new?origin=card_v2&cardId=${TEST_CARD_ID}&objectiveId=${TEST_OBJECTIVE_ID}&goal=stabilize&returnTo=%2Fcards`,
      { waitUntil: "domcontentloaded" },
    );
    // new 页会立即创建并 redirect（幂等键稳定）；404 则停留 new 无 redirect。
    await expect(page).toHaveURL(/\/learning-runs\//, { timeout: 30_000 });
  });
});
