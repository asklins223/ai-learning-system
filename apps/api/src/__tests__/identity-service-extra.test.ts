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
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_TTL_MS,
  nextSessionExpiry,
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

test("SESSION_TTL_MS 是 30 天滑动窗口", () => {
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

// ─── 滑动续期策略 ────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

function sessionAge(days: number) {
  const now = new Date("2026-09-15T00:00:00.000Z");
  const createdAt = new Date(now.getTime() - days * DAY);
  return { createdAt, expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS), now };
}

test("刚签发的会话不触发续期写入", () => {
  assert.equal(nextSessionExpiry(sessionAge(1)), null);
});

test("剩余寿命过半之前不写库", () => {
  assert.equal(nextSessionExpiry(sessionAge(10)), null);
});

test("剩余寿命不足一半时滑动到整窗口", () => {
  const { createdAt, expiresAt, now } = sessionAge(20);
  const renewed = nextSessionExpiry({ createdAt, expiresAt, now });
  assert.ok(renewed);
  assert.equal(renewed.getTime(), now.getTime() + SESSION_TTL_MS);
});

test("续期不得越过绝对上限", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  // 175 天前创建：窗口早已滑到上限之外，只能续到 createdAt + 180 天。
  const createdAt = new Date(now.getTime() - 175 * DAY);
  const expiresAt = new Date(now.getTime() + 1 * DAY);
  const renewed = nextSessionExpiry({ createdAt, expiresAt, now });
  assert.ok(renewed);
  assert.equal(renewed.getTime(), createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS);
  assert.ok(renewed.getTime() < now.getTime() + SESSION_TTL_MS);
});

test("到达绝对上限后不再续期", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  const createdAt = new Date(now.getTime() - 181 * DAY);
  assert.equal(nextSessionExpiry({ createdAt, expiresAt: new Date(now.getTime() + 1 * DAY), now }), null);
});

test("每周打开一次的用户可以一直用到绝对上限才重新登录", () => {
  // 这是对用户可见承诺的固化：30 天窗口 + 180 天绝对上限，活跃用户约半年免登录。
  const start = new Date("2026-01-01T00:00:00.000Z");
  let expiresAt = new Date(start.getTime() + SESSION_TTL_MS);
  let lastUsableDay = -1;
  for (let day = 0; day <= 400; day += 7) {
    const now = new Date(start.getTime() + day * DAY);
    if (expiresAt.getTime() <= now.getTime()) break;
    lastUsableDay = day;
    const renewed = nextSessionExpiry({ createdAt: start, expiresAt, now });
    if (renewed) expiresAt = renewed;
  }
  assert.equal(lastUsableDay, 175);
  assert.ok(expiresAt.getTime() <= start.getTime() + SESSION_ABSOLUTE_MAX_MS);
});

test("间隔 25 天再打开仍在窗口内，并续满一整窗", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = new Date(start.getTime() + SESSION_TTL_MS);
  const now = new Date(start.getTime() + 25 * DAY);
  assert.ok(expiresAt.getTime() > now.getTime(), "25 天后会话仍应有效");
  const renewed = nextSessionExpiry({ createdAt: start, expiresAt, now });
  assert.ok(renewed);
  assert.equal(renewed.getTime(), now.getTime() + SESSION_TTL_MS);
});

test("超过一整个窗口未打开就会被登出", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = new Date(start.getTime() + SESSION_TTL_MS);
  const now = new Date(start.getTime() + 31 * DAY);
  assert.ok(expiresAt.getTime() <= now.getTime());
  assert.equal(nextSessionExpiry({ createdAt: start, expiresAt, now }), null);
});

test("已过期或恰好到期的会话不会被续活", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  const createdAt = new Date(now.getTime() - 20 * DAY);
  assert.equal(nextSessionExpiry({ createdAt, expiresAt: new Date(now.getTime()), now }), null);
  assert.equal(nextSessionExpiry({ createdAt, expiresAt: new Date(now.getTime() - DAY), now }), null);
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
