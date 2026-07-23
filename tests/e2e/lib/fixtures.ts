import {
  test as base,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { readFileSync } from "fs";
import { attachErrorListenersToContext } from "./console-allowlist";
import { assertNoSeriousViolations, scanForAccessibility, type AccessibilityScanResult } from "./accessibility";

/**
 * Test fixture types per ADR-0008 and v0.5-fixture-contract.
 *
 * NOTE: This harness expects a running seed CLI (`seed --profile pr --run-id <uuid>`)
 * to provision workspaces and one-time credentials. The E2E_SEED_OUTPUT env var
 * points to a JSON file produced by the seed CLI.
 *
 * Until the seed CLI (QLT-01) is implemented, tests can use E2E_DEV_LOGIN
 * credentials for local development. CI must use the seed CLI path.
 *
 * Accessibility: The `a11yScan` fixture provides WCAG 2.2 AA scanning.
 * Serious/critical violations are blocking per ADR-0008 §6.
 */

export interface SeedCredentials {
  runId: string;
  /** Seed CLI 使用的 profile（pr/nightly/rc），决定数据规模 */
  profile?: "pr" | "nightly" | "rc";
  workspaces: Array<{
    name: string;
    slug: string;
    ownerEmail: string;
    ownerPassword: string;
    memberEmail?: string;
    memberPassword?: string;
    workspaceId?: string;
    noteIds?: string[];
    cardIds?: string[];
  }>;
}

function loadSeedCredentials(): SeedCredentials {
  const seedPath = process.env.E2E_SEED_OUTPUT;
  if (!seedPath) {
    if (process.env.CI) {
      throw new Error(
        "E2E_SEED_OUTPUT must be set in CI. Run seed CLI before E2E tests.",
      );
    }
    // Dev fallback: allow E2E_DEV_LOGIN env for local development
    const devEmail = process.env.E2E_DEV_EMAIL;
    const devPassword = process.env.E2E_DEV_PASSWORD;
    const devSlug = process.env.E2E_DEV_WORKSPACE_SLUG ?? "default";
    if (!devEmail || !devPassword) {
      throw new Error(
        "Either E2E_SEED_OUTPUT or (E2E_DEV_EMAIL + E2E_DEV_PASSWORD) must be set for E2E tests.",
      );
    }
    return {
      runId: "dev",
      workspaces: [
        {
          name: devSlug,
          slug: devSlug,
          ownerEmail: devEmail,
          ownerPassword: devPassword,
        },
      ],
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return JSON.parse(readFileSync(seedPath, "utf8")) as SeedCredentials;
}

/**
 * Perform login through the real UI flow (no API bypass).
 * Returns when the workspace dashboard is loaded.
 *
 * The login page has a "checkingSession" phase that shows
 * "正在准备登录页面" for up to 1.8s while verifying existing sessions.
 * We wait for the email input to appear, then fill, submit, and
 * race against both success (dashboard heading) and failure (error alert).
 */
export async function loginViaUI(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    // Wait for the session check to complete and the form to appear.
    // The page shows "正在准备登录页面" during session check; the #email
    // input is only rendered after checkingSession becomes false.
    // Timeout is 45s to accommodate slow dev server compilation under
    // parallel test load.
    await expect(page.locator("#email")).toBeVisible({ timeout: 45_000 });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: /进入工作区|sign in|登录/i }).click();

    // Login uses client-side router.replace("/"), so waitForURL can race.
    // We race the dashboard heading against the error alert to provide
    // a clear diagnostic when login fails instead of just timing out.
    // Timeout is 45s to accommodate slower API responses when multiple
    // parallel test workers log in simultaneously.
    const successLocator = page.getByRole("heading", { name: /今日学习|今日变化/ });
    const errorAlert = page.locator(".login-form-error");

    const result = await Promise.race([
      expect(successLocator).toBeVisible({ timeout: 45_000 }).then(() => "success"),
      expect(errorAlert).toBeVisible({ timeout: 45_000 }).then(() => "error"),
    ]).catch(() => "timeout" as const);

    if (result === "success") {
      // The heading renders before the dashboard Promise.all has settled.
      // Wait for both loading surfaces to disappear so a test navigation
      // cannot abort a legitimate home-data request and create a false pass.
      await expect(
        page.locator(
          ".learning-home-focus--loading, .learning-home-card-grid[aria-busy='true']",
        ),
      ).toHaveCount(0, { timeout: 45_000 });
      await page.waitForLoadState("networkidle");
      return;
    }

    // If login failed with a transient error, retry once after a short delay.
    // Common transient errors: "登录服务暂时不可用，请稍后重试。"
    if (result === "error" && attempt < maxAttempts) {
      const errorText = (await errorAlert.textContent()) ?? "";
      if (errorText.includes("暂时不可用") || errorText.includes("稍后重试")) {
        await page.waitForTimeout(2000);
        continue;
      }
    }

    if (result === "error") {
      const errorText = (await errorAlert.textContent()) ?? "unknown error";
      throw new Error(
        `Login failed for ${email}: ${errorText.trim()}. ` +
          "Check that the seed CLI created the user and the API can reach the database.",
      );
    }

    throw new Error(`Login timed out for ${email} after ${45_000 * attempt}ms`);
  }
}

