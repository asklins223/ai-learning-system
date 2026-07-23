import type { Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  loginViaUI,
  type SeedCredentials,
} from "../lib/fixtures";

/**
 * PR-blocking browser journeys from ADR-0008 §6.
 *
 * Fixture data is a contract, not an optional convenience. A missing card,
 * evidence item, validation question, or responsive account action therefore
 * fails the gate instead of silently calling test.skip().
 */

async function openNoteEditor(page: Page): Promise<ReturnType<Page["locator"]>> {
  const editor = page.locator("textarea.ne-editor-textarea");
  if (!(await editor.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^(编辑|写作)$/ }).click();
  }
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The editor loads version history after it becomes visible. Let that
  // request settle so closing the test context cannot manufacture a Firefox
  // NS_BINDING_ABORTED failure after the user-visible assertion has passed.
  await page.waitForLoadState("networkidle");
  return editor;
}

function waitForNoteVersions(page: Page, noteId?: string) {
  return page.waitForResponse((response) => {
    if (response.request().method() !== "GET") return false;
    const pathname = new URL(response.url()).pathname;
    return noteId
      ? pathname === `/api/notes/${noteId}/versions`
      : /^\/api\/notes\/[\w-]+\/versions$/.test(pathname);
  });
}

async function createEmptyNote(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/notes");
  await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const versionsResponsePromise = waitForNoteVersions(page);
  await page.getByRole("button", { name: /新建笔记/ }).click();
  await expect(page).toHaveURL(/\/notes\/[\w-]+/);
  const editor = await openNoteEditor(page);
  const versionsResponse = await versionsResponsePromise;
  expect(versionsResponse.ok(), "initial version history must load").toBeTruthy();
  return editor;
}

function uniqueMarker(testInfo: TestInfo, purpose: string): string {
  return `E2E ${purpose} ${testInfo.project.name} worker-${testInfo.workerIndex} ${Date.now()}`;
}

