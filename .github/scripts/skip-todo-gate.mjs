#!/usr/bin/env node
/**
 * QLT-01/02: skip/todo allowlist 门禁脚本
 *
 * 功能：
 *   1. 对每个包运行测试，捕获 TAP 输出中的 skipped/todo 计数
 *   2. 检查是否有未在 allowlist 中的 skip/todo
 *   3. 拒绝 Playwright 中 `|| true` / `&& false` 这类恒真空断言
 *   4. allowlist 条目包含：测试名、Issue、Owner、批准人、到期日
 *
 * 用法：
 *   node .github/scripts/skip-todo-gate.mjs                    # 运行所有包
 *   node .github/scripts/skip-todo-gate.mjs --package apps/api # 只运行指定包
 *
 * allowlist 文件: .github/scripts/skip-todo-allowlist.json
 *
 * 退出码：
 *   0 — 无 skip/todo 或全部在 allowlist 中
 *   1 — 有未 allowlist 的 skip/todo
 */

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ─── 包配置 ─────────────────────────────────────────────────────────────

const PACKAGES = [
  { path: "packages/shared", testDir: "src" },
  { path: "packages/ai-quality", testDir: "src" },
  { path: "apps/api", testDir: "src" },
  { path: "apps/web", testDir: "lib" },
  { path: "workers/ai-worker", testDir: "src" },
];
const E2E_PACKAGE = "tests/e2e";

// ─── allowlist ─────────────────────────────────────────────────────────

const ALLOWLIST_PATH = resolve(import.meta.dirname, "skip-todo-allowlist.json");

/**
 * allowlist 条目结构:
 * [
 *   {
 *     "testName": "测试名（支持子串匹配）",
 *     "package": "apps/api",
 *     "type": "skip" | "todo",
 *     "issue": "#123",
 *     "owner": "owner-name",
 *     "approver": "approver-name",
 *     "expiresAt": "2026-08-01",
 *     "reason": "原因说明"
 *   }
 * ]
 */
const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  : [];

function validateAllowlist(entries) {
  if (!Array.isArray(entries)) return ["allowlist 根节点必须是数组"];
  const errors = [];
  const now = Date.now();
  const maxExpiry = now + 14 * 24 * 60 * 60 * 1000;
  for (const [index, entry] of entries.entries()) {
    const label = `allowlist[${index}]`;
    for (const field of ["testName", "package", "issue", "owner", "approver", "reason", "expiresAt"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        errors.push(`${label}.${field} 必须是非空字符串`);
      }
    }
    if (entry?.type !== "skip" && entry?.type !== "todo") {
      errors.push(`${label}.type 必须是 skip 或 todo`);
    }
    const expiry = Date.parse(entry?.expiresAt ?? "");
    if (!Number.isFinite(expiry)) {
      errors.push(`${label}.expiresAt 不是有效日期`);
    } else if (expiry < now) {
      errors.push(`${label}.expiresAt 已过期`);
    } else if (expiry > maxExpiry) {
      errors.push(`${label}.expiresAt 超过最长 14 天例外窗口`);
    }
  }
  return errors;
}

const allowlistErrors = validateAllowlist(allowlist);

// ─── 参数解析 ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetPackage = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--package") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error("[skip-todo] --package 需要一个包路径");
      process.exit(2);
    }
    targetPackage = args[i + 1];
    i++;
  } else {
    console.error(`[skip-todo] 未知参数: ${args[i]}`);
    process.exit(2);
  }
}

const selectablePackages = [...PACKAGES.map((pkg) => pkg.path), E2E_PACKAGE];
if (targetPackage && !selectablePackages.includes(targetPackage)) {
  console.error(
    `[skip-todo] 未知包: ${targetPackage}；可选值: ${selectablePackages.join(", ")}`,
  );
  process.exit(2);
}

// ─── TAP 输出解析 ───────────────────────────────────────────────────────

/**
 * 从 TAP 输出中提取 skip/todo 测试
 * @param {string} output - TAP 输出
 * @returns {{skipped: Array, todo: Array, skippedCount: number, todoCount: number}}
 */
