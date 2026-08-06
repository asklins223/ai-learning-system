/**
 * 卡组轮播 E2E（docs/plans/card-set-carousel-ui.md §9.2 硬门禁）。
 *
 * 通过 page.route 拦截 /api/card-sets**（含列表/详情/成员子路径），对 UI 做确定性测试：
 * - 轮播渲染/键盘切换/箭头切换
 * - 点击焦点封面 → 原地展开成员（不跳详情页，G-2 展开态禁用轮播切换）
 * - 收起后焦点归还封面按钮（G-2）
 * - G-1 reduced-motion 下成员 stagger delay 归零
 * - G-10 视图/筛选切换时 live region 说明数据口径差异
 * - G-7 轮播页 axe-core serious/critical 为 0
 * - 深链 ?set=&expand=1 自动展开
 * - 移动端展开走底部 Drawer（deck-member）
 *
 * 运行前提：目标 app 以 NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED=true 构建；
 * 未开启时用例自动 skip。
 */

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const CREATED = "2026-08-01T00:00:00.000Z";

const CARD_SETS = [
  {
    id: "set-00000000-0000-0000-0000-000000000001",
    workspaceId: "ws-00000000-0000-0000-0000-000000000001",
    noteId: "note-00000000-0000-0000-0000-000000000001",
    noteVersionId: "nv-00000000-0000-0000-0000-000000000001",
    generationRunId: "run-00000000-0000-0000-0000-000000000001",
    status: "active",
    title: "量子力学基础",
    summary: "波函数、观测与不确定性原理的入门梳理。",
    coverageReport: null,
    createdAt: CREATED,
    activatedAt: CREATED,
    supersededAt: null,
    cardCount: 4,
    sectionCardCount: 3,
    overviewCardId: "card-00000000-0000-0000-0000-000000000001",
  },
  {
    id: "set-00000000-0000-0000-0000-000000000002",
    workspaceId: "ws-00000000-0000-0000-0000-000000000001",
    noteId: "note-00000000-0000-0000-0000-000000000001",
    noteVersionId: "nv-00000000-0000-0000-0000-000000000002",
    generationRunId: "run-00000000-0000-0000-0000-000000000002",
    status: "superseded",
    title: "旧版量子力学",
    summary: "已被新版本替代的早期整理。",
    coverageReport: null,
    createdAt: CREATED,
    activatedAt: CREATED,
    supersededAt: CREATED,
    cardCount: 3,
    sectionCardCount: 2,
    overviewCardId: "card-00000000-0000-0000-0000-000000000011",
  },
  {
    id: "set-00000000-0000-0000-0000-000000000003",
    workspaceId: "ws-00000000-0000-0000-0000-000000000001",
    noteId: "note-00000000-0000-0000-0000-000000000002",
    noteVersionId: "nv-00000000-0000-0000-0000-000000000003",
    generationRunId: "run-00000000-0000-0000-0000-000000000003",
    status: "archived",
    title: "归档卡组",
    summary: "已归档的临时整理。",
    coverageReport: null,
    createdAt: CREATED,
    activatedAt: CREATED,
    supersededAt: null,
    cardCount: 2,
    sectionCardCount: 1,
    overviewCardId: "card-00000000-0000-0000-0000-000000000021",
  },
] as const;

function member(
  id: string,
  title: string,
  summary: string,
  scope: "overview" | "section",
  ordinal: number,
  status = "active",
  keyPoints = 2,
) {
  return {
    card: {
      id,
      noteVersionId: "nv-00000000-0000-0000-0000-000000000001",
      workspaceId: "ws-00000000-0000-0000-0000-000000000001",
      status,
      schemaJson: { title, summary },
      artifactId: null,
      createdAt: CREATED,
      cardSetId: "set-00000000-0000-0000-0000-000000000001",
      scope,
      ordinal,
    },
    keyPoints: Array.from({ length: keyPoints }, (_, i) => ({
      id: `${id}-kp-${i}`,
      cardId: id,
      ordinal: i,
      claim: `要点 ${i + 1}`,
      quoteText: null,
      segmentRef: null,
    })),
  };
}

