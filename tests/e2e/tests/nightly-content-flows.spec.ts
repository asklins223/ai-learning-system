import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../lib/fixtures";

/**
 * E2E: Nightly content flows (QLT-01/02, ADR-0008 §6).
 *
 * These tests cover the nightly/RC expansion paths that are NOT part of the
 * PR smoke set. Per the plan §6.7:
 *
 *   Nightly/RC 扩展覆盖：
 *   - 来源创建、URL 异常、Markdown 批量导入与部分失败
 *   - 搜索分页、星图截断/加载、导出恢复
 *   - 51 / 100 / 1000 条数据边界
 *   - 390 / 768 / 1440 视口、键盘、焦点、减少动画和控制台错误
 *
 * Invite/onboarding flows are handled separately and are NOT included here.
 *
 * @nightly
 */

type SourcePayload = {
  id: string;
  status: string;
  title: string;
};

type SourceDetailPayload = {
  source: SourcePayload;
};

type SearchPayload = {
  items: Array<{
    objectType: string;
    objectId: string;
    title: string | null;
    href: string;
  }>;
  total: number;
  nextOffset: number | null;
};

type CursorPagePayload = {
  items: Array<{ id: string }>;
  total: number;
  nextCursor: string | null;
};

function uniqueFixtureTitle(testInfo: TestInfo, purpose: string) {
  return `E2E ${purpose} ${testInfo.project.name} ${testInfo.workerIndex} ${Date.now()}`;
}

