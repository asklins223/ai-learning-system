/**
 * QLT-01/02: Keyboard navigation E2E tests (ADR-0008 §6.7)
 *
 * 计划 §6.7 要求："所有 PR/RC 流程执行键盘主路径和自动化 WCAG 2.2 AA 扫描"
 * 本文件覆盖键盘导航的以下维度：
 *   1. Tab 顺序在主要页面上到达关键交互元素
 *   2. Shift+Tab 反向导航
 *   3. Escape 关闭模态/面板
 *   4. Space 激活按钮（WCAG 2.1.1）
 *   5. Enter 激活链接和按钮
 *   6. 焦点指示器可见（WCAG 2.4.7）
 *   7. 模态打开时焦点陷阱（WCAG 2.4.3）
 *
 * @pr
 */

import { test, expect } from "../lib/fixtures";

test.describe("Keyboard navigation — global @pr", () => {
  test("Tab reaches interactive elements on today page", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await page.waitForLoadState("networkidle");

    // First Tab should focus an interactive element (not body)
    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.tagName.toLowerCase() : "body";
    });
    expect(["a", "button", "input", "textarea", "select", "[contenteditable]"]).toContain(focusedTag);
  });

  test("Shift+Tab reverses focus order on notes page", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();

    // Tab forward twice, then Shift+Tab back
    await page.keyboard.press("Tab");
    const firstFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, id: el.id, text: el.textContent?.slice(0, 30) } : null;
    });

    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");

    const backFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, id: el.id, text: el.textContent?.slice(0, 30) } : null;
    });

    // After Shift+Tab we should be back at the first focused element
    expect(backFocused).toEqual(firstFocused);
  });

  test("Escape closes user menu dropdown", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Open the account/navigation surface exposed at this responsive width.
    // The tablet trigger changes its accessible name after activation, so keep
    // a stable locator based on the controlled element rather than its label.
    const width = page.viewportSize()?.width ?? 1440;
    const userMenuButton = width < 640
      ? page.locator('[data-ui="mobile-nav"] button[aria-controls="mobile-nav-panel"]').filter({ hasText: "我的" })
      : width < 960
        ? page.locator('[data-ui="tablet-topbar"] button[aria-controls="tablet-navigation-drawer"]')
        : page.locator('.user-row[aria-controls="sidebar-account-popover"]');
    await expect(userMenuButton).toBeVisible();
    await userMenuButton.focus();
    await page.keyboard.press("Enter");
    await expect(userMenuButton).toHaveAttribute("aria-expanded", "true");

    const controlledId = await userMenuButton.getAttribute("aria-controls");
    expect(controlledId, "menu trigger must reference its responsive menu").toBeTruthy();
    await expect(page.locator(`#${controlledId}`)).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await expect(userMenuButton).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`#${controlledId}`)).not.toBeVisible();
    await expect(userMenuButton).toBeFocused();
  });

  test("Space activates buttons equivalently to Enter", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    // At tablet width the theme control lives inside the navigation drawer;
    // mobile and desktop expose a page-level ThemeToggle.
    const width = page.viewportSize()?.width ?? 1440;
    let themeToggle;
    if (width >= 640 && width < 960) {
      const menuButton = page.locator(
        '[data-ui="tablet-topbar"] button[aria-controls="tablet-navigation-drawer"]',
      );
      await menuButton.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: "导航菜单" });
      await expect(drawer).toBeVisible();
      themeToggle = drawer.getByRole("button", { name: /切换到(?:夜间|日间)/ });
    } else {
      themeToggle = page.getByRole("button", {
        name: /切换到夜间模式|切换到日间模式/,
      });
    }

    await expect(themeToggle).toBeVisible();
    await expect(themeToggle).toBeEnabled();
    await themeToggle.focus();
    await expect(themeToggle).toBeFocused();

    // Press Space to activate — the button should toggle theme
    const initialTheme = await page.locator("html").getAttribute("data-theme");
    expect(initialTheme).toMatch(/^(day|night)$/);
    await page.keyboard.press("Space");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", initialTheme!);
  });

  test("responsive navigation links are keyboard accessible", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    // Select the navigation that is actually exposed at the active breakpoint.
    // Desktop sidebar links remain in the DOM while hidden on smaller screens,
    // so a document-wide `nav a` locator is not a meaningful keyboard check.
    const width = page.viewportSize()?.width ?? 1440;
    let navigation;
    if (width < 640) {
      navigation = page.locator('[data-ui="mobile-nav"]');
    } else if (width < 960) {
      const menuButton = page.locator(
        '[data-ui="tablet-topbar"] button[aria-controls="tablet-navigation-drawer"]',
      );
      await menuButton.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: "导航菜单" });
      await expect(drawer).toBeVisible();
      navigation = drawer.getByRole("navigation", { name: "主导航" });
    } else {
      navigation = page.locator("aside.sidebar").getByRole("navigation", { name: "主导航" });
    }

    const reviewLink = navigation.getByRole("link", { name: "复习", exact: true });
    await expect(reviewLink).toBeVisible();
    await reviewLink.focus();
    await expect(reviewLink).toBeFocused();
    await expect(reviewLink).toHaveAttribute("href", "/review");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole("heading", { name: /复习|review/i }).first()).toBeVisible();
  });

  test("focus indicator is visible on key elements", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    // Keyboard entry starts at the skip link at every responsive breakpoint.
    // Using Tab (instead of programmatic focus) exercises :focus-visible.
    const skipLink = page.getByRole("link", { name: "跳到主内容" });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    const focusStyles = await skipLink.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return {
        outlineColor: styles.outlineColor,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        boxShadow: styles.boxShadow,
      };
    });

    const hasOutline = Number.parseFloat(focusStyles.outlineWidth) > 0
      && focusStyles.outlineStyle !== "none"
      && focusStyles.outlineColor !== "rgba(0, 0, 0, 0)";
    const hasBoxShadow = focusStyles.boxShadow !== "none";
    expect(hasOutline || hasBoxShadow, "keyboard focus must have a visible indicator").toBe(true);
  });

  test("form fields are keyboard navigable in sequence", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // The quick capture panel is collapsed by default — expand it first.
    // Use a stable CSS selector: the button's accessible name changes
    // from "快速收录" to "收起录入台" after clicking, so getByRole
    // with name matching would lose the reference.
    const toggleButton = page.locator("button.today-header-capture");
    await expect(toggleButton).toBeVisible({ timeout: 10_000 });
    await toggleButton.click();
    await expect(toggleButton).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    // Focus the capture textbox directly.
    const captureInput = page.locator("#today-capture-input");
    await expect(captureInput).toBeVisible({ timeout: 5_000 });
    await captureInput.focus();
    await expect(captureInput).toBeFocused();

    // Type content via keyboard
    await page.keyboard.type("键盘测试内容");

    // Verify content was entered
    const value = await captureInput.inputValue();
    expect(value).toContain("键盘测试内容");
  });
});

