/**
 * 文档 16 星图行动面 E2E（P7 Gate：star_map_action_v1 投影切流真实链路）。
 *
 * E10 语义子集：登录 → /graph 投影渲染（计数来自投影节点，非旧 reader）→
 * 选中 key_point → 详情面板显示投影个人事实与 live CTA → 发起星图 Run
 * （checkpoint 基线）→ 提交 → 真 Critic 评估 → 完成 → "返回理解星图"
 * （changeSetId + restoreRun）→ graph 页一次性显影提示。
 *
 * 运行前提（本地 dev 栈）：
 *   - API :4000、web :3000（读仓库根 .env，star_map_action_v1=on）
 *   - seed-e2e-v06.ts 已跑（TEST_CARD_ID 固定槽位 + 3 key_points）
 *   E2E_BASE_URL=http://localhost:3000 E2E_DEV_EMAIL=... E2E_DEV_PASSWORD=...
 */

import { test, expect } from "@playwright/test";
import {
  skipIfNoServer,
  devCredentials,
  loginViaUI,
} from "./helpers.ts";

const CREDENTIALS = devCredentials();
const CAN_RUN = Boolean(process.env.E2E_BASE_URL) && Boolean(CREDENTIALS);

test.describe("文档 16 星图行动面（投影切流）", () => {
  test.describe.configure({ mode: "serial" });

  test("E10 子集：/graph 投影渲染 → 选中 kp → 发起星图 Run → 返回显影", async ({ page }) => {
    test.skip(!CAN_RUN, "E2E_BASE_URL/E2E_DEV_* 未配置");
    skipIfNoServer();
    test.setTimeout(240_000); // 真 Critic + 结算 + 返回显影整链路
    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);

    // 1. /graph：投影切流后计数来自投影节点（种子卡 ≥1 恒星、≥1 论点卫星）。
    await page.goto("/graph", { waitUntil: "domcontentloaded" });
    const subtitle = page.locator(".universe-subtitle");
    await expect(subtitle).toContainText(/[1-9]\d* 颗学习恒星/, { timeout: 30_000 });
    await expect(subtitle).toContainText(/[1-9]\d* 颗论点卫星/, { timeout: 30_000 });

    // 2. 键盘浏览 → 选中"地球公转"论点卫星（投影 key_point 节点，提交内容与
    //    该 kp 匹配才能演示自动结算）→ 详情面板打开。
    await page.locator("details.universe-keyboard-browser summary").click();
    const kpButton = page.locator("details.universe-keyboard-browser li button:has-text(\"Earth's orbital period\")").first();
    await expect(kpButton).toBeVisible({ timeout: 15_000 });
    await kpButton.click();
    const detailPanel = page.locator("aside.universe-detail-panel.is-open");
    await expect(detailPanel).toBeVisible({ timeout: 15_000 });
    // 投影个人事实（§15.2）：个人状态/练习足迹替代旧证据计数（诚实降级）。
    await expect(detailPanel.getByText("个人状态")).toBeVisible({ timeout: 15_000 });
    await expect(detailPanel.getByText("练习足迹")).toBeVisible({ timeout: 15_000 });

    // 3. live CTA（star_map_action_v1 开启且选中 key_point）→ 发起。
    const cta = detailPanel.getByRole("link", { name: /三分钟练习/ });
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();
    await expect(page).toHaveURL(/\/learning-runs\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // 4. Player 提交 → 真 Critic 评估（最长 ~90s）。
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });
    await textarea.fill("地球绕太阳公转一周大约需要 365 天，完成一次公转，这就是地球的轨道周期。");
    const submitButton = page.getByRole("button", { name: /提交|完成作答|submit/i });
    await expect(submitButton).toBeVisible({ timeout: 15_000 });
    await submitButton.click();
    // 结算分支：demonstrated/declared_unable 自动 commit；partial 会进
    // checkpoint(partial) 等用户"按当前结果结束"——两种都收敛到结果页。
    const finishCheckpoint = page.getByRole("button", { name: "按当前结果结束" });
    try {
      await finishCheckpoint.waitFor({ timeout: 45_000 });
      await finishCheckpoint.click();
    } catch {
      // 已自动结算（无 checkpoint 分支）。
    }

    // 5. 结果页（ResultView 卡片内）→ 返回理解星图（§15.5：changeSetId 一次性
    //    显影 + restoreRun 视口恢复）。限定在结果卡内点击——committing 阶段
    //    journey 面板也有同名返回按钮（歧义）。
    const backToGraph = page.locator(".learning-run-result__actions").getByRole("button", { name: "返回理解星图" });
    await expect(backToGraph).toBeVisible({ timeout: 90_000 });
    await backToGraph.click();
    await expect(page).toHaveURL(/\/graph\?.*(changeSetId|restoreRun)/, { timeout: 30_000 });
    // graph 页按 changeSetId 显示显影提示（本地 receipt 同设备一次）。
    await expect(page.getByText("本次学习已显影到星图")).toBeVisible({ timeout: 30_000 });
  });
});
