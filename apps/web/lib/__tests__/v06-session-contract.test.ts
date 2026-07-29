/**
 * v0.6 Session Idempotency & Draft CAS Contract Tests (计划 §6.4.1/§8.2/§10.4)
 *
 * Security invariants:
 * - 计划 §6.4.1: "action command 对响应丢失、双击和 retry 可回放，
 *   且命中先于 revision/state 校验"
 * - 计划 §8.2: "baseRevision 不一致返回 409 draft_conflict；
 *   evaluation_pending/终态拒绝迟到 PATCH"
 * - 计划 §8.2: "unable 只返回 resultAvailable，答案化内容一律经 reveal-result"
 *
 * Tests verify API client behavior for:
 * 1. Idempotency replay — same key returns same response
 * 2. Idempotency key reuse — different request with same key → 409
 * 3. Draft revision CAS conflict — baseRevision mismatch → 409 draft_conflict
 * 4. Late PATCH rejection — evaluation_pending/terminal rejects draft
 * 5. Unable response minimization — only { status, resultAvailable }
 * 6. Submit response minimization — only { status, jobId }
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../api.ts";
import type { StartSessionResult, DraftResult, SubmitResult, UnableResult } from "../api.ts";

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

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: code, message }, status);
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
  "rubricVersion",
  "reducerVersion",
  "promptVersion",
  "modelId",
  "providerName",
] as const;

function assertNoSensitiveFields(obj: unknown, path = ""): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoSensitiveFields(item, `${path}[${i}]`));
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const field of SENSITIVE_FIELDS) {
    assert.ok(
      !(field in record),
      `Sensitive field "${field}" found in pre-reveal response at path "${path}" — violates 计划 §10.4`,
    );
  }

  for (const [key, value] of Object.entries(record)) {
    assertNoSensitiveFields(value, path ? `${path}.${key}` : key);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("v0.6 session idempotency & draft CAS", () => {
  describe("action command idempotency replay (计划 §6.4.1)", () => {
    it("same idempotency key replays original start response", async () => {
      const originalResponse: StartSessionResult = {
        status: "ready",
        submissionId: "sub-123",
        question: {
          questionId: "q-1",
          questionType: "explain",
          question: "请解释 CAP 定理",
          keyPointOrdinal: 1,
        },
      };

      let callCount = 0;
      mockFetch(() => {
        callCount++;
        return jsonResponse(originalResponse);
      });

      // First call
      const result1 = await api.startValidationSession("card-1", {
        idempotencyKey: "idem-replay-1",
      });

      // Second call with same key — should get same response (server replays)
      const result2 = await api.startValidationSession("card-1", {
        idempotencyKey: "idem-replay-1",
      });

      assert.equal(result1.status, result2.status);
      assert.equal(result1.submissionId, result2.submissionId);
      assert.equal(callCount, 2, "API client should make both requests; server handles replay");
    });

    it("different idempotency key creates new session", async () => {
      let keys: string[] = [];
      mockFetch((_url, init) => {
        const body = JSON.parse(init.body as string);
        keys.push(body.idempotencyKey);
        return jsonResponse({
          status: "ready",
          submissionId: `sub-${keys.length}`,
          question: { questionId: "q-1", questionType: "explain", question: "test" },
        });
      });

      await api.startValidationSession("card-1", { idempotencyKey: "key-A" });
      await api.startValidationSession("card-1", { idempotencyKey: "key-B" });

      assert.deepEqual(keys, ["key-A", "key-B"]);
    });

    it("idempotency key reuse with different request returns 409", async () => {
      mockFetch(() =>
        errorResponse(409, "idempotency_key_reused", "Idempotency key was used with a different request"),
      );

      await assert.rejects(
        api.startValidationSession("card-1", { idempotencyKey: "reused-key" }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          assert.equal(error.code, "idempotency_key_reused");
          return true;
        },
      );
    });

    it("submit with same idempotency key replays original response", async () => {
      const originalResponse: SubmitResult = {
        status: "evaluation_pending",
        jobId: "job-1",
      };

      mockFetch(() => jsonResponse(originalResponse));

      const result1 = await api.submitValidationAnswer("sub-1", {
        answer: "my answer",
        baseRevision: 1,
        idempotencyKey: "submit-replay",
      });

      const result2 = await api.submitValidationAnswer("sub-1", {
        answer: "my answer",
        baseRevision: 1,
        idempotencyKey: "submit-replay",
      });

      assert.equal(result1.status, result2.status);
      assert.equal(result1.jobId, result2.jobId);
    });
  });

  describe("draft revision CAS conflict (计划 §8.2)", () => {
    it("baseRevision mismatch returns 409 draft_conflict", async () => {
      mockFetch(() =>
        errorResponse(409, "draft_conflict", "Draft revision mismatch"),
      );

      await assert.rejects(
        api.draftValidationAnswer("sub-1", {
          answer: "new text",
          baseRevision: 0, // stale revision
          idempotencyKey: "draft-1",
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          assert.equal(error.code, "draft_conflict");
          return true;
        },
      );
    });

    it("successful draft returns revision and answerHash", async () => {
      const draftResult: DraftResult = {
        revision: 2,
        answerHash: "abc123def456",
      };

      mockFetch(() => jsonResponse(draftResult));

      const result = await api.draftValidationAnswer("sub-1", {
        answer: "my answer",
        baseRevision: 1,
        idempotencyKey: "draft-1",
      });

      assert.equal(result.revision, 2);
      assert.ok(result.answerHash);
      assertNoSensitiveFields(result, "draftResult");
    });

    it("late PATCH to evaluation_pending is rejected (计划 §8.2)", async () => {
      mockFetch(() =>
        errorResponse(409, "invalid_state_transition", "Cannot draft in evaluation_pending state"),
      );

      await assert.rejects(
        api.draftValidationAnswer("sub-1", {
          answer: "late answer",
          baseRevision: 3,
          idempotencyKey: "late-draft",
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          return true;
        },
      );
    });

    it("late PATCH to terminal state is rejected", async () => {
      mockFetch(() =>
        errorResponse(409, "invalid_state_transition", "Cannot draft in completed state"),
      );

      await assert.rejects(
        api.draftValidationAnswer("sub-1", {
          answer: "late answer",
          baseRevision: 5,
          idempotencyKey: "late-draft-2",
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          return true;
        },
      );
    });
  });

  describe("unable response minimization (计划 §8.2)", () => {
    it("unable only returns { status, resultAvailable }", async () => {
      mockFetch(() => jsonResponse({
        status: "completed",
        resultAvailable: true,
      }));

      const result = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "unable-1",
      });

      // Only two fields allowed
      assert.deepEqual(
        Object.keys(result).sort(),
        ["resultAvailable", "status"],
      );

      // No sensitive fields (feedback, rubric, evidence, answer)
      assertNoSensitiveFields(result, "unableResult");
    });

    it("unable does not return feedback or evidence content", async () => {
      mockFetch(() => jsonResponse({
        status: "completed",
        resultAvailable: true,
      }));

      const result = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "unable-2",
      }) as unknown as Record<string, unknown>;

      // Explicitly check that answer-bearing fields are NOT present
      assert.ok(!("feedback" in result), "unable must not return feedback");
      assert.ok(!("rubricItems" in result), "unable must not return rubricItems");
      assert.ok(!("evidenceRefs" in result), "unable must not return evidenceRefs");
      assert.ok(!("outcome" in result), "unable must not return outcome");
      assert.ok(!("userAnswer" in result), "unable must not return userAnswer");
    });

    it("unable with same idempotency key replays original response", async () => {
      const originalResponse: UnableResult = {
        status: "completed",
        resultAvailable: true,
      };

      mockFetch(() => jsonResponse(originalResponse));

      const result1 = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "unable-replay",
      });

      const result2 = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "unable-replay",
      });

      assert.equal(result1.status, result2.status);
      assert.equal(result1.resultAvailable, result2.resultAvailable);
    });
  });

  describe("submit response minimization (计划 §8.2)", () => {
    it("submit only returns { status, jobId }", async () => {
      mockFetch(() => jsonResponse({
        status: "evaluation_pending",
        jobId: "job-123",
      }));

      const result = await api.submitValidationAnswer("sub-1", {
        answer: "final answer",
        baseRevision: 3,
        idempotencyKey: "submit-1",
      });

      // Only allowed fields
      const allowedFields = ["status", "jobId"];
      for (const key of Object.keys(result)) {
        assert.ok(
          allowedFields.includes(key),
          `Unexpected field "${key}" in SubmitResult — submit must only return status and jobId`,
        );
      }

      // No sensitive fields
      assertNoSensitiveFields(result, "submitResult");
    });

    it("submit does not return feedback or outcome", async () => {
      mockFetch(() => jsonResponse({
        status: "evaluation_pending",
        jobId: "job-1",
      }));

      const result = await api.submitValidationAnswer("sub-1", {
        answer: "answer",
        baseRevision: 1,
        idempotencyKey: "submit-2",
      }) as unknown as Record<string, unknown>;

      assert.ok(!("feedback" in result), "submit must not return feedback");
      assert.ok(!("outcome" in result), "submit must not return outcome");
      assert.ok(!("rubricItems" in result), "submit must not return rubricItems");
    });
  });

  describe("reveal-source response (计划 §7.4)", () => {
    it("reveal-source returns assistance level and source availability", async () => {
      mockFetch(() => jsonResponse({
        assistanceLevel: "source_viewed",
        sourceAvailable: true,
      }));

      const result = await api.revealValidationSource("sub-1", {
        idempotencyKey: "reveal-1",
      });

      assert.equal(result.assistanceLevel, "source_viewed");
      assert.equal(result.sourceAvailable, true);

      // No answer-bearing content in reveal-source response
      assertNoSensitiveFields(result, "revealSourceResult");
    });

    it("reveal-source with same idempotency key is idempotent", async () => {
      mockFetch(() => jsonResponse({
        assistanceLevel: "source_viewed",
        sourceAvailable: true,
      }));

      const result1 = await api.revealValidationSource("sub-1", {
        idempotencyKey: "reveal-idem",
      });

      const result2 = await api.revealValidationSource("sub-1", {
        idempotencyKey: "reveal-idem",
      });

      assert.equal(result1.assistanceLevel, result2.assistanceLevel);
      assert.equal(result1.sourceAvailable, result2.sourceAvailable);
    });
  });

  describe("blocked state responses (计划 §9.2)", () => {
    it("no_hard_evidence blocked status does not throw", async () => {
      mockFetch(() => jsonResponse({
        status: "blocked",
        reason: "no_hard_evidence",
      }));

      const result = await api.startValidationSession("card-1", {
        idempotencyKey: "blocked-1",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "no_hard_evidence");
      // No submissionId for blocked status
      assert.ok(!result.submissionId, "blocked status must not create submission");
    });

    it("assistance_cooldown blocked status includes unassistedEligibleAt", async () => {
      const eligibleAt = "2026-07-26T12:00:00Z";
      mockFetch(() => jsonResponse({
        status: "blocked",
        reason: "assistance_cooldown",
        unassistedEligibleAt: eligibleAt,
      }));

      const result = await api.startValidationSession("card-1", {
        idempotencyKey: "blocked-2",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "assistance_cooldown");
      assert.equal(result.unassistedEligibleAt, eligibleAt);
    });

    it("unsafe_fallback blocked status is non-retryable", async () => {
      mockFetch(() => jsonResponse({
        status: "blocked",
        reason: "unsafe_fallback",
      }));

      const result = await api.startValidationSession("card-1", {
        idempotencyKey: "blocked-3",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "unsafe_fallback");
    });
  });

  describe("abandon response (计划 §8.2)", () => {
    it("abandon returns abandoned status", async () => {
      mockFetch(() => jsonResponse({
        status: "abandoned",
      }));

      const result = await api.abandonValidationSession("sub-1", {
        idempotencyKey: "abandon-1",
      });

      assert.equal(result.status, "abandoned");
      assertNoSensitiveFields(result, "abandonResult");
    });

    it("abandon with same idempotency key is idempotent", async () => {
      mockFetch(() => jsonResponse({ status: "abandoned" }));

      const result1 = await api.abandonValidationSession("sub-1", {
        idempotencyKey: "abandon-replay",
      });

      const result2 = await api.abandonValidationSession("sub-1", {
        idempotencyKey: "abandon-replay",
      });

      assert.equal(result1.status, result2.status);
    });
  });
});