const SET_A_MEMBERS = [
  member("card-00000000-0000-0000-0000-000000000001", "量子力学总览", "全篇脉络与关键结论。", "overview", 0, "active", 3),
  member("card-00000000-0000-0000-0000-000000000002", "波函数与概率幅", "波函数的统计诠释。", "section", 1, "active", 2),
  member("card-00000000-0000-0000-0000-000000000003", "不确定性原理", "位置与动量的对易关系。", "section", 2, "active", 2),
  member("card-00000000-0000-0000-0000-000000000004", "观测与坍缩", "测量导致波函数坍缩。", "section", 3, "active", 1),
];

const MEMBERS: Record<string, unknown[]> = {
  "set-00000000-0000-0000-0000-000000000001": SET_A_MEMBERS,
};

async function mockDeckApi(page: Page) {
  await mockDeckApiWith(page, {
    items: CARD_SETS,
    nextCursor: null,
    total: CARD_SETS.length,
  });
}

/**
 * 可参数化的 /api/card-sets mock：支持空库 / 分页 / 单请求失败，
 * 供 §6.1/§6.4/§6.5 边界用例使用。
 */
async function mockDeckApiWith(
  page: Page,
  options: {
    items?: readonly unknown[];
    nextCursor?: string | null;
    total?: number;
    members?: Record<string, unknown[]>;
    /** 列表请求失败一次后再成功（测重试）。 */
    failListOnce?: boolean;
    /** 分页第二页的卡组（cursor 命中时返回）。 */
    pageTwo?: readonly unknown[];
  },
) {
  const {
    items = CARD_SETS,
    nextCursor = null,
    total = items.length,
    members = MEMBERS,
    failListOnce = false,
    pageTwo = null,
  } = options;
  let listCalls = 0;

  await page.route("**/api/card-sets**", async (route) => {
    const url = new URL(route.request().url());
    const cardsMatch = url.pathname.match(/\/api\/card-sets\/([^/]+)\/cards$/);
    if (cardsMatch) {
      await route.fulfill({
        json: {
          cardSetId: cardsMatch[1],
          items: members[cardsMatch[1]] ?? [],
          nextCursor: null,
        },
      });
      return;
    }
    const setMatch = url.pathname.match(/\/api\/card-sets\/([^/]+)$/);
    if (setMatch) {
      const set = CARD_SETS.find((item) => item.id === setMatch[1]);
      if (set) {
        await route.fulfill({
          json: {
            cardSet: set,
            cards: members[setMatch[1]] ?? [],
            nextCursor: null,
          },
        });
      } else {
        await route.fulfill({ status: 404, json: { error: "not found" } });
      }
      return;
    }
    // 列表请求：支持 cursor 分页与单次失败重试
    listCalls += 1;
    if (failListOnce && listCalls === 1) {
      await route.fulfill({ status: 500, json: { error: "boom" } });
      return;
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor && pageTwo) {
      await route.fulfill({ json: { items: pageTwo, nextCursor: null, total } });
      return;
    }
    await route.fulfill({ json: { items, nextCursor, total } });
  });
}

