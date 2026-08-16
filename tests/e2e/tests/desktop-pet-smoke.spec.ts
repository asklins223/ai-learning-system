import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

/**
 * Desktop Electron E2E smoke（方案 16 桌宠窗口）。
 *
 * 默认跳过；本地/CI 需要：
 *   DESKTOP_E2E=1
 *   ELECTRON_APP_PATH=<path to app main.js or electron entry>
 * 例如：
 *   DESKTOP_E2E=1 ELECTRON_APP_PATH=apps/desktop/dist/main.js \
 *     npx playwright test tests/e2e/tests/desktop-pet-smoke.spec.ts
 */
test.skip(!process.env.DESKTOP_E2E, "Desktop E2E requires DESKTOP_E2E=1");

test("desktop launches and renders companion pet surface @pr @desktop", async () => {
  const appPath = process.env.ELECTRON_APP_PATH;
  expect(appPath, "ELECTRON_APP_PATH is required for desktop E2E").toBeTruthy();

  const app: ElectronApplication = await electron.launch({
    args: [appPath!],
    env: {
      ...(process.env as Record<string, string>),
      // 测试环境不弹真实登录；至少验证 Pet 窗口/主窗口能创建。
      E2E_DESKTOP_SMOKE: "1",
    },
  });

  let petPage: Page | null = null;
  try {
    await app.firstWindow();
    // 等待 pet 窗口出现；Electron 可能用 BrowserWindow 加载 /companion/pet。
    const windows = app.windows();
    petPage = windows.find((w) => w.url().includes("/companion/pet")) ?? windows[0] ?? null;
    expect(petPage, "expected at least one desktop window").not.toBeNull();

    await petPage!.waitForLoadState("domcontentloaded");
    // 不依赖真实后端：只验证桌面窗口确实加载了应用页面。
    expect(petPage!.url()).toContain("http");
  } finally {
    await app.close().catch(() => {});
  }
});
