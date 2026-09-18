#!/usr/bin/env node
/**
 * QLT-01/02: 覆盖率收集与阈值门禁脚本
 *
 * 功能：
 *   1. 对每个包运行 c8，并将该包全部生产源码纳入分母
 *   2. 解析文件级覆盖率计数并聚合全仓报告
 *   3. 按阈值规则检查（阈值定义见 coverage-gate-lib.mjs，支持按关键模块差异化）
 *   4. 生成机器可读 JSON 报告
 *
 * 用法：
 *   node .github/scripts/coverage-gate.mjs                    # 运行所有包
 *   node .github/scripts/coverage-gate.mjs --package apps/api # 只运行指定包
 *   node .github/scripts/coverage-gate.mjs --report-only      # 只生成报告，不阻断
 *
 * 退出码：
 *   0 — 门禁达标，或使用 --report-only 完成诊断
 *   1 — 非 report-only 模式下测试/覆盖率门禁失败
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import {
  aggregateCoverage,
  buildChangedLinesCoverage,
  coverageSummaryPath,
  evaluatePackageRun,
  evaluateRepositoryGates,
  normalizeMetric,
  parseChangedLines,
} from "./coverage-gate-lib.mjs";

// ─── 包配置 ─────────────────────────────────────────────────────────────

/** 包定义：测试发现目录，以及必须进入全仓分母的生产源码。 */
const PACKAGES = [
  {
    path: "packages/shared",
    testDir: "src",
    sourceDirs: ["src"],
    sourceIncludes: ["src/**/*.ts", "src/**/*.tsx"],
  },
  {
    path: "packages/ai-quality",
    testDir: "src",
    sourceDirs: ["src"],
    sourceIncludes: ["src/**/*.ts", "src/**/*.tsx"],
  },
  {
    path: "apps/api",
    testDir: "src",
    sourceDirs: ["src"],
    sourceIncludes: ["src/**/*.ts", "src/**/*.tsx"],
  },
  {
    path: "workers/ai-worker",
    testDir: "src",
    sourceDirs: ["src"],
    sourceIncludes: ["src/**/*.ts", "src/**/*.tsx"],
  },
];

// ─── 参数解析 ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetPackage = null;
let reportOnly = false;
let changedBase = process.env.COVERAGE_BASE_SHA || null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--package") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("[coverage] --package 需要一个包路径");
      process.exit(2);
    }
    targetPackage = args[i + 1];
    i++;
  } else if (args[i] === "--report-only") {
    reportOnly = true;
  } else if (args[i] === "--changed-base") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("[coverage] --changed-base 需要一个 Git commit SHA");
      process.exit(2);
    }
    changedBase = args[i + 1];
    i++;
  } else {
    console.error(`[coverage] 未知参数: ${args[i]}`);
    process.exit(2);
  }
}

if (changedBase && !/^[0-9a-f]{7,40}$/i.test(changedBase)) {
  console.error("[coverage] changed-lines 基线必须是 7-40 位十六进制 commit SHA");
  process.exit(2);
}

if (targetPackage && !PACKAGES.some((pkg) => pkg.path === targetPackage)) {
  console.error(
    `[coverage] 未知包: ${targetPackage}；可选值: ${PACKAGES.map((pkg) => pkg.path).join(", ")}`,
  );
  process.exit(2);
}

// ─── 覆盖率解析 ─────────────────────────────────────────────────────────

function readCoverageSummary(summaryPath, repoRoot) {
  if (!existsSync(summaryPath)) return null;

  const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (!raw.total) return null;

  const files = Object.entries(raw)
    .filter(([file]) => file !== "total")
    .map(([file, rawMetrics]) => {
      const metrics = {
        lines: normalizeMetric(rawMetrics.lines),
        branches: normalizeMetric(rawMetrics.branches),
        functions: normalizeMetric(rawMetrics.functions),
      };
      return {
        file: relative(repoRoot, file).replaceAll("\\", "/"),
        linePct: metrics.lines.pct,
        branchPct: metrics.branches.pct,
        funcPct: metrics.functions.pct,
        metrics,
      };
    })
    .filter((entry) => !entry.file.includes(".test.") && !entry.file.includes("/__tests__/"));

  return { ...aggregateCoverage(files), files };
}

