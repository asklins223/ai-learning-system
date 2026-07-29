import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for v0.6 E2E tests (计划 §13.3, M4 Gate)
 *
 * Test scenarios (计划 §13.3):
 * - card CTA → Focus → answer → feedback → next review
 * - review queue → resume attempt → answer → result → next item
 * - pre-submit leakage detection
 * - reveal source prevents upgrade
 * - session/source/result Cache-Control: private, no-store
 * - generation timeout/fallback/retry, evaluation retry, unable, abandon, stale
 * - unsafe deterministic fallback → blocked
 * - refresh/cross-tab recovery
 * - 390/768/1440 viewports, keyboard, 200% zoom, reduced motion, axe
 *
 * Run: npx playwright test
 * UI mode: npx playwright test --ui
 */

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // v0.6 tests need sequential execution for state isolation
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for state isolation
  reporter: [
    ["html", { outputFolder: "playwright-report" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-390",
      use: { ...devices["iPhone 12"] },
    },
    {
      name: "tablet-768",
      use: { viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1440",
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
