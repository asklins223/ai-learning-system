import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  aggregateCoverage,
  buildChangedLinesCoverage,
  coverageSummaryPath,
  evaluatePackageRun,
  evaluateRepositoryGates,
  parseChangedLines,
} from "./coverage-gate-lib.mjs";

function coveredFile(file, { lines = [100, 100], branches = [20, 20] } = {}) {
  return {
    file,
    metrics: {
      lines: { total: lines[0], covered: lines[1] },
      branches: { total: branches[0], covered: branches[1] },
      functions: { total: 1, covered: 1 },
    },
  };
}

const criticalFiles = [
  "apps/api/src/modules/identity/service.ts",
  "apps/api/src/db/client.ts",
  "apps/api/src/modules/job/service.ts",
  "workers/ai-worker/src/index.ts",
  "workers/ai-worker/src/lib/job-lease.ts",
  "workers/ai-worker/src/handlers/index.ts",
  "apps/api/src/modules/import/routes.ts",
  "apps/api/src/modules/export/service.ts",
].map((file) => coveredFile(file));

test("aggregateCoverage weights raw counters instead of averaging package percentages", () => {
  const coverage = aggregateCoverage([
    coveredFile("large.ts", { lines: [900, 630], branches: [90, 54] }),
    coveredFile("small.ts", { lines: [100, 100], branches: [10, 10] }),
  ]);

  assert.equal(coverage.linePct, 73);
  assert.equal(coverage.branchPct, 64);
  assert.deepEqual(coverage.metrics.lines, {
    total: 1000,
    covered: 730,
    skipped: 0,
    pct: 73,
  });
});

test("repository and every explicit critical group are evaluated independently", () => {
  const gates = evaluateRepositoryGates(criticalFiles, {
    changedLinesCoverage: {
      files: [coveredFile("changed.ts", { lines: [10, 8], branches: [0, 0] })],
    },
  });

  assert.equal(gates.repository.status, "pass");
  assert.deepEqual(
    gates.criticalModules.map(({ id, status, fileCount }) => ({ id, status, fileCount })),
    [
      { id: "identity", status: "pass", fileCount: 1 },
      { id: "tenant", status: "pass", fileCount: 1 },
      { id: "job-lease", status: "pass", fileCount: 4 },
      { id: "import-export", status: "pass", fileCount: 2 },
    ],
  );
  assert.equal(gates.changedLines.status, "pass");
  assert.equal(gates.thresholdsPassed, true);
});

test("missing critical source and unavailable changed-line mapping fail closed", () => {
  const gates = evaluateRepositoryGates(
    criticalFiles.filter((file) => !file.file.includes("/import/") && !file.file.includes("/export/")),
  );
  const importExport = gates.criticalModules.find((group) => group.id === "import-export");

  assert.equal(importExport.status, "no-coverage");
  assert.equal(importExport.fileCount, 0);
  assert.equal(importExport.passed, false);
  assert.equal(gates.changedLines.status, "not-evaluated");
  assert.equal(gates.changedLines.passed, false);
  assert.equal(gates.thresholdsPassed, false);
});

test("unavailable changed-line mapping can be skipped for local/report-only runs", () => {
  const gates = evaluateRepositoryGates(criticalFiles, { requireChangedLines: false });

  assert.equal(gates.changedLines.status, "skipped");
  assert.equal(gates.changedLines.passed, true);
  assert.equal(gates.changedLines.coverage, null);
  assert.equal(gates.thresholdsPassed, true);
});

test("a matched path with no executable lines cannot satisfy a threshold", () => {
  const gates = evaluateRepositoryGates([
    coveredFile("apps/api/src/modules/identity/types.ts", {
      lines: [0, 0],
      branches: [0, 0],
    }),
  ]);

  assert.equal(gates.repository.status, "no-coverage");
  assert.equal(gates.criticalModules[0].status, "no-coverage");
});

test("targeted summaries cannot replace the canonical repository summary", () => {
  const reportDir = join("outputs", "coverage");
  assert.equal(coverageSummaryPath(reportDir, null), join(reportDir, "summary.json"));
  assert.equal(
    coverageSummaryPath(reportDir, "apps/api"),
    join(reportDir, "apps-api.summary.json"),
  );
});

test("a package without discovered tests fails even when c8 produced a report", () => {
  assert.deepEqual(
    evaluatePackageRun({
      coverageAvailable: true,
      testFileCount: 0,
      testExitCode: 0,
      sourceInventoryMismatchCount: 0,
    }),
    { status: "no-tests", passed: false },
  );
});

test("a c8 report missing or adding source files fails the source inventory contract", () => {
  assert.deepEqual(
    evaluatePackageRun({
      coverageAvailable: true,
      testFileCount: 1,
      testExitCode: 0,
      sourceInventoryMismatchCount: 1,
    }),
    { status: "incomplete-coverage", passed: false },
  );
});

test("zero-context Git diffs produce exact new-side changed line numbers", () => {
  const changed = parseChangedLines([
    "diff --git apps/api/src/a.ts apps/api/src/a.ts",
    "--- apps/api/src/a.ts",
    "+++ apps/api/src/a.ts",
    "@@ -2,0 +3,2 @@",
    "+first",
    "+second",
    "@@ -9 +11 @@",
    "-old",
    "+new",
    "diff --git deleted.ts deleted.ts",
    "--- deleted.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
  ].join("\n"));

  assert.deepEqual([...changed.get("apps/api/src/a.ts")], [3, 4, 11]);
  assert.equal(changed.has("deleted.ts"), false);
});

test("changed-line coverage counts only executable Istanbul lines", () => {
  const changed = new Map([
    ["apps/api/src/a.ts", new Set([3, 4, 11])],
    ["packages/shared/src/types.ts", new Set([1, 2])],
  ]);
  const hits = new Map([
    ["apps/api/src/a.ts", new Map([[3, 1], [4, 0], [8, 10]])],
    ["packages/shared/src/types.ts", new Map()],
  ]);
  const result = buildChangedLinesCoverage(changed, hits);

  assert.equal(result.changedSourceLines, 5);
  assert.equal(result.executableChangedLines, 2);
  assert.deepEqual(result.files[0].metrics.lines, {
    total: 2,
    covered: 1,
    skipped: 0,
  });
});