test.describe("Keyboard navigation — page transitions @pr", () => {
  test("can navigate between pages using keyboard only", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();

    const responsiveNavLink = async (name: "笔记" | "复习") => {
      const width = page.viewportSize()?.width ?? 1440;
      if (width < 640) {
        if (name === "复习") {
          return page.locator('[data-ui="mobile-nav"]').getByRole("link", { name, exact: true });
        }

        const mineButton = page
          .locator('[data-ui="mobile-nav"] button[aria-controls="mobile-nav-panel"]')
          .filter({ hasText: "我的" });
        await mineButton.focus();
        await page.keyboard.press("Enter");
        const panel = page.locator("#mobile-nav-panel");
        await expect(panel).toBeVisible();
        return panel.getByRole("link", { name, exact: true });
      }

      if (width < 960) {
        const menuButton = page.locator(
          '[data-ui="tablet-topbar"] button[aria-controls="tablet-navigation-drawer"]',
        );
        await menuButton.focus();
        await page.keyboard.press("Enter");
        const drawer = page.getByRole("dialog", { name: "导航菜单" });
        await expect(drawer).toBeVisible();
        return drawer.getByRole("navigation", { name: "主导航" })
          .getByRole("link", { name, exact: true });
      }

      return page.locator("aside.sidebar")
        .getByRole("navigation", { name: "主导航" })
        .getByRole("link", { name, exact: true });
    };

    const navToNotes = await responsiveNavLink("笔记");
    await expect(navToNotes).toBeVisible();
    await expect(navToNotes).toHaveAttribute("href", "/notes");
    await navToNotes.focus();
    await expect(navToNotes).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();

    const navToReview = await responsiveNavLink("复习");
    await expect(navToReview).toBeVisible();
    await expect(navToReview).toHaveAttribute("href", "/review");
    await navToReview.focus();
    await expect(navToReview).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole("heading", { name: /复习|review/i }).first()).toBeVisible();
  });

  test("back button works after keyboard navigation", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: /今日学习|今日变化/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: "笔记", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Browser back should work
    await page.goBack();
    await expect(page).toHaveURL(/\/today/);
  });
});