async function createSearchableTextSource(
  page: Page,
  testInfo: TestInfo,
  purpose: string,
): Promise<{ id: string; title: string }> {
  const title = uniqueFixtureTitle(testInfo, purpose);
  await page.goto("/sources");
  await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "新建来源", exact: true }).click();

  const capturePanel = page.getByRole("region", { name: "收录一份新资料" });
  await expect(capturePanel).toBeVisible();
  await capturePanel.getByRole("button", { name: /^文本(?:\s|$)/ }).click();
  await capturePanel.getByRole("textbox", { name: "资料标题" }).fill(title);
  await capturePanel
    .getByRole("textbox", { name: "文本内容" })
    .fill(`${title}\n\nDeterministic searchable content for the nightly browser gate.`);

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname.endsWith("/sources");
  });
  await capturePanel.getByRole("button", { name: "加入解析队列" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok(), `source creation returned ${createResponse.status()}`).toBeTruthy();
  const createdPayload = await createResponse.json() as SourceDetailPayload;
  const created = createdPayload.source;
  expect(created.id, "source creation must return its persisted id").toMatch(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  );

  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/sources/${created.id}`);
      expect(response.ok(), `source status returned ${response.status()}`).toBeTruthy();
      return ((await response.json()) as SourceDetailPayload).source.status;
    }, {
      timeout: 30_000,
      message: `source ${created.id} should finish parsing before search assertions`,
    })
    .toBe("ready");

  return { id: created.id, title };
}

async function searchFor(
  page: Page,
  query: string,
  type?: "note" | "card" | "source" | "evidence",
): Promise<SearchPayload> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname.endsWith("/search")
      && url.searchParams.get("q") === query
      && (type === undefined || url.searchParams.get("type") === type);
  });

  if (type === undefined) {
    const input = page.getByRole("searchbox", { name: "跨对象检索" });
    await input.fill(query);
    await input.press("Enter");
  } else {
    await page
      .getByRole("group", { name: "按学习对象类型筛选" })
      .getByRole("button", { name: type === "source" ? "来源" : type })
      .click();
  }

  const response = await responsePromise;
  expect(response.ok(), `search returned ${response.status()}`).toBeTruthy();
  return response.json() as Promise<SearchPayload>;
}

test.describe("Sources page — creation and validation @nightly", () => {
  test("sources list page loads with seeded data", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: /来源|资料/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    // The sources page container should be rendered
    await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });

    // New source button should be visible
    await expect(page.locator(".sources-action-primary")).toBeVisible();
  });

  test("create text source via capture panel", async ({ authedPage }) => {
    const page = authedPage;
    const sourceTitle = `E2E Nightly Source ${Date.now()}`;

    await page.goto("/sources");
    await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });

    // Open the create panel
    const createButton = page.locator(".sources-action-primary");
    await createButton.click();

    // The capture paper should appear
    const capturePanel = page.getByRole("region", { name: "收录一份新资料" });
    await expect(capturePanel).toBeVisible({ timeout: 5_000 });

    // Select "文本" type (default is usually text, but click to be sure)
    await capturePanel.getByRole("button", { name: /^文本(?:\s|$)/ }).click();

    // Fill in title
    await capturePanel.getByRole("textbox", { name: "资料标题" }).fill(sourceTitle);

    // Fill in content textarea
    await capturePanel
      .getByRole("textbox", { name: "文本内容" })
      .fill("This is a test source created by the nightly E2E suite for content flow validation.");

    // Submit the form and verify the persisted success state, not just the click.
    const submitButton = capturePanel.getByRole("button", { name: "加入解析队列" });
    await expect(submitButton).toBeEnabled();
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/sources"),
      { timeout: 10_000 },
    );
    await submitButton.click();
    const createResponse = await createResponsePromise;

    expect(createResponse.ok()).toBeTruthy();
    await expect(capturePanel).toBeHidden({ timeout: 10_000 });
    await expect(page.locator(".sources-notice")).toContainText(
      `“${sourceTitle}”已加入资料解析队列。`,
    );
  });

  test("URL source validation rejects invalid URLs", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/sources");
    await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "新建来源", exact: true }).click();
    const capturePanel = page.getByRole("region", { name: "收录一份新资料" });
    await expect(capturePanel).toBeVisible({ timeout: 5_000 });
    await capturePanel.getByRole("button", { name: /^网页链接/ }).click();
    await capturePanel.getByRole("textbox", { name: "资料标题" }).fill("Invalid URL fixture");

    const urlInput = capturePanel.getByRole("textbox", { name: "网页链接" });
    await urlInput.fill("not-a-valid-url");
    await expect(urlInput).toHaveAttribute("aria-invalid", "true");
    await expect(capturePanel.getByText("请输入以 http:// 或 https:// 开头的有效链接。", {
      exact: true,
    })).toBeVisible();
    await expect(capturePanel.getByRole("button", { name: "加入解析队列" })).toBeDisabled();
  });

  test("status filter buttons toggle the source list", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/sources");
    await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });

    const filterGroup = page.getByRole("group", {
      name: "按解析状态筛选来源；计数为当前已加载资料",
    });
    const allFilter = filterGroup.getByRole("button", { name: /^全部/ });
    const readyFilter = filterGroup.getByRole("button", { name: /^已就绪/ });
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");

    await readyFilter.click();
    await expect(readyFilter).toHaveAttribute("aria-pressed", "true");
    const readyCards = page.locator(".sources-card");
    await expect.poll(() => readyCards.count()).toBeGreaterThan(0);
    const readyStatuses = await readyCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-status")),
    );
    expect(new Set(readyStatuses)).toEqual(new Set(["ready"]));

    await allFilter.click();
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.locator(".sources-card").count()).toBeGreaterThanOrEqual(
      readyStatuses.length,
    );
  });
});

test.describe("Search — query and filtering @nightly", () => {
  test("search page loads with query input", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/search");
    await expect(page.locator(".search-page-refined, .search-page")).toBeVisible({
      timeout: 10_000,
    });

    // Search input should be present
    await expect(page.locator("#global-search-input, .search-command-form input")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("search returns the source created for this test", async ({
    authedPage,
  }, testInfo) => {
    const page = authedPage;
    const source = await createSearchableTextSource(page, testInfo, "search-result");
    await page.goto("/search");
    const payload = await searchFor(page, source.title);
    expect(payload.total).toBeGreaterThanOrEqual(1);
    expect(payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectType: "source",
        objectId: source.id,
        title: source.title,
      }),
    ]));

    const result = page.locator(`[data-search-result-key="source:${source.id}"]`);
    await expect(result).toBeVisible({ timeout: 10_000 });
    await expect(result.getByRole("heading", { name: source.title })).toBeVisible();
  });

  test("search type filters update the request and visible result set", async ({
    authedPage,
  }, testInfo) => {
    const page = authedPage;
    const source = await createSearchableTextSource(page, testInfo, "search-filter");
    await page.goto("/search");
    await searchFor(page, source.title);
    const sourcePayload = await searchFor(page, source.title, "source");
    expect(sourcePayload.total).toBeGreaterThanOrEqual(1);
    expect(sourcePayload.items.every((item) => item.objectType === "source")).toBe(true);

    const filterGroup = page.getByRole("group", { name: "按学习对象类型筛选" });
    await expect(filterGroup.getByRole("button", { name: "来源", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".search-result-card")).toHaveCount(sourcePayload.items.length);
    const visibleTypes = await page.locator(".search-result-card").evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-type")),
    );
    expect(new Set(visibleTypes)).toEqual(new Set(["source"]));
  });

  test("search result link navigates to the exact persisted source", async ({
    authedPage,
  }, testInfo) => {
    const page = authedPage;
    const source = await createSearchableTextSource(page, testInfo, "search-link");
    await page.goto("/search");
    const payload = await searchFor(page, source.title);
    const expectedItem = payload.items.find((item) => item.objectId === source.id);
    expect(expectedItem?.href).toBe(`/sources/${source.id}`);

    const resultLink = page.locator(`[data-search-result-key="source:${source.id}"]`);
    await expect(resultLink).toHaveAttribute("href", new RegExp(`^/sources/${source.id}\\?`));
    await resultLink.click();
    await expect(page).toHaveURL(new RegExp(`/sources/${source.id}(?:\\?|$)`));
    await expect(page.getByRole("heading", { name: source.title, exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("Understanding graph — rendering and interaction @nightly", () => {
  test("graph page loads and renders canvas", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/graph");

    const graphRegion = page.getByRole("region", {
      name: "理解星图：你的真实知识宇宙",
      exact: true,
    });
    await expect(graphRegion).toBeVisible({ timeout: 10_000 });

    // The canvas must be both laid out and backed by a non-empty drawing buffer.
    const graphCanvas = graphRegion.locator("canvas.universe-canvas-surface");
    await expect(graphCanvas).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          graphCanvas.evaluate(
            (element) =>
              (element as HTMLCanvasElement).width *
              (element as HTMLCanvasElement).height,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  });

  test("graph filter buttons toggle node visibility", async ({ authedPage }) => {
    const page = authedPage;
    const graphResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith("/api/graph"),
    );
    await page.goto("/graph");
    const graphResponse = await graphResponsePromise;
    expect(graphResponse.ok()).toBeTruthy();
    const graphPayload = await graphResponse.json() as {
      meta: { cardCount: number; stateCounts: Record<string, number> };
    };
    expect(graphPayload.meta.cardCount).toBeGreaterThan(0);
    expect(
      (graphPayload.meta.stateCounts.misunderstood ?? 0)
      + (graphPayload.meta.stateCounts.due_review ?? 0),
      "nightly seed must expose at least one card requiring attention",
    ).toBeGreaterThan(0);

    const graphRoot = page.locator(".universe-page");
    const filterDock = page.getByRole("navigation", { name: "按理解状态探索星域" });
    const allFilter = filterDock.getByRole("button", { name: /^全部星域/ });
    const attentionFilter = filterDock.getByRole("button", { name: /^需关注/ });
    const readout = page.locator(".universe-layer-readout");
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    await expect(attentionFilter).toBeEnabled();
    const allNodeCount = Number.parseInt((await readout.textContent()) ?? "", 10);
    expect(allNodeCount).toBeGreaterThan(0);

    await attentionFilter.click();
    await expect(attentionFilter).toHaveAttribute("aria-pressed", "true");
    await expect(graphRoot).toHaveAttribute("data-state-filter", "attention");
    await expect.poll(async () => Number.parseInt((await readout.textContent()) ?? "", 10))
      .toBeGreaterThan(0);

    await allFilter.click();
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    await expect(graphRoot).toHaveAttribute("data-state-filter", "all");
    await expect(readout).toHaveText(`${allNodeCount} 星体`);
  });

  test("graph handles empty state gracefully", async ({ authedPage }) => {
    const page = authedPage;
    await page.route("**/api/graph", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          nodes: [],
          edges: [],
          meta: {
            generatedAt: "2026-07-23T00:00:00.000Z",
            totalCards: 0,
            nodeCount: 0,
            edgeCount: 0,
            sourceCount: 0,
            noteCount: 0,
            cardCount: 0,
            keyPointCount: 0,
            truncated: false,
            stateCounts: {},
          },
        }),
      });
    });
    await page.goto("/graph");
    const emptyState = page.locator(".universe-status-card");
    await expect(emptyState.getByText("第一颗知识恒星还没有诞生", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(emptyState.getByRole("link", { name: /去写笔记/ })).toHaveAttribute(
      "href",
      "/notes",
    );
    await expect(page.locator(".universe-layer-readout")).toHaveText("0 星体");
  });
});

test.describe("Settings — provider configuration @nightly", () => {
  test("settings page loads with provider config section", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/settings#model");
    await expect(page.getByRole("heading", { name: /设置|settings/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    const modelPanel = page.locator("#model");
    await expect(modelPanel).toBeVisible({ timeout: 10_000 });
    await expect(modelPanel.getByRole("heading", { name: "模型与 API 配置" })).toBeVisible();

    const providerSelect = modelPanel.getByLabel("模型来源");
    await expect(providerSelect).toBeVisible();
    await expect(providerSelect).toHaveValue("mock");
    await expect(providerSelect.locator('option[value="mock"]')).toHaveText("系统默认");
  });
});

/**
 * Nightly pagination boundary tests.
 *
 * Both nightly and RC seed profiles provide more than 50 notes/reviews.
 */
test.describe("Data boundary — 51 item pagination @nightly", () => {
  test("notes cursor pagination and list render all 51+ items", async ({ authedPage }) => {
    const page = authedPage;

    const firstResponse = await page.request.get("/api/notes?limit=50&trashed=false");
    expect(firstResponse.ok(), `notes first page returned ${firstResponse.status()}`).toBeTruthy();
    const firstPage = await firstResponse.json() as CursorPagePayload;
    expect(firstPage.total).toBeGreaterThanOrEqual(51);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondResponse = await page.request.get(
      `/api/notes?limit=50&trashed=false&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(secondResponse.ok(), `notes second page returned ${secondResponse.status()}`).toBeTruthy();
    const secondPage = await secondResponse.json() as CursorPagePayload;
    expect(secondPage.total).toBeGreaterThanOrEqual(firstPage.total);
    expect(secondPage.items.length).toBeGreaterThanOrEqual(1);

    const firstIds = new Set(firstPage.items.map((note) => note.id));
    expect(secondPage.items.every((note) => !firstIds.has(note.id))).toBeTruthy();

    await page.goto("/notes");
    await expect(page.locator(".notes-index-paper")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.locator(".notes-card").count()).toBeGreaterThanOrEqual(51);
  });

  test("review queue handles many due reviews", async ({ authedPage }) => {
    const page = authedPage;

    const reviewResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname.endsWith("/reviews") &&
          url.searchParams.get("status") === "pending"
        );
      },
      { timeout: 10_000 },
    );
    await page.goto("/review");
    const reviewResponse = await reviewResponsePromise;

    await expect(
      page.getByRole("heading", { name: /复习|review/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    expect(reviewResponse.ok()).toBeTruthy();

    const visibleQueueCount = page
      .locator(".review-queue-count:visible, .review-queue-trigger:visible strong")
      .first();
    await expect(visibleQueueCount).toBeVisible({ timeout: 10_000 });
    const loadedCount = Number.parseInt((await visibleQueueCount.textContent()) ?? "", 10);
    expect(loadedCount).toBeGreaterThanOrEqual(40);
    // 2026-08-11：v0.5 的"完成本轮"按钮已随 UI 删除——队列计数断言保留
    // （对 v0.6 仍有效），按钮断言移除。
  });
});

