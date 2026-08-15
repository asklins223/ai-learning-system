import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../lib/fixtures";

type CreatedInvite = {
  token: string;
  tokenHint: string;
};

async function openInviteSettings(page: Page): Promise<void> {
  await page.goto("/settings#invites");
  await expect(
    page.getByRole("heading", { name: "邀请与成员管理" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "创建邀请" })).toBeVisible();
}

async function createInvite(page: Page): Promise<CreatedInvite> {
  await openInviteSettings(page);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/invites")
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "生成邀请", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const result = await response.json() as CreatedInvite;
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.tokenHint).toMatch(/^[a-f0-9]{8}$/);

  await expect(page.getByText(/邀请信息只显示一次/)).toBeVisible();
  await expect(page.locator("code.invite-result-code")).toHaveText(result.token);
  return result;
}

function inviteRow(page: Page, tokenHint: string) {
  return page.locator(".invite-table tbody tr").filter({ hasText: tokenHint });
}

function uniqueInviteeEmail(
  testInfo: TestInfo,
  runId: string,
  purpose: string,
): string {
  const project = testInfo.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const namespace = runId.replaceAll("-", "");
  return `e2e-${purpose}-${project}-${namespace}-${Date.now()}@e2e.test`;
}

async function registerInvitee(
  context: BrowserContext,
  token: string,
  email: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/register?token=${encodeURIComponent(token)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "建立个人学习账本" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("#inviteToken")).toHaveValue(token);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("TestPass123!");

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/register-v2")
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建账号并加入协作空间" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  await expect(
    page.getByRole("heading", {
      name: /今日学习|今日变化|走完第一条学习闭环|建立你的第一条学习记录/,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(
      ".learning-home-focus--loading, .learning-home-card-grid[aria-busy='true']",
    ),
  ).toHaveCount(0, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  return page;
}

test.describe("Invitation & member lifecycle @pr", () => {
  test("owner creates an invitation and the secret is displayed once", async ({
    authedPage,
    browserName,
  }) => {
    if (browserName === "chromium") {
      await authedPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    } else {
      // Firefox's Playwright backend does not support granting clipboard-read.
      // Install the smallest browser-local substitute before settings loads so
      // the UI contract is still exercised without weakening production code.
      await authedPage.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => undefined },
        });
      });
    }
    const invite = await createInvite(authedPage);

    const copy = authedPage.getByRole("button", { name: "复制邀请码" });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(authedPage.getByRole("button", { name: "已复制" })).toBeVisible();
    await expect(inviteRow(authedPage, invite.tokenHint)).toHaveCount(1);
  });

  test("new invitation appears as active", async ({ authedPage }) => {
    const invite = await createInvite(authedPage);
    const row = inviteRow(authedPage, invite.tokenHint);
    await expect(row).toHaveCount(1);
    await expect(row.locator(".invite-status-chip.status-active")).toHaveText("可用");
  });

  test("owner revokes the exact invitation it created", async ({ authedPage }) => {
    const invite = await createInvite(authedPage);
    const row = inviteRow(authedPage, invite.tokenHint);
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "撤销", exact: true }).click();
    await authedPage.getByRole("button", { name: "确认撤销" }).click();
    await expect(row.locator(".invite-status-chip.status-revoked")).toHaveText("已撤销", {
      timeout: 10_000,
    });
  });

  test("owner sees the seeded workspace member", async ({
    authedPage,
    seedCredentials,
  }) => {
    await openInviteSettings(authedPage);
    const memberEmail = seedCredentials.workspaces[0].memberEmail;
    expect(memberEmail).toBeTruthy();
    const memberRow = authedPage.locator(".member-table tbody tr").filter({
      hasText: memberEmail!,
    });
    await expect(memberRow).toHaveCount(1);
    await expect(memberRow.getByRole("button", { name: "移除", exact: true })).toBeVisible();
  });
});

test.describe("Invitee onboarding @pr", () => {
  test("valid invitation registers a user and records consumption", async ({
    authedPage,
    newMonitoredContext,
    seedCredentials,
  }, testInfo) => {
    const invite = await createInvite(authedPage);
    const email = uniqueInviteeEmail(testInfo, seedCredentials.runId, "join");
    const inviteeContext = await newMonitoredContext();
    await registerInvitee(inviteeContext, invite.token, email);
    await inviteeContext.close();

    await authedPage.reload();
    await expect(authedPage.getByRole("heading", { name: "工作区成员" })).toBeVisible({
      timeout: 20_000,
    });
    const row = inviteRow(authedPage, invite.tokenHint);
    await expect(row.locator(".invite-status-chip.status-consumed")).toHaveText("已使用");
    await expect(
      authedPage.locator(".member-table tbody tr").filter({ hasText: email }),
    ).toHaveCount(1);
  });

  test("owner removal revokes a newly registered member", async ({
    authedPage,
    newMonitoredContext,
    seedCredentials,
  }, testInfo) => {
    const invite = await createInvite(authedPage);
    const email = uniqueInviteeEmail(testInfo, seedCredentials.runId, "remove");
    const inviteeContext = await newMonitoredContext();
    await registerInvitee(inviteeContext, invite.token, email);
    await inviteeContext.close();

    await authedPage.reload();
    const memberRow = authedPage.locator(".member-table tbody tr").filter({ hasText: email });
    await expect(memberRow).toHaveCount(1, { timeout: 20_000 });
    await memberRow.getByRole("button", { name: "移除", exact: true }).click();
    await authedPage.getByRole("button", { name: "确认移除" }).click();
    await expect(memberRow).toHaveCount(0, { timeout: 10_000 });
  });
});