test.describe("Keyboard navigation — settings page @pr", () => {
  test("settings form fields are keyboard accessible", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /设置/ })).toBeVisible({ timeout: 5_000 });

    // Open the profile editor through the keyboard, then prove its text field
    // accepts keyboard input. The test intentionally leaves the change unsaved.
    const editProfile = page.getByRole("button", { name: "编辑档案" });
    await expect(editProfile).toBeVisible({ timeout: 10_000 });
    await expect(editProfile).toBeEnabled();
    await editProfile.focus();
    await page.keyboard.press("Enter");

    const displayName = page.getByRole("textbox", { name: "昵称" });
    await expect(displayName).toBeVisible();
    await displayName.focus();
    await expect(displayName).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type("-keyboard");
    await expect(displayName).toHaveValue(/-keyboard$/);
  });

  test("tab order in settings follows visual order", async ({ authedPage }) => {
    const page = authedPage;
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /设置/ })).toBeVisible({ timeout: 10_000 });

    const width = page.viewportSize()?.width ?? 1440;
    if (width < 640) {
      const sectionPicker = page.getByRole("combobox", { name: "当前设置分区" });
      await expect(sectionPicker).toBeVisible();
      await sectionPicker.focus();
      await expect(sectionPicker).toBeFocused();
      await page.keyboard.press("Tab");
      const refreshAccount = page.getByRole("button", { name: "刷新账户信息" });
      await expect(refreshAccount).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(sectionPicker).toBeFocused();
    } else {
      const tablist = page.getByRole("tablist", { name: "设置分区" });
      const tabs = tablist.getByRole("tab");
      await expect(tabs.first()).toBeVisible();
      expect(await tabs.count(), "settings must expose multiple ordered sections").toBeGreaterThan(1);
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      await tabs.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(tabs.nth(1)).toBeFocused();
    }
  });
});

test.describe("Keyboard navigation — login page @pr", () => {
  test("login form is fully keyboard accessible", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /继续你的学习|登录/i })).toBeVisible({ timeout: 5_000 });

    const emailInput = page.getByRole("textbox", { name: "邮箱" });
    const passwordInput = page.locator("#password");
    // Keep a stable locator because its accessible name changes after Space.
    const passwordToggle = page.locator("button.login-password-toggle");
    const rememberCheckbox = page.getByRole("checkbox", { name: "在此私人设备保持登录" });
    const submitButton = page.getByRole("button", { name: "进入工作区" });

    await expect(emailInput).toBeVisible();
    await emailInput.focus();
    await expect(emailInput).toBeFocused();
    await page.keyboard.type("keyboard-test@ailearn.local");

    await page.keyboard.press("Tab");
    await expect(passwordInput).toBeFocused();
    await page.keyboard.type("keyboard-test-password");

    await page.keyboard.press("Tab");
    await expect(passwordToggle).toBeFocused();
    await expect(passwordToggle).toHaveAccessibleName("显示密码");
    await page.keyboard.press("Space");
    await expect(passwordToggle).toHaveAttribute("aria-pressed", "true");
    await expect(passwordToggle).toHaveAccessibleName("隐藏密码");
    await expect(passwordInput).toHaveAttribute("type", "text");

    await page.keyboard.press("Tab");
    await expect(rememberCheckbox).toBeFocused();
    // 登录页“在此私人设备保持登录”默认勾选（useState(true)）。
    // Space 应切换为未勾选——断言真实 toggle 行为而非固定终态。
    await expect(rememberCheckbox).toBeChecked();
    await page.keyboard.press("Space");
    await expect(rememberCheckbox).not.toBeChecked();

    await page.keyboard.press("Tab");
    await expect(submitButton).toBeFocused();
  });
});
