/**
 * 隐私扫描脚本单元测试
 *
 * 验证 ADR-0006 §7 要求：
 *   - Canary secret 不泄漏
 *   - 学习正文不泄漏
 *   - 正常 metrics 文本不被误报
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scanForPrivacyViolations } from "../scripts/privacy-scan.js";

describe("privacy-scan: scanForPrivacyViolations", () => {
  // ─── 正常 metrics 文本不应触发告警 ────────────────────────────────────

  it("正常 metrics 文本应通过扫描", () => {
    const normalMetrics = [
      "# HELP http_requests_total Total HTTP requests",
      "# TYPE http_requests_total counter",
      'http_requests_total{method="GET",route="/api/cards",status="200"} 42',
      'http_requests_total{method="POST",route="/api/notes",status="201"} 7',
      "",
      "# HELP job_processed_total Total jobs processed",
      "# TYPE job_processed_total counter",
      'job_processed_total{type="understanding_generate",status="success"} 100',
      'job_processed_total{type="card_generate",status="failed"} 3',
      "",
      "# HELP db_up Database connectivity status",
      "# TYPE db_up gauge",
      "db_up 1",
      "",
      "# HELP release_info Release information",
      "# TYPE release_info gauge",
      'release_info{version="0.5.0",commit="abc1234"} 1',
    ].join("\n");

    const result = scanForPrivacyViolations(normalMetrics);
    assert.equal(result.passed, true, `Expected pass, got violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
  });

  it("空文本应通过扫描", () => {
    const result = scanForPrivacyViolations("");
    assert.equal(result.passed, true);
  });

  it("包含路由模板但不含 query 的文本应通过", () => {
    const text = 'http_requests_total{route="/api/cards/:id"} 10';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, true);
  });

  // ─── Canary secret 应被检测 ──────────────────────────────────────────

  it("应检测 sk- 开头的 API Key", () => {
    const text = 'log_line{level="error"} "using key sk-abcdefghijklmnopqrstuvwxyz123456"';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "api_key_canary"));
  });

  it("应检测 Bearer token", () => {
    const text = 'authorization="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "api_key_canary"));
  });

  it("应检测 password 明文", () => {
    const text = 'db_config password="supersecretpassword123"';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "password_canary"));
  });

  it("应检测 password hash", () => {
    const text = 'user{password_hash="$2a$10$abcdefghijklmnopqrstuv"} 1';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "password_canary"));
  });

  it("应检测 Cookie header", () => {
    const text = "Set-Cookie: session=abc123def456; HttpOnly; Secure";
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "cookie_canary"));
  });

  it("应检测 Authorization header", () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "authorization_header"));
  });

  it("应检测 CSRF token", () => {
    const text = 'csrf_token="abcdef1234567890abcdef1234567890"';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "csrf_token"));
  });

  // ─── URL query 参数应被检测 ──────────────────────────────────────────

  it("应检测 URL 中的 query 参数", () => {
    const text = "redirect=https://app.example.com/callback?token=secret123";
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "url_query_params"));
  });

  // ─── 学习正文应被检测 ────────────────────────────────────────────────

  it("应检测 JSON 中的长 text 字段（疑似笔记正文）", () => {
    const text =
      '{"text":"这是一段非常长的笔记正文内容，包含了用户的学习心得和详细的分析过程，这种内容不应该出现在 metrics 或日志中"}';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "note_content_canary"));
  });

  it("应检测 JSON 中的长 content 字段", () => {
    const text =
      '{"content":"用户回答：我认为这个算法的时间复杂度是 O(n log n)，因为每次分区操作需要 O(n) 时间，而递归深度为 O(log n)。"}';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "note_content_canary"));
  });

  it("应检测 JSON 中的 answer 字段（复习回答）", () => {
    const text =
      '{"answer":"这道题的关键在于理解动态规划的状态转移方程，我们需要定义 dp[i] 表示前 i 个元素的最优解，然后通过状态转移方程 dp[i] = max(dp[i-1], dp[i-2] + nums[i]) 来求解。"}';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "note_content_canary"));
  });

  // ─── Provider 原始响应应被检测 ───────────────────────────────────────

  it("应检测 Provider 原始响应片段", () => {
    const text =
      'provider_response: {"output":{"text":"这是一段很长的 AI 生成内容，包含了详细的学习卡片正文和分析，这种 Provider 原始响应不应该出现在日志或 metrics 中","finish_reason":"stop"}}';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "provider_raw_response"));
  });

  // ─── 数据库连接字符串应被检测 ────────────────────────────────────────

  it("应检测带密码的 PostgreSQL 连接字符串", () => {
    const text = "DATABASE_URL=postgres://user:secretpass@192.168.1.100:5432/study";
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "private_ip_canary"));
  });

  // ─── Lease token 原始值应被检测 ─────────────────────────────────────

  it("应检测原始 lease token UUID", () => {
    const text = 'lease_token="a1b2c3d4-e5f6-7890-abcd-ef1234567890"';
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.patternName === "lease_token_raw"));
  });

  // ─── 多重违规 ─────────────────────────────────────────────────────────

  it("应检测多重违规", () => {
    const text = [
      'log{ts="2026-07-19"} "using key sk-abcdefghijklmnopqrstuvwxyz123456"',
      'request_cookie="session=abc123; token=xyz789"',
      '{"text":"这是一段非常长的笔记正文内容，包含了用户的学习心得和详细的分析过程"}',
    ].join("\n");
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    assert.ok(result.violations.length >= 2, `Expected at least 2 violations, got ${result.violations.length}`);
  });

  // ─── matchPreview 应被截断 ──────────────────────────────────────────

  it("matchPreview 应截断到 80 字符以避免二次泄漏", () => {
    const longSecret = "sk-" + "a".repeat(100);
    const text = `key=${longSecret}`;
    const result = scanForPrivacyViolations(text);
    assert.equal(result.passed, false);
    const violation = result.violations.find((v) => v.patternName === "api_key_canary");
    assert.ok(violation);
    assert.ok(violation!.matchPreview.endsWith("…"), "Preview should end with ellipsis");
    assert.ok(violation!.matchPreview.length <= 82, `Preview too long: ${violation!.matchPreview.length}`);
  });

  // ─── 短文本不应误报 note_content ────────────────────────────────────

  it("短 text 字段（<30 字符）不应触发 note_content_canary", () => {
    const text = '{"text":"short text"}';
    const result = scanForPrivacyViolations(text);
    // 短文本不应触发 note_content_canary（但可能触发其他模式，这里只验证不触发这个）
    assert.ok(
      !result.violations.some((v) => v.patternName === "note_content_canary"),
      "Short text should not trigger note_content_canary",
    );
  });
});
