import { join } from "node:path";

export const REPOSITORY_THRESHOLD = Object.freeze({ lines: 70, branches: 60 });
export const CRITICAL_THRESHOLD = Object.freeze({ lines: 85, branches: 75 });
export const CHANGED_LINES_THRESHOLD = Object.freeze({ lines: 80 });

/**
 * Critical runtime modules named by the v0.5 release plan. Rules are
 * repository-relative and intentionally explicit: broad package-level
 * thresholds are not a substitute for measuring these paths directly.
 */
export const CRITICAL_MODULE_GROUPS = Object.freeze([
  Object.freeze({
    id: "identity",
    label: "identity",
    prefixes: Object.freeze(["apps/api/src/modules/identity/"]),
  }),
  Object.freeze({
    id: "tenant",
    label: "tenant isolation",
    files: Object.freeze([
      "apps/api/src/db/client.ts",
      "apps/api/src/modules/identity/middleware.ts",
      "workers/ai-worker/src/db.ts",
    ]),
  }),
  Object.freeze({
    id: "job-lease",
    label: "job + lease",
    files: Object.freeze([
      "workers/ai-worker/src/handlers/index.ts",
      "workers/ai-worker/src/index.ts",
      "workers/ai-worker/src/lib/job-lease.ts",
      "workers/ai-worker/src/lib/job-retry.ts",
      "workers/ai-worker/src/queue.ts",
    ]),
    prefixes: Object.freeze(["apps/api/src/modules/job/"]),
  }),
  Object.freeze({
    id: "evidence",
    label: "evidence",
    files: Object.freeze([
      "apps/api/src/lib/evidence.ts",
      "workers/ai-worker/src/handlers/index.ts",
      "workers/ai-worker/src/lib/align.ts",
    ]),
    prefixes: Object.freeze(["apps/api/src/modules/evidence/"]),
  }),
  Object.freeze({
    id: "validation-review",
    label: "validation + review",
    files: Object.freeze([
      "packages/shared/src/review-attempt.ts",
      "workers/ai-worker/src/handlers/index.ts",
    ]),
    prefixes: Object.freeze([
      "apps/api/src/modules/validation/",
      "apps/api/src/modules/review/",
    ]),
  }),
  Object.freeze({
    id: "import-export",
    label: "import + export",
    prefixes: Object.freeze([
      "apps/api/src/modules/import/",
      "apps/api/src/modules/export/",
    ]),
  }),
]);

function percentage(covered, total) {
  return total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100;
}

export function normalizeMetric(metric = {}) {
  const total = Number.isFinite(metric.total) ? metric.total : 0;
  const covered = Number.isFinite(metric.covered) ? metric.covered : 0;
  return {
    total,
    covered,
    skipped: Number.isFinite(metric.skipped) ? metric.skipped : 0,
    pct: percentage(covered, total),
  };
}

export function aggregateCoverage(files) {
  const counters = {
    lines: { total: 0, covered: 0, skipped: 0 },
    branches: { total: 0, covered: 0, skipped: 0 },
    functions: { total: 0, covered: 0, skipped: 0 },
  };

  for (const file of files) {
    for (const metricName of Object.keys(counters)) {
      const metric = normalizeMetric(file.metrics?.[metricName]);
      counters[metricName].total += metric.total;
      counters[metricName].covered += metric.covered;
      counters[metricName].skipped += metric.skipped;
    }
  }

  const lines = normalizeMetric(counters.lines);
  const branches = normalizeMetric(counters.branches);
  const functions = normalizeMetric(counters.functions);
  return {
    linePct: lines.pct,
    branchPct: branches.pct,
    funcPct: functions.pct,
    metrics: { lines, branches, functions },
  };
}

/** Parse the new-side line ranges from a zero-context unified Git diff. */
export function parseChangedLines(diffText) {
  const changedLines = new Map();
  let currentFile = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      currentFile = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (currentFile && !changedLines.has(currentFile)) {
        changedLines.set(currentFile, new Set());
      }
      continue;
    }
    if (!currentFile || !line.startsWith("@@")) continue;

    const match = line.match(/\+(\d+)(?:,(\d+))?\s/);
    if (!match) continue;
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    for (let offset = 0; offset < count; offset++) {
      changedLines.get(currentFile).add(start + offset);
    }
  }

  return changedLines;
}

/**
 * Intersect changed source lines with Istanbul's executable line map. Lines
 * containing only types, whitespace or comments are deliberately excluded,
 * matching standard line-coverage semantics.
 */