function discoverFiles(cwd, directories) {
  const files = [];

  function visit(relativeDirectory) {
    const entries = readdirSync(resolve(cwd, relativeDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath.replaceAll("\\", "/"));
      }
    }
  }

  for (const directory of directories) visit(directory);
  return files.sort();
}

function discoverTestFiles(cwd, testDir) {
  return discoverFiles(cwd, [testDir]).filter((file) => /\.test\.tsx?$/.test(file));
}

function discoverProductionSourceFiles(cwd, sourceDirs) {
  return discoverFiles(cwd, sourceDirs)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !/\.d\.ts$/.test(file))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => !/\.integration\.tsx?$/.test(file))
    .filter((file) => !file.includes("/__tests__/"))
    .filter((file) => !file.includes("/integration-tests/"));
}

function getGitCommit(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function readLineHits(coveragePath, repoRoot) {
  if (!existsSync(coveragePath)) return null;
  const raw = JSON.parse(readFileSync(coveragePath, "utf8"));
  const lineHitsByFile = new Map();

  for (const [absolutePath, fileCoverage] of Object.entries(raw)) {
    const file = relative(repoRoot, absolutePath).replaceAll("\\", "/");
    const lineHits = new Map();
    for (const [statementId, location] of Object.entries(fileCoverage.statementMap ?? {})) {
      const line = location?.start?.line;
      const hits = fileCoverage.s?.[statementId];
      if (!Number.isInteger(line) || !Number.isFinite(hits)) continue;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }
    lineHitsByFile.set(file, lineHits);
  }
  return lineHitsByFile;
}

function collectChangedLinesCoverage(repoRoot, base, head, files, lineHitsByFile) {
  if (!base) return null;

  let resolvedBase;
  try {
    resolvedBase = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", resolvedBase, head], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`changed-lines 基线 ${base} 不存在或不是 HEAD 的祖先`);
  }

  const productionFiles = files.map((file) => file.file);
  const diff = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--no-prefix",
      "--find-renames",
      "--diff-filter=ACMR",
      `${resolvedBase}...${head}`,
      "--",
      ...productionFiles,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  return {
    base: resolvedBase,
    head,
    ...buildChangedLinesCoverage(parseChangedLines(diff), lineHitsByFile),
  };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────

const repoRoot = resolve(import.meta.dirname, "..", "..");
const reportDir = join(repoRoot, "outputs", "coverage");
mkdirSync(reportDir, { recursive: true });
const gitCommit = getGitCommit(repoRoot);

const packagesToRun = targetPackage
  ? PACKAGES.filter((p) => p.path === targetPackage)
  : PACKAGES;

const results = [];
const allLineHitsByFile = new Map();
let executionFailed = false;
const c8Bin = join(repoRoot, "node_modules", ".bin", "c8");

if (!existsSync(c8Bin)) {
  console.error("[coverage] 缺少 c8；请先在仓库根目录运行 npm ci");
  process.exit(1);
}

for (const pkg of packagesToRun) {
  console.log(`[coverage] 运行 ${pkg.path}...`);

  const cwd = join(repoRoot, pkg.path);
  const testFiles = discoverTestFiles(cwd, pkg.testDir);
  const productionSourceFiles = discoverProductionSourceFiles(cwd, pkg.sourceDirs);
  if (testFiles.length === 0) {
    console.log(`[coverage] ${pkg.path}: 无测试文件（门禁失败）；仍以 0 命中收集全部生产源码`);
  }
  const packageSlug = pkg.path.replace(/\//g, "-");
  const rawReportDir = join(reportDir, "raw", packageSlug);
  const summaryFile = join(rawReportDir, "coverage-summary.json");
  const detailedCoverageFile = join(rawReportDir, "coverage-final.json");
  const pkgReportPath = join(reportDir, `${packageSlug}.coverage.json`);
  rmSync(rawReportDir, { recursive: true, force: true });
  rmSync(pkgReportPath, { force: true });

  let output;
  let testExitCode = 0;
  try {
    output = execFileSync(
      c8Bin,
      [
        "--all",
        "--extension=.ts",
        "--extension=.tsx",
        ...pkg.sourceIncludes.map((pattern) => `--include=${pattern}`),
        "--exclude=**/*.test.ts",
        "--exclude=**/*.test.tsx",
        "--exclude=**/__tests__/**",
        // Integration harnesses live under src so they can share package
        // imports, but they are test code rather than production code. Counting
        // their unexecuted source in the denominator understates runtime
        // coverage and makes the report depend on filename conventions.
        "--exclude=**/integration-tests/**",
        "--exclude=**/*.integration.ts",
        "--exclude=**/*.integration.tsx",
        "--exclude=**/*.d.ts",
        "--reporter=json-summary",
        "--reporter=json",
        "--reporter=text",
        `--reports-dir=${rawReportDir}`,
        "node",
        ...(testFiles.length > 0
          ? ["--import", "tsx", "--test", ...testFiles]
          : ["--eval", ""]),
      ],
      { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (err) {
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    testExitCode = Number.isInteger(err.status) ? err.status : 1;
  }

  if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  const coverage = readCoverageSummary(summaryFile, repoRoot);
  const packageLineHits = readLineHits(detailedCoverageFile, repoRoot);

  if (!coverage || !packageLineHits) {
    console.log(`[coverage] ${pkg.path}: 无法解析覆盖率报告`);
    results.push({
      package: pkg.path,
      status: "no-coverage",
      testExitCode,
      testFileCount: testFiles.length,
      sourceCounts: {
        expected: productionSourceFiles.length,
        reported: 0,
        missing: productionSourceFiles.map((file) => `${pkg.path}/${file}`),
        unexpected: [],
      },
    });
    executionFailed = true;
    continue;
  }

  for (const [file, lineHits] of packageLineHits) {
    allLineHitsByFile.set(file, lineHits);
  }

  const expectedSourcePaths = productionSourceFiles.map((file) => `${pkg.path}/${file}`);
  const reportedSourcePaths = new Set(coverage.files.map((file) => file.file));
  const missingSourceFiles = expectedSourcePaths.filter((file) => !reportedSourcePaths.has(file));
  const expectedSourcePathSet = new Set(expectedSourcePaths);
  const unexpectedSourceFiles = coverage.files
    .map((file) => file.file)
    .filter((file) => !expectedSourcePathSet.has(file));
  const hasTests = testFiles.length > 0;
  const { passed, status } = evaluatePackageRun({
    coverageAvailable: true,
    testFileCount: testFiles.length,
    testExitCode,
    sourceInventoryMismatchCount:
      missingSourceFiles.length + unexpectedSourceFiles.length,
  });

  console.log(
    `[coverage] ${pkg.path}: lines=${coverage.linePct.toFixed(2)}%, branches=${coverage.branchPct.toFixed(2)}%, sources=${coverage.files.length}/${productionSourceFiles.length}, tests=${hasTests ? (testExitCode === 0 ? "PASS" : `FAIL(${testExitCode})`) : "MISSING"}`,
  );

  if (!passed) executionFailed = true;

  results.push({
    package: pkg.path,
    status,
    testExitCode,
    testFileCount: testFiles.length,
    coverage: {
      linePct: coverage.linePct,
      branchPct: coverage.branchPct,
      funcPct: coverage.funcPct,
    },
    sourceCounts: {
      expected: productionSourceFiles.length,
      reported: coverage.files.length,
      missing: missingSourceFiles,
      unexpected: unexpectedSourceFiles,
    },
    files: coverage.files,
  });

  // 保存单个包的覆盖率报告
  writeFileSync(
    pkgReportPath,
    JSON.stringify(
      {
        package: pkg.path,
        timestamp: new Date().toISOString(),
        gitCommit,
        ...coverage,
        testFileCount: testFiles.length,
        sourceCounts: {
          expected: productionSourceFiles.length,
          reported: coverage.files.length,
          missing: missingSourceFiles,
          unexpected: unexpectedSourceFiles,
        },
        passed,
      },
      null,
      2,
    ),
  );
}

// ─── 汇总报告 ───────────────────────────────────────────────────────────

const repositoryFiles = results.flatMap((result) => result.files ?? []);
let changedLinesCoverage = null;
if (!targetPackage && changedBase) {
  try {
    changedLinesCoverage = collectChangedLinesCoverage(
      repoRoot,
      changedBase,
      gitCommit,
      repositoryFiles,
      allLineHitsByFile,
    );
  } catch (error) {
    console.error(`[coverage] ${error.message}`);
    executionFailed = true;
  }
}
const repositoryGates = targetPackage
  ? null
  : evaluateRepositoryGates(repositoryFiles, {
      changedLinesCoverage,
      requireChangedLines: Boolean(changedBase || process.env.CI),
    });
const testFailures = results.filter((result) =>
  ["test-fail", "no-tests"].includes(result.status),
).length;
const noCoverage = results.filter((result) => result.status === "no-coverage").length;
const sourceInventoryFailures = results.filter(
  (result) =>
    (result.sourceCounts?.missing?.length ?? 0) > 0 ||
    (result.sourceCounts?.unexpected?.length ?? 0) > 0,
).length;
const summary = {
  timestamp: new Date().toISOString(),
  nodeVersion: process.version,
  gitCommit,
  scope: targetPackage ? "package" : "repository",
  targetPackage,
  totalPackages: results.length,
  passed: repositoryGates?.passed ?? 0,
  failed: repositoryGates?.failed ?? 0,
  testFailures,
  noCoverage,
  sourceInventoryFailures,
  packageSourceCounts: results.map((result) => ({
    package: result.package,
    ...result.sourceCounts,
  })),
  results,
  gates: repositoryGates,
};

// Targeted developer runs must not overwrite the canonical all-package
// summary consumed by release evidence and baseline generation.
const summaryPath = coverageSummaryPath(reportDir, targetPackage);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.log("");
console.log("[coverage] ========================================");
const statusLabel = (status) => {
  if (reportOnly && status === "fail") return "REPORT";
  return status.toUpperCase();
};
if (repositoryGates) {
  const { repository, criticalModules, changedLines } = repositoryGates;
  console.log(
    `[coverage]  repository: lines=${repository.coverage.linePct.toFixed(2)}%/${repository.thresholdValues.lines}%, branches=${repository.coverage.branchPct.toFixed(2)}%/${repository.thresholdValues.branches}% → ${statusLabel(repository.status)}${reportOnly ? " (report-only)" : ""}`,
  );
  for (const group of criticalModules) {
    console.log(
      `[coverage]  critical/${group.id}: matched=${group.fileCount}, lines=${group.coverage.linePct.toFixed(2)}%/${group.thresholdValues.lines}%, branches=${group.coverage.branchPct.toFixed(2)}%/${group.thresholdValues.branches}% → ${statusLabel(group.status)}${reportOnly ? " (report-only)" : ""}`,
    );
    for (const file of group.files) console.log(`[coverage]    - ${file}`);
  }
  const changedLineDetail = changedLines.coverage
    ? `lines=${changedLines.coverage.linePct.toFixed(2)}%/${changedLines.thresholdValues.lines}%, executable=${changedLines.executableChangedLines}/${changedLines.changedSourceLines}, base=${changedLines.base?.slice(0, 12)}`
    : `need ${changedLines.thresholdValues.lines}%`;
  console.log(
    `[coverage]  changed-lines: ${changedLineDetail} → ${statusLabel(changedLines.status)}${reportOnly && changedLines.status === "fail" ? " (report-only)" : ""}${changedLines.reason ? ` — ${changedLines.reason}` : ""}`,
  );
} else {
  console.log(`[coverage]  target package diagnostic: ${targetPackage}`);
}
console.log(`[coverage]  汇总: ${summary.passed} 门禁通过, ${summary.failed} 门禁未达标${reportOnly ? "（report-only 不阻断）" : ""}, ${summary.testFailures} 测试发现/执行失败, ${summary.noCoverage} 无覆盖率, ${summary.sourceInventoryFailures} 源码清单不完整`);
console.log(`[coverage]  报告: ${summaryPath}`);
console.log("[coverage] ========================================");

if (!reportOnly && (executionFailed || noCoverage > 0 || repositoryGates?.thresholdsPassed === false)) {
  process.exit(1);
}
