/**
 * v0.6 Playwright E2E Test Scaffold (计划 §10.4, §13.3 M4 Gate)
 *
 * This file defines the E2E test cases required by the M4 Gate.
 * To run these tests, install Playwright:
 *   npm install -D @playwright/test
 *   npx playwright install
 *
 * Then run:
 *   npx playwright test e2e/v06-focus-e2e.spec.ts
 *
 * Required M4 Gate E2E scenarios (计划 §13.3):
 * - card CTA → Focus → answer → feedback → next review
 * - review queue → resume attempt → answer → result → next item
 * - pre-submit 全部网络响应、RSC/hydration、预取缓存、DOM 无隐藏答案结构
 * - reveal source 后不升级，活跃会话内来源链接不能绕过 assistance
 * - session/source/result 的 private, no-store、无敏感 prefetch/Service Worker cache
 * - generation timeout/fallback/retry、evaluation timeout/retry、unable、abandon、stale
 * - unsafe deterministic fallback 展示不可重试 blocked
 * - Review 结果由用户显式进入下一条，后台完成不导航
 * - refresh/跨标签页/跨设备恢复
 * - 390/768/1440、软键盘、键盘、200% zoom、reduced motion、axe
 *
 * NOTE: This file uses Playwright-style imports but is structured as a scaffold.
 * It will not run until @playwright/test is installed.
 */

// Uncomment when Playwright is installed:
// import { test, expect, type Page, type Response } from "@playwright/test";
// import { AxeBuilder } from "@axe-core/playwright";

// ─── Sensitive fields that must NEVER appear in pre-reveal responses ──────

export const SENSITIVE_FIELDS = [
  "rubricItems",
  "expectedConcept",
  "evidenceId",
  "evidenceSnapshot",
  "sourceFingerprint",
  "exposureFingerprint",
  "claim",
  "quote",
  "quoteText",
  "blockContent",
  "noteTitle",
  "cardTitle",
  "feedback",
  "outcome",
  "userAnswer",
  "answerHash",
  "answerLockedAt",
  "assistanceSnapshotExposedAt",
  "validationEventId",
  "reviewAttemptId",
  "inputScheduleId",
  "generatorKind",
  "rubricVersion",
  "reducerVersion",
  "policyVersion",
  "noteVersionId",
  "artifactId",
  "generationJobId",
] as const;

// ─── Test scenarios ───────────────────────────────────────────────────────

