import type { Locator, Page } from "@playwright/test";
import {
  test,
  expect,
  loginViaUI,
  type SeedCredentials,
} from "../lib/fixtures";

/**
 * E2E: Workspace switching and permission denial (ADR-0008 §6, QLT-01/02, SEC-01).
 *
 * The seed contract supplies two isolated workspaces. The primary owner only
 * belongs to workspace A, while the shared member belongs to A and B. That
 * lets these tests exercise real tenant and role boundaries without optional
 * UI branches or fabricated identifiers.
 *
 * @pr
 */

type CurrentUser = {
  workspaceId: string;
  workspaceName: string;
  role: string;
};

function fixtureWorkspaceName(
  credentials: SeedCredentials,
  index: number,
): string {
  const workspace = credentials.workspaces[index];
  if (workspace.name) return workspace.name;

  // Keep locally generated output from the immediately preceding fixture
  // contract readable while developers reseed. New seed output always carries
  // the explicit name field.
  const namespace = credentials.runId.replaceAll("-", "");
  return index === 0
    ? `Seed Workspace ${namespace}`
    : `Seed Workspace B ${namespace}`;
}

async function getCurrentUser(page: Page): Promise<CurrentUser> {
  const response = await page.request.get("/api/auth/me");
  expect(response.status()).toBe(200);
  return await response.json() as CurrentUser;
}

/** Reveal the responsive account surface that owns WorkspaceSwitcher. */
async function revealWorkspaceSwitcher(page: Page): Promise<Locator> {
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

  const switcher = page.locator(".workspace-switcher:visible");
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  return switcher;
}

test.describe("Workspace tenant boundaries @pr", () => {
  test("owner can access workspace settings", async ({ authedPage }) => {
    await authedPage.goto("/settings#workspaces");

    await expect(
      authedPage.getByRole("heading", { name: "工作区管理" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("foreign note is returned as an exact non-leaking 404", async ({
    authedPage,
    seedCredentials,
  }) => {
    expect(seedCredentials.workspaces).toHaveLength(2);
    const foreignNoteId = seedCredentials.workspaces[1].noteIds?.[0];
    expect(foreignNoteId).toBeTruthy();

    const response = await authedPage.request.get(`/api/notes/${foreignNoteId}`);
    const responseText = await response.text();

    expect(response.status()).toBe(404);
    // 2026-08-14：API 默认 404 响应统一为 { error: "not_found", message: "资源不存在" }
    // （server.ts setNotFoundHandler，不泄漏路由模板）。
    expect(JSON.parse(responseText)).toEqual({ error: "not_found", message: "资源不存在" });
    expect(responseText).not.toContain("Tenant B Private Note");
    expect(responseText).not.toContain("Private tenant B content");
  });

  test("single-workspace owner sees the current workspace without a switch action", async ({
    authedPage,
    seedCredentials,
  }) => {
    const workspaceName = fixtureWorkspaceName(seedCredentials, 0);
    const switcher = await revealWorkspaceSwitcher(authedPage);

    await expect(switcher).toHaveClass(/is-single/);
    await expect(switcher).toHaveAttribute("aria-label", "当前工作区");
    await expect(switcher.locator(".workspace-switcher-name")).toHaveText(workspaceName);
    await expect(switcher.locator(".workspace-switcher-trigger")).toHaveCount(0);
  });
});

test.describe("Workspace switching @pr", () => {
  test("shared member can switch to the other seeded workspace", async ({
    newMonitoredContext,
    seedCredentials,
  }) => {
    const primaryWorkspace = seedCredentials.workspaces[0];
    expect(primaryWorkspace.memberEmail).toBeTruthy();
    expect(primaryWorkspace.memberPassword).toBeTruthy();

    const context = await newMonitoredContext();
    const page = await context.newPage();
    await loginViaUI(
      page,
      primaryWorkspace.memberEmail!,
      primaryWorkspace.memberPassword!,
    );

    const before = await getCurrentUser(page);
    const targetIndex = seedCredentials.workspaces.findIndex(
      (workspace) => workspace.workspaceId !== before.workspaceId,
    );
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const target = seedCredentials.workspaces[targetIndex];
    expect(target.workspaceId).toBeTruthy();
    const targetName = fixtureWorkspaceName(seedCredentials, targetIndex);

    const switcher = await revealWorkspaceSwitcher(page);
    const trigger = switcher.locator(".workspace-switcher-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    const workspaceList = switcher.getByLabel("切换工作区");
    await expect(workspaceList).toBeVisible();
    const targetOption = workspaceList
      .locator(".workspace-switcher-option")
      .filter({ hasText: targetName });
    await expect(targetOption).toHaveCount(1);

    const switchResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/switch-workspace")
      && response.request().method() === "POST",
    );
    const refreshedIdentityPromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/me")
      && response.request().method() === "GET",
    );
    const reloadPromise = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
    });
    await targetOption.click();

    const switchResponse = await switchResponsePromise;
    expect(switchResponse.status()).toBe(200);
    await reloadPromise;
    const refreshedIdentity = await refreshedIdentityPromise;
    expect(refreshedIdentity.status()).toBe(200);
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible({
      timeout: 45_000,
    });

    await expect.poll(async () => (await getCurrentUser(page)).workspaceId).toBe(
      target.workspaceId,
    );
    const switchedUser = await getCurrentUser(page);
    expect(switchedUser.workspaceName).toBe(targetName);
    expect(switchedUser.role).toBe("member");

    const switchedWorkspace = await revealWorkspaceSwitcher(page);
    await expect(switchedWorkspace.locator(".workspace-switcher-name")).toHaveText(targetName);
    await page.waitForLoadState("networkidle");
  });
});

test.describe("Member vs owner privileges @pr", () => {
  test("member cannot see or call invite management", async ({
    newMonitoredContext,
    seedCredentials,
  }) => {
    const workspace = seedCredentials.workspaces[0];
    expect(workspace.memberEmail).toBeTruthy();
    expect(workspace.memberPassword).toBeTruthy();

    const context = await newMonitoredContext();
    const page = await context.newPage();
    await loginViaUI(page, workspace.memberEmail!, workspace.memberPassword!);
    await page.goto("/settings#invites");

    await expect(page.getByRole("heading", { name: "当前账户" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("tab", { name: /邀请与成员/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "创建邀请" })).toHaveCount(0);

    const csrfCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "ailearn_csrf",
    );
    expect(csrfCookie).toBeDefined();
    const response = await page.request.post("/api/invites", {
      headers: { "x-csrf-token": csrfCookie!.value },
      data: { role: "member", expiresInHours: 72 },
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "owner role required" });
  });

  test("owner sees the deterministic invitation entry point", async ({ authedPage }) => {
    await authedPage.goto("/settings#invites");

    await expect(
      authedPage.getByRole("heading", { name: "邀请与成员管理" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByRole("heading", { name: "创建邀请" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "生成邀请" })).toBeVisible();
  });
});