test.describe("RC data boundary — 100/1000 item pagination @boundary", () => {
  test("search handles large document set (1000 docs)", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/search");
    const firstPage = await searchFor(page, "Search Document");
    expect(firstPage.total).toBeGreaterThanOrEqual(1_000);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextOffset).toBe(50);

    const resultCards = page.locator(".search-result-card");
    await expect(resultCards).toHaveCount(50);

    const nextResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname.endsWith("/search")
        && url.searchParams.get("q") === "Search Document"
        && url.searchParams.get("offset") === "50";
    });
    await page.getByRole("button", { name: "加载更多结果" }).click();
    const nextResponse = await nextResponsePromise;
    expect(nextResponse.ok(), `search second page returned ${nextResponse.status()}`).toBeTruthy();
    const secondPage = await nextResponse.json() as SearchPayload;
    expect(secondPage.total).toBeGreaterThanOrEqual(firstPage.total);
    expect(secondPage.items).toHaveLength(50);
    expect(secondPage.nextOffset).toBe(100);
    await expect(resultCards).toHaveCount(100);
  });

  test("cards list renders with many items (100 cards)", async ({ authedPage }) => {
    const page = authedPage;

    const initialResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/cards"
        && !url.searchParams.has("cursor");
    });
    await page.goto("/cards");
    const initialResponse = await initialResponsePromise;
    expect(initialResponse.ok(), `cards first page returned ${initialResponse.status()}`).toBeTruthy();
    const firstPage = await initialResponse.json() as CursorPagePayload;
    expect(firstPage.total).toBeGreaterThanOrEqual(100);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();

    const cardItems = page.locator("a.cards-card, [data-ui='study-card']");
    await expect(cardItems).toHaveCount(50, { timeout: 10_000 });

    const nextResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/cards"
        && url.searchParams.has("cursor");
    });
    await page.getByRole("button", { name: "加载更早的学习卡" }).click();
    const nextResponse = await nextResponsePromise;
    expect(nextResponse.ok(), `cards second page returned ${nextResponse.status()}`).toBeTruthy();
    const secondPage = await nextResponse.json() as CursorPagePayload;
    expect(secondPage.total).toBeGreaterThanOrEqual(firstPage.total);
    expect(secondPage.items).toHaveLength(50);
    await expect(cardItems).toHaveCount(100, { timeout: 10_000 });
  });
});

/**
 * Responsive viewport tests (nightly only).
 *
 * Per ADR-0008 §6: "390 / 768 / 1440 视口、键盘、焦点、减少动画和控制台错误"
 * These tests verify key pages render correctly at mobile and tablet widths.
 * The playwright.config.ts already sets up projects for chromium-390 and
 * chromium-768 when E2E_PROFILE=nightly or rc.
 *
 * @nightly
 */
test.describe("Responsive layout — mobile and tablet @nightly", () => {
  test("today page renders at mobile width without horizontal scroll", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    // Check for horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // 5px tolerance
  });

  test("notes list renders at mobile width without horizontal scroll", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible({ timeout: 10_000 });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test("review page renders at mobile width without horizontal scroll", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/review");
    await expect(
      page.getByRole("heading", { name: /复习|review/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });

  test("sources page renders at mobile width without horizontal scroll", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/sources");
    await expect(page.locator(".sources-page")).toBeVisible({ timeout: 10_000 });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });
});
