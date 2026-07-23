/**
 * identity/service.ts 纯函数补充测试
 *
 * 覆盖 canonicalizeEmail、generateDefaultWorkspaceName、
 * SESSION_TTL_MS、RECOVERED_PASSWORD_SENTINEL 等纯函数和常量。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeEmail,
  generateDefaultWorkspaceName,
  SESSION_TTL_MS,
  RECOVERED_PASSWORD_SENTINEL,
  hashPassword,
  type SessionContext,
  type WorkspaceInfo,
} from "../modules/identity/service.ts";

// ─── canonicalizeEmail ───────────────────────────────────────────────────

test("canonicalizeEmail 转小写", () => {
  assert.equal(canonicalizeEmail("User@Example.COM"), "user@example.com");
});

test("canonicalizeEmail 去除首尾空白", () => {
  assert.equal(canonicalizeEmail("  user@example.com  "), "user@example.com");
});

test("canonicalizeEmail 组合空白和小写", () => {
  assert.equal(canonicalizeEmail("  MyEmail@TEST.org  "), "myemail@test.org");
});

test("canonicalizeEmail 空字符串", () => {
  assert.equal(canonicalizeEmail(""), "");
});

test("canonicalizeEmail 只有空白", () => {
  assert.equal(canonicalizeEmail("   "), "");
});

test("canonicalizeEmail 已规范化的邮箱不变", () => {
  assert.equal(canonicalizeEmail("user@example.com"), "user@example.com");
});

// ─── generateDefaultWorkspaceName ────────────────────────────────────────

test("generateDefaultWorkspaceName 使用 displayName", () => {
  assert.equal(generateDefaultWorkspaceName("小明", "user@example.com"), "小明的工作区");
});

test("generateDefaultWorkspaceName displayName 为空时使用 email 本地部分", () => {
  assert.equal(generateDefaultWorkspaceName(null, "user@example.com"), "user的工作区");
});

test("generateDefaultWorkspaceName displayName 为 undefined 时使用 email 本地部分", () => {
  assert.equal(generateDefaultWorkspaceName(undefined, "test@test.org"), "test的工作区");
});

test("generateDefaultWorkspaceName displayName 为空字符串时使用 email 本地部分", () => {
  assert.equal(generateDefaultWorkspaceName("", "admin@site.com"), "admin的工作区");
});

test("generateDefaultWorkspaceName displayName 为空白时使用 email 本地部分", () => {
  assert.equal(generateDefaultWorkspaceName("   ", "hello@world.com"), "hello的工作区");
});

test("generateDefaultWorkspaceName email 无 @ 时使用整个 email", () => {
  assert.equal(generateDefaultWorkspaceName(null, "noemail"), "noemail的工作区");
});

test("generateDefaultWorkspaceName email 和 displayName 都为空时使用默认值", () => {
  assert.equal(generateDefaultWorkspaceName(null, ""), "用户的工作区");
});

test("generateDefaultWorkspaceName 超长 displayName 被截断", () => {
  const longName = "a".repeat(100);
  const result = generateDefaultWorkspaceName(longName, "user@example.com");
  // MAX_WORKSPACE_NAME_LENGTH=50, 预留 "的工作区" 4 字符，base 截断到 46
  assert.ok(result.length <= 50, `工作区名称应 ≤50 字符，实际 ${result.length}`);
  assert.ok(result.endsWith("的工作区"));
});

test("generateDefaultWorkspaceName 超长 email 本地部分被截断", () => {
  const longEmail = `${"b".repeat(100)}@example.com`;
  const result = generateDefaultWorkspaceName(null, longEmail);
  assert.ok(result.length <= 50, `工作区名称应 ≤50 字符，实际 ${result.length}`);
  assert.ok(result.endsWith("的工作区"));
});

// ─── 常量验证 ────────────────────────────────────────────────────────────

test("SESSION_TTL_MS 是 7 天的毫秒数", () => {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.equal(SESSION_TTL_MS, sevenDaysMs);
});

test("RECOVERED_PASSWORD_SENTINEL 是非空字符串", () => {
  assert.equal(typeof RECOVERED_PASSWORD_SENTINEL, "string");
  assert.ok(RECOVERED_PASSWORD_SENTINEL.length > 0);
});

test("RECOVERED_PASSWORD_SENTINEL 不以 $2 开头（不是 bcrypt 哈希）", () => {
  assert.ok(!RECOVERED_PASSWORD_SENTINEL.startsWith("$2"));
});

// ─── hashPassword ────────────────────────────────────────────────────────

test("hashPassword 返回 bcrypt 哈希字符串", async () => {
  const hash = await hashPassword("testpassword123");
  assert.equal(typeof hash, "string");
  assert.ok(hash.startsWith("$2a$") || hash.startsWith("$2b$"), "应以 $2a$ 或 $2b$ 开头");
});

test("hashPassword 相同密码产生不同哈希（盐随机）", async () => {
  const hash1 = await hashPassword("samepassword");
  const hash2 = await hashPassword("samepassword");
  assert.notEqual(hash1, hash2);
});

// ─── 类型完整性验证 ──────────────────────────────────────────────────────

test("SessionContext 包含 userId 和 workspaceId", () => {
  const ctx: SessionContext = { userId: "u1", workspaceId: "w1" };
  assert.ok("userId" in ctx);
  assert.ok("workspaceId" in ctx);
});

test("WorkspaceInfo 包含 ADR-0009 必需字段", () => {
  const info: WorkspaceInfo = {
    workspaceId: "w1",
    workspaceName: "测试工作区",
    role: "owner",
    workspaceType: "personal",
    isPersonal: true,
    leftAt: null,
  };
  assert.ok("isPersonal" in info, "ADR-0009: 必须包含 isPersonal 字段");
  assert.ok("workspaceType" in info);
  assert.ok("leftAt" in info, "ADR-0009: 必须包含 leftAt 字段");
  assert.ok("role" in info);
});
