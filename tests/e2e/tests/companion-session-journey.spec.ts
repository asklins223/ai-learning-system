import type { Page } from "@playwright/test";
import { test, expect, type SeedCredentials } from "../lib/fixtures";

// 方案 16：卡片主按钮是统一 LearningRun 微旅程入口，真实文案随状态变化
// （开始三分钟巩固 / 预览这次微旅程 / 开始巩固）。
const PRIMARY_ACTION = "开始三分钟巩固";
const EVIDENCE_ACTION = "查看原文依据";

async function resolveCardId(
  page: Page,
  seedCredentials: SeedCredentials,
): Promise<string> {
  const seededCardId = seedCredentials.workspaces[0]?.cardIds?.[0];
  if (seededCardId) return seededCardId;
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/cards");
    if (!result.ok) return undefined;
    const payload = await result.json() as { items?: Array<{ id?: string }> };
    return payload.items?.[0]?.id;
  });
  if (!response) {
    throw new Error("the authenticated workspace must expose a card for the Companion practice");
  }
  return response;
}

/** 点击卡片主按钮进入 LearningRun，等待 Run 创建完成并落到 [runId] 路由。 */
async function enterLearningRun(page: Page, cardId: string): Promise<string> {
  await page.goto(`/cards/${cardId}`);
  await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-ui='lc-card-primary-action']").click();
  await expect(page).toHaveURL(/\/learning-runs\/[\w-]+/, { timeout: 30_000 });
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  expect(runId).toBeTruthy();
  return runId!;
}

/**
 * 方案 16 统一 LearningRun 微旅程垂直切片（替代旧 consolidation practice）。
 *
 * 真实浏览器驱动真实 API/DB/评估链：
 * - 卡片动作区：恰好一个三分钟巩固主按钮 + 一个证据动作；
 * - 点击主按钮 → /learning-runs/new → 幂等创建 → [runId]；
 * - Player 是单列任务页，无角色图/航程 chrome；
 * - 提交 → 独立评估 → 确定性结算（checkpoint/结果），绝无假完成；
 * - 创建失败（AI consent）时页面引导，不静默吞错；
 * - 同一天重复进入恢复同一 Run（幂等）；
 * - review/today/star map 不新增竞争入口。
 *
 * @pr
 */
test.describe.serial("unified LearningRun journeys", () => {
  test("learning card keeps exactly one primary run action and one evidence action @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);

    await page.goto(`/cards/${cardId}`);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });

    const actions = page.locator("[data-ui='lc-learning-card-actions']");
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button")).toHaveCount(2);
    await expect(actions.locator("[data-ui='lc-card-primary-action']"))
      .toHaveAccessibleName(PRIMARY_ACTION);
    await expect(actions.locator("[data-ui='lc-card-evidence-action']"))
      .toHaveAccessibleName(EVIDENCE_ACTION);
    await expect(actions.getByRole("button", { name: /朗读|问一问|开始.*航程/ })).toHaveCount(0);

    // 操作区可以说明下一步，但不再重复学习卡本身的标题与核心概述。
    const cardTitle = (await page.locator("#card-detail-title").textContent())?.trim() ?? "";
    const cardSummary = (await page.locator(".card-detail-core-understanding p").textContent())
      ?.trim() ?? "";
    expect(cardTitle).not.toBe("");
    expect(cardSummary).not.toBe("");
    await expect(actions.getByText(cardTitle, { exact: true })).toHaveCount(0);
    await expect(actions.getByText(cardSummary, { exact: true })).toHaveCount(0);
  });

  test("LearningRun player is a single-column task without character or journey chrome @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);
    await enterLearningRun(page, cardId);

    // 十秒内出现第一个可执行动作（§3.1）：题面 + 作答区。
    await expect(page.getByRole("textbox", { name: "用你自然的表达回答" }))
      .toBeVisible({ timeout: 15_000 });

    // 单列任务：无角色图、无航程叙事；唯一伴随表面是「本轮操作」
    // 操作栏（换个方式/提示/跳过），不是伴星面板或角色 chrome。
    const main = page.locator("main");
    await expect(main.locator('img[alt="学习伴星"]')).toHaveCount(0);
    await expect(main.locator(".companion-stage-intro, .companion-stage-portrait"))
      .toHaveCount(0);
    await expect(main.getByText(/航程/)).toHaveCount(0);
    const asides = main.locator("aside");
    await expect(asides).toHaveCount(1);
    await expect(asides.first()).toHaveAccessibleName("本轮操作");

    // 返回学习卡，退出本轮入口。
    await page.getByRole("button", { name: "返回学习卡" }).click();
    await expect(page).toHaveURL(new RegExp(`/cards/${cardId}$`));
  });

  test("answer submission moves from locked assessment to a deterministic settlement @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    test.setTimeout(240_000);
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);
    await enterLearningRun(page, cardId);

    const answer = page.getByRole("textbox", { name: "用你自然的表达回答" });
    await expect(answer).toBeVisible({ timeout: 15_000 });
    await answer.click();
    await page.keyboard.type("刻意练习通过明确目标、即时反馈和适度挑战来改善表现，这是我的理解。");
    const submit = page.getByRole("button", { name: /锁定并提交回答/ });
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();

    // 提交后进入评估：回答锁定、独立评估进行中（不提前声称已保存/已评估）。
    await expect(page.getByText("正在独立评估", { exact: false }).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/回答已锁定|回答已安全锁定/).first())
      .toBeVisible({ timeout: 15_000 });

    // 真实 Critic 完成评估后出现确定性结算：检查点决定或本轮结果。
    await expect(
      page.getByText(/检查点|本轮结果|学习结算/).first(),
    ).toBeVisible({ timeout: 120_000 });
  });

  test("AI consent create failure leads to an explicit recovery surface @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);
    await page.goto(`/cards/${cardId}`);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/learning-runs", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: "AI_CONSENT_REQUIRED",
          message: "工作区尚未签署 AI 使用协议",
        }),
      });
    });
    await page.locator("[data-ui='lc-card-primary-action']").click();
    // 创建失败必须显示错误面，而不是静默吞掉（fail closed 不假装成功）。
    await expect(page.locator(".learning-run-player--error")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(".learning-run-player--error").first()).toContainText(
      /AI 使用协议|签署/,
    );
    await page.unroute("**/api/learning-runs");
  });

  test("re-entering the same card on the same day resumes the same run @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    const page = authedPage;
    const cardId = await resolveCardId(page, seedCredentials);
    const firstRunId = await enterLearningRun(page, cardId);
    await expect(page.getByRole("textbox", { name: "用你自然的表达回答" }))
      .toBeVisible({ timeout: 15_000 });

    // 返回卡片后再次进入：同天幂等键复用同一 Run（恢复语义，不重复创建）。
    await page.getByRole("button", { name: "返回学习卡" }).click();
    await expect(page).toHaveURL(new RegExp(`/cards/${cardId}$`));
    const secondRunId = await enterLearningRun(page, cardId);
    expect(secondRunId).toBe(firstRunId);
  });

  test("review, today and star map do not add competing practice actions @pr", async ({
    authedPage,
  }) => {
    const page = authedPage;
    // 方案 16：统一入口之外不允许出现第二套伴星练习动作。
    for (const path of ["/review", "/today", "/graph"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("[data-ui='lc-card-primary-action']")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /开始巩固练习|开始.*航程/ })).toHaveCount(0);
    }
  });
});
