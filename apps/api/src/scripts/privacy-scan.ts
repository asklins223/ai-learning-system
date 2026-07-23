/**
 * OPS-01: 隐私扫描脚本（ADR-0006 §7）
 *
 * 自动扫描 metrics 文本和日志 artifact，验证不存在禁采内容：
 *   - Canary secret（API Key、密码、token 片段）
 *   - 学习正文（笔记内容、用户回答、quote、question）
 *   - 完整 URL query 参数
 *   - Cookie / CSRF / Authorization header 值
 *   - Provider 原始请求/响应
 *
 * 用法：
 *   node --import tsx scripts/privacy-scan.ts --metrics-url http://localhost:4000/metrics
 *   node --import tsx scripts/privacy-scan.ts --file /tmp/metrics-output.txt
 *   node --import tsx scripts/privacy-scan.ts --text "raw text to scan"
 *
 * 退出码：
 *   0 — 未发现禁采内容
 *   1 — 发现禁采内容（或参数错误）
 *
 * CI 集成：
 *   在 unit-tests 和 production-compose 之后运行，
 *   拉取 /metrics 端点文本并扫描。
 */

import { readFile } from "node:fs/promises";

// ─── Canary 模式定义 ─────────────────────────────────────────────────────

/**
 * 禁采内容模式列表。
 * 每个模式包含名称、正则和描述。
 * 如果在 metrics/日志文本中匹配到任一模式，扫描失败。
 */
interface CanaryPattern {
  /** 模式名称 */
  name: string;
  /** 匹配正则表达式 */
  pattern: RegExp;
  /** 描述为什么禁止 */
  reason: string;
}

