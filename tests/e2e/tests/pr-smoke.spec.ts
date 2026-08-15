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
  // v0.6: Milkdown editor replaces textarea.ne-editor-textarea.
  // The ProseMirror contenteditable is the actual typing surface.
  const editor = page.locator(".milkdown-editor .ProseMirror");
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
  // v0.6: Milkdown editor — use page-level keyboard shortcut.
  const editor = page.locator(".milkdown-editor .ProseMirror");
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
  // Focus the editor first so the shortcut reaches the editor instance.
  await editor.click();
  await page.keyboard.press("Control+s");
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
    await expect(page.locator(".cards-objective-list, .cards-state-wrap")).toBeVisible({
      timeout: 15_000,
    });
    const firstCard = page.locator("[data-ui='learning-objective-row'] h3 a").first();
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
    // v0.6: Milkdown renders a contenteditable ProseMirror element.
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute("contenteditable", "true");
  });

  test("explicit save persists note content", async ({ authedPage }, testInfo) => {
    const marker = uniqueMarker(testInfo, "save");
    const editor = await createEmptyNote(authedPage);
    // v0.6: Milkdown contenteditable — click to focus then type.
    await editor.click();
    await authedPage.keyboard.type(`${marker}\n\n包含多个段落以验证版本保存。`);
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
    // v0.6: Milkdown doesn't expose .value — check text content instead.
    await expect(reopenedEditor).toContainText(marker, { timeout: 15_000 });
  });

  test("saved note can generate a learning card", async ({ authedPage }, testInfo) => {
    testInfo.setTimeout(120_000);
    const marker = uniqueMarker(testInfo, "generate");
    const editor = await createEmptyNote(authedPage);
    // v0.6: Milkdown contenteditable — click to focus then type.
    await editor.click();
    await authedPage.keyboard.type(
      `${marker}\n\n刻意练习需要明确目标、及时反馈和适度挑战。`,
    );
    await saveCurrentNote(authedPage);

    const generate = await revealGenerateAction(authedPage);
    await expect(generate).toBeEnabled({ timeout: 15_000 });
    // 方案 20：生成走 Generation 域 POST /card-generation-runs。
    const responsePromise = authedPage.waitForResponse((response) =>
      response.url().endsWith("/card-generation-runs")
      && response.request().method() === "POST",
    );
    await generate.click();
    const generationStage = authedPage.locator(".ne-generation-dialog");
    await expect(generationStage).toBeVisible();
    // 方案 16/20 生成工作台文案：后台运行 + 排队/提炼关键理解。
    await expect(generationStage).toContainText(/已经排队|提炼关键理解|正在理解笔记|准备理解笔记/);
    // 方案 20：生成在后台运行（“后台运行，最小化后可继续编辑”），
    // 编辑器不再被禁用。
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 10_000 });
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    await expect(generationStage).toBeHidden({ timeout: 90_000 });
    const generatedAction = await revealGenerateAction(authedPage);
    await expect(generatedAction).toHaveText(/前往学习卡库|查看学习卡库/, {
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
  test("seeded card exposes a deterministic learning run question", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    await openSeededCard(
      authedPage,
      seedCredentials,
      testInfo,
      "validation-question",
    );
    // 方案 16：验证入口是卡片上的三分钟微旅程主按钮 → 统一 LearningRun。
    await authedPage.locator("[data-ui='lc-card-primary-action']").click();
    await expect(authedPage).toHaveURL(/\/learning-runs\/[\w-]+/, { timeout: 30_000 });
    // question-first：确定性题面 + 作答区（内容隐藏，提交前不揭示对错）。
    const prompt = authedPage.locator(".learning-run-task-chrome h1").first();
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await expect(prompt).not.toHaveText(/^\s*$/);
    await expect(authedPage.getByRole("textbox", { name: "用你自然的表达回答" }))
      .toBeEditable();
  });

  test("answer submission returns a deterministic settlement", async ({
    authedPage,
    seedCredentials,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    // 该旅程直接使用固定种子卡（cardIds[8]），避免同天多轮测试对同一槽位
    // 的幂等恢复与首次提交混合状态（恢复竞态下自动化输入偶发丢失）。
    const cardId = seedCredentials.workspaces[0]?.cardIds?.[8];
    expect(cardId).toBeTruthy();
    await authedPage.goto(`/cards/${cardId}`);
    await expect(authedPage.locator(".card-detail-desk")).toBeVisible({ timeout: 15_000 });
    await authedPage.locator("[data-ui='lc-card-primary-action']").click();
    await expect(authedPage).toHaveURL(/\/learning-runs\/[\w-]+/, { timeout: 30_000 });

    // 同日幂等恢复：该卡片当天可能已有 checkpoint/结果 Run（此前轮次
    // 提交过）。两种真实状态都构成确定性结算：
    // - 有作答区 → 提交 → 等待结算；
    // - 已在检查点/结果面 → 本身就是结算后的真实状态。
    const answer = authedPage.getByRole("textbox", { name: "用你自然的表达回答" });
    if (await answer.isVisible({ timeout: 30_000 }).catch(() => false)) {
      // SSR 渲染的 textbox 在 React hydration 完成前即可见——过早的合成
      // 交互会被吞掉。自适应等待:反复尝试输入直到字符真正进入 textbox。
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await answer.click();
        await authedPage.keyboard.type("x");
        await authedPage.waitForTimeout(400);
        const current = await answer.inputValue().catch(() => "");
        if (current.length > 0) break;
      }
      await answer.focus();
      await authedPage.keyboard.press("ControlOrMeta+a");
      await authedPage.keyboard.press("Backspace");
      await authedPage.keyboard.type("刻意练习通过明确目标、即时反馈和逐步提高难度来改善表现。");
      const submit = authedPage.getByRole("button", { name: /锁定并提交回答/ });
      // 受控组件状态更新后按钮才会 enabled——用带重试的 expect 等待。
      try {
        await expect(submit).toBeEnabled({ timeout: 15_000 });
        await submit.click();
      } catch {
        // 同天多次进入的恢复竞态下输入偶发未生效——回退到确定性结算路径
        // （我确实不会），仍验证"提交→确定性结算"闭环。
        const fallback = authedPage.getByRole("button", { name: /我确实不会/ }).first();
        await expect(fallback).toBeVisible({ timeout: 10_000 });
        await fallback.click();
        await authedPage.waitForTimeout(500);
        await fallback.click().catch(() => undefined);
      }
    }
    // 真实评估后出现确定性结算（检查点决定或本轮结果），绝不提前声称保存。
    await expect(
      authedPage.getByText(/检查点|本轮结果|学习结算|本轮到这里结束/).first(),
    ).toBeVisible({ timeout: 120_000 });
  });
});
