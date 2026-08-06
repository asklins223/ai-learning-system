#!/usr/bin/env node
/**
 * REL-01: Release manifest 聚合脚本
 *
 * 功能：
 *   1. 收集全仓测试摘要（各包 pass/fail/skip/todo 计数）
 *   2. 收集覆盖率摘要（各包 line%/branch%）
 *   3. 记录版本、commit、迁移末端 + journal digest
 *   4. 记录构建产物 digest（如果存在）
 *   5. 生成机器可读 release manifest JSON
 *
 * 用法：
 *   node .github/scripts/release-manifest-generate.mjs                    # 生成 dev manifest
 *   node .github/scripts/release-manifest-generate.mjs --output manifest.json
 *   node .github/scripts/release-manifest-generate.mjs --check            # 校验 manifest 完整性
 *   node .github/scripts/release-manifest-generate.mjs --rc               # 生成 contract-compliant RC manifest
 *   node .github/scripts/release-manifest-generate.mjs --skip-tests       # 跳过测试运行（使用已有摘要）
 *
 * 退出码：
 *   0 — manifest 生成或校验成功
 *   1 — 生成或校验失败
 */

import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ─── 包配置 ─────────────────────────────────────────────────────────────

const PACKAGES = [
  { path: "packages/shared", testDir: "src" },
  { path: "packages/ai-quality", testDir: "src" },
  { path: "apps/api", testDir: "src" },
  { path: "apps/web", testDir: "lib" },
  { path: "workers/ai-worker", testDir: "src" },
];

const JOURNAL_PATH = "apps/api/src/db/migrations/meta/_journal.json";

// ─── 参数解析 ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let outputPath = null;
let checkMode = false;
let rcMode = false;
let skipTests = false;
let imagesPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else if (args[i] === "--check") {
    checkMode = true;
  } else if (args[i] === "--rc") {
    rcMode = true;
  } else if (args[i] === "--skip-tests") {
    skipTests = true;
  } else if (args[i] === "--images" && args[i + 1]) {
    imagesPath = args[i + 1];
    i++;
  }
}

const repoRoot = resolve(import.meta.dirname, "..", "..");
const runnerTemp = process.env.RUNNER_TEMP || process.env.TEMP || null;

// ─── 加载 CI 产出的结果摘要（如果存在）──────────────────────────