export function buildChangedLinesCoverage(changedLines, lineHitsByFile) {
  const files = [];
  let changedSourceLines = 0;
  let executableChangedLines = 0;

  for (const [file, lineNumbers] of changedLines) {
    changedSourceLines += lineNumbers.size;
    const lineHits = lineHitsByFile.get(file) ?? new Map();
    let total = 0;
    let covered = 0;
    for (const lineNumber of lineNumbers) {
      if (!lineHits.has(lineNumber)) continue;
      total++;
      if (lineHits.get(lineNumber) > 0) covered++;
    }
    executableChangedLines += total;
    if (total === 0) continue;

    files.push({
      file,
      metrics: {
        lines: { total, covered, skipped: 0 },
        branches: { total: 0, covered: 0, skipped: 0 },
        functions: { total: 0, covered: 0, skipped: 0 },
      },
    });
  }

  return { files, changedSourceLines, executableChangedLines };
}

export function matchesCriticalGroup(file, group) {
  const path = file.file.replaceAll("\\", "/");
  return (
    (group.files ?? []).includes(path) ||
    (group.prefixes ?? []).some((prefix) => path.startsWith(prefix))
  );
}

export function evaluateThreshold({ id, label, files, threshold }) {
  const coverage = aggregateCoverage(files);
  const hasSource = files.length > 0 && coverage.metrics.lines.total > 0;
  const linesPassed = hasSource && coverage.linePct >= threshold.lines;
  const branchesPassed =
    threshold.branches === undefined ||
    (hasSource && coverage.branchPct >= threshold.branches);
  const passed = linesPassed && branchesPassed;

  return {
    id,
    label,
    status: hasSource ? (passed ? "pass" : "fail") : "no-coverage",
    passed,
    fileCount: files.length,
    files: files.map((file) => file.file).sort(),
    coverage,
    thresholdValues: threshold,
  };
}

/**
 * Evaluate the canonical v0.5 gates from file-level Istanbul counters.
 * changedLinesCoverage must come from a base/head-aware line map. A missing
 * input is reported and fails closed instead of being silently treated as a
 * pass or approximated from whole-file coverage.
 */
export function evaluateRepositoryGates(files, { changedLinesCoverage = null } = {}) {
  const repository = evaluateThreshold({
    id: "repository",
    label: "all production source",
    files,
    threshold: REPOSITORY_THRESHOLD,
  });

  const criticalModules = CRITICAL_MODULE_GROUPS.map((group) =>
    evaluateThreshold({
      id: group.id,
      label: group.label,
      files: files.filter((file) => matchesCriticalGroup(file, group)),
      threshold: CRITICAL_THRESHOLD,
    }),
  );

  const changedLines = changedLinesCoverage
    ? {
        ...evaluateThreshold({
          id: "changed-lines",
          label: "changed lines",
          files: changedLinesCoverage.files ?? [],
          threshold: CHANGED_LINES_THRESHOLD,
        }),
        base: changedLinesCoverage.base ?? null,
        head: changedLinesCoverage.head ?? null,
        changedSourceLines: changedLinesCoverage.changedSourceLines ?? 0,
        executableChangedLines: changedLinesCoverage.executableChangedLines ?? 0,
      }
    : {
        id: "changed-lines",
        label: "changed lines",
        status: "not-evaluated",
        passed: false,
        fileCount: 0,
        files: [],
        coverage: null,
        thresholdValues: CHANGED_LINES_THRESHOLD,
        reason:
          "A reliable base/head-aware changed-line coverage map is not configured; the release gate fails closed.",
      };

  const gateResults = [repository, ...criticalModules, changedLines];
  return {
    repository,
    criticalModules,
    changedLines,
    gateResults,
    passed: gateResults.filter((gate) => gate.passed).length,
    failed: gateResults.filter((gate) => !gate.passed).length,
    thresholdsPassed: gateResults.every((gate) => gate.passed),
  };
}

export function coverageSummaryPath(reportDir, targetPackage) {
  return targetPackage
    ? join(reportDir, `${targetPackage.replaceAll("/", "-")}.summary.json`)
    : join(reportDir, "summary.json");
}

export function evaluatePackageRun({
  coverageAvailable,
  testFileCount,
  testExitCode,
  sourceInventoryMismatchCount,
}) {
  if (!coverageAvailable) return { status: "no-coverage", passed: false };
  if (testFileCount === 0) return { status: "no-tests", passed: false };
  if (testExitCode !== 0) return { status: "test-fail", passed: false };
  if (sourceInventoryMismatchCount > 0) {
    return { status: "incomplete-coverage", passed: false };
  }
  return { status: "pass", passed: true };
}