async function saveCurrentNote(page: Page): Promise<void> {
  const editor = page.locator("textarea.ne-editor-textarea");
  const noteId = new URL(page.url()).pathname.split("/").at(-1);
  expect(noteId, "the note editor URL must contain a note id").toBeTruthy();

  // Compact layouts intentionally hide the header save button. Exercise the
  // editor's documented Ctrl+S shortcut instead, and wait for this note's
  // actual PATCH so an already-rendered "已保存" chip cannot produce a false
  // positive before React starts the save operation.
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/api/notes/${noteId}`),
  );
  const versionsResponsePromise = waitForNoteVersions(page, noteId);
  await editor.press("Control+s");
  const response = await responsePromise;
  expect(response.ok(), `explicit note save returned ${response.status()}`).toBeTruthy();
  const versionsResponse = await versionsResponsePromise;
  expect(versionsResponse.ok(), "saved version history must refresh").toBeTruthy();
  await expect(page.locator(".ne-save-live")).toContainText("已保存", {
    timeout: 20_000,
  });
}

async function revealGenerateAction(
  page: Page,
): Promise<ReturnType<Page["locator"]>> {
  const inlineAction = page
    .locator(".ne-header-generate:visible, .note-editor-generate-button:visible")
    .first();
  if (await inlineAction.isVisible().catch(() => false)) return inlineAction;

  // Phones intentionally collapse generation into the overflow menu.
  const moreActions = page.locator(".ne-more-actions");
  const summary = moreActions.locator(":scope > summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  if ((await moreActions.getAttribute("open")) === null) await summary.click();

  const menu = moreActions.locator(":scope > div");
  await expect(menu).toBeVisible();
  const action = menu
    .getByRole("button", {
      name: /^(生成学习卡|生成新版学习卡|生成中…|前往学习卡库)$/,
    })
    .first();
  await expect(action).toBeVisible();
  return action;
}

type SeedCardScenario =
  | "evidence-read"
  | "evidence-override"
  | "validation-question"
  | "validation-submit";

const SEED_CARD_SCENARIO_OFFSET: Record<SeedCardScenario, number> = {
  "evidence-read": 0,
  "evidence-override": 1,
  "validation-question": 2,
  "validation-submit": 3,
};

const SEED_CARD_PROJECT_OFFSET: Record<string, number> = {
  "chromium-1440-pr": 0,
  "chromium-1440": 0,
  "chromium-390": 1,
  "chromium-768": 2,
  "firefox-1440": 3,
};

function isolatedSeededCardId(
  credentials: SeedCredentials,
  testInfo: TestInfo,
  scenario: SeedCardScenario,
): string | undefined {
  const cardIds = credentials.workspaces[0].cardIds;
  if (!cardIds?.length) return undefined;

  const projectOffset = SEED_CARD_PROJECT_OFFSET[testInfo.project.name];
  if (projectOffset === undefined) {
    throw new Error(
      `PR smoke seed-card isolation has no slot for project ${testInfo.project.name}`,
    );
  }

  // Allocate from the tail so queue-oriented tests consuming the earliest due
  // schedules do not mutate the cards used by evidence/validation smoke tests.
  // Nightly/RC provide at least 51 cards (4 projects x 4 scenarios = 16).
  const distanceFromTail =
    projectOffset * Object.keys(SEED_CARD_SCENARIO_OFFSET).length
    + SEED_CARD_SCENARIO_OFFSET[scenario];
  const cardId = cardIds.at(-(distanceFromTail + 1));
  if (!cardId) {
    throw new Error(
      `Seed profile ${credentials.profile ?? "unknown"} supplied ${cardIds.length} cards; `
      + `${testInfo.project.name}/${scenario} requires at least ${distanceFromTail + 1}`,
    );
  }
  return cardId;
}

async function openSeededCard(
  page: Page,
  credentials: SeedCredentials,
  testInfo: TestInfo,
  scenario: SeedCardScenario,
): Promise<void> {
  const seededCardId = isolatedSeededCardId(credentials, testInfo, scenario);

  if (seededCardId) {
    await page.goto(`/cards/${seededCardId}`);
  } else {
    // Dev-credential fallback remains usable, but the card is still required.
    await page.goto("/cards");
    await expect(page.locator(".cards-grid, .cards-state-wrap")).toBeVisible({
      timeout: 15_000,
    });
    const firstCard = page.locator("a.cards-card, [data-ui='study-card']").first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    const href = await firstCard.getAttribute("href");
    expect(href, "seeded card must expose a detail link").toBeTruthy();
    await page.waitForLoadState("networkidle");
    await page.goto(href!);
  }

  await expect(page).toHaveURL(/\/cards\/[\w-]+/);
  await expect(page.locator(".card-detail-loading")).not.toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".card-detail-desk")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function openFirstEvidence(page: Page): Promise<void> {
  let evidenceCard = page.locator(".evidence-card-button:visible").first();
  if ((page.viewportSize()?.width ?? 1440) >= 1240) {
    await expect(evidenceCard).toBeVisible({ timeout: 15_000 });
  } else {
    // Compact mode keeps a duplicate header trigger in the DOM but hides it;
    // the visible, accessible action lives in the bottom action dock.
    const evidenceTrigger = page
      .getByRole("navigation", { name: "学习卡详情操作" })
      .getByRole("button", { name: /^证据线索/ });
    await expect(evidenceTrigger).toBeVisible({ timeout: 10_000 });
    await evidenceTrigger.click();
    await expect(page.locator(".card-detail-evidence-sheet")).toBeVisible();
    evidenceCard = page.locator(".card-detail-evidence-sheet .evidence-card-button").first();
  }

  await expect(evidenceCard).toBeVisible({ timeout: 15_000 });
  await evidenceCard.click();
  await expect(
    page.getByRole("dialog", { name: "这条理解由什么支持？" }),
  ).toBeVisible({ timeout: 10_000 });
}

async function revealValidationPanel(page: Page): Promise<void> {
  const panel = page.locator("[data-ui='validation-panel']");
  if ((page.viewportSize()?.width ?? 1440) < 1240) {
    const trigger = page.getByRole("button", { name: "验证理解", exact: true }).last();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
  }
  await expect(panel).toBeVisible({ timeout: 15_000 });
}

async function revealLogout(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width < 640) {
    await page.getByRole("button", { name: "我的", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "个人导航" })).toBeVisible();
  } else if (width < 960) {
    await page.getByRole("button", { name: "打开菜单" }).click();
    await expect(page.getByRole("dialog", { name: "导航菜单" })).toBeVisible();
  } else {
    await page.getByRole("button", { name: "用户菜单" }).click();
    await expect(page.getByRole("dialog", { name: "账户与工作区" })).toBeVisible();
  }

  const logout = page.getByRole("button", { name: "退出登录", exact: true });
  await expect(logout).toBeVisible();
  return logout;
}

test.describe("PR smoke: Login/logout & session restore @pr", () => {
  test("login page loads and meets the serious accessibility gate", async ({ page, a11yScan }) => {
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: /进入工作区|sign in|登录/i })).toBeVisible();
    await a11yScan.assert(page);
  });

  test("successful login reaches the workspace", async ({ page, seedCredentials }) => {
    const owner = seedCredentials.workspaces[0];
    await loginViaUI(page, owner.ownerEmail, owner.ownerPassword);
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("logout invalidates the session and returns to login", async ({ authedPage }) => {
    const logout = await revealLogout(authedPage);
    const responsePromise = authedPage.waitForResponse((response) =>
      response.url().endsWith("/api/auth/logout")
      && response.request().method() === "POST",
    );
    await logout.click();
    const response = await responsePromise;
    expect(response.status()).toBe(204);
    await expect(authedPage).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(authedPage.locator("#email")).toBeVisible();
  });

  test("session persists across a full page reload", async ({ authedPage }) => {
    await authedPage.goto("/notes");
    await expect(authedPage.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
    await authedPage.reload();
    await expect(authedPage.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: /新建笔记/ })).toBeVisible();
  });
});

test.describe("PR smoke: New note + save + generate card @pr", () => {
  test("owner can create a new editable note", async ({ authedPage }) => {
    const editor = await createEmptyNote(authedPage);
    await expect(editor).toBeEditable();
  });

  test("explicit save persists note content", async ({ authedPage }, testInfo) => {
    const marker = uniqueMarker(testInfo, "save");
    const editor = await createEmptyNote(authedPage);
    await editor.fill(`${marker}\n\n包含多个段落以验证版本保存。`);
    await saveCurrentNote(authedPage);
    const noteUrl = new URL(authedPage.url()).pathname;

    await authedPage.waitForLoadState("networkidle");
    const reopenedVersionsPromise = waitForNoteVersions(
      authedPage,
      noteUrl.split("/").at(-1),
    );
    await authedPage.goto(noteUrl);
    const reopenedEditor = await openNoteEditor(authedPage);
    const reopenedVersions = await reopenedVersionsPromise;
    expect(reopenedVersions.ok(), "reopened version history must load").toBeTruthy();
    await expect(reopenedEditor).toHaveValue(new RegExp(marker));
  });

  test("saved note can generate a learning card", async ({ authedPage }, testInfo) => {
    testInfo.setTimeout(120_000);
    const marker = uniqueMarker(testInfo, "generate");
    const editor = await createEmptyNote(authedPage);
    await editor.fill(
      `${marker}\n\n刻意练习需要明确目标、及时反馈和适度挑战。`,
    );
    await saveCurrentNote(authedPage);

    const generate = await revealGenerateAction(authedPage);
    await expect(generate).toBeEnabled({ timeout: 15_000 });
    const responsePromise = authedPage.waitForResponse((response) =>
      response.url().endsWith("/api/cards/generate")
      && response.request().method() === "POST",
    );
    await generate.click();
    const generationStage = authedPage.locator(".ne-generation-dialog");
    await expect(generationStage).toBeVisible();
    await expect(generationStage).toContainText(/正在锁定当前笔记版本|生成任务已进入队列|正在提炼关键理解/);
    await expect(editor).toBeDisabled();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    await expect(generationStage).toBeHidden({ timeout: 90_000 });
    const generatedAction = await revealGenerateAction(authedPage);
    await expect(generatedAction).toHaveText("前往学习卡库", {
      timeout: 90_000,
    });
  });
});

test.describe("PR smoke: Evidence review @pr", () => {
  test("seeded card exposes its aligned evidence", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    await openSeededCard(
      authedPage,
      seedCredentials,
      testInfo,
      "evidence-read",
    );
    await openFirstEvidence(authedPage);
    const dialog = authedPage.getByRole("dialog", { name: "这条理解由什么支持？" });
    await expect(dialog.locator("blockquote")).not.toBeEmpty();
    await expect(dialog.getByRole("button", { name: "确认引用" })).toBeVisible();
  });

  test("owner can record an evidence override", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    await openSeededCard(
      authedPage,
      seedCredentials,
      testInfo,
      "evidence-override",
    );
    await openFirstEvidence(authedPage);
    const dialog = authedPage.getByRole("dialog", { name: "这条理解由什么支持？" });
    const responsePromise = authedPage.waitForResponse((response) =>
      /\/api\/evidences\/[\w-]+\/override$/.test(response.url())
      && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "确认引用" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(dialog.getByText("已确认", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("PR smoke: Validation result @pr", () => {
  test("hard evidence exposes a deterministic validation question", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    await openSeededCard(
      authedPage,
      seedCredentials,
      testInfo,
      "validation-question",
    );
    await revealValidationPanel(authedPage);
    await expect(authedPage.getByRole("heading", { name: "验证理解" })).toBeVisible();
    await expect(authedPage.locator(".ref-validation-question-text")).not.toBeEmpty();
    await expect(authedPage.locator("#ref-validation-answer")).toBeEditable();
  });

  test("answer submission returns a validation result", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    await openSeededCard(
      authedPage,
      seedCredentials,
      testInfo,
      "validation-submit",
    );
    await revealValidationPanel(authedPage);
    const answer = authedPage.locator("#ref-validation-answer");
    await answer.fill("刻意练习通过明确目标、即时反馈和逐步提高难度来改善表现。");
    await authedPage.getByRole("button", { name: "提交回答" }).click();
    await expect(authedPage.locator('[aria-label="验证结果"]')).toBeVisible({
      timeout: 105_000,
    });
    await expect(authedPage.locator(".ref-validation-feedback-confidence")).toContainText("判定置信度");
  });
});