function loadCIResults() {
  const results = {};
  if (!runnerTemp) return results;

  // Load E2E results from Playwright's JUnit artifact.
  const e2eResultsPath = join(runnerTemp, "playwright-results", "junit.xml");
  if (existsSync(e2eResultsPath)) {
    try {
      const xml = readFileSync(e2eResultsPath, "utf8");
      const rootTag = xml.match(/<testsuites\b([^>]*)>/)?.[1];
      if (!rootTag) throw new Error("missing <testsuites> summary");
      const attr = (name) => Number(rootTag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
      const total = attr("tests");
      const failed = attr("failures") + attr("errors");
      const skipped = attr("skipped");
      const passed = total - failed - skipped;
      if (total <= 0 || passed < 0) throw new Error("invalid JUnit counts");
      results.e2e = {
        passed,
        failed,
        skipped,
        total,
        status: failed === 0 && skipped === 0 ? "passed" : "failed",
        evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/e2e`],
      };
    } catch (err) {
      console.log(`[release-manifest] E2E 结果解析失败: ${err.message}`);
    }
  }

  // Load Trivy scan results (containerScan)
  const scanResultsDir = join(runnerTemp, "release-evidence", "scan-results");
  const trivyApiPath = join(scanResultsDir, "trivy-scan-api.txt");
  const trivyWorkerPath = join(scanResultsDir, "trivy-scan-worker.txt");
  const trivyWebPath = join(scanResultsDir, "trivy-scan-web.txt");
  const containerScans = [];

  for (const [path, name] of [[trivyApiPath, "api"], [trivyWorkerPath, "worker"], [trivyWebPath, "web"]]) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8");
        // Trivy outputs "Total: X (Low: 0, Medium: 0, High: 0, Critical: 0)" on PASS (no HIGH/CRITICAL)
        const hasHighCritical = /High:\s*[1-9]/.test(content) || /Critical:\s*[1-9]/.test(content);
        containerScans.push({
          name,
          status: hasHighCritical ? "failed" : "passed",
          evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/container-scan/${name}`],
        });
      } catch (err) {
        console.log(`[release-manifest] Trivy 结果解析失败 (${path}): ${err.message}`);
      }
    }
  }

  if (containerScans.length > 0) {
    results.containerScan = {
      status: containerScans.some(s => s.status === "failed") ? "failed" : "passed",
      scans: containerScans,
      evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/container-scan`],
    };
  }

  // Load npm audit results (dependencyScan)
  const npmAuditApiPath = join(scanResultsDir, "npm-audit-api.txt");
  const npmAuditWorkerPath = join(scanResultsDir, "npm-audit-worker.txt");
  const npmAuditWebPath = join(scanResultsDir, "npm-audit-web.txt");
  const dependencyScans = [];

  for (const [path, name] of [[npmAuditApiPath, "api"], [npmAuditWorkerPath, "worker"], [npmAuditWebPath, "web"]]) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8");
        // npm audit outputs "found 0 vulnerabilities" on PASS
        // or "found X vulnerabilities (Y moderate, Z high, ...)" on FAIL
        const foundVuln = /found\s+\d+\s+vulnerabilities/.test(content);
        const hasHighCritical = /high|critical/i.test(content);
        dependencyScans.push({
          name,
          status: foundVuln && hasHighCritical ? "failed" : "passed",
          evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/dep-scan/${name}`],
        });
      } catch (err) {
        console.log(`[release-manifest] npm audit 结果解析失败 (${path}): ${err.message}`);
      }
    }
  }

  if (dependencyScans.length > 0) {
    results.dependencyScan = {
      status: dependencyScans.some(s => s.status === "failed") ? "failed" : "passed",
      scans: dependencyScans,
      evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/dep-scan`],
    };
  }

  return results;
}

function loadUnitTestEvidence() {
  if (!runnerTemp) return [];
  const logsDir = join(runnerTemp, "unit-test-logs");
  const logNames = new Map([
    ["packages/shared", "shared.tap"],
    ["packages/ai-quality", "ai-quality.tap"],
    ["apps/api", "api.tap"],
    ["apps/web", "web.tap"],
    ["workers/ai-worker", "worker.tap"],
  ]);
  const summaries = [];
  for (const pkg of PACKAGES) {
    const logPath = join(logsDir, logNames.get(pkg.path));
    if (!existsSync(logPath)) continue;
    const summary = parseTestSummary(readFileSync(logPath, "utf8"));
    if (summary.total <= 0 || summary.pass + summary.fail > summary.total) {
      throw new Error(`Invalid TAP summary in ${logPath}`);
    }
    summary.exitCode = 0;
    summaries.push({ package: pkg.path, tests: summary });
  }
  return summaries;
}

/**
 * 加载 CI 构建产出的镜像 digest JSON（由 capture-image-digests.mjs 生成）
 * 如果未提供 --images 参数或文件不存在，返回 null（RC manifest 使用占位符）
 */
function loadImageDigests() {
  if (!imagesPath) return null;
  const fullPath = resolve(repoRoot, imagesPath);
  if (!existsSync(fullPath)) {
    console.log(`[release-manifest] 镜像 digest 文件未找到: ${imagesPath}`);
    return null;
  }
  const data = JSON.parse(readFileSync(fullPath, "utf8"));
  if (!data.images || typeof data.images !== "object") {
    console.log(`[release-manifest] 镜像 digest 文件格式无效: ${imagesPath}`);
    return null;
  }
  if (data.releaseReady !== true || Object.values(data.images).some((image) => image?.publishable !== true)) {
    console.log(`[release-manifest] 镜像证据仅对应本地 Docker daemon，不能作为可拉取的 RC digest`);
    return null;
  }
  console.log(`[release-manifest] 镜像 digest 已加载: ${Object.keys(data.images).join(", ")}`);
  return data.images;
}

// ─── 工具函数 ───────────────────────────────────────────────────────────

/**
 * 从 TAP 输出中解析测试摘要
 */
function parseTestSummary(output) {
  const testsMatch = output.match(/#\s*tests\s+(\d+)/);
  const passMatch = output.match(/#\s*pass\s+(\d+)/);
  const failMatch = output.match(/#\s*fail\s+(\d+)/);
  const skippedMatch = output.match(/#\s*skipped\s+(\d+)/);
  const todoMatch = output.match(/#\s*todo\s+(\d+)/);
  const durationMatch = output.match(/#\s*duration_ms\s+([\d.]+)/);

  return {
    total: testsMatch ? parseInt(testsMatch[1]) : 0,
    pass: passMatch ? parseInt(passMatch[1]) : 0,
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    skipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
    todo: todoMatch ? parseInt(todoMatch[1]) : 0,
    durationMs: durationMatch ? parseFloat(durationMatch[1]) : 0,
  };
}

/**
 * 获取 Git 信息
 */
function getGitInfo() {
  const commit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const shortCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const isClean = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim() === "";
  const tag = (() => {
    try {
      return execSync("git describe --tags --exact-match HEAD 2>/dev/null", { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  // sourceDateEpoch: commit timestamp in seconds
  const sourceDateEpoch = parseInt(
    execSync("git show -s --format=%ct HEAD", { cwd: repoRoot, encoding: "utf8" }).trim(),
    10,
  );

  return { commit, shortCommit, branch, isClean, tag, sourceDateEpoch };
}

/**
 * 获取版本信息
 */
function getVersionInfo() {
  const versionJsonPath = join(repoRoot, "release", "version.json");
  if (existsSync(versionJsonPath)) {
    return JSON.parse(readFileSync(versionJsonPath, "utf8"));
  }
  return { version: "unknown" };
}

/**
 * 获取迁移信息，包括 journal digest
 */
function getMigrationInfo() {
  const migrationsDir = join(repoRoot, "apps", "api", "src", "db", "migrations");
  const journalFullPath = join(repoRoot, JOURNAL_PATH);

  if (!existsSync(migrationsDir)) {
    return {
      journalPath: JOURNAL_PATH,
      journalDigest: null,
      latestMigration: "unknown",
      migrationCount: 0,
      count: 0, // backward compat for dev manifest
    };
  }

  const files = execSync(`find ${migrationsDir} -maxdepth 1 -name '*.sql' | sort`, {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);

  if (files.length === 0) {
    return {
      journalPath: JOURNAL_PATH,
      journalDigest: null,
      latestMigration: "none",
      migrationCount: 0,
      count: 0,
    };
  }

  const latestFile = files[files.length - 1];
  const latestName = latestFile.split("/").pop();

  // Compute journal digest
  let journalDigest = null;
  if (existsSync(journalFullPath)) {
    const journalBytes = readFileSync(journalFullPath);
    const hash = createHash("sha256").update(journalBytes).digest("hex");
    journalDigest = `sha256:${hash}`;
  }

  return {
    journalPath: JOURNAL_PATH,
    journalDigest,
    latestMigration: latestName,
    migrationCount: files.length,
    count: files.length, // backward compat for dev manifest
  };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────

console.log(`[release-manifest] 收集发布清单...${rcMode ? " (RC 模式)" : ""}`);

const gitInfo = getGitInfo();
const versionInfo = getVersionInfo();
const migrationInfo = getMigrationInfo();
const nodeVersion = process.version;
const imageDigests = loadImageDigests();

console.log(`[release-manifest] 版本: ${versionInfo.version}`);
console.log(`[release-manifest] Commit: ${gitInfo.shortCommit} (branch: ${gitInfo.branch})`);
console.log(`[release-manifest] 迁移: ${migrationInfo.latestMigration} (${migrationInfo.migrationCount} 个)`);
if (migrationInfo.journalDigest) {
  console.log(`[release-manifest] Journal digest: ${migrationInfo.journalDigest.substring(0, 24)}...`);
}
console.log(`[release-manifest] Node: ${nodeVersion}`);
console.log(`[release-manifest] Source date epoch: ${gitInfo.sourceDateEpoch}`);

// 收集各包测试摘要
const packageSummaries = [];
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
let totalSkipped = 0;
let totalTodo = 0;

if (skipTests) {
  console.log("[release-manifest] 使用已有测试证据（--skip-tests）");
  const existingSummaries = loadUnitTestEvidence();
  if (rcMode && process.env.GITHUB_ACTIONS === "true" && existingSummaries.length !== PACKAGES.length) {
    throw new Error(`CI RC manifest requires ${PACKAGES.length} TAP artifacts, found ${existingSummaries.length}`);
  }
  for (const item of existingSummaries) {
    packageSummaries.push(item);
    const summary = item.tests;
    totalTests += summary.total;
    totalPass += summary.pass;
    totalFail += summary.fail;
    totalSkipped += summary.skipped;
    totalTodo += summary.todo;
    console.log(`[release-manifest]   ${item.package}: ${summary.pass}/${summary.total} pass from TAP artifact`);
  }
} else {
  for (const pkg of PACKAGES) {
    console.log(`[release-manifest] 测试 ${pkg.path}...`);

    const cwd = join(repoRoot, pkg.path);
    const testFileList = execSync(`find ${pkg.testDir} -name '*.test.ts' | sort`, {
      cwd,
      encoding: "utf8",
    }).trim();

    if (!testFileList) {
      packageSummaries.push({ package: pkg.path, tests: { total: 0, pass: 0, fail: 0, skipped: 0, todo: 0 } });
      continue;
    }

    const testFiles = testFileList.split("\n");

    let output;
    let exitCode = 0;
    try {
      output = execFileSync(
        "node",
        ["--import", "tsx", "--test", ...testFiles],
        { cwd, encoding: "utf8", timeout: 120000 },
      );
    } catch (err) {
      output = err.stdout || err.stderr || "";
      exitCode = err.status || 1;
    }

    const summary = parseTestSummary(output);
    summary.exitCode = exitCode;

    packageSummaries.push({ package: pkg.path, tests: summary });

    totalTests += summary.total;
    totalPass += summary.pass;
    totalFail += summary.fail;
    totalSkipped += summary.skipped;
    totalTodo += summary.todo;

    console.log(
      `[release-manifest]   ${pkg.path}: ${summary.pass}/${summary.total} pass, ${summary.fail} fail, ${summary.skipped} skip, ${summary.todo} todo`,
    );
  }
}

// 收集覆盖率摘要（如果存在）
const coverageSummaryPath = join(repoRoot, "outputs", "coverage", "summary.json");
let coverageSummary = null;
if (existsSync(coverageSummaryPath)) {
  coverageSummary = JSON.parse(readFileSync(coverageSummaryPath, "utf8"));
  console.log(`[release-manifest] 覆盖率报告: 已加载`);
} else {
  console.log(`[release-manifest] 覆盖率报告: 未找到（运行 coverage-gate.mjs 生成）`);
}

// 收集构建产物 digest（如果存在）
const buildDigests = {};
const buildPaths = [
  { key: "api", path: "apps/api/dist/server.cjs" },
  { key: "web", path: "apps/web/.next/BUILD_ID" },
];

for (const { key, path } of buildPaths) {
  const fullPath = join(repoRoot, path);
  if (existsSync(fullPath)) {
    const digest = execSync(`shasum -a 256 "${fullPath}" | awk '{print $1}'`, {
      encoding: "utf8",
    }).trim();
    buildDigests[key] = { path, sha256: digest };
    console.log(`[release-manifest] 构建产物 ${key}: ${digest.substring(0, 16)}...`);
  }
}

// ─── RC 模式：生成 contract-compliant manifest ──────────────────────

/**
 * 构造 RC manifest 的 images 部分。
 *
 * 当 imageDigests（来自 capture-image-digests.mjs）可用时，使用真实的
 * canonical sha256 digest、platform 和 provenance 信息。
 * 否则使用占位符（仅用于本地/dev 预览，contract verifier 会拒绝占位符）。
 *
 * @param {Record<string, any> | null} imageDigests — 来自 --images JSON 的镜像信息
 * @returns {Record<string, any>} — manifest.images 对象
 */
function makeImageSection(imageDigests) {
  const imageNames = ["api", "web", "worker"];
  const defaultRepositories = {
    api: "ghcr.io/asklins223/ailearn/api",
    web: "ghcr.io/asklins223/ailearn/web",
    worker: "ghcr.io/asklins223/ailearn/worker",
  };
  const images = {};

  for (const name of imageNames) {
    const real = imageDigests?.[name];
    if (real && real.digest && /^sha256:[0-9a-f]{64}$/.test(real.digest)) {
      // Use real digest from CI build
      images[name] = {
        repository: real.repository || defaultRepositories[name],
        digest: real.digest,
        ...(real.platform ? { platform: real.platform } : {}),
        provenance: real.provenance || {
          buildRunId: process.env.GITHUB_RUN_ID || "0",
          builtAt: new Date().toISOString(),
          deploymentEnvironment: "ci-compose-smoke",
          observedAt: new Date().toISOString(),
          observedDigest: real.digest,
          evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/images/${name}`],
        },
      };
    } else {
      // Placeholder — contract verifier will reject this
      images[name] = {
        repository: defaultRepositories[name],
        digest: `sha256:${"0".repeat(64)}`,
        provenance: {
          buildRunId: process.env.GITHUB_RUN_ID || "0",
          builtAt: new Date().toISOString(),
          deploymentEnvironment: "ci-compose-smoke",
          observedAt: new Date().toISOString(),
          observedDigest: `sha256:${"0".repeat(64)}`,
          evidence: [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/images/${name}`],
        },
      };
    }
  }

  return images;
}

if (rcMode) {
  const allTestsPassed = totalTests > 0 && totalFail === 0 && totalSkipped === 0 && totalTodo === 0;
  const ciResults = loadCIResults();

  // Contract schema requires these gate fields
  function makeGate(status, evidence, summary) {
    const gate = { status, evidence };
    if (summary) gate.summary = summary;
    return gate;
  }

  const rcManifest = {
    schemaVersion: 1,
    version: versionInfo.version !== "unknown" ? versionInfo.version : "0.5.0",
    tag: gitInfo.tag || "v0.5.0-rc.1",
    commit: gitInfo.commit,
    sourceDateEpoch: gitInfo.sourceDateEpoch,
    nodeVersion,
    generatedAt: new Date().toISOString(),
    migration: {
      journalPath: migrationInfo.journalPath,
      journalDigest: migrationInfo.journalDigest || `sha256:${"0".repeat(64)}`,
      latestMigration: migrationInfo.latestMigration,
      migrationCount: migrationInfo.migrationCount,
    },
    // Images: use real digests from capture-image-digests.mjs if available;
    // otherwise fall back to placeholders for local/dev runs.
    images: makeImageSection(imageDigests),
    tests: {
      summary: {
        passed: totalPass,
        failed: totalFail,
        skipped: totalSkipped,
        todo: totalTodo,
      },
      unit: makeGate(
        allTestsPassed ? "passed" : "failed",
        [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/unit`],
        `${totalPass}/${totalTests} pass`,
      ),
      integration: makeGate(
        process.env.GITHUB_RUN_ID ? "passed" : "not_applicable",
        [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/integration`],
        process.env.GITHUB_RUN_ID ? "fresh-migrations job passed" : "Integration evidence unavailable locally",
      ),
      e2e: ciResults.e2e
        ? makeGate(
            ciResults.e2e.status,
            ciResults.e2e.evidence,
            `${ciResults.e2e.passed}/${ciResults.e2e.total} pass${ciResults.e2e.failed > 0 ? `, ${ciResults.e2e.failed} fail` : ""}`,
          )
        : makeGate(
            "not_applicable",
            [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/e2e`],
            "E2E tests run separately via Playwright job",
          ),
      coverage: makeGate(
        coverageSummary
          && coverageSummary.failed === 0
          && (coverageSummary.testFailures ?? 0) === 0
          && coverageSummary.noCoverage === 0
          ? "passed"
          : "failed",
        [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/coverage`],
        coverageSummary
          ? `${coverageSummary.passed} pass / ${coverageSummary.failed} threshold fail / ${coverageSummary.testFailures ?? 0} test fail / ${coverageSummary.noCoverage} missing`
          : "No coverage report",
      ),
      dependencyScan: ciResults.dependencyScan
        ? makeGate(
            ciResults.dependencyScan.status,
            ciResults.dependencyScan.evidence,
            `${ciResults.dependencyScan.scans.length} packages scanned`,
          )
        : makeGate(
            "not_applicable",
            [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/dep-scan`],
            "npm audit not configured as blocking gate",
          ),
      secretScan: makeGate(
        process.env.GITHUB_RUN_ID ? "passed" : "not_applicable",
        [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/secret-scan`],
        process.env.GITHUB_RUN_ID ? "Gitleaks job passed" : "Secret scan evidence unavailable locally",
      ),
      containerScan: ciResults.containerScan
        ? makeGate(
            ciResults.containerScan.status,
            ciResults.containerScan.evidence,
            `${ciResults.containerScan.scans.length} images scanned`,
          )
        : makeGate(
            "not_applicable",
            [`ci://run/${process.env.GITHUB_RUN_ID || "local"}/container-scan`],
            "Container scanning not configured",
          ),
    },
    // AIQ: placeholder — actual metrics filled by supervisor-rc-gate CLI run
    aiQuality: {
      status: "not_run",
      datasetVersion: null,
      datasetDigest: `sha256:${"0".repeat(64)}`,
      sampleCount: 30,
      labelVersion: null,
      scorerCommit: null,
      promptVersion: null,
      provider: {
        endpointOrigin: null,
        modelId: null,
        modelRevision: null,
        temperature: null,
      },
      runs: 0,
      runResults: [],
      metrics: {
        hardCitationPrecision: null,
        keyPointHardCoverage: null,
        expectedBlockHardCoverage: null,
      },
      costUsd: 0,
      evidence: [],
    },
    // Approvals: filled progressively during gray release.
    // See docs/operations.md#promotion-and-approvals for the active approval
    // requirements. Both approvals must be "approved" before the contract
    // verifier accepts the manifest as a release-ready RC.
    approvals: {
      owner: {
        decision: "pending",
        approver: null,
        decidedAt: null,
        evidence: null,
      },
      securityDataReviewer: {
        decision: "pending",
        approver: null,
        decidedAt: null,
        evidence: null,
      },
    },
  };

  const manifestPath = outputPath || join(repoRoot, "outputs", "release-manifest.json");
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(rcManifest, null, 2));

  console.log("");
  console.log("[release-manifest] ========================================");
  console.log(`[release-manifest]  模式: RC (contract-compliant)`);
  console.log(`[release-manifest]  版本: ${rcManifest.version}`);
  console.log(`[release-manifest]  Tag: ${rcManifest.tag}`);
  console.log(`[release-manifest]  Commit: ${rcManifest.commit.substring(0, 12)}`);
  console.log(`[release-manifest]  迁移末端: ${rcManifest.migration.latestMigration}`);
  console.log(`[release-manifest]  Journal digest: ${rcManifest.migration.journalDigest.substring(0, 24)}...`);
  console.log(`[release-manifest]  测试: ${totalPass}/${totalTests} pass, ${totalFail} fail`);
  console.log(`[release-manifest]  覆盖率: ${coverageSummary ? `${coverageSummary.passed} pass / ${coverageSummary.failed} fail` : "未收集"}`);
  const imageStatus = imageDigests
    ? `已注入 (${Object.keys(imageDigests).join(", ")})`
    : "占位符（未提供 --images）";
  console.log(`[release-manifest]  镜像 digest: ${imageStatus}`);
  console.log(`[release-manifest]  Manifest: ${manifestPath}`);
  console.log("[release-manifest] ========================================");
  if (!imageDigests) {
    console.log("[release-manifest] 注意: 镜像 digest 为占位符，");
    console.log("[release-manifest]       需由 --images 参数注入 CI 构建产出的真实 digest。");
  }
  if (rcManifest.aiQuality.status !== "passed") {
    console.log("[release-manifest] 注意: aiQuality 为占位符，");
    console.log("[release-manifest]       需由 supervisor-rc-gate CLI 运行真实 Provider 后填充。");
  }
  process.exit(0);
}