const CANARY_PATTERNS: CanaryPattern[] = [
  {
    name: "api_key_canary",
    // 匹配常见 API key 格式：sk-xxx、dashscope key、Bearer token
    pattern: /(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,}|dashscope-[a-zA-Z0-9]{20,})/i,
    reason: "API Key / Bearer token 不应出现在 metrics 或日志中（ADR-0006 §4）",
  },
  {
    name: "password_canary",
    // 匹配 password=xxx 或 passwordHash 明文
    pattern: /(?:password\s*[=:]\s*["']?[a-zA-Z0-9!@#$%^&*]{8,}|password_hash\s*[=:]\s*["']?\$2[aby])/i,
    reason: "密码明文或 hash 不应出现在 metrics 或日志中",
  },
  {
    name: "cookie_canary",
    // 匹配 Set-Cookie 或 Cookie header 值
    pattern: /(?:Set-Cookie\s*:|Cookie\s*:)[^\n\r]{10,}/i,
    reason: "Cookie 值不应出现在 metrics 或日志中（ADR-0006 §4）",
  },
  {
    name: "authorization_header",
    // 匹配 Authorization header
    pattern: /Authorization\s*:\s*(?:Bearer|Basic|Digest)\s+[a-zA-Z0-9._-]{10,}/i,
    reason: "Authorization header 不应出现在 metrics 或日志中",
  },
  {
    name: "csrf_token",
    // 匹配 CSRF token
    pattern: /(?:csrf[_-]?token|x-csrf-token)\s*[=:]\s*["']?[a-zA-Z0-9]{16,}/i,
    reason: "CSRF token 不应出现在 metrics 或日志中",
  },
  {
    name: "url_query_params",
    // 匹配 URL 中的 query 参数（可能包含敏感信息）
    // 注意：normalizeRouteTemplate 应已去除 query，此检查捕获遗漏
    pattern: /(?:https?:\/\/[^\s"']+\/[^\s"']*\?[a-zA-Z_]+=[a-zA-Z0-9%]+)/i,
    reason: "完整 URL query 参数不应出现在 metrics 中（ADR-0006 §4）",
  },
  {
    name: "lease_token_raw",
    // 匹配原始 lease token（UUID 格式的 lease token）
    // 注意：指标 label 只应记录不可复用短 fingerprint
    pattern: /lease[_-]?token\s*[=:]\s*["']?[a-f0-9-]{36}/i,
    reason: "原始 lease token 不应出现在 metrics 中，应使用短 fingerprint",
  },
  {
    name: "note_content_canary",
    // 匹配可能的笔记正文（JSON blocks 中的 text/content/answer 等字段）
    // 启发式检查：字段值超过 30 字符视为疑似正文泄漏
    // （正常 metrics label 值通常为短枚举，不会超过 30 字符）
    pattern: /"(?:text|content|body|answer|quote_text|question)"\s*:\s*"[^"]{30,}"/i,
    reason: "笔记/回答/引文正文不应出现在 metrics 或日志中（ADR-0006 §4）",
  },
  {
    name: "provider_raw_response",
    // 匹配 Provider 原始响应片段（output/choices/message 等字段后跟大括号）
    // 超过 40 字符的 JSON 对象视为疑似 Provider 响应泄漏
    // 注意：JSON key 可能带引号（如 "output":），正则允许可选引号
    pattern: /"?(?:output|choices|message|completion)"?\s*:\s*\{[^}]{40,}\}/i,
    reason: "Provider 原始响应不应出现在 metrics 或日志中（ADR-0006 §4）",
  },
  {
    name: "private_ip_canary",
    // 匹配私有 IP 地址（可能在连接字符串中泄漏）
    // 只标记明确带密码的连接字符串
    pattern: /postgres:\/\/[a-zA-Z]+:[^@]+@(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/i,
    reason: "包含密码的数据库连接字符串不应出现在 metrics 或日志中",
  },
];

// ─── 扫描结果 ───────────────────────────────────────────────────────────

interface ScanResult {
  /** 扫描的文本长度 */
  textLength: number;
  /** 发现的违规项 */
  violations: Array<{
    patternName: string;
    reason: string;
    /** 匹配到的文本片段（截断到 100 字符避免二次泄漏） */
    matchPreview: string;
  }>;
  /** 是否通过 */
  passed: boolean;
}

/**
 * 扫描文本中是否包含禁采内容。
 *
 * @param text - 要扫描的文本（metrics 输出或日志内容）
 * @returns 扫描结果
 */
export function scanForPrivacyViolations(text: string): ScanResult {
  const violations: ScanResult["violations"] = [];

  for (const canary of CANARY_PATTERNS) {
    const match = text.match(canary.pattern);
    if (match) {
      // 截断匹配文本，避免在报告中二次泄漏完整 secret
      const preview = match[0].slice(0, 80) + (match[0].length > 80 ? "…" : "");
      violations.push({
        patternName: canary.name,
        reason: canary.reason,
        matchPreview: preview,
      });
    }
  }

  return {
    textLength: text.length,
    violations,
    passed: violations.length === 0,
  };
}

// ─── CLI 入口 ───────────────────────────────────────────────────────────

interface CliArgs {
  metricsUrl: string | null;
  file: string | null;
  text: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { metricsUrl: null, file: null, text: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--metrics-url" && next) {
      result.metricsUrl = next;
      i++;
    } else if (arg === "--file" && next) {
      result.file = next;
      i++;
    } else if (arg === "--text" && next) {
      result.text = next;
      i++;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  let text: string;

  if (args.metricsUrl) {
    // 从 /metrics 端点拉取
    console.log(`[privacy-scan] Fetching metrics from: ${args.metricsUrl}`);
    const response = await fetch(args.metricsUrl);
    if (!response.ok) {
      console.error(`[privacy-scan] Failed to fetch metrics: HTTP ${response.status}`);
      process.exit(1);
    }
    text = await response.text();
  } else if (args.file) {
    // 从文件读取
    console.log(`[privacy-scan] Reading file: ${args.file}`);
    text = await readFile(args.file, "utf8");
  } else if (args.text) {
    // 直接扫描文本
    console.log(`[privacy-scan] Scanning provided text (${args.text.length} chars)`);
    text = args.text;
  } else {
    console.error("Usage: privacy-scan.ts --metrics-url <url> | --file <path> | --text <string>");
    process.exit(1);
  }

  const result = scanForPrivacyViolations(text);

  console.log(`[privacy-scan] Scanned ${result.textLength} characters`);
  console.log(`[privacy-scan] Found ${result.violations.length} violation(s)`);

  if (result.violations.length > 0) {
    for (const v of result.violations) {
      console.error(`[privacy-scan] VIOLATION: ${v.patternName}`);
      console.error(`[privacy-scan]   Reason: ${v.reason}`);
      console.error(`[privacy-scan]   Preview: ${v.matchPreview}`);
    }
    process.exit(1);
  }

  console.log("[privacy-scan] PASS: no privacy violations detected");
  process.exit(0);
}

// 仅在直接执行时运行 CLI（被 import 时不运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[privacy-scan] Fatal error:", err);
    process.exit(1);
  });
}
