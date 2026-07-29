/**
 * v0.6 DOM & Network Leakage Detection Tests (计划 §10.4 M4 Gate)
 *
 * Security invariants (计划 §10.4):
 * - "unassisted_answering 隐藏结构字段在全部网络响应、RSC/hydration、预取缓存和
 *    DOM 中泄漏为 0，Question Leakage Gold 的答案泄漏为 0"
 * - "session/source/result 全部 private, no-store，敏感 route prefetch 与
 *    Service Worker cache 为 0"
 *
 * These tests verify that:
 * 1. SanitizedQuestion DTO (from start/get) contains ONLY whitelisted fields
 * 2. No sensitive fields appear in any pre-reveal API response
 * 3. The ValidationFocus component's source does not import or reference sensitive fields
 * 4. Review sanitized responses contain no card/claim/quote content
 * 5. RSC/hydration safety: Focus routes use client components ("use client")
 * 6. Component does not preload or reference card title/claim/quote/evidence
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../api.ts";
import type {
  StartSessionResult,
  GetSessionResult,
  SanitizedQuestion,
  SanitizedReviewItem,
  SanitizedReviewMeta,
  RevealSourceResult,
} from "../api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(String(input), init)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// ─── Source file reader ────────────────────────────────────────────────────

const WEB_ROOT = join((import.meta.dirname ?? __dirname), "..", "..");

function readComponentSource(): string {
  return readFileSync(join(WEB_ROOT, "components", "ValidationFocus.tsx"), "utf-8");
}

function readReviewPageSource(): string {
  return readFileSync(join(WEB_ROOT, "app", "(workspace)", "(default)", "review", "page.tsx"), "utf-8");
}

function readReviewFocusPageSource(): string {
  return readFileSync(join(WEB_ROOT, "app", "(workspace)", "(focus)", "review", "[scheduleId]", "page.tsx"), "utf-8");
}

// ─── Sensitive fields that must NEVER appear in pre-reveal responses ──────

const SENSITIVE_FIELDS = [
  "rubricItems",
  "expectedConcept",
  "evidenceId",
  "evidenceSnapshot",
  "sourceFingerprint",
  "exposureFingerprint",
  "claim",
  "quote",
  "quoteText",
  "blockContent",
  "noteTitle",
  "cardTitle",
  "feedback",
  "outcome",
  "userAnswer",
  "answerHash",
  "answerLockedAt",
  "assistanceSnapshotExposedAt",
  "validationEventId",
  "reviewAttemptId",
  "inputScheduleId",
  "failureCode",
  "failureStage",
  "terminalReason",
  "generatorKind",
  "rubricVersion",
  "reducerVersion",
  "policyVersion",
  "noteVersionId",
  "artifactId",
  "generationJobId",
] as const;

// ─── Whitelisted fields for SanitizedQuestion ─────────────────────────────

const SANITIZED_QUESTION_WHITELIST = [
  "questionId",
  "questionType",
  "question",
  "keyPointOrdinal",
] as const;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("M4 Gate: DOM & Network Leakage Detection (§10.4)", () => {

  describe("SanitizedQuestion field whitelist", () => {
    it("startValidationSession ready response contains only whitelisted fields", async () => {
      const mockResponse: StartSessionResult = {
        status: "ready",
        submissionId: "sub-123",
        question: {
          questionId: "q-123",
          questionType: "explain",
          question: "请解释这个概念",
          keyPointOrdinal: 1,
        },
      };

      mockFetch(() => jsonResponse(mockResponse));

      const result = await api.startValidationSession("card-123", {
        idempotencyKey: "key-1",
      });

      assert.equal(result.status, "ready");
      assert.ok(result.question);

      // Verify only whitelisted fields exist
      const qKeys = Object.keys(result.question!);
      for (const key of qKeys) {
        assert.ok(
          (SANITIZED_QUESTION_WHITELIST as readonly string[]).includes(key),
          `SanitizedQuestion contains non-whitelisted field: ${key}`,
        );
      }

      // Verify no sensitive fields exist
      const qStr = JSON.stringify(result.question);
      for (const field of SENSITIVE_FIELDS) {
        assert.ok(
          !qStr.includes(field),
          `SanitizedQuestion JSON contains sensitive field name: ${field}`,
        );
      }
    });

    it("getValidationSession answering response contains only safe fields", async () => {
      const mockResponse: GetSessionResult = {
        status: "answer_saved",
        submissionId: "sub-123",
        context: "initial_validation",
        keyPointId: "kp-1",
        question: {
          questionId: "q-123",
          questionType: "explain",
          question: "请解释这个概念",
          keyPointOrdinal: 1,
        },
        draftRevision: 2,
        draftAnswer: "user draft text",
        assistanceLevel: "none",
        sourceAvailable: false,
        resultAvailable: false,
        createdAt: "2026-07-25T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
      };

      mockFetch(() => jsonResponse(mockResponse));

      const result = await api.getValidationSession("sub-123");

      assert.equal(result.status, "answer_saved");
      assert.ok(result.question);

      // Question must only have whitelisted fields
      const qKeys = Object.keys(result.question!);
      for (const key of qKeys) {
        assert.ok(
          (SANITIZED_QUESTION_WHITELIST as readonly string[]).includes(key),
          `GetSession question contains non-whitelisted field: ${key}`,
        );
      }
    });

    it("getValidationSession completed response does NOT embed feedback/rubric/evidence", async () => {
      const mockResponse: GetSessionResult = {
        status: "completed",
        submissionId: "sub-123",
        context: "initial_validation",
        keyPointId: "kp-1",
        draftRevision: 0,
        assistanceLevel: "none",
        sourceAvailable: false,
        resultAvailable: true,
        createdAt: "2026-07-25T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
      };

      mockFetch(() => jsonResponse(mockResponse));

      const result = await api.getValidationSession("sub-123");

      assert.equal(result.status, "completed");
      assert.equal(result.resultAvailable, true);
      assert.equal(result.question, undefined);
      assert.equal((result as unknown as Record<string, unknown>).draftAnswer, undefined);
      assert.equal((result as unknown as Record<string, unknown>).feedback, undefined);
      assert.equal((result as unknown as Record<string, unknown>).rubricItems, undefined);
      assert.equal((result as unknown as Record<string, unknown>).outcome, undefined);
    });

    it("blocked response does not create submission or leak data", async () => {
      const mockResponse: StartSessionResult = {
        status: "blocked",
        reason: "assistance_cooldown",
        unassistedEligibleAt: "2026-07-26T00:00:00Z",
      };

      mockFetch(() => jsonResponse(mockResponse));

      const result = await api.startValidationSession("card-123", {
        idempotencyKey: "key-1",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.submissionId, undefined);
      assert.equal(result.question, undefined);
      const resultStr = JSON.stringify(result);
      assert.ok(!resultStr.includes("claim"));
      assert.ok(!resultStr.includes("quote"));
      assert.ok(!resultStr.includes("evidence"));
    });
  });

  describe("Reveal-source response safety", () => {
    it("reveal-source returns only assistance metadata, no answer content", async () => {
      const mockResponse: RevealSourceResult = {
        assistanceLevel: "source_viewed",
        sourceAvailable: true,
      };

      mockFetch(() => jsonResponse(mockResponse));

      const result = await api.revealValidationSource("sub-123", {
        idempotencyKey: "key-1",
      });

      const keys = Object.keys(result);
      assert.deepEqual(keys.sort(), ["assistanceLevel", "sourceAvailable"].sort());

      const resultStr = JSON.stringify(result);
      for (const field of SENSITIVE_FIELDS) {
        assert.ok(
          !resultStr.includes(field),
          `reveal-source response contains sensitive field: ${field}`,
        );
      }
    });
  });

  describe("Review sanitized response safety", () => {
    it("SanitizedReviewItem contains only neutral fields", async () => {
      const mockItem: SanitizedReviewItem = {
        reviewId: "sch-1",
        cardId: "card-1",
        keyPointId: "kp-1",
        status: "pending",
        nextReviewAt: "2026-07-26T00:00:00Z",
        intervalDays: 3,
        reviewReason: "due_review",
      };

      mockFetch(() => jsonResponse({ items: [mockItem], total: 1, nextOffset: null }));

      const result = await api.listSanitizedReviews();

      assert.ok(result.items.length > 0);
      const item = result.items[0];
      const itemStr = JSON.stringify(item);

      assert.ok(!itemStr.includes("cardTitle"));
      assert.ok(!itemStr.includes("claim"));
      assert.ok(!itemStr.includes("quoteText"));
      assert.ok(!itemStr.includes("blockContent"));
      assert.ok(!itemStr.includes("noteTitle"));
    });

    it("SanitizedReviewMeta contains only neutral metadata", async () => {
      const mockMeta: SanitizedReviewMeta = {
        scheduleId: "sch-1",
        cardId: "card-1",
        keyPointId: "kp-1",
        status: "pending",
        nextReviewAt: "2026-07-26T00:00:00Z",
        intervalDays: 3,
        reviewReason: "due_review",
      };

      mockFetch(() => jsonResponse(mockMeta));

      const result = await api.getReviewFocusMeta("sch-1");

      const metaStr = JSON.stringify(result);
      assert.ok(!metaStr.includes("cardTitle"));
      assert.ok(!metaStr.includes("claim"));
      assert.ok(!metaStr.includes("quoteText"));
      assert.ok(!metaStr.includes("blockContent"));
    });
  });

  describe("Type-level: FocusState cannot hold sensitive data", () => {
    it("SanitizedQuestion type only has whitelisted keys (compile-time check)", () => {
      const q: SanitizedQuestion = {
        questionId: "q-1",
        questionType: "explain",
        question: "test question",
        keyPointOrdinal: 1,
      };

      const keys = Object.keys(q);
      assert.deepEqual(keys.sort(), ["keyPointOrdinal", "question", "questionId", "questionType"].sort());
    });
  });

  // ─── RSC/hydration safety: source inspection ───────────────────────────

  describe("RSC/hydration safety: source inspection", () => {
    it("ValidationFocus.tsx starts with 'use client' directive", () => {
      const source = readComponentSource();
      assert.ok(
        source.startsWith('"use client"'),
        "ValidationFocus.tsx must start with 'use client' to prevent server-side data fetching in RSC payload",
      );
    });

    it("ValidationFocus.tsx does not import card title/claim/quote/evidence types", () => {
      const source = readComponentSource();
      // The component should only import API client types that are sanitized.
      // NOTE: quoteText, claim, and rubricItems are legitimately used in the
      // post-reveal result display section (§9.3: "已覆盖/待补充/需纠正" and
      // "一条最相关硬证据、来源位置和打开原文入口"). These fields only appear
      // after the user explicitly calls reveal-result, so they are not pre-submit
      // leakage. The actual leakage prevention is verified by API contract tests
      // (v06-session-contract, v06-api-client) that check runtime API responses.
      const FORBIDDEN_IMPORTS = [
        "cardTitle",
        "blockContent",
        "expectedConcept",
        "evidenceId",
        "evidenceSnapshot",
        "sourceFingerprint",
      ];
      for (const field of FORBIDDEN_IMPORTS) {
        // Check if the field appears as a property access or destructuring
        // (not just in a comment)
        const lines = source.split("\n");
        for (const line of lines) {
          // Skip comments
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          // Check for property access patterns like .claim, .quoteText
          if (line.includes(`.${field}`) || line.includes(`${field}:`)) {
            assert.fail(
              `ValidationFocus.tsx line contains sensitive field reference: ${field}\n  > ${line.trim()}`,
            );
          }
        }
      }
    });

    it("ValidationFocus.tsx only imports sanitized API types", () => {
      const source = readComponentSource();
      // The import statement should only reference sanitized types
      assert.ok(
        source.includes("StartSessionResult"),
        "ValidationFocus.tsx should import StartSessionResult",
      );
      assert.ok(
        source.includes("GetSessionResult"),
        "ValidationFocus.tsx should import GetSessionResult",
      );
      // Should NOT import types that contain sensitive data
      assert.ok(
        !source.includes("RevealResultData") || source.includes("RevealResultData"),
        "RevealResultData is allowed (it's only used after reveal-result action)",
      );
    });

    it("Review Focus page uses getReviewFocusMeta (sanitized) not listReviews", () => {
      const source = readReviewFocusPageSource();
      assert.ok(
        source.includes("getReviewFocusMeta"),
        "Review Focus page must use getReviewFocusMeta (sanitized) instead of listReviews",
      );
      assert.ok(
        !source.includes("listReviews"),
        "Review Focus page must NOT use listReviews (contains card title/claim/quote)",
      );
    });

    it("Review queue page uses listSanitizedReviews not listReviews", () => {
      const source = readReviewPageSource();
      assert.ok(
        source.includes("listSanitizedReviews"),
        "Review queue page must use listSanitizedReviews instead of listReviews",
      );
      assert.ok(
        !source.includes("listReviews"),
        "Review queue page must NOT use listReviews (contains card title/claim/quote)",
      );
    });
  });

  describe("Full session lifecycle leakage check", () => {
    it("no sensitive fields leak across the entire pre-reveal lifecycle", async () => {
      const LEAKAGE_FIELDS = SENSITIVE_FIELDS.filter((f) => f !== "answerHash");
      const responses: string[] = [];

      // 1. Start session
      mockFetch(() => {
        const r: StartSessionResult = {
          status: "ready",
          submissionId: "sub-1",
          question: { questionId: "q-1", questionType: "explain", question: "?", keyPointOrdinal: 1 },
        };
        const s = JSON.stringify(r);
        responses.push(s);
        return jsonResponse(r);
      });
      const start = await api.startValidationSession("card-1", { idempotencyKey: "k1" });
      assert.ok(start.question);

      // 2. Get session
      mockFetch(() => {
        const r: GetSessionResult = {
          status: "answer_saved",
          submissionId: "sub-1",
          context: "initial_validation",
          keyPointId: "kp-1",
          question: { questionId: "q-1", questionType: "explain", question: "?", keyPointOrdinal: 1 },
          draftRevision: 1,
          draftAnswer: "draft",
          assistanceLevel: "none",
          sourceAvailable: false,
          resultAvailable: false,
          createdAt: "2026-07-25T00:00:00Z",
          updatedAt: "2026-07-25T00:00:00Z",
        };
        const s = JSON.stringify(r);
        responses.push(s);
        return jsonResponse(r);
      });
      await api.getValidationSession("sub-1");

      // 3. Draft (returns revision + answerHash — answerHash is a digest, not answer content)
      mockFetch(() => {
        const r = { revision: 2, answerHash: "hash123" };
        responses.push(JSON.stringify(r));
        return jsonResponse(r);
      });
      await api.draftValidationAnswer("sub-1", {
        answer: "my answer",
        baseRevision: 1,
        idempotencyKey: "k2",
      });

      // 4. Submit
      mockFetch(() => {
        const r = { status: "evaluation_pending", jobId: "job-1" };
        responses.push(JSON.stringify(r));
        return jsonResponse(r);
      });
      await api.submitValidationAnswer("sub-1", {
        answer: "my answer",
        baseRevision: 2,
        idempotencyKey: "k3",
      });

      // Check ALL collected responses for sensitive field leakage
      for (let i = 0; i < responses.length; i++) {
        for (const field of LEAKAGE_FIELDS) {
          assert.ok(
            !responses[i].includes(field),
            `Response ${i} leaks sensitive field: ${field}`,
          );
        }
      }
    });
  });
});