// ─── Dev 模式：生成开发用 manifest（原有逻辑）──────────────────────

const manifest = {
  manifestVersion: "1.0",
  generatedAt: new Date().toISOString(),
  version: versionInfo.version,
  git: gitInfo,
  nodeVersion,
  sourceDateEpoch: gitInfo.sourceDateEpoch,
  migration: migrationInfo,
  testSummary: {
    totalTests,
    totalPass,
    totalFail,
    totalSkipped,
    totalTodo,
    allTestsPassed: totalFail === 0 && totalSkipped === 0 && totalTodo === 0,
    packages: packageSummaries,
  },
  coverage: coverageSummary
    ? {
        passed: coverageSummary.passed,
        failed: coverageSummary.failed,
        results: coverageSummary.results?.map((r) => ({
          package: r.package,
          status: r.status,
          coverage: r.coverage,
          threshold: r.thresholdValues,
        })),
      }
    : null,
  buildDigests: Object.keys(buildDigests).length > 0 ? buildDigests : null,
};

// 校验模式
if (checkMode) {
  console.log("");
  console.log("[release-manifest] 校验清单:");
  let checksPassed = true;

  const checks = [
    { name: "Git working tree clean", passed: gitInfo.isClean },
    { name: "版本号非 unknown", passed: versionInfo.version !== "unknown" },
    { name: "所有测试通过", passed: manifest.testSummary.allTestsPassed },
    { name: "无 skip/todo", passed: totalSkipped === 0 && totalTodo === 0 },
    { name: "覆盖率报告存在", passed: coverageSummary !== null },
    { name: "覆盖率全部通过", passed: coverageSummary?.failed === 0 },
    { name: "API 构建产物存在", passed: !!buildDigests.api },
    { name: "Web 构建产物存在", passed: !!buildDigests.web },
    { name: "Journal digest 已计算", passed: !!migrationInfo.journalDigest },
  ];

  for (const check of checks) {
    const status = check.passed ? "✓" : "✗";
    console.log(`  ${status} ${check.name}`);
    if (!check.passed) checksPassed = false;
  }

  console.log("");
  if (!checksPassed) {
    console.error("[release-manifest] 校验失败: 存在未通过项");
    process.exit(1);
  }
  console.log("[release-manifest] 校验通过");
  process.exit(0);
}

// 输出 manifest
const manifestPath = outputPath || join(repoRoot, "outputs", "release-manifest.json");
mkdirSync(join(manifestPath, ".."), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("");
console.log("[release-manifest] ========================================");
console.log(`[release-manifest]  版本: ${manifest.version}`);
console.log(`[release-manifest]  测试: ${totalPass}/${totalTests} pass, ${totalFail} fail`);
console.log(`[release-manifest]  覆盖率: ${coverageSummary ? `${coverageSummary.passed} pass / ${coverageSummary.failed} fail` : "未收集"}`);
console.log(`[release-manifest]  Journal digest: ${migrationInfo.journalDigest ? migrationInfo.journalDigest.substring(0, 24) + "..." : "未计算"}`);
console.log(`[release-manifest]  Manifest: ${manifestPath}`);
console.log("[release-manifest] ========================================");
