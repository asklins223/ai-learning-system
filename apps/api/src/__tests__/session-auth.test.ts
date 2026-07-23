/**
 * session-auth.ts 单元测试
 *
 * 覆盖所有纯函数：parseCookieHeader, extractAuthCredential, generateCsrfToken,
 * secureCookiesEnabled, createAuthCookieHeaders, createClearAuthCookieHeaders,
 * hasValidCookieCsrf
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  parseCookieHeader,
  extractAuthCredential,
  generateCsrfToken,
  secureCookiesEnabled,
  createAuthCookieHeaders,
  createClearAuthCookieHeaders,
  hasValidCookieCsrf,
} from "../modules/identity/session-auth.ts";

// ─── parseCookieHeader ────────────────────────────────────────────────────

test("parseCookieHeader: undefined 返回空对象", () => {
  assert.deepEqual(parseCookieHeader(undefined), {});
});

test("parseCookieHeader: 空字符串返回空对象", () => {
  assert.deepEqual(parseCookieHeader(""), {});
});

test("parseCookieHeader: 单个 cookie 正确解析", () => {
  const result = parseCookieHeader("ailearn_session=abc123");
  assert.equal(result.ailearn_session, "abc123");
});

test("parseCookieHeader: 多个 cookie 用分号分隔", () => {
  const result = parseCookieHeader("a=1; b=2; c=3");
  assert.equal(result.a, "1");
  assert.equal(result.b, "2");
  assert.equal(result.c, "3");
});

test("parseCookieHeader: 值含 URL 编码字符正确解码", () => {
  const result = parseCookieHeader("key=" + encodeURIComponent("hello world!"));
  assert.equal(result.key, "hello world!");
});

test("parseCookieHeader: 分号后有空格也能正确解析", () => {
  const result = parseCookieHeader("a=1; b=2");
  assert.equal(result.a, "1");
  assert.equal(result.b, "2");
});

test("parseCookieHeader: 无等号的部分被跳过", () => {
  const result = parseCookieHeader("a=1; invalid; b=2");
  assert.equal(result.a, "1");
  assert.equal(result.b, "2");
  assert.ok(!result.invalid);
});

test("parseCookieHeader: key 为空的部分被跳过", () => {
  const result = parseCookieHeader("=value; a=1");
  assert.equal(result.a, "1");
  assert.equal(Object.keys(result).length, 1);
});

test("parseCookieHeader: 畸形的 URI 编码不崩溃，跳过该值", () => {
  const result = parseCookieHeader("bad=%E0; good=ok");
  assert.ok(result.good === "ok");
  // bad 值可能被跳过或保留为原始值
});

// ─── extractAuthCredential ────────────────────────────────────────────────

test("extractAuthCredential: Bearer token 正确提取", () => {
  const result = extractAuthCredential({
    authorization: "Bearer my-token-123",
  });
  assert.ok(result);
  assert.equal(result.token, "my-token-123");
  assert.equal(result.source, "bearer");
});

test("extractAuthCredential: bearer 大小写不敏感", () => {
  const result = extractAuthCredential({
    authorization: "bearer my-token",
  });
  assert.ok(result);
  assert.equal(result.source, "bearer");
});

test("extractAuthCredential: cookie 中的 session token 正确提取", () => {
  const result = extractAuthCredential({
    cookie: `${SESSION_COOKIE_NAME}=cookie-token-value`,
  });
  assert.ok(result);
  assert.equal(result.token, "cookie-token-value");
  assert.equal(result.source, "cookie");
});

test("extractAuthCredential: Bearer 优先于 cookie", () => {
  const result = extractAuthCredential({
    authorization: "Bearer bearer-token",
    cookie: `${SESSION_COOKIE_NAME}=cookie-token`,
  });
  assert.ok(result);
  assert.equal(result.source, "bearer");
  assert.equal(result.token, "bearer-token");
});

test("extractAuthCredential: 无任何凭证返回 null", () => {
  assert.equal(extractAuthCredential({}), null);
});

test("extractAuthCredential: 空 authorization 返回 null", () => {
  assert.equal(extractAuthCredential({ authorization: "" }), null);
});

test("extractAuthCredential: authorization 格式不对返回 null", () => {
  assert.equal(extractAuthCredential({ authorization: "Basic abc123" }), null);
});

test("extractAuthCredential: cookie 中无 session 返回 null", () => {
  const result = extractAuthCredential({
    cookie: "other_cookie=value",
  });
  assert.equal(result, null);
});

test("extractAuthCredential: Bearer 后无 token 返回 null", () => {
  const result = extractAuthCredential({
    authorization: "Bearer ",
  });
  assert.equal(result, null);
});

// ─── generateCsrfToken ───────────────────────────────────────────────────

test("generateCsrfToken: 返回非空字符串", () => {
  const token = generateCsrfToken();
  assert.ok(token.length > 0);
  assert.equal(typeof token, "string");
});

test("generateCsrfToken: 每次调用生成不同值", () => {
  const token1 = generateCsrfToken();
  const token2 = generateCsrfToken();
  assert.notEqual(token1, token2);
});

test("generateCsrfToken: 是 base64url 编码", () => {
  const token = generateCsrfToken();
  // base64url 字符集：A-Z a-z 0-9 - _
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

// ─── secureCookiesEnabled ────────────────────────────────────────────────

test("secureCookiesEnabled: AUTH_COOKIE_SECURE=true 返回 true", () => {
  assert.equal(secureCookiesEnabled({ AUTH_COOKIE_SECURE: "true" }), true);
});

test("secureCookiesEnabled: AUTH_COOKIE_SECURE=false 返回 false", () => {
  assert.equal(secureCookiesEnabled({ AUTH_COOKIE_SECURE: "false" }), false);
});

test("secureCookiesEnabled: NODE_ENV=production 返回 true", () => {
  assert.equal(secureCookiesEnabled({ NODE_ENV: "production" }), true);
});

test("secureCookiesEnabled: NODE_ENV=development 返回 false", () => {
  assert.equal(secureCookiesEnabled({ NODE_ENV: "development" }), false);
});

test("secureCookiesEnabled: 未设置任何环境变量返回 false", () => {
  assert.equal(secureCookiesEnabled({}), false);
});

test("secureCookiesEnabled: AUTH_COOKIE_SECURE 优先于 NODE_ENV", () => {
  assert.equal(
    secureCookiesEnabled({ AUTH_COOKIE_SECURE: "false", NODE_ENV: "production" }),
    false,
  );
});

test("secureCookiesEnabled: AUTH_COOKIE_SECURE 大小写不敏感", () => {
  assert.equal(secureCookiesEnabled({ AUTH_COOKIE_SECURE: "TRUE" }), true);
  assert.equal(secureCookiesEnabled({ AUTH_COOKIE_SECURE: "False" }), false);
});

// ─── createAuthCookieHeaders ─────────────────────────────────────────────

test("createAuthCookieHeaders: 返回两个 cookie header", () => {
  const result = createAuthCookieHeaders("session-token", 3600);
  assert.equal(result.headers.length, 2);
  assert.ok(result.csrfToken);
});

test("createAuthCookieHeaders: session cookie 包含 HttpOnly", () => {
  const result = createAuthCookieHeaders("session-token", 3600);
  assert.ok(result.headers[0].includes("HttpOnly"));
  assert.ok(result.headers[0].includes(SESSION_COOKIE_NAME));
});

test("createAuthCookieHeaders: csrf cookie 不包含 HttpOnly", () => {
  const result = createAuthCookieHeaders("session-token", 3600);
  assert.ok(!result.headers[1].includes("HttpOnly"));
  assert.ok(result.headers[1].includes(CSRF_COOKIE_NAME));
});

test("createAuthCookieHeaders: 包含 Max-Age", () => {
  const result = createAuthCookieHeaders("session-token", 3600);
  assert.ok(result.headers[0].includes("Max-Age=3600"));
});

test("createAuthCookieHeaders: maxAgeSeconds 为 undefined 时不包含 Max-Age", () => {
  const result = createAuthCookieHeaders("session-token", undefined);
  assert.ok(!result.headers[0].includes("Max-Age"));
});

test("createAuthCookieHeaders: 包含 SameSite=Lax", () => {
  const result = createAuthCookieHeaders("session-token", 3600);
  assert.ok(result.headers[0].includes("SameSite=Lax"));
  assert.ok(result.headers[1].includes("SameSite=Lax"));
});

test("createAuthCookieHeaders: 自定义 csrfToken 被使用", () => {
  const result = createAuthCookieHeaders("session-token", 3600, "custom-csrf");
  assert.equal(result.csrfToken, "custom-csrf");
  assert.ok(result.headers[1].includes("custom-csrf"));
});

test("createAuthCookieHeaders: session token 被 URL 编码", () => {
  const result = createAuthCookieHeaders("token with spaces", 3600);
  assert.ok(result.headers[0].includes(encodeURIComponent("token with spaces")));
});

// ─── createClearAuthCookieHeaders ───────────────────────────────────────

test("createClearAuthCookieHeaders: 返回两个 cookie header", () => {
  const headers = createClearAuthCookieHeaders();
  assert.equal(headers.length, 2);
});

test("createClearAuthCookieHeaders: 包含过期时间", () => {
  const headers = createClearAuthCookieHeaders();
  assert.ok(headers[0].includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"));
  assert.ok(headers[1].includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"));
});

test("createClearAuthCookieHeaders: Max-Age=0", () => {
  const headers = createClearAuthCookieHeaders();
  assert.ok(headers[0].includes("Max-Age=0"));
});

test("createClearAuthCookieHeaders: session cookie 包含 HttpOnly", () => {
  const headers = createClearAuthCookieHeaders();
  assert.ok(headers[0].includes("HttpOnly"));
  assert.ok(headers[0].includes(SESSION_COOKIE_NAME));
});

// ─── hasValidCookieCsrf ──────────────────────────────────────────────────

test("hasValidCookieCsrf: GET 请求总是返回 true", () => {
  assert.equal(hasValidCookieCsrf("GET", {}), true);
});

test("hasValidCookieCsrf: HEAD 请求总是返回 true", () => {
  assert.equal(hasValidCookieCsrf("HEAD", {}), true);
});

test("hasValidCookieCsrf: OPTIONS 请求总是返回 true", () => {
  assert.equal(hasValidCookieCsrf("OPTIONS", {}), true);
});

test("hasValidCookieCsrf: POST 无 csrf cookie 和 header 返回 false", () => {
  assert.equal(hasValidCookieCsrf("POST", {}), false);
});

test("hasValidCookieCsrf: POST 有匹配的 csrf cookie 和 header 返回 true", () => {
  const token = "matching-csrf-token";
  assert.equal(
    hasValidCookieCsrf("POST", {
      cookie: `${CSRF_COOKIE_NAME}=${token}`,
      [CSRF_HEADER_NAME]: token,
    }),
    true,
  );
});

test("hasValidCookieCsrf: POST csrf cookie 和 header 不匹配返回 false", () => {
  assert.equal(
    hasValidCookieCsrf("POST", {
      cookie: `${CSRF_COOKIE_NAME}=token-a`,
      [CSRF_HEADER_NAME]: "token-b",
    }),
    false,
  );
});

test("hasValidCookieCsrf: POST 只有 csrf cookie 无 header 返回 false", () => {
  assert.equal(
    hasValidCookieCsrf("POST", {
      cookie: `${CSRF_COOKIE_NAME}=token`,
    }),
    false,
  );
});

test("hasValidCookieCsrf: POST 只有 csrf header 无 cookie 返回 false", () => {
  assert.equal(
    hasValidCookieCsrf("POST", {
      [CSRF_HEADER_NAME]: "token",
    }),
    false,
  );
});

test("hasValidCookieCsrf: 方法名大小写不敏感", () => {
  assert.equal(hasValidCookieCsrf("get", {}), true);
  assert.equal(hasValidCookieCsrf("Post", {}), false);
});

test("hasValidCookieCsrf: header 为数组时取第一个值", () => {
  const token = "array-csrf-token";
  assert.equal(
    hasValidCookieCsrf("POST", {
      cookie: `${CSRF_COOKIE_NAME}=${token}`,
      [CSRF_HEADER_NAME]: [token, "other"],
    }),
    true,
  );
});