/**
 * Accessibility scan function type.
 * Scans the current page state for WCAG 2.2 AA violations.
 * Throws on serious/critical violations.
 */
type A11yScan = {
  /** Assert no serious/critical violations on the current page state */
  assert: (page: Page) => Promise<void>;
  /** Scan and return the result without throwing */
  scan: (page: Page) => Promise<AccessibilityScanResult>;
};

/** Create an isolated browser context whose pages share the test error gate. */
type MonitoredContextFactory = (
  options?: BrowserContextOptions,
) => Promise<BrowserContext>;

/**
 * Extended test fixture with auth, error monitoring, and accessibility scanning.
 */
export const test = base.extend<
  {
    errors: string[];
    authedPage: Page;
    workspaceSlug: string;
    a11yScan: A11yScan;
    newMonitoredContext: MonitoredContextFactory;
    seedCredentials: SeedCredentials;
  }
>({
  errors: [
    async ({}, use) => {
      const errors: string[] = [];
      await use(errors);
      if (errors.length > 0) {
        throw new Error(
          `Global error listeners detected ${errors.length} issue(s):\n${errors.join("\n")}`,
        );
      }
    },
    { auto: true },
  ],
  context: async ({ context, errors }, use) => {
    const detach = attachErrorListenersToContext(context, (error) => {
      errors.push(error);
    });
    try {
      await use(context);
    } finally {
      detach();
    }
  },
  authedPage: async ({ page }, use) => {
    const creds = loadSeedCredentials();
    const ws = creds.workspaces[0];
    await loginViaUI(page, ws.ownerEmail, ws.ownerPassword);
    await use(page);
  },
  workspaceSlug: async ({}, use) => {
    const creds = loadSeedCredentials();
    await use(creds.workspaces[0].slug);
  },
  seedCredentials: async ({}, use) => {
    await use(loadSeedCredentials());
  },
  a11yScan: async ({}, use) => {
    const scanImpl: A11yScan = {
      assert: async (page: Page) => {
        await assertNoSeriousViolations(page);
      },
      scan: async (page: Page) => {
        return scanForAccessibility(page);
      },
    };
    await use(scanImpl);
  },
  newMonitoredContext: async ({ browser, errors }, use) => {
    const contexts: Array<{
      context: BrowserContext;
      detach: () => void;
    }> = [];

    await use(async (options) => {
      const context = await browser.newContext(options);
      const detach = attachErrorListenersToContext(context, (error) => {
        errors.push(error);
      });
      contexts.push({ context, detach });
      return context;
    });

    for (const { context, detach } of contexts.reverse()) {
      detach();
      await context.close().catch(() => undefined);
    }
  },
});

export { expect };
