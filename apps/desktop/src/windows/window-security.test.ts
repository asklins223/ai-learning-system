import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternalUrl, isAllowedWindowNavigation } from "./window-security";

test("navigation is restricted to the current dynamic origin", () => {
  const origin = "http://127.0.0.1:3037";
  assert.equal(isAllowedWindowNavigation(`${origin}/login`, origin, "main"), true);
  assert.equal(isAllowedWindowNavigation("http://127.0.0.1:3038/login", origin, "main"), false);
  assert.equal(isAllowedWindowNavigation("https://example.com", origin, "main"), false);
  assert.equal(isAllowedWindowNavigation(`${origin}/companion/pet?surface=electron`, origin, "pet"), true);
  assert.equal(isAllowedWindowNavigation(`${origin}/settings`, origin, "pet"), false);
});

test("external navigation only accepts HTTPS hosts on the explicit allowlist (fail-closed default)", () => {
  // 默认白名单为空 → 任何外链被拒（fail-closed）
  assert.equal(isAllowedExternalUrl("https://example.com/docs"), false);
  assert.equal(isAllowedExternalUrl("https://example.com/docs", ["example.com"]), true);
  assert.equal(isAllowedExternalUrl("http://example.com/docs", ["example.com"]), false);
  assert.equal(isAllowedExternalUrl("https://evil.com/docs", ["example.com"]), false);
  assert.equal(isAllowedExternalUrl("https://sub.example.com/docs", ["example.com"]), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)", ["example.com"]), false);
  assert.equal(isAllowedExternalUrl("not a url", ["example.com"]), false);
});
