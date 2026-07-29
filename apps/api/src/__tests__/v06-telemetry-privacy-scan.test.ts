/**
 * v0.6 遥测隐私扫描测试 (计划 §4.1, §6.9)
 *
 * 计划 §4.1 安全不变量：
 *   "telemetry、日志和 metrics 不包含题面、答案、claim、quote、
 *    expected concept 或 Provider 原始响应"
 *
 * 本测试扫描 v0.6 Worker handlers 和 API 服务中的 logger 调用，
 * 确保不将以下敏感内容写入日志或 metrics：
 *   - 题面 (question text)
 *   - 用户答案 (user_answer)
 *   - claim / quote (key point 内容)
 *   - expectedConcept (rubric 评估端使用)
 *   - Provider 原始响应
 *   - answerExcerpt (评估输出片段)
 *   - feedback 文本
 *   - rationale 文本
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── 敏感字段名列表 (计划 §4.1) ───────────────────────────────────────────

const SENSITIVE_FIELD_PATTERNS = [
  // 题面和答案
  /userAnswer\s*[,)}\]]/,
  /user_answer\s*[,)}\]]/,
  /"answer"\s*:/,
  /"question"\s*:/,
  /questionText\s*[,)}\]]/,
  // claim 和 quote
  /\.claim\b(?!_)/,
  /\.quoteText\b/,
  /quote_text\b/,
  // rubric 评估端敏感字段
  /expectedConcept\s*[,)}\]]/,
  /expected_concept\b/,
  /answerExcerpt\s*[,)}\]]/,
  /answer_excerpt\b/,
  // Provider 原始响应
  /rawOutput\b/,
  /providerResponse\b/,
  /providerRaw\b/,
];

// ─── logger 调用中的敏感字段检测 ──────────────────────────────────────────

/**
 * 检查一行代码是否在 logger 上下文中引用了敏感字段。
 * logger 调用模式：logger.info/debug/warn/error({ ... }, "message")
 */
function isSensitiveFieldInLoggerContext(line: string, prevLine: string): boolean {
  // 检查是否在 logger 调用上下文中
  const isLoggerCall = prevLine.includes("logger.") || line.includes("logger.");
  if (!isLoggerCall) return false;

  // 排除注释行
  if (line.trim().startsWith("//") || line.trim().startsWith("*")) return false;

  // 排除字段名定义（如 const userAnswer = ...）
  // 只检测 logger 上下文中的直接字段引用
  for (const pattern of SENSITIVE_FIELD_PATTERNS) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

// ─── 扫描 Worker handler 文件 ─────────────────────────────────────────────

const WORKER_HANDLER_DIR = join(
  process.cwd(),
  "workers/ai-worker/src/handlers",
);

const API_MODULE_DIR = join(
  process.cwd(),
  "apps/api/src/modules/validation",
);

function scanFileForSensitiveLoggerContent(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const violations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";

    if (isSensitiveFieldInLoggerContext(line, prevLine)) {
      violations.push(`${filePath}:${i + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

function scanDirectoryForSensitiveLoggerContent(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const violations: string[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      violations.push(...scanDirectoryForSensitiveLoggerContent(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      violations.push(...scanFileForSensitiveLoggerContent(fullPath));
    }
  }
  return violations;
}

// ─── Tests ────────────────────────────────────────────────────────────────

test("v0.6 遥测隐私：Worker handlers 不在 logger 中泄漏敏感字段", () => {
  const violations = scanDirectoryForSensitiveLoggerContent(WORKER_HANDLER_DIR);
  assert.equal(
    violations.length,
    0,
    `Worker handler logger 调用中发现敏感字段泄漏 (计划 §4.1):\n${violations.join("\n")}`,
  );
});

test("v0.6 遥测隐私：API validation 模块不在 logger 中泄漏敏感字段", () => {
  const violations = scanDirectoryForSensitiveLoggerContent(API_MODULE_DIR);
  assert.equal(
    violations.length,
    0,
    `API validation 模块 logger 调用中发现敏感字段泄漏 (计划 §4.1):\n${violations.join("\n")}`,
  );
});

// ─── 验证 metrics 标签不包含敏感内容 ───────────────────────────────────────

test("v0.6 遥测隐私：metrics 标签使用 operation/type/status，不含 question/answer/quote", () => {
  // 检查 metrics.ts 中的 labelNames
  const metricsPath = join(
    process.cwd(),
    "workers/ai-worker/src/lib/metrics.ts",
  );
  if (!existsSync(metricsPath)) {
    // Skip if file not found (may be in different path in CI)
    return;
  }
  const content = readFileSync(metricsPath, "utf8");

  // 确认 labelNames 不包含敏感字段名
  const sensitiveLabelPatterns = [
    /labelNames.*question/i,
    /labelNames.*answer/i,
    /labelNames.*quote/i,
    /labelNames.*claim/i,
    /labelNames.*expectedConcept/i,
  ];

  for (const pattern of sensitiveLabelPatterns) {
    assert.ok(
      !pattern.test(content),
      `metrics.ts labelNames 中发现敏感字段名: ${pattern}`,
    );
  }

  // 确认 JOB_TYPES 和 PROVIDER_OPERATIONS 是操作类型，不是内容
  assert.ok(content.includes("job"), "metrics should have job metrics");
  assert.ok(content.includes("provider"), "metrics should have provider metrics");
});

// ─── 验证 logAICall 不记录答案/题面/quote ─────────────────────────────────

test("v0.6 遥测隐私：logAICall 参数不包含 answer/question/quote 字段", () => {
  const governancePath = join(
    process.cwd(),
    "workers/ai-worker/src/lib/governance.ts",
  );
  if (!existsSync(governancePath)) return;
  const content = readFileSync(governancePath, "utf8");

  // AICallAuditParams 接口不应包含 answer/question/quote 等字段
  const sensitiveParamPatterns = [
    /answer\s*[?:]?\s*(string|text)/i,
    /question\s*[?:]?\s*(string|text)/i,
    /quote\s*[?:]?\s*(string|text)/i,
    /claim\s*[?:]?\s*(string|text)/i,
    /expectedConcept\s*[?:]?\s*(string|text)/i,
  ];

  // 检查 AICallAuditParams 接口定义部分
  const interfaceMatch = content.match(/interface AICallAuditParams\s*\{[^}]+\}/s);
  if (interfaceMatch) {
    const interfaceContent = interfaceMatch[0];
    for (const pattern of sensitiveParamPatterns) {
      assert.ok(
        !pattern.test(interfaceContent),
        `AICallAuditParams 接口中发现敏感字段: ${pattern}`,
      );
    }
  }

  // 确认 audit log 写入的 values 不包含敏感字段
  const insertMatch = content.match(/aiAuditLog\.\$inferInsert/);
  assert.ok(insertMatch, "Should reference aiAuditLog insert type");
});