async function gotoDeck(page: Page, path = "/cards") {
  await mockDeckApi(page);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("card set carousel (卡组轮播)", () => {
  test.describe.configure({ mode: "serial" });

  const cover = (page: Page) => page.locator('[data-ui="deck-cover"]');
  const carousel = (page: Page) => page.locator('[data-ui="card-set-carousel"]');
  const caption = (page: Page) => page.locator(".deck-carousel-caption");
  const expanded = (page: Page) => page.locator('[data-ui="deck-expanded"]');

  async function ensureDeckUi(page: Page) {
    await gotoDeck(page);
    if ((await carousel(page).count()) === 0) {
      test.skip(true, "NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED 未在目标 app 开启");
      return false;
    }
    return true;
  }

  test("轮播渲染：3 副封面、焦点题注、指示器", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await expect(carousel(page)).toBeVisible();
    await expect(cover(page)).toHaveCount(3);
    await expect(caption(page)).toContainText("卡组 1 / 已加载 3 组");
    // 焦点封面可展开（tabindex 0），侧翼只聚焦
    await expect(cover(page).nth(0)).toHaveAttribute("tabindex", "0");
    await expect(cover(page).nth(1)).toHaveAttribute("tabindex", "-1");
    await expect(page.locator('[data-ui="carousel-indicator"]')).toHaveCount(3);
  });

  test("键盘切换：→ 移动焦点、Home/End 跳首/末", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(caption(page)).toContainText("卡组 2 / 已加载 3 组");

    await page.keyboard.press("End");
    await expect(caption(page)).toContainText("卡组 3 / 已加载 3 组");
    await expect(page.locator('[data-ui="carousel-next"]')).toBeDisabled();

    await page.keyboard.press("Home");
    await expect(caption(page)).toContainText("卡组 1 / 已加载 3 组");
  });

  test("箭头切换：点击 next/prev 移动焦点", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await page.click('[data-ui="carousel-next"]');
    await expect(caption(page)).toContainText("卡组 2 / 已加载 3 组");
    await page.click('[data-ui="carousel-prev"]');
    await expect(caption(page)).toContainText("卡组 1 / 已加载 3 组");
  });

  test("展开：焦点封面点击后原地展开成员（不跳详情页）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    // 仍在 /cards，未跳详情页；URL 携带 ?set=&expand=1
    await expect(page).toHaveURL(/\/cards\?set=set-00000000-0000-0000-0000-000000000001&expand=1$/);
    // 总览卡全宽 + 3 张章节卡 = 4 张成员瓦片
    await expect(page.locator('[data-ui="deck-member-card"]')).toHaveCount(4);
    await expect(page.locator('[data-ui="deck-member-card"]').first()).toContainText("量子力学总览");
    await expect(page.locator('[data-ui="deck-collapse"]')).toBeFocused();
  });

  test("G-8: 展开态禁用轮播切换（←/→ 无效）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(expanded(page)).toBeVisible();
    await expect(page.locator('[data-ui="deck-member-card"]').first()).toContainText("量子力学总览");
  });

  test("G-2: 收起后焦点归还封面按钮", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    await page.click('[data-ui="deck-collapse"]');

    await expect(carousel(page)).toBeVisible();
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-ui"),
    );
    expect(active).toBe("deck-cover");
  });

  test("G-1: reduced-motion 下成员 stagger delay 归零", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    await expect(page.locator('[data-ui="deck-member-card"]')).toHaveCount(4);
    const delay = await page
      .locator('[data-ui="deck-member-card"]')
      .nth(1)
      .evaluate((el) => getComputedStyle(el).animationDelay);
    expect(delay).toBe("0s");
  });

  test("G-10: 筛选切换时 live region 播报口径", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await page.click('button.cards-filter-btn:has-text("已归档")');
    await expect(page.locator(".cards-live-region")).toContainText("已重置到第一组");
    // 分母口径：已加载内容中匹配 1 副卡组
    await expect(caption(page)).toContainText("已加载 1 组");
  });

  test("G-7: 轮播页 axe-core serious/critical 为 0", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    const violations = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(violations).toEqual([]);
  });

  test("深链：?set=&expand=1 自动展开目标卡组", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await gotoDeck(page, `/cards?set=${CARD_SETS[1].id}&expand=1`);
    if ((await carousel(page).count()) === 0) {
      test.skip(true, "NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED 未在目标 app 开启");
      return;
    }
    await expect(expanded(page)).toBeVisible();
    await expect(page.locator('[data-ui="deck-member-card"]')).toHaveCount(2);
  });

  test("移动端：展开走底部 Drawer（deck-member）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDeck(page);
    if ((await carousel(page).count()) === 0) {
      test.skip(true, "NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED 未在目标 app 开启");
      return;
    }
    await cover(page).first().click();
    await expect(page.locator('[data-ui="deck-member"]')).toBeVisible();
    await expect(page.locator(".deck-member-list li")).toHaveCount(4);
  });

  test("拖拽/滑动：向左拖焦点封面 → 下一副（§3.2）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    const box = await cover(page).first().boundingBox();
    expect(box).toBeTruthy();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 140, startY, { steps: 8 });
    await page.mouse.up();
    await expect(caption(page)).toContainText("卡组 2 / 已加载 3 组");
  });

  test("拖拽/滑动：向右拖（端点外）只回弹不切换", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    const box = await cover(page).first().boundingBox();
    expect(box).toBeTruthy();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 140, startY, { steps: 8 });
    await page.mouse.up();
    await expect(caption(page)).toContainText("卡组 1 / 已加载 3 组");
  });

  test("G-1: reduced-motion 下甩动不提交（只按位移阈值，§5.4）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (!(await ensureDeckUi(page))) return;

    const box = await cover(page).first().boundingBox();
    expect(box).toBeTruthy();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // 快速小位移（< 84px 阈值）：非 reduced-motion 会按速度提交，此处必须不提交
    await page.mouse.move(startX - 40, startY, { steps: 2 });
    await page.mouse.up();
    await expect(caption(page)).toContainText("卡组 1 / 已加载 3 组");
  });

  test("G-2: 浏览器后退收起后焦点归还封面按钮（§4.2 三路径等效）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    await page.goBack();
    await expect(carousel(page)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.getAttribute("data-ui")),
      )
      .toBe("deck-cover");
  });

  test("G-10: 搜索播报匹配数（§6.3）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await page.fill("#cards-search-input", "量子");
    await expect(page.locator(".cards-live-region")).toContainText("已重置到第一组");
    await expect(page.locator(".cards-live-region")).toContainText("匹配 2 副卡组");
  });

  test("G-7: 展开态 axe-core serious/critical 为 0", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    if (!(await ensureDeckUi(page))) return;

    await cover(page).first().click();
    await expect(expanded(page)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    const violations = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(violations).toEqual([]);
  });

  test("空卡组库：展示空态 CTA（§6.1）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await mockDeckApiWith(page, { items: [] });
    await page.goto("/cards");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".cards-state-card")).toContainText("还没有学习卡组");
  });

  test("加载更早：cursor 追加下一页卡组（§6.4）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    const pageTwo = CARD_SETS.map((set, i) => ({
      ...set,
      id: `set-page2-${i}`,
      title: `更早卡组 ${i + 1}`,
    }));
    await mockDeckApiWith(page, { nextCursor: "cursor-2", pageTwo });
    await page.goto("/cards");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-ui="carousel-load-more"]')).toBeVisible();
    await page.click('[data-ui="carousel-load-more"]');
    await expect(caption(page)).toContainText("已加载 6 组");
  });

  test("初始加载失败：错误态 + 重新加载可恢复（§6.1）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await mockDeckApiWith(page, { failListOnce: true });
    await page.goto("/cards");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".cards-state-card--error")).toContainText("暂时无法打开");
    await page.click('button:has-text("重新加载")');
    await expect(carousel(page)).toBeVisible();
    await expect(caption(page)).toContainText("已加载 3 组");
  });

  test("深链目标不在已加载页：清参 + 播报（§6.5）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    await gotoDeck(page, "/cards?set=nonexistent-set&expand=1");
    if ((await carousel(page).count()) === 0) {
      test.skip(true, "NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED 未在目标 app 开启");
      return;
    }
    await expect(page).toHaveURL(/\/cards$/);
    await expect(page.locator(".cards-live-region")).toContainText("不在当前加载结果");
  });

  test("cardCount=0 卡组：点击导航详情页而非展开（§6.5）", async ({ page }) => {
    test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set");
    const emptySet = {
      ...CARD_SETS[0],
      id: "set-00000000-0000-0000-0000-000000000099",
      title: "空卡组",
      cardCount: 0,
      sectionCardCount: 0,
      overviewCardId: null,
    };
    await mockDeckApiWith(page, { items: [emptySet, ...CARD_SETS.slice(1)] });
    await page.goto("/cards");
    await page.waitForLoadState("networkidle");
    await expect(cover(page).first()).toContainText("暂无卡片");
    await cover(page).first().click();
    await expect(page).toHaveURL(/\/card-sets\/set-00000000-0000-0000-0000-000000000099$/);
  });
});
