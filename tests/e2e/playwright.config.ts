import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration per ADR-0008.
 *
 * Profiles:
 * - PR smoke (default): Chromium 1440, @pr-tagged journeys only.
 * - Nightly: Chromium 390/768/1440 + Firefox 1440, @nightly + @pr journeys.
 * - RC: full matrix + 51/100/1000 boundary fixtures.
 *
 * Global hooks enforce:
 * - pageerror / unhandled rejection / request-failed are never allowlisted.
 * - console.warn/error only allowed via precise allowlist with expiry.
 */
const isNightly = process.env.E2E_PROFILE === "nightly";
const isRC = process.env.E2E_PROFILE === "rc";
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const projects: Parameters<typeof defineConfig>[0]["projects"] = [];

if (!isNightly && !isRC) {
  projects.push({
    name: "chromium-1440-pr",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    grep: /@pr/,
  });
}

if (isNightly || isRC) {
  projects.push(
    {
      name: "chromium-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      grep: /@(pr|nightly)/,
    },
    {
      name: "chromium-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
      grep: /@(pr|nightly)/,
    },
    {
      name: "chromium-768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
      grep: /@(pr|nightly)/,
    },
    {
      name: "firefox-1440",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } },
      grep: /@(pr|nightly)/,
    },
  );
}

if (isRC) {
  // RC 启用边界数据测试项目：
  // - 使用 @boundary 标签标记的测试在 RC profile 下运行
  // - 这些测试验证 51/100/1000 条数据的分页、搜索和列表性能
  // - seed CLI 在 RC profile 下创建 100 条卡片 + 1000 条搜索文档
  projects.push({
    name: "chromium-1440-boundary",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    grep: /@boundary/,
    // 边界测试需要更长超时，因为数据量大
    timeout: 120_000,
  });
}

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Local dev: limit to 2 workers to avoid overwhelming the Next.js dev
  // server which compiles pages on-demand. CI already uses 1 worker.
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/junit.xml" }],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects,
});