export const E2E_SCENARIOS = {
  // 计划 §13.3: "card CTA → Focus → answer → feedback → next review"
  cardValidationFlow: {
    name: "Card CTA → Focus → answer → feedback → next review",
    steps: [
      "Navigate to /cards/[id]",
      "Click '开始验证' CTA",
      "Wait for Focus page to load",
      "Verify question is displayed without card title/claim/quote",
      "Type answer in textarea",
      "Press Cmd/Ctrl+Enter to submit",
      "Wait for evaluation to complete",
      "Click '揭示结果' to reveal feedback",
      "Verify feedback shows outcome, rubric items, evidence",
      "Verify next review date is displayed",
    ],
  },

  // 计划 §13.3: "review queue → resume attempt → answer → result → next item"
  reviewFlow: {
    name: "Review queue → resume attempt → answer → result → next item",
    steps: [
      "Navigate to /review",
      "Verify queue shows only neutral task items (no card title/claim)",
      "Click first review task",
      "Wait for Review Focus page to load",
      "Verify question is displayed without card title/claim/quote",
      "Type answer and submit",
      "Wait for evaluation to complete",
      "Reveal result",
      "Click '下一条' to go to next review",
      "Verify no auto-navigation occurred",
    ],
  },

  // 计划 §13.3: "pre-submit 全部网络响应、RSC/hydration、预取缓存、DOM 无隐藏答案结构"
  leakageDetection: {
    name: "Pre-submit leakage detection",
    steps: [
      "Navigate to /cards/[id]/validate",
      "Intercept ALL network responses",
      "Check each response body for SENSITIVE_FIELDS",
      "Check RSC payload (__NEXT_DATA__) for sensitive fields",
      "Check DOM for hidden elements containing sensitive data",
      "Check prefetch cache for sensitive data",
      "Assert zero leakage across all checks",
    ],
  },

  // 计划 §13.3: "reveal source 后不升级"
  sourceRevealNoUpgrade: {
    name: "Source reveal prevents upgrade",
    steps: [
      "Start validation session",
      "Click '查看原文' and confirm",
      "Verify assistance banner appears",
      "Submit answer",
      "Reveal result",
      "Verify understanding is NOT upgraded (due to assistance)",
      "Verify next review interval is not increased",
    ],
  },

  // 计划 §13.3: "generation timeout/fallback/retry"
  generationFailure: {
    name: "Question generation failure → retry",
    steps: [
      "Start session (mock provider to fail)",
      "Verify question_retryable state is shown",
      "Click '重试出题'",
      "Verify new job is created",
      "Verify question eventually appears",
    ],
  },

  // 计划 §13.3: "unsafe deterministic fallback 展示不可重试 blocked"
  unsafeFallback: {
    name: "Unsafe deterministic fallback → blocked",
    steps: [
      "Start session with mock that returns unsafe fallback",
      "Verify question_blocked state is shown",
      "Verify '题目暂不可用' message is displayed",
      "Verify no retry button is available",
      "Verify return navigation is available",
    ],
  },

  // 计划 §13.3: "refresh/跨标签页/跨设备恢复"
  crossTabRecovery: {
    name: "Cross-tab and refresh recovery",
    steps: [
      "Start session in tab 1",
      "Open same URL in tab 2",
      "Verify tab 2 resumes same session",
      "Type in tab 1, verify draft appears in tab 2 after refresh",
      "Close tab 1, refresh tab 2",
      "Verify session is still resumable",
    ],
  },
};

// ─── Viewport configurations (计划 §9.5) ──────────────────────────────────

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

// ─── Accessibility check configuration ────────────────────────────────────

export const A11Y_CONFIG = {
  // WCAG 2.2 AA — serious and critical violations must be 0
  rules: {
    "color-contrast": { enabled: true },
    "touch-target": { enabled: true },
    "focus-order-semantics": { enabled: true },
    "aria-required-attr": { enabled: true },
    "aria-valid-attr-value": { enabled: true },
    "button-name": { enabled: true },
    "label": { enabled: true },
    "region": { enabled: true },
  },
  // Only report serious and critical issues
  tags: ["wcag2a", "wcag2aa", "wcag22aa"],
};

// ─── Network response leakage checker ─────────────────────────────────────

export function checkResponseForLeakage(
  url: string,
  body: string,
): string[] {
  const leaks: string[] = [];
  for (const field of SENSITIVE_FIELDS) {
    if (body.includes(field)) {
      leaks.push(`${url}: contains "${field}"`);
    }
  }
  return leaks;
}

// ─── Cache-Control header checker ────────────────────────────────────────

export function checkCacheControlHeaders(
  url: string,
  headers: Record<string, string>,
): string[] {
  const issues: string[] = [];
  const cacheControl = headers["cache-control"] || "";

  // Session/source/result routes must use private, no-store
  const sensitiveRoutes = [
    "/validation-sessions/",
    "/validation-events/",
    "/reviews/",
  ];

  if (sensitiveRoutes.some((route) => url.includes(route))) {
    if (!cacheControl.includes("no-store")) {
      issues.push(`${url}: missing no-store in Cache-Control`);
    }
    if (!cacheControl.includes("private")) {
      issues.push(`${url}: missing private in Cache-Control`);
    }
  }

  return issues;
}

// ─── Summary ─────────────────────────────────────────────────────────────

export const M4_GATE_E2E_SUMMARY = {
  totalScenarios: Object.keys(E2E_SCENARIOS).length,
  totalViewports: Object.keys(VIEWPORTS).length,
  requiredPassRate: 1.0, // 100%
  description: "M4 Gate requires all E2E scenarios to pass at 100% across 3 viewports with WCAG 2.2 AA compliance",
};
