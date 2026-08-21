/**
 * 文档 16 星图行动面 E2E（P7 Gate：star_map_action_v1 投影切流真实链路）。
 *
 * E10 语义子集：登录 → /graph 当前 V3 topology 渲染 →
 * 选中 objective → 详情面板显示个人状态与 typed action →
 * 进入当前 V2 学习目标详情页。
 *
 * 运行前提（本地 dev 栈）：
 *   - API :4000、web :3000（读仓库根 .env，star_map_action_v1=on）
 *   - seed-e2e-v06.ts 已跑（TEST_CARD_ID 固定 V2 卡槽位）
 *   E2E_BASE_URL=http://localhost:3000 E2E_DEV_EMAIL=... E2E_DEV_PASSWORD=...
 */

import { test, expect } from "@playwright/test";
import {
  skipIfNoServer,
  devCredentials,
  loginViaUI,
  TEST_CARD_ID,
} from "./helpers.ts";

const CREDENTIALS = devCredentials();
const CAN_RUN = Boolean(process.env.E2E_BASE_URL) && Boolean(CREDENTIALS);

test.describe("文档 16 星图行动面（投影切流）", () => {
  test.describe.configure({ mode: "serial" });

  test("E10 子集：/graph topology 渲染 → 选中 objective → 进入目标详情", async ({ page }) => {
    test.skip(!CAN_RUN, "E2E_BASE_URL/E2E_DEV_* 未配置");
    skipIfNoServer();
    test.setTimeout(90_000);
    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);

    // 1. /graph：重构后的 V3 topology 直接展示 source/note/objective/evidence。
    await page.goto("/graph", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".graph-v3")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".graph-v3-node--note").first()).toBeVisible({ timeout: 30_000 });
    const objectiveNode = page.locator(".graph-v3-node--objective[aria-label=\"Earth's orbital period\"]");
    await expect(objectiveNode).toBeVisible({ timeout: 30_000 });

    // 2. 选中学习目标节点 → 当前 V3 详情面板打开。
    await objectiveNode.click();
    const detailPanel = page.locator("aside.graph-v3-sidepanel");
    await expect(detailPanel).toBeVisible({ timeout: 15_000 });
    await expect(detailPanel.getByRole("heading", { name: "Earth's orbital period" })).toBeVisible();
    await expect(detailPanel.getByText("状态")).toBeVisible();
    await expect(detailPanel.getByText("练习轨迹")).toBeVisible();

    // 3. 当前 V3 图的详情入口必须落到真实 V2 card route；正式 Run
    //    由 learning-run-v1 套件执行，避免在每个 viewport 重复消耗一次 LLM 结算。
    const detailLink = detailPanel.getByRole("link", { name: "查看目标档案" });
    await expect(detailLink).toHaveAttribute("href", `/learning-cards/${TEST_CARD_ID}`);
    await detailLink.click();
    await expect(page).toHaveURL(new RegExp(`/learning-cards/${TEST_CARD_ID}$`));
    await expect(page.getByRole("button", { name: /开始验证/ })).toBeVisible({ timeout: 30_000 });
  });
});
