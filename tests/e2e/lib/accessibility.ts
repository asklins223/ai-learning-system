import { type Page } from "@playwright/test";

/**
 * WCAG 2.2 AA accessibility scanning utility (ADR-0008 §6).
 *
 * Every PR and RC E2E run must execute automated accessibility scans.
 * Serious and critical violations are blocking — they must be 0.
 *
 * This module wraps @axe-core/playwright to provide:
 *   - scanForAccessibility(page): scan the current page state
 *   - scanForAccessibilityOnNavigation(page, url): navigate + scan
 *   - assertNoSeriousViolations(page): assertion helper for test fixtures
 *
 * Violation severity:
 *   - critical / serious: BLOCKING (test fails)
 *   - moderate / minor: reported but non-blocking (collected for trends)
 *
 * The scan uses WCAG 2.2 AA ruleset, which includes:
 *   - color contrast (AA thresholds)
 *   - keyboard navigation / focus management
 *   - ARIA validity
 *   - heading hierarchy
 *   - image alt text
 *   - form labels
 *   - landmark regions
 *   - tab order
 */

export interface AccessibilityViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical";
  description: string;
  help: string;
  helpUrl: string;
  nodes: number;
  targets: string[];
  failureSummaries: string[];
  pageUrl: string;
}

export interface AccessibilityScanResult {
  violations: AccessibilityViolation[];
  blockingViolations: AccessibilityViolation[];
  nonBlockingViolations: AccessibilityViolation[];
  passed: boolean;
  scannedUrl: string;
  scannedAt: string;
}

/** Impact levels that cause test failure */
const BLOCKING_IMPACT: AccessibilityViolation["impact"][] = ["serious", "critical"];

/**
 * Run an Axe accessibility scan on the current page state.
 *
 * Usage in tests:
 *   const result = await scanForAccessibility(page);
 *   expect(result.passed).toBe(true);
 *
 * Or use the assertion helper:
 *   await assertNoSeriousViolations(page);
 *
 * @param page - Playwright Page instance
 * @param tagFilter - Optional list of Axe rule tags (defaults to WCAG 2.2 AA)
 * @returns Scan result with violations categorized by severity
 */
export async function scanForAccessibility(
  page: Page,
  tagFilter: string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
): Promise<AccessibilityScanResult> {
  // Dynamic import to avoid hard dependency at module load time.
  // @axe-core/playwright must be installed as a devDependency.
  let AxeBuilder: typeof import("@axe-core/playwright").AxeBuilder;
  try {
    const mod = await import("@axe-core/playwright");
    AxeBuilder = mod.AxeBuilder;
  } catch (cause) {
    throw new Error(
      "[accessibility] 无法加载 @axe-core/playwright；可访问性门禁保持阻断。" +
        "请先运行 npm ci 并确认依赖完整。",
      { cause },
    );
  }

  const results = await new AxeBuilder({ page })
    .withTags(tagFilter)
    .analyze();

  const unknownImpactRules = results.violations
    .filter((violation) => violation.impact === null)
    .map((violation) => violation.id);
  if (unknownImpactRules.length > 0) {
    throw new Error(
      `[accessibility] Axe 未提供违规严重度，门禁保持阻断: ${unknownImpactRules.join(", ")}`,
    );
  }

  const violations: AccessibilityViolation[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact as AccessibilityViolation["impact"],
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.length,
    targets: v.nodes.map((node) => node.target.join(" ")),
    failureSummaries: v.nodes
      .map((node) => node.failureSummary?.trim() ?? "")
      .filter(Boolean),
    pageUrl: page.url(),
  }));

  const blockingViolations = violations.filter((v) =>
    BLOCKING_IMPACT.includes(v.impact),
  );
  const nonBlockingViolations = violations.filter(
    (v) => !BLOCKING_IMPACT.includes(v.impact),
  );

  return {
    violations,
    blockingViolations,
    nonBlockingViolations,
    passed: blockingViolations.length === 0,
    scannedUrl: page.url(),
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Navigate to a URL and scan for accessibility violations.
 *
 * @param page - Playwright Page instance
 * @param url - URL to navigate to before scanning
 * @returns Scan result
 */
export async function scanForAccessibilityOnNavigation(
  page: Page,
  url: string,
): Promise<AccessibilityScanResult> {
  await page.goto(url);
  // Wait for page to settle (network idle might be too aggressive;
  // use a short timeout to let dynamic content render)
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);
  return scanForAccessibility(page);
}

/**
 * Assert that the current page has no serious or critical accessibility violations.
 *
 * This is the primary assertion helper for E2E tests. It scans the current
 * page state and throws a descriptive error if any blocking violations exist.
 *
 * Usage:
 *   await assertNoSeriousViolations(page);
 *
 * @param page - Playwright Page instance
 * @throws Error with violation details if serious/critical violations exist
 */
export async function assertNoSeriousViolations(page: Page): Promise<void> {
  const result = await scanForAccessibility(page);

  if (!result.passed) {
    const details = result.blockingViolations
      .map((v) => {
        const nodeInfo = v.nodes > 1 ? ` (${v.nodes} occurrences)` : "";
        const targetInfo = v.targets.length > 0
          ? `\n    Targets: ${v.targets.join(", ")}`
          : "";
        const failureInfo = v.failureSummaries.length > 0
          ? `\n    ${v.failureSummaries.join("\n    ")}`
          : "";
        return `  [${v.impact}] ${v.id}: ${v.help}${nodeInfo}`
          + `\n    ${v.helpUrl}${targetInfo}${failureInfo}`;
      })
      .join("\n");

    throw new Error(
      `Accessibility scan found ${result.blockingViolations.length} blocking violation(s) ` +
        `on ${result.scannedUrl}:\n${details}\n\n` +
        `Non-blocking violations: ${result.nonBlockingViolations.length}`,
    );
  }

  // Log non-blocking violations for trend tracking (not test failures)
  if (result.nonBlockingViolations.length > 0) {
    console.log(
      `[accessibility] ${result.nonBlockingViolations.length} non-blocking violation(s) on ${result.scannedUrl}:`,
    );
    for (const v of result.nonBlockingViolations) {
      console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
    }
  }
}

/**
 * Format a scan result as a compact JSON string for CI artifact reporting.
 */
export function formatScanResultForReport(result: AccessibilityScanResult): string {
  return JSON.stringify(
    {
      scannedUrl: result.scannedUrl,
      scannedAt: result.scannedAt,
      passed: result.passed,
      totalViolations: result.violations.length,
      blockingCount: result.blockingViolations.length,
      nonBlockingCount: result.nonBlockingViolations.length,
      blockingViolations: result.blockingViolations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes,
        targets: v.targets,
      })),
      nonBlockingViolations: result.nonBlockingViolations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes,
        targets: v.targets,
      })),
    },
    null,
    2,
  );
}
