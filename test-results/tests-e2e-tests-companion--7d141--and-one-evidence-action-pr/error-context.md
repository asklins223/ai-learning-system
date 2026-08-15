# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/tests/companion-session-journey.spec.ts >> authenticated consolidation practice journeys >> learning card keeps exactly one primary practice action and one evidence action @pr
- Location: tests/e2e/tests/companion-session-journey.spec.ts:89:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/login", waiting until "domcontentloaded"

```

# Test source

```ts
  1   | import {
  2   |   test as base,
  3   |   expect,
  4   |   type BrowserContext,
  5   |   type BrowserContextOptions,
  6   |   type Page,
  7   | } from "@playwright/test";
  8   | import { readFileSync } from "fs";
  9   | import { attachErrorListenersToContext } from "./console-allowlist";
  10  | import { assertNoSeriousViolations, scanForAccessibility, type AccessibilityScanResult } from "./accessibility";
  11  | 
  12  | /**
  13  |  * Test fixture types per ADR-0008 and v0.5-fixture-contract.
  14  |  *
  15  |  * NOTE: This harness expects a running seed CLI (`seed --profile pr --run-id <uuid>`)
  16  |  * to provision workspaces and one-time credentials. The E2E_SEED_OUTPUT env var
  17  |  * points to a JSON file produced by the seed CLI.
  18  |  *
  19  |  * Until the seed CLI (QLT-01) is implemented, tests can use E2E_DEV_LOGIN
  20  |  * credentials for local development. CI must use the seed CLI path.
  21  |  *
  22  |  * Accessibility: The `a11yScan` fixture provides WCAG 2.2 AA scanning.
  23  |  * Serious/critical violations are blocking per ADR-0008 §6.
  24  |  */
  25  | 
  26  | export interface SeedCredentials {
  27  |   runId: string;
  28  |   /** Seed CLI 使用的 profile（pr/nightly/rc），决定数据规模 */
  29  |   profile?: "pr" | "nightly" | "rc";
  30  |   workspaces: Array<{
  31  |     name: string;
  32  |     slug: string;
  33  |     ownerEmail: string;
  34  |     ownerPassword: string;
  35  |     memberEmail?: string;
  36  |     memberPassword?: string;
  37  |     workspaceId?: string;
  38  |     noteIds?: string[];
  39  |     cardIds?: string[];
  40  |   }>;
  41  | }
  42  | 
  43  | function loadSeedCredentials(): SeedCredentials {
  44  |   const seedPath = process.env.E2E_SEED_OUTPUT;
  45  |   if (!seedPath) {
  46  |     if (process.env.CI) {
  47  |       throw new Error(
  48  |         "E2E_SEED_OUTPUT must be set in CI. Run seed CLI before E2E tests.",
  49  |       );
  50  |     }
  51  |     // Dev fallback: allow E2E_DEV_LOGIN env for local development
  52  |     const devEmail = process.env.E2E_DEV_EMAIL;
  53  |     const devPassword = process.env.E2E_DEV_PASSWORD;
  54  |     const devSlug = process.env.E2E_DEV_WORKSPACE_SLUG ?? "default";
  55  |     if (!devEmail || !devPassword) {
  56  |       throw new Error(
  57  |         "Either E2E_SEED_OUTPUT or (E2E_DEV_EMAIL + E2E_DEV_PASSWORD) must be set for E2E tests.",
  58  |       );
  59  |     }
  60  |     return {
  61  |       runId: "dev",
  62  |       workspaces: [
  63  |         {
  64  |           name: devSlug,
  65  |           slug: devSlug,
  66  |           ownerEmail: devEmail,
  67  |           ownerPassword: devPassword,
  68  |         },
  69  |       ],
  70  |     };
  71  |   }
  72  |   // eslint-disable-next-line @typescript-eslint/no-require-imports
  73  |   return JSON.parse(readFileSync(seedPath, "utf8")) as SeedCredentials;
  74  | }
  75  | 
  76  | /**
  77  |  * Perform login through the real UI flow (no API bypass).
  78  |  * Returns when the workspace dashboard is loaded.
  79  |  *
  80  |  * The login page has a "checkingSession" phase that shows
  81  |  * "正在准备登录页面" for up to 1.8s while verifying existing sessions.
  82  |  * We wait for the email input to appear, then fill, submit, and
  83  |  * race against both success (dashboard heading) and failure (error alert).
  84  |  */
  85  | export async function loginViaUI(
  86  |   page: Page,
  87  |   email: string,
  88  |   password: string,
  89  | ): Promise<void> {
  90  |   const maxAttempts = 2;
  91  |   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
> 92  |     await page.goto("/login", { waitUntil: "domcontentloaded" });
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  93  |     // Wait for the session check to complete and the form to appear.
  94  |     // The page shows "正在准备登录页面" during session check; the #email
  95  |     // input is only rendered after checkingSession becomes false.
  96  |     // Timeout is 45s to accommodate slow dev server compilation under
  97  |     // parallel test load.
  98  |     await expect(page.locator("#email")).toBeVisible({ timeout: 45_000 });
  99  |     await page.locator("#email").fill(email);
  100 |     await page.locator("#password").fill(password);
  101 |     await page.getByRole("button", { name: /进入工作区|sign in|登录/i }).click();
  102 | 
  103 |     // Login uses client-side router.replace("/"), so waitForURL can race.
  104 |     // We race the dashboard heading against the error alert to provide
  105 |     // a clear diagnostic when login fails instead of just timing out.
  106 |     // Timeout is 45s to accommodate slower API responses when multiple
  107 |     // parallel test workers log in simultaneously.
  108 |     const successLocator = page.getByRole("heading", { name: /今日学习|今日变化/ });
  109 |     const errorAlert = page.locator(".login-form-error");
  110 | 
  111 |     const result = await Promise.race([
  112 |       expect(successLocator).toBeVisible({ timeout: 45_000 }).then(() => "success"),
  113 |       expect(errorAlert).toBeVisible({ timeout: 45_000 }).then(() => "error"),
  114 |     ]).catch(() => "timeout" as const);
  115 | 
  116 |     if (result === "success") {
  117 |       // The heading renders before the dashboard Promise.all has settled.
  118 |       // Wait for both loading surfaces to disappear so a test navigation
  119 |       // cannot abort a legitimate home-data request and create a false pass.
  120 |       await expect(
  121 |         page.locator(
  122 |           ".learning-home-focus--loading, .learning-home-card-grid[aria-busy='true']",
  123 |         ),
  124 |       ).toHaveCount(0, { timeout: 45_000 });
  125 |       await page.waitForLoadState("networkidle");
  126 |       return;
  127 |     }
  128 | 
  129 |     // If login failed with a transient error, retry once after a short delay.
  130 |     // Common transient errors: "登录服务暂时不可用，请稍后重试。"
  131 |     if (result === "error" && attempt < maxAttempts) {
  132 |       const errorText = (await errorAlert.textContent()) ?? "";
  133 |       if (errorText.includes("暂时不可用") || errorText.includes("稍后重试")) {
  134 |         await page.waitForTimeout(2000);
  135 |         continue;
  136 |       }
  137 |     }
  138 | 
  139 |     if (result === "error") {
  140 |       const errorText = (await errorAlert.textContent()) ?? "unknown error";
  141 |       throw new Error(
  142 |         `Login failed for ${email}: ${errorText.trim()}. ` +
  143 |           "Check that the seed CLI created the user and the API can reach the database.",
  144 |       );
  145 |     }
  146 | 
  147 |     throw new Error(`Login timed out for ${email} after ${45_000 * attempt}ms`);
  148 |   }
  149 | }
  150 | 
  151 | /**
  152 |  * Accessibility scan function type.
  153 |  * Scans the current page state for WCAG 2.2 AA violations.
  154 |  * Throws on serious/critical violations.
  155 |  */
  156 | type A11yScan = {
  157 |   /** Assert no serious/critical violations on the current page state */
  158 |   assert: (page: Page) => Promise<void>;
  159 |   /** Scan and return the result without throwing */
  160 |   scan: (page: Page) => Promise<AccessibilityScanResult>;
  161 | };
  162 | 
  163 | /** Create an isolated browser context whose pages share the test error gate. */
  164 | type MonitoredContextFactory = (
  165 |   options?: BrowserContextOptions,
  166 | ) => Promise<BrowserContext>;
  167 | 
  168 | /**
  169 |  * Extended test fixture with auth, error monitoring, and accessibility scanning.
  170 |  */
  171 | export const test = base.extend<
  172 |   {
  173 |     errors: string[];
  174 |     authedPage: Page;
  175 |     workspaceSlug: string;
  176 |     a11yScan: A11yScan;
  177 |     newMonitoredContext: MonitoredContextFactory;
  178 |     seedCredentials: SeedCredentials;
  179 |   }
  180 | >({
  181 |   errors: [
  182 |     async ({}, use) => {
  183 |       const errors: string[] = [];
  184 |       await use(errors);
  185 |       if (errors.length > 0) {
  186 |         throw new Error(
  187 |           `Global error listeners detected ${errors.length} issue(s):\n${errors.join("\n")}`,
  188 |         );
  189 |       }
  190 |     },
  191 |     { auto: true },
  192 |   ],
```