#!/usr/bin/env node
/**
 * OPS-01: Prometheus alerts.yml 语法验证脚本
 *
 * 验证 infra/prometheus/alerts.yml 的 YAML 语法是否正确。
 * 由于 promtool 不在 npm 上，使用 YAML parser 进行基础语法校验。
 *
 * 失败时 exit 1，CI 会被阻断。
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";

// 确定项目根目录（从脚本位置向上查找）
const scriptDir = new URL(import.meta.url).pathname;
const rootDir = join(scriptDir, "..", "..", "..");

const alertsPath = join(rootDir, "infra", "prometheus", "alerts.yml");

if (!existsSync(alertsPath)) {
  console.error(`❌ Alerts file not found: ${alertsPath}`);
  process.exit(1);
}

console.log(`🔍 Validating Prometheus alerts syntax: ${alertsPath}`);

let alertsDoc;
try {
  const alertsContent = readFileSync(alertsPath, "utf8");
  alertsDoc = load(alertsContent);
  console.log("✅ YAML syntax is valid");
} catch (error) {
  console.error(`\n❌ YAML parsing failed: ${error.message}`);
  console.error(
    "\n提示: Prometheus 配置参考文档:\n" +
    "  https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/",
  );
  process.exit(1);
}

// 验证 Prometheus alerts 的结构
const groups = alertsDoc?.groups;
if (!Array.isArray(groups)) {
  console.error("\n❌ alerts.yml must have a 'groups' array at the root");
  process.exit(1);
}

const alertNames = new Set();
for (let i = 0; i < groups.length; i++) {
  const group = groups[i];
  if (!group || typeof group !== "object") {
    console.error(`\n❌ Group ${i} is not an object`);
    process.exit(1);
  }
  if (typeof group.name !== "string") {
    console.error(`\n❌ Group ${i} must have a 'name' string`);
    process.exit(1);
  }
  if (!Array.isArray(group.rules)) {
    console.error(`\n❌ Group '${group.name}' must have a 'rules' array`);
    process.exit(1);
  }
  for (let j = 0; j < group.rules.length; j++) {
    const rule = group.rules[j];
    if (!rule || typeof rule !== "object") {
      console.error(`\n❌ Group '${group.name}' rule ${j} is not an object`);
      process.exit(1);
    }
    if (typeof rule.alert !== "string") {
      console.error(`\n❌ Group '${group.name}' rule ${j} must have an 'alert' string`);
      process.exit(1);
    }
    if (typeof rule.expr !== "string") {
      console.error(`\n❌ Group '${group.name}' rule ${j} must have an 'expr' string`);
      process.exit(1);
    }
    if (typeof rule.for !== "string" && rule.for !== undefined) {
      console.error(`\n❌ Group '${group.name}' rule ${j} 'for' must be a string duration (e.g., '5m')`);
      process.exit(1);
    }
    if (rule.labels && typeof rule.labels !== "object") {
      console.error(`\n❌ Group '${group.name}' rule ${j} 'labels' must be an object`);
      process.exit(1);
    }
    if (rule.annotations && typeof rule.annotations !== "object") {
      console.error(`\n❌ Group '${group.name}' rule ${j} 'annotations' must be an object`);
      process.exit(1);
    }
    // 检查 alert 名称唯一性
    if (alertNames.has(rule.alert)) {
      console.error(`\n⚠️  Warning: Alert name '${rule.alert}' is duplicated`);
    }
    alertNames.add(rule.alert);
  }
}

console.log(`✅ Found ${groups.length} group(s) with ${alertNames.size} unique alert rule(s)`);

// 定义 OPS-01 需要的指标 allowlist（来自 ADR-0006 §2）
const REQUIRED_METRICS = [
  "ailearn_http_requests_total",
  "ailearn_http_request_duration_seconds",
  "ailearn_http_errors_5xx_total",
  "ailearn_readiness_status",
  "ailearn_job_queue_depth",
  "ailearn_job_oldest_pending_age_seconds",
  "ailearn_job_terminal_total",
  "ailearn_job_retries_total",
  "ailearn_job_lease_lost_total",
  "ailearn_job_duration_seconds",
  "ailearn_provider_calls_total",
  "ailearn_provider_call_duration_seconds",
  "ailearn_provider_errors_total",
  "ailearn_funnel_events_total",
  "ailearn_release_info",
];

// 检查是否所有必需指标都在告警规则中被使用
const alertsContent = readFileSync(alertsPath, "utf8");
const missingMetrics = [];
for (const metric of REQUIRED_METRICS) {
  if (!alertsContent.includes(metric)) {
    missingMetrics.push(metric);
  }
}

if (missingMetrics.length > 0) {
  console.warn(
    "\n⚠️  Warning: Some required metrics are not used in alerts.yml:\n" +
    `  ${missingMetrics.join("\n  ")}\n` +
    "这些指标在代码中已定义但未在告警规则中被引用。\n" +
    "如果这是预期的（例如指标尚在早期阶段），可以忽略此警告。",
  );
}

console.log("✅ Validation complete");
