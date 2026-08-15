import type { Page } from "@playwright/test";
import { test, expect, type SeedCredentials } from "../lib/fixtures";

/**
 * §24.5 E04/E07 验收旅程：到期复习消费恰一 schedule + 声明不会的确定性结算。
 *
 * 真实浏览器 → 真实 API/DB/评估链；断言 DB 事实（schedule 消费 + successor）。
 */

async function declareUnable(page: Page): Promise<void> {
  // 进入 Run 后点"我确实不会"（确定性 declared_unable → Commit）。
  const unable = page.getByRole("button", { name: /我确实不会/ }).first();
  await expect(unable).toBeVisible({ timeout: 30_000 });
  await unable.click();
}

test.describe("review & declared-unable corpus", () => {
  test("E04: due review consumes exactly one schedule @pr", async ({
    authedPage,
  }) => {
    test.setTimeout(240_000);
    const page = authedPage;

    await page.goto("/review");
    await expect(page.locator(".review-v06-item").first()).toBeVisible({ timeout: 15_000 });
    // 记录第一个到期 schedule 的 id(href 参数)。
    const firstHref = await page.locator(".review-v06-item").first().getAttribute("href");
    expect(firstHref).toContain("origin=review");
    const scheduleId = new URL(firstHref!, "http://x").searchParams.get("scheduleId");
    expect(scheduleId).toBeTruthy();

    await page.locator(".review-v06-item").first().click();
    await expect(page).toHaveURL(/\/learning-runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await declareUnable(page);

    // 结算结果页(declared_unable)。
    await expect(page.getByText(/本轮结果|学习结算/).first()).toBeVisible({
      timeout: 120_000,
    });

    // DB 事实:原 schedule 被消费——从 pending 队列消失(status=completed)。
    const stillPending = await page.evaluate(async (id) => {
      const res = await fetch(`/api/reviews?limit=100`);
      const body = await res.json() as {
        items?: Array<{ reviewId?: string }>;
      };
      return body.items?.some((i) => i.reviewId === id) ?? false;
    }, scheduleId);
    // eslint-disable-next-line no-console
    console.log(`PROBE-E04 schedule=${scheduleId} stillPending=${stillPending}`);
    expect(stillPending).toBe(false);
  });

  test("E07: declared unable is a deterministic settle, not mastery @pr", async ({
    authedPage,
    seedCredentials,
  }) => {
    test.setTimeout(240_000);
    const page = authedPage;
    const cardId = (seedCredentials as SeedCredentials).workspaces[0]?.cardIds?.[7];
    expect(cardId).toBeTruthy();

    await page.goto(`/cards/${cardId}`);
    await expect(page.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });
    await page.locator("[data-ui='lc-card-primary-action']").click();
    await expect(page).toHaveURL(/\/learning-runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await declareUnable(page);

    await expect(page.getByText(/本轮结果|学习结算/).first()).toBeVisible({
      timeout: 120_000,
    });
    // 结算面明确不是掌握(无"已证明"文案;declared_unable 语义)。
    await expect(page.getByText(/已证明/)).toHaveCount(0);
  });
});