function parseSkipTodo(output) {
  const skipped = [];
  const todo = [];

  // 匹配 TAP 格式中的 skip/todo 行
  // ok N - name # SKIP reason
  // not ok N - name # TODO reason
  const lines = output.split("\n");
  for (const line of lines) {
    const skipMatch = line.match(/^\s*ok\s+\d+\s+-\s+(.+?)\s*#\s*SKIP\s*(.*)/i);
    if (skipMatch) {
      skipped.push({ name: skipMatch[1].trim(), reason: skipMatch[2].trim() });
      continue;
    }

    const todoMatch = line.match(/^\s*not\s+ok\s+\d+\s+-\s+(.+?)\s*#\s*TODO\s*(.*)/i);
    if (todoMatch) {
      todo.push({ name: todoMatch[1].trim(), reason: todoMatch[2].trim() });
    }
  }

  // 也检查汇总行
  const summaryMatch = output.match(/#\s*skipped\s+(\d+)/);
  const todoSummaryMatch = output.match(/#\s*todo\s+(\d+)/);

  const skippedCount = summaryMatch ? parseInt(summaryMatch[1], 10) : skipped.length;
  const todoCount = todoSummaryMatch ? parseInt(todoSummaryMatch[1], 10) : todo.length;

  return {
    skipped,
    todo,
    skippedCount,
    todoCount,
    unparsedSkippedCount: Math.max(0, skippedCount - skipped.length),
    unparsedTodoCount: Math.max(0, todoCount - todo.length),
  };
}

/**
 * Playwright 不输出 TAP，且条件式 test.skip 会让必测旅程静默变绿。
 * 因此对 spec 源码做一个窄范围静态门禁；如确有平台级例外，仍须通过
 * 同一 allowlist（package=tests/e2e）记录 owner、approver 与到期日。
 */
function parsePlaywrightSkipTodo(source, file) {
  const skipped = [];
  const todo = [];
  const vacuous = [];

  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;

    if (/\|\|\s*true\b|&&\s*false\b/.test(line)) {
      vacuous.push({
        name: `${file}:${index + 1}`,
        reason: line,
      });
    }

    const call = line.match(
      /\b(?:test\.describe\.(skip|fixme)|test\.(skip|fixme|todo))\s*\(/,
    );
    if (!call) continue;

    const kind = call[1] ?? call[2];
    const title = line.match(/["'`]([^"'`]+)["'`]/)?.[1] ?? kind;
    const item = {
      name: `${file}:${index + 1} ${title}`,
      reason: line,
    };
    if (kind === "skip") skipped.push(item);
    else todo.push(item);
  }

  return { skipped, todo, vacuous };
}

/**
 * 检查 skip/todo 是否在 allowlist 中且未过期
 */
function checkAllowlist(item, pkgPath, type) {
  const now = new Date();

  for (const entry of allowlist) {
    if (entry.type !== type) continue;
    if (entry.package !== pkgPath) continue;

    // 子串匹配测试名
    if (item.name.includes(entry.testName) || entry.testName.includes(item.name)) {
      // 检查是否过期
      if (entry.expiresAt) {
        const expiry = new Date(entry.expiresAt);
        if (expiry < now) {
          return { allowed: false, reason: `allowlist 条目已过期 (${entry.expiresAt})`, entry };
        }
      }
      return { allowed: true, entry };
    }
  }

  return { allowed: false, reason: "未在 allowlist 中" };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────

const repoRoot = resolve(import.meta.dirname, "..", "..");
const reportDir = join(repoRoot, "outputs", "skip-todo");
mkdirSync(reportDir, { recursive: true });

const packagesToRun = targetPackage
  ? PACKAGES.filter((p) => p.path === targetPackage)
  : PACKAGES;

const results = [];
let allPassed = allowlistErrors.length === 0;
for (const error of allowlistErrors) {
  console.error(`[skip-todo] INVALID ALLOWLIST: ${error}`);
}

for (const pkg of packagesToRun) {
  console.log(`[skip-todo] 运行 ${pkg.path}...`);

  const cwd = join(repoRoot, pkg.path);
  const testFileList = execSync(`find ${pkg.testDir} -name '*.test.ts' | sort`, {
    cwd,
    encoding: "utf8",
  }).trim();

  if (!testFileList) {
    console.error(`[skip-todo] ${pkg.path}: 未发现测试文件，保持阻断`);
    allPassed = false;
    results.push({
      package: pkg.path,
      skippedCount: 0,
      todoCount: 0,
      skipped: [],
      todo: [],
      testExitCode: null,
      violations: [{
        type: "test-discovery",
        testName: pkg.path,
        reason: "未发现测试文件",
        allowlistStatus: "测试发现为空不可豁免",
      }],
      passed: false,
    });
    continue;
  }

  const testFiles = testFileList.split("\n");

  let output;
  let testExitCode = 0;
  try {
    output = execFileSync(
      "node",
      ["--import", "tsx", "--test", ...testFiles],
      { cwd, encoding: "utf8", timeout: 120000 },
    );
  } catch (err) {
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    testExitCode = Number.isInteger(err.status) ? err.status : 1;
  }

  const parsed = parseSkipTodo(output);

  console.log(
    `[skip-todo] ${pkg.path}: ${parsed.skippedCount} skipped, ${parsed.todoCount} todo`,
  );

  // 检查每个 skip/todo 是否在 allowlist 中
  const violations = [];

  if (testExitCode !== 0) {
    violations.push({
      type: "test-failure",
      testName: pkg.path,
      reason: `测试命令退出码 ${testExitCode}`,
      allowlistStatus: "测试失败不可由 skip/todo 门禁吞掉",
    });
  }

  if (parsed.unparsedSkippedCount > 0 || parsed.unparsedTodoCount > 0) {
    violations.push({
      type: "tap-parse",
      testName: pkg.path,
      reason: `TAP 汇总中仍有 ${parsed.unparsedSkippedCount} 个 skip、${parsed.unparsedTodoCount} 个 todo 未解析`,
      allowlistStatus: "无法映射到 allowlist，按 fail-closed 处理",
    });
  }

  for (const item of parsed.skipped) {
    const check = checkAllowlist(item, pkg.path, "skip");
    if (!check.allowed) {
      violations.push({
        type: "skip",
        testName: item.name,
        reason: item.reason,
        allowlistStatus: check.reason,
      });
    }
  }

  for (const item of parsed.todo) {
    const check = checkAllowlist(item, pkg.path, "todo");
    if (!check.allowed) {
      violations.push({
        type: "todo",
        testName: item.name,
        reason: item.reason,
        allowlistStatus: check.reason,
      });
    }
  }

  if (violations.length > 0) {
    allPassed = false;
    for (const v of violations) {
      console.error(`[skip-todo] VIOLATION: ${pkg.path} ${v.type}: "${v.testName}" — ${v.allowlistStatus}`);
    }
  }

  results.push({
    package: pkg.path,
    skippedCount: parsed.skippedCount,
    todoCount: parsed.todoCount,
    skipped: parsed.skipped,
    todo: parsed.todo,
    testExitCode,
    unparsedSkippedCount: parsed.unparsedSkippedCount,
    unparsedTodoCount: parsed.unparsedTodoCount,
    violations,
    passed: violations.length === 0,
  });
}

// Playwright Must journeys: reject source-level skip/fixme/todo unless an
// explicit, non-expired allowlist entry exists.
if (!targetPackage || targetPackage === E2E_PACKAGE) {
  console.log(`[skip-todo] 扫描 ${E2E_PACKAGE} Playwright spec...`);
  const cwd = join(repoRoot, E2E_PACKAGE);
  const specFileList = execSync("find tests -name '*.spec.ts' | sort", {
    cwd,
    encoding: "utf8",
  }).trim();
  const skipped = [];
  const todo = [];
  const vacuous = [];

  for (const file of specFileList ? specFileList.split("\n") : []) {
    const parsed = parsePlaywrightSkipTodo(
      readFileSync(join(cwd, file), "utf8"),
      file,
    );
    skipped.push(...parsed.skipped);
    todo.push(...parsed.todo);
    vacuous.push(...parsed.vacuous);
  }

  const violations = [];
  if (!specFileList) {
    violations.push({
      type: "test-discovery",
      testName: E2E_PACKAGE,
      reason: "未发现 Playwright spec",
      allowlistStatus: "E2E 测试发现为空不可豁免",
    });
  }
  for (const [type, items] of [["skip", skipped], ["todo", todo]]) {
    for (const item of items) {
      const check = checkAllowlist(item, E2E_PACKAGE, type);
      if (!check.allowed) {
        violations.push({
          type,
          testName: item.name,
          reason: item.reason,
          allowlistStatus: check.reason,
        });
      }
    }
  }
  for (const item of vacuous) {
    violations.push({
      type: "vacuous",
      testName: item.name,
      reason: item.reason,
      allowlistStatus: "恒真空断言不允许进入门禁测试",
    });
  }

  if (violations.length > 0) {
    allPassed = false;
    for (const violation of violations) {
      console.error(
        `[skip-todo] VIOLATION: ${E2E_PACKAGE} ${violation.type}: `
          + `"${violation.testName}" — ${violation.allowlistStatus}`,
      );
    }
  }

  console.log(
    `[skip-todo] ${E2E_PACKAGE}: ${skipped.length} skipped, ${todo.length} todo, `
      + `${vacuous.length} vacuous`,
  );
  results.push({
    package: E2E_PACKAGE,
    skippedCount: skipped.length,
    todoCount: todo.length,
    vacuousCount: vacuous.length,
    skipped,
    todo,
    vacuous,
    violations,
    passed: violations.length === 0,
  });
}

// ─── 汇总报告 ───────────────────────────────────────────────────────────

const summary = {
  timestamp: new Date().toISOString(),
  allowlistPath: ALLOWLIST_PATH,
  allowlistCount: allowlist.length,
  allowlistErrors,
  totalSkipped: results.reduce((sum, r) => sum + r.skippedCount, 0),
  totalTodo: results.reduce((sum, r) => sum + r.todoCount, 0),
  totalVacuous: results.reduce((sum, r) => sum + (r.vacuousCount ?? 0), 0),
  totalViolations: results.reduce((sum, r) => sum + r.violations.length, 0),
  results,
};

// Preserve the canonical full-run report when a developer asks for one
// package only; release evidence must never consume a partial summary.
const summaryPath = targetPackage
  ? join(reportDir, `${targetPackage.replace(/\//g, "-")}.summary.json`)
  : join(reportDir, "summary.json");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.log("");
console.log("[skip-todo] ========================================");
console.log(
  `[skip-todo]  汇总: ${summary.totalSkipped} skipped, ${summary.totalTodo} todo, `
    + `${summary.totalVacuous} vacuous, ${summary.totalViolations} 违规`,
);
console.log(`[skip-todo]  报告: ${summaryPath}`);
console.log("[skip-todo] ========================================");

if (!allPassed) {
  process.exit(1);
}
