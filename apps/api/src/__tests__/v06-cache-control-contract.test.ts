/**
 * v0.6 Cache-Control Contract Test (计划 §8.2/§10.4)
 *
 * Security invariant (计划 §10.4):
 *   "session/source/result 全部 `private, no-store`，
 *    敏感 route prefetch 与 Service Worker cache 为 0"
 *
 * This test verifies that ALL v0.6 validation session routes and
 * v0.6 review sanitized routes set the `Cache-Control: private, no-store`
 * header on their responses.
 *
 * Approach: source-level analysis counting route definitions vs
 * NO_STORE header references to ensure complete coverage.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────

function readSource(relPath: string): string {
  const absPath = path.resolve(
    import.meta.dirname ?? __dirname,
    relPath,
  );
  return fs.readFileSync(absPath, "utf-8");
}

/**
 * Count occurrences of a substring in source code,
 * excluding comment lines (lines starting with // or *).
 */
function countOccurrences(source: string, pattern: string | RegExp): number {
  const lines = source.split("\n");
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comment lines
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (typeof pattern === "string") {
      if (line.includes(pattern)) count++;
    } else {
      if (pattern.test(line)) count++;
    }
  }
  return count;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("v0.6 Cache-Control contract (计划 §10.4)", () => {
  const sessionRoutesSource = readSource("../modules/validation/session-routes.ts");
  const reviewRoutesSource = readSource("../modules/review/routes.ts");

  describe("validation session routes — all 10 endpoints", () => {
    // Count route definitions: app.post/app.get/app.patch patterns
    const routeDefinitionCount = countOccurrences(
      sessionRoutesSource,
      /app\.(post|get|patch|delete|put)</,
    );

    // Count NO_STORE header applications
    const noStoreCount = countOccurrences(sessionRoutesSource, "NO_STORE");

    it("defines at least 10 route handlers", () => {
      assert.ok(
        routeDefinitionCount >= 10,
        `Expected at least 10 route definitions, found ${routeDefinitionCount}`,
      );
    });

    it("defines NO_STORE constant with correct value", () => {
      assert.ok(
        sessionRoutesSource.includes('const NO_STORE'),
        "session-routes.ts must define NO_STORE constant",
      );
      const noStoreDef = sessionRoutesSource.match(
        /const\s+NO_STORE\s*=\s*\{[^}]*"Cache-Control"[^}]*"private,\s*no-store"[^}]*\}/,
      );
      assert.ok(
        noStoreDef,
        "NO_STORE constant must be { 'Cache-Control': 'private, no-store' }",
      );
    });

    it("every route handler sets NO_STORE header (count match)", () => {
      // Every route should have a reply.headers(NO_STORE) call.
      // We subtract 1 for the constant definition line itself.
      const expectedApplications = routeDefinitionCount;
      const actualApplications = noStoreCount - 1; // subtract constant definition

      assert.ok(
        actualApplications >= expectedApplications,
        `Expected at least ${expectedApplications} NO_STORE applications (one per route), found ${actualApplications}. ` +
          `Route count: ${routeDefinitionCount}, NO_STORE references: ${noStoreCount}`,
      );
    });

    it("all known endpoint paths are present", () => {
      const expectedPaths = [
        "/cards/:cardId/validation-sessions/start",
        "/validation-sessions/:submissionId",
        "/validation-sessions/:submissionId/draft",
        "/validation-sessions/:submissionId/reveal-source",
        "/validation-sessions/:submissionId/reveal-result",
        "/validation-sessions/:submissionId/submit",
        "/validation-sessions/:submissionId/unable",
        "/validation-sessions/:submissionId/retry-question",
        "/validation-sessions/:submissionId/retry-evaluation",
        "/validation-sessions/:submissionId/abandon",
      ];

      for (const routePath of expectedPaths) {
        assert.ok(
          sessionRoutesSource.includes(`"${routePath}"`),
          `Missing route: ${routePath}`,
        );
      }
    });
  });

  describe("review sanitized routes", () => {
    it("defines GET /reviews with sanitized=true branch", () => {
      assert.ok(
        reviewRoutesSource.includes("sanitized"),
        "review/routes.ts must handle sanitized query parameter",
      );
      assert.ok(
        reviewRoutesSource.includes('"private, no-store"') ||
          reviewRoutesSource.includes("'private, no-store'"),
        "Sanitized review list route must set Cache-Control: private, no-store",
      );
    });

    it("defines GET /reviews/:scheduleId/sanitized endpoint", () => {
      assert.ok(
        reviewRoutesSource.includes("/reviews/:scheduleId/sanitized"),
        "Missing GET /reviews/:scheduleId/sanitized route",
      );
    });

    it("sanitized meta endpoint sets Cache-Control: private, no-store", () => {
      // The /reviews/:scheduleId/sanitized route must set private, no-store
      const routeIdx = reviewRoutesSource.indexOf("/reviews/:scheduleId/sanitized");
      assert.ok(routeIdx > -1, "Route not found");

      // Find the handler block after this route definition
      const handlerBlock = reviewRoutesSource.slice(routeIdx, routeIdx + 2000);
      assert.ok(
        handlerBlock.includes('"private, no-store"') ||
          handlerBlock.includes("'private, no-store'"),
        "GET /reviews/:scheduleId/sanitized must set Cache-Control: private, no-store",
      );
    });
  });

  describe("Cache-Control value verification", () => {
    it("session-routes NO_STORE value is exactly 'private, no-store'", () => {
      const match = sessionRoutesSource.match(
        /const\s+NO_STORE\s*=\s*\{\s*"Cache-Control"\s*:\s*"([^"]+)"\s*\}/,
      );
      assert.ok(match, "NO_STORE constant not found or malformed");
      assert.equal(
        match![1],
        "private, no-store",
        `NO_STORE value must be "private, no-store", got "${match![1]}"`,
      );
    });

    it("review sanitized routes use 'private, no-store'", () => {
      const hasCorrectValue = reviewRoutesSource.includes('"private, no-store"');
      assert.ok(hasCorrectValue, "Review routes must use 'private, no-store' value");
    });
  });
});
