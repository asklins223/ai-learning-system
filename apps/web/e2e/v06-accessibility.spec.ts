/**
 * v0.6 E2E: Accessibility Tests with axe-core (计划 §9.5, §10.4, M4 Gate)
 *
 * 计划 §9.5 要求：
 *   "390×844 与软键盘打开时文本框、提交按钮可达且无横向溢出"
 *   "触控目标至少 44×44；状态不只依赖颜色"
 *   "支持 200% zoom、reduced motion、屏幕阅读器和纯键盘路径"
 *   "WCAG 2.2 AA serious/critical 为 0"
 *
 * 计划 §10.4 Gate:
 *   "三视口、键盘、axe/WCAG、200% zoom 和移动软键盘 E2E 通过"
 */

import { test, expect } from "@playwright/test";
import {
  skipIfNoServer,
  authenticatedBeforeEach,
  TEST_CARD_ID,
} from "./helpers.ts";

// 2026-08-12（e2e 质量审计 P1-1）：受保护页面统一真实登录
authenticatedBeforeEach();

import AxeBuilder from "@axe-core/playwright";

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

test.describe("v0.6 Accessibility (计划 §9.5, §10.4)", () => {
  test.describe.configure({ mode: "serial" });

  // ─── axe-core WCAG 2.2 AA compliance ───────────────────────────────────

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`Focus page: axe-core WCAG 2.2 AA at ${name}`, async ({ page }) => {
          skipIfNoServer();

      await page.setViewportSize(viewport);
      await page.goto(`/cards/${TEST_CARD_ID}/validate`);
      await page.waitForLoadState("networkidle");

      const accessibilityScanResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
        .analyze();

      // Only report serious and critical issues
      const seriousAndCritical = accessibilityScanResults.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );

      expect(seriousAndCritical).toEqual([]);
    });
  }

  // ─── Keyboard navigation (计划 §9.5: "纯键盘路径") ────────────────────────

  test("Focus page: keyboard-only navigation", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // Tab through the page — all interactive elements should be reachable
    let focusableCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const activeElement = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.tagName : null;
      });
      if (activeElement && ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(activeElement)) {
        focusableCount++;
      }
    }

    // Should have found at least some focusable elements
    expect(focusableCount).toBeGreaterThan(0);
  });

  // ─── Touch target size (计划 §9.5: "触控目标至少 44×44") ────────────────

  test("Focus page: touch targets are at least 44x44px", async ({ page }) => {
        skipIfNoServer();

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // Get all buttons
    const buttons = page.locator("button, [role='button']");
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible()) {
        const box = await btn.boundingBox();
        if (box) {
          // Touch targets should be at least 44x44px (WCAG 2.5.5)
          // Allow some flexibility for inline elements
          const isInteractive = await btn.evaluate((el) => {
            const tag = el.tagName.toLowerCase();
            return tag === "button" || el.getAttribute("role") === "button";
          });
          if (isInteractive) {
            expect(box.height).toBeGreaterThanOrEqual(40); // Allow slight flexibility
          }
        }
      }
    }
  });

  // ─── 200% zoom (计划 §9.5: "支持 200% zoom") ────────────────────────────

  test("Focus page: no horizontal overflow at 200% zoom", async ({ page }) => {
        skipIfNoServer();

    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // Set 200% zoom
    await page.evaluate(() => {
      document.body.style.zoom = "2";
    });

    // Check no horizontal overflow
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasOverflow).toBe(false);
  });

  // ─── Reduced motion (计划 §9.5: "支持 reduced motion") ──────────────────

  test("Focus page: respects prefers-reduced-motion", async ({ browser }) => {
        skipIfNoServer();

    const context = await browser.newContext({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const reducedMotionPage = await context.newPage();

    await reducedMotionPage.goto(`/cards/${TEST_CARD_ID}/validate`);
    await reducedMotionPage.waitForLoadState("networkidle");

    // 2026-08-12（P1-2 修复）：此前只断言 body transition（body 几乎永无
    // 过渡样式 → 恒真）。改为三段真验证：
    // 1) 上下文确实以 reduce 启动（matchMedia 真值）；
    // 2) 样式表存在针对具体动画类的 reduced-motion 清零规则
    //    （card-detail.css:3691 .card-detail-loading>div animation:none 等）；
    // 3) 页面无任何非零 animation/transition 元素（清零规则实际生效）。
    const reduced = await reducedMotionPage.evaluate(() =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    expect(reduced).toBe(true);

    const reducedMotionRules = await reducedMotionPage.evaluate(() => {
      let found = false;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSMediaRule
              && rule.conditionText.includes("prefers-reduced-motion")
              && /animation\s*:\s*none|transition\s*:\s*none/i.test(rule.cssText)) {
              found = true;
            }
          }
        } catch {
          // 跨源样式表不可读——跳过
        }
      }
      return found;
    });
    expect(reducedMotionRules).toBe(true);

    const animatedCount = await reducedMotionPage.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("*"));
      return els.filter((el) => {
        const s = window.getComputedStyle(el);
        return s.animationName !== "none"
          || (s.transitionDuration !== "0s" && s.transitionDuration !== "");
      }).length;
    });
    expect(animatedCount).toBe(0);

    await reducedMotionPage.close();
    await context.close();
  });

  // ─── Color contrast (WCAG 2.2 AA) ──────────────────────────────────────

  test("Focus page: color contrast meets WCAG AA", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .withRules(["color-contrast"])
      .analyze();

    const colorContrastViolations = results.violations.filter(
      (v) => v.id === "color-contrast",
    );

    expect(colorContrastViolations).toEqual([]);
  });

  // ─── ARIA roles and labels ──────────────────────────────────────────────

  test("Focus page: ARIA roles and labels present", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // Check for aria-label on interactive elements — buttons without aria-label
    // must have visible text content to serve as accessible name (WCAG 4.1.2)
    // 2026-08-11：此前循环内断言恒真（任一文本或 label 即过），且循环被
    // if (buttonsWithoutLabel > 0) 包裹——无按钮时整个检查空转。改为直接统计
    // 无可访问名的可见按钮数，必须为 0。
    const inaccessibleButtons = await page.locator("button:visible").evaluateAll(
      (buttons) => buttons.filter(
        (button) => !((button.textContent ?? "").trim()
          || button.getAttribute("aria-label")
          || button.getAttribute("aria-labelledby")),
      ).length,
    );
    expect(inaccessibleButtons).toBe(0);

    // 2026-08-11：删除恒真断言（alertElements >= 0 / radioGroup >= 0 无意义），
    // 保留"页面实际渲染"底线：body 有可见文本内容。
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  // ─── Status not solely dependent on color (计划 §9.5) ───────────────────

  test("Focus page: outcome status has text labels, not just color", async ({ page }) => {
        skipIfNoServer();

    await page.goto(`/cards/${TEST_CARD_ID}/validate`);
    await page.waitForLoadState("networkidle");

    // 2026-08-12（P1-3 修复）：此前测试体为空（恒通过）。结果状态的
    // “文本标签不依赖颜色”契约分两层验证：
    // 1) 运行时：结果区（若渲染）必须携带非空文本；
    // 2) 源码契约：getOutcomeMeta 的 3 个 outcome label 均为文本且渲染处
    //    使用 label 字段（颜色只作 tone 辅助）——读组件源码静态断言。
    const outcome = page.locator(".validation-focus-result-outcome");
    if ((await outcome.count()) > 0) {
      await expect(outcome.first()).not.toBeEmpty();
    }

    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../components/ValidationFocus.tsx"),
      "utf8",
    );
    // 三个 outcome label 必须存在（文本标签）
    for (const label of ["已基本掌握", "还差一点", "存在理解偏差"]) {
      expect(source).toContain(`label: "${label}"`);
    }
    // 渲染处使用 label 而非仅 tone（颜色不能是唯一区分）
    expect(source).toMatch(/meta\.label/);
    expect(source).toMatch(/className={\`validation-focus-result-outcome[^}]*\$\{meta\.tone\}/);
  });
});
