#!/usr/bin/env node
/**
 * FDN-01: 正式覆盖率基线保存脚本
 *
 * 功能：
 *   1. 运行 coverage-gate.mjs 生成覆盖率报告
 *   2. 将报告与 Git commit/branch/timestamp 一起保存为不可变基线
 *   3. 生成基线 manifest（包含 digest 用于完整性校验）
 *   4. 支持 --compare 模式与已有基线比较
 *
 * 用法：
 *   node .github/scripts/coverage-baseline-save.mjs                    # 保存当前覆盖率基线
 *   node .github/scripts/coverage-baseline-save.mjs --label v0.5.0     # 带标签保存
 *   node .github/scripts/coverage-baseline-save.mjs --use-existing     # 使用已收集的 summary
 *   node .github/scripts/coverage-baseline-save.mjs --compare           # 与最新基线比较
 *
 * 退出码：
 *   0 — 基线保存或比较成功
 *   1 — 失败
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const baselineDir = join(repoRoot, "outputs", "coverage-baselines");
const coverageDir = join(repoRoot, "outputs", "coverage");
const expectedCoveragePackages = [
  "packages/shared",
  "packages/db",
  "packages/ai-quality",
  "apps/api",
  "apps/web",
  "workers/ai-worker",
];

// ─── 参数解析 ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let label = null;
let compareMode = false;
let useExisting = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--label") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("[coverage-baseline] --label 需要一个值");
      process.exit(2);
    }
    label = args[i + 1];
    i++;
  } else if (args[i] === "--compare") {
    compareMode = true;
  } else if (args[i] === "--use-existing") {
    useExisting = true;
  } else {
    console.error(`[coverage-baseline] 未知参数: ${args[i]}`);
    process.exit(2);
  }
}

if (compareMode && useExisting) {
  console.error("[coverage-baseline] --compare 与 --use-existing 不能同时使用");
  process.exit(2);
}

// ─── 工具函数 ───────────────────────────────────────────────────────────

function getGitInfo() {
  const commit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const shortCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const timestamp = parseInt(
    execSync("git show -s --format=%ct HEAD", { cwd: repoRoot, encoding: "utf8" }).trim(),
    10,
  );
  return { commit, shortCommit, branch, timestamp };
}

function computeDigest(filePath) {
  const content = readFileSync(filePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function packageReportName(packagePath) {
  return `${packagePath.replaceAll("/", "-")}.coverage.json`;
}

function validateCoverageSummary(summary, expectedCommit, context) {
  if (summary?.scope !== "repository" || summary?.targetPackage != null) {
    throw new Error(`${context}不是全仓覆盖率报告`);
  }
  if (summary.gitCommit !== expectedCommit) {
    throw new Error(
      `${context} commit 不匹配：报告=${summary.gitCommit ?? "missing"}，当前=${expectedCommit}`,
    );
  }
  if (!Array.isArray(summary.results)) {
    throw new Error(`${context}缺少 results`);
  }

  const reportedPackages = new Set(summary.results.map((result) => result.package));
  const missingPackages = expectedCoveragePackages.filter((pkg) => !reportedPackages.has(pkg));
  const unexpectedPackages = [...reportedPackages].filter(
    (pkg) => !expectedCoveragePackages.includes(pkg),
  );
  if (missingPackages.length > 0 || unexpectedPackages.length > 0) {
    throw new Error(
      `${context}包集合不完整（缺少: ${missingPackages.join(", ") || "无"}；多出: ${unexpectedPackages.join(", ") || "无"}）`,
    );
  }
  if (
    summary.testFailures !== 0 ||
    summary.noCoverage !== 0 ||
    summary.sourceInventoryFailures !== 0
  ) {
    throw new Error(
      `${context}包含失败证据（tests=${summary.testFailures}, noCoverage=${summary.noCoverage}, sourceInventory=${summary.sourceInventoryFailures}）`,
    );
  }

  for (const pkg of expectedCoveragePackages) {
    const result = summary.results.find((entry) => entry.package === pkg);
    if (
      result?.status !== "pass" ||
      !Number.isInteger(result.testFileCount) ||
      result.testFileCount < 1 ||
      (result.sourceCounts?.missing?.length ?? 0) > 0 ||
      (result.sourceCounts?.unexpected?.length ?? 0) > 0
    ) {
      throw new Error(`${context}中的 ${pkg} 测试或源码清单不完整`);
    }
  }
}

function validatePackageReports(expectedCommit) {
  for (const pkg of expectedCoveragePackages) {
    const reportPath = join(coverageDir, packageReportName(pkg));
    if (!existsSync(reportPath)) {
      throw new Error(`缺少逐包覆盖率报告: ${packageReportName(pkg)}`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (report.package !== pkg || report.gitCommit !== expectedCommit) {
      throw new Error(
        `${packageReportName(pkg)} 与当前 commit/package 不匹配`,
      );
    }
    if (
      report.passed !== true ||
      !Number.isInteger(report.testFileCount) ||
      report.testFileCount < 1 ||
      (report.sourceCounts?.missing?.length ?? 0) > 0 ||
      (report.sourceCounts?.unexpected?.length ?? 0) > 0
    ) {
      throw new Error(`${packageReportName(pkg)} 不是完整且成功的逐包证据`);
    }
  }
}

function findLatestBaseline() {
  if (!existsSync(baselineDir)) return null;
  const entries = readdirSync(baselineDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const manifestPath = join(baselineDir, e.name, "baseline-manifest.json");
      if (!existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        return { name: e.name, manifest };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.manifest.git.timestamp ?? 0) - (a.manifest.git.timestamp ?? 0));
  return entries[0] ?? null;
}

// ─── 比较模式 ───────────────────────────────────────────────────────────

if (compareMode) {
  console.log("[coverage-baseline] 比较模式：与最新基线对比");

  const latest = findLatestBaseline();
  if (!latest) {
    console.log("[coverage-baseline] 未找到已有基线，无法比较");
    process.exit(0);
  }

  console.log(`[coverage-baseline] 最新基线: ${latest.name} (${latest.manifest.git.shortCommit})`);

  // Run coverage gate to get current report
  console.log("[coverage-baseline] 运行覆盖率门禁...");
  try {
    execSync("node .github/scripts/coverage-gate.mjs --report-only", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch {
    console.error("[coverage-baseline] 覆盖率门禁运行失败");
    process.exit(1);
  }

  const currentSummaryPath = join(coverageDir, "summary.json");
  if (!existsSync(currentSummaryPath)) {
    console.error("[coverage-baseline] 当前覆盖率报告未找到");
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(currentSummaryPath, "utf8"));
  const baseline = latest.manifest.coverageSummary;
  const currentGit = getGitInfo();
  try {
    validateCoverageSummary(current, currentGit.commit, "当前覆盖率摘要");
    validateCoverageSummary(
      baseline,
      latest.manifest.git.commit,
      "基线覆盖率摘要",
    );
  } catch (error) {
    console.error(`[coverage-baseline] ${error.message}`);
    process.exit(1);
  }

  console.log("");
  console.log("[coverage-baseline] ========================================");
  console.log(`[coverage-baseline]  基线: ${latest.name}`);
  console.log(`[coverage-baseline]  基线 commit: ${latest.manifest.git.shortCommit}`);
  console.log(`[coverage-baseline]  基线时间: ${latest.manifest.git.isoTimestamp}`);
  console.log("[coverage-baseline] ----------------------------------------");
  console.log("[coverage-baseline]  各包覆盖率对比:");
  console.log("[coverage-baseline] ----------------------------------------");

  let hasRegression = false;
  for (const baselinePkg of baseline.results) {
    if (!current.results.some((pkg) => pkg.package === baselinePkg.package)) {
      hasRegression = true;
      console.log(`  ${baselinePkg.package}: 当前报告缺失`);
    }
  }
  for (const currentPkg of current.results) {
    const baselinePkg = baseline.results.find((p) => p.package === currentPkg.package);
    if (!baselinePkg) {
      console.log(`  ${currentPkg.package}: 新增包 (lines=${currentPkg.coverage?.linePct?.toFixed(2)}%)`);
      continue;
    }

    const baseLines = baselinePkg.coverage?.linePct ?? 0;
    const currLines = currentPkg.coverage?.linePct ?? 0;
    const baseBranches = baselinePkg.coverage?.branchPct ?? 0;
    const currBranches = currentPkg.coverage?.branchPct ?? 0;
    const lineDelta = currLines - baseLines;
    const branchDelta = currBranches - baseBranches;

    const lineSymbol = lineDelta >= 0 ? "↑" : "↓";
    const branchSymbol = branchDelta >= 0 ? "↑" : "↓";

    console.log(
      `  ${currentPkg.package}:`,
      `lines=${currLines.toFixed(2)}% (${lineSymbol}${Math.abs(lineDelta).toFixed(2)}pp)`,
      `branches=${currBranches.toFixed(2)}% (${branchSymbol}${Math.abs(branchDelta).toFixed(2)}pp)`,
    );

    // Flag significant regression (> 2pp drop)
    if (lineDelta < -2 || branchDelta < -2) {
      hasRegression = true;
      console.log(`    ⚠ 覆盖率下降超过 2pp`);
    }
  }

  console.log("[coverage-baseline] ========================================");
  if (hasRegression) {
    console.error("[coverage-baseline] 存在覆盖率回归（> 2pp 下降）");
    process.exit(1);
  }
  console.log("[coverage-baseline] 无显著覆盖率回归");
  process.exit(0);
}

// ─── 保存模式 ───────────────────────────────────────────────────────────

console.log("[coverage-baseline] 保存正式覆盖率基线...");

// Step 1: Run the gate locally, or consume a summary downloaded from the
// blocking unit-test job. Release evidence runners intentionally avoid
// reinstalling every workspace solely to regenerate already-collected data.
if (useExisting) {
  console.log("[coverage-baseline] 使用已有覆盖率报告");
} else {
  console.log("[coverage-baseline] 运行覆盖率门禁...");
  try {
    execSync("node .github/scripts/coverage-gate.mjs --report-only", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch {
    console.error("[coverage-baseline] 覆盖率门禁运行失败");
    process.exit(1);
  }
}

// Step 2: Verify coverage summary exists
const summaryPath = join(coverageDir, "summary.json");
if (!existsSync(summaryPath)) {
  console.error("[coverage-baseline] 覆盖率摘要未找到（coverage-gate.mjs 可能未成功运行）");
  process.exit(1);
}

const coverageSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
const gitInfo = getGitInfo();
try {
  validateCoverageSummary(coverageSummary, gitInfo.commit, "覆盖率摘要");
  validatePackageReports(gitInfo.commit);
} catch (error) {
  console.error(`[coverage-baseline] ${error.message}`);
  process.exit(1);
}

// Step 3: Create baseline directory
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const baselineName = label
  ? `${timestamp.replace(/T.*/, "")}-${label}`
  : timestamp;
const thisBaselineDir = join(baselineDir, baselineName);
mkdirSync(thisBaselineDir, { recursive: true });

// Step 4: Copy coverage reports to baseline directory
const filesToCopy = [
  { src: "summary.json", dest: "coverage-summary.json" },
  ...expectedCoveragePackages.map((pkg) => ({
    src: packageReportName(pkg),
    dest: packageReportName(pkg),
  })),
];

const copiedFiles = [];
for (const { src, dest } of filesToCopy) {
  const srcPath = join(coverageDir, src);
  if (existsSync(srcPath)) {
    const destPath = join(thisBaselineDir, dest);
    copyFileSync(srcPath, destPath);
    copiedFiles.push({ path: dest, digest: computeDigest(destPath) });
  }
}

// Step 5: Generate baseline manifest
const manifest = {
  baselineName,
  savedAt: new Date().toISOString(),
  git: {
    commit: gitInfo.commit,
    shortCommit: gitInfo.shortCommit,
    branch: gitInfo.branch,
    timestamp: gitInfo.timestamp,
    isoTimestamp: new Date(gitInfo.timestamp * 1000).toISOString(),
  },
  nodeVersion: process.version,
  coverageSummary,
  files: copiedFiles,
};

const manifestPath = join(thisBaselineDir, "baseline-manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Step 6: Compute manifest digest
const manifestDigest = computeDigest(manifestPath);

console.log("");
console.log("[coverage-baseline] ========================================");
console.log(`[coverage-baseline]  基线名称: ${baselineName}`);
console.log(`[coverage-baseline]  Commit: ${gitInfo.shortCommit} (${gitInfo.branch})`);
console.log(`[coverage-baseline]  时间: ${manifest.git.isoTimestamp}`);
console.log(`[coverage-baseline]  Node: ${process.version}`);
console.log(`[coverage-baseline]  覆盖率: ${coverageSummary.passed} pass / ${coverageSummary.failed} fail / ${coverageSummary.noCoverage} no-coverage`);
console.log(`[coverage-baseline]  文件数: ${copiedFiles.length}`);
console.log(`[coverage-baseline]  Manifest digest: ${manifestDigest.substring(0, 24)}...`);
console.log(`[coverage-baseline]  保存位置: ${thisBaselineDir}`);
console.log("[coverage-baseline] ========================================");
console.log("[coverage-baseline] 基线已保存。使用 --compare 与此基线对比。");
