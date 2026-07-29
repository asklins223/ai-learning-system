/**
 * Unit tests for v0.6 Validation Session API client methods (计划 §8.2)
 *
 * Verifies:
 * 1. Each API method calls the correct endpoint with the correct HTTP method
 * 2. Request bodies are properly serialized
 * 3. SanitizedQuestion DTO does NOT contain sensitive fields (leakage prevention)
 * 4. GetSessionResult does NOT contain rubric/expectedConcept/evidence fields
 *
 * Security invariant (计划 §10.4):
 * "unassisted_answering 隐藏结构字段在全部网络响应中泄漏为 0"
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../api.ts";
import type {
  SanitizedQuestion,
  GetSessionResult,
  RevealResultData,
} from "../api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(String(input), init)) as typeof fetch;
}

// ─── Sensitive field names that must NEVER appear in sanitized responses ──

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
      `Sensitive field "${field}" found in sanitized response at path "${path}" — this violates 计划 §10.4`,
    );
  }

  for (const [key, value] of Object.entries(record)) {
    assertNoSensitiveFields(value, path ? `${path}.${key}` : key);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("v0.6 API client methods", () => {
  describe("startValidationSession", () => {
    it("calls POST /cards/:cardId/validation-sessions/start with correct body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";

      mockFetch((url, init) => {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        capturedBody = init.body ? String(init.body) : "";
        return Response.json({
          status: "ready",
          submissionId: "sub-123",
          question: {
            questionId: "q-1",
            questionType: "explain",
            question: "请解释 CAP 定理",
            keyPointOrdinal: 1,
          },
        });
      });

      const result = await api.startValidationSession("card-1", {
        keyPointId: "kp-1",
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/cards/card-1/validation-sessions/start"));
      assert.equal(capturedMethod, "POST");
      const body = JSON.parse(capturedBody);
      assert.equal(body.keyPointId, "kp-1");
      assert.equal(body.idempotencyKey, "idem-1");

      assert.equal(result.status, "ready");
      assert.equal(result.submissionId, "sub-123");
      assert.ok(result.question);
      assert.equal(result.question!.questionId, "q-1");
    });

    it("passes review context and reviewScheduleId when provided", async () => {
      let capturedBody = "";

      mockFetch((_url, init) => {
        capturedBody = init.body ? String(init.body) : "";
        return Response.json({ status: "blocked", reason: "not_yet_due" });
      });

      await api.startValidationSession("card-1", {
        idempotencyKey: "idem-1",
        context: "review",
        reviewScheduleId: "sched-1",
      });

      const body = JSON.parse(capturedBody);
      assert.equal(body.context, "review");
      assert.equal(body.reviewScheduleId, "sched-1");
    });

    it("SanitizedQuestion in response has no sensitive fields", async () => {
      const sanitizedQuestion: SanitizedQuestion = {
        questionId: "q-1",
        questionType: "explain",
        question: "请解释 CAP 定理",
        keyPointOrdinal: 2,
      };

      mockFetch(() => Response.json({
        status: "ready",
        submissionId: "sub-1",
        question: sanitizedQuestion,
      }));

      const result = await api.startValidationSession("card-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(result.question);
      assertNoSensitiveFields(result.question, "question");
      // Only allowed fields
      assert.deepEqual(
        Object.keys(result.question!).sort(),
        ["keyPointOrdinal", "question", "questionId", "questionType"],
      );
    });
  });

  describe("getValidationSession", () => {
    it("calls GET /validation-sessions/:submissionId", async () => {
      let capturedUrl = "";
      let capturedMethod = "";

      mockFetch((url, init) => {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        return Response.json({
          submissionId: "sub-1",
          status: "ready",
          context: "initial_validation",
          keyPointId: "kp-1",
          question: {
            questionId: "q-1",
            questionType: "explain",
            question: "Test question",
          },
          draftRevision: 3,
          draftAnswer: "draft text",
          assistanceLevel: "none",
          sourceAvailable: false,
          resultAvailable: false,
          createdAt: "2026-07-25T00:00:00Z",
          updatedAt: "2026-07-25T00:00:00Z",
        });
      });

      const result = await api.getValidationSession("sub-1");

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1"));
      // GET requests may not explicitly set method (defaults to GET)
      assert.ok(capturedMethod === "GET" || capturedMethod === "");
      assert.equal(result.submissionId, "sub-1");
      assert.equal(result.status, "ready");
      assert.ok(result.question);
    });

    it("GetSessionResult has no sensitive fields (计划 §10.4 leakage prevention)", async () => {
      const sessionResult: GetSessionResult = {
        submissionId: "sub-1",
        status: "ready",
        context: "initial_validation",
        keyPointId: "kp-1",
        question: {
          questionId: "q-1",
          questionType: "explain",
          question: "Test question",
          keyPointOrdinal: 1,
        },
        draftRevision: 0,
        draftAnswer: "",
        assistanceLevel: "none",
        sourceAvailable: false,
        resultAvailable: false,
        createdAt: "2026-07-25T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
      };

      mockFetch(() => Response.json(sessionResult));

      const result = await api.getValidationSession("sub-1");

      // Verify no sensitive fields in the entire response
      assertNoSensitiveFields(result, "getSessionResult");

      // Verify the question DTO only has allowed fields
      if (result.question) {
        assertNoSensitiveFields(result.question, "question");
        const allowedQuestionFields = ["questionId", "questionType", "question", "keyPointOrdinal"];
        for (const key of Object.keys(result.question)) {
          assert.ok(
            allowedQuestionFields.includes(key),
            `Unexpected field "${key}" in SanitizedQuestion`,
          );
        }
      }

      // Verify the session result only has allowed fields (no rubric/evidence/feedback)
      const allowedSessionFields = [
        "submissionId", "status", "context", "keyPointId",
        "question", "draftRevision", "draftAnswer", "selfConfidence",
        "assistanceLevel", "sourceAvailable", "resultAvailable",
        "jobId", "createdAt", "updatedAt",
      ];
      for (const key of Object.keys(result)) {
        assert.ok(
          allowedSessionFields.includes(key),
          `Unexpected field "${key}" in GetSessionResult`,
        );
      }
    });

    it("completed session only returns resultAvailable=true, no feedback/rubric", async () => {
      mockFetch(() => Response.json({
        submissionId: "sub-1",
        status: "completed",
        context: "initial_validation",
        keyPointId: "kp-1",
        draftRevision: 5,
        assistanceLevel: "none",
        sourceAvailable: true,
        resultAvailable: true,
        createdAt: "2026-07-25T00:00:00Z",
        updatedAt: "2026-07-25T00:00:00Z",
      }));

      const result = await api.getValidationSession("sub-1");

      assert.equal(result.status, "completed");
      assert.equal(result.resultAvailable, true);
      assert.equal(result.question, undefined);
      // No feedback, rubricItems, or evidence in the session GET
      assertNoSensitiveFields(result, "completedSession");
    });
  });

  describe("draftValidationAnswer", () => {
    it("calls PATCH /validation-sessions/:submissionId/draft with correct body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";

      mockFetch((url, init) => {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        capturedBody = init.body ? String(init.body) : "";
        return Response.json({ revision: 2, answerHash: "abc123" });
      });

      const result = await api.draftValidationAnswer("sub-1", {
        answer: "my answer",
        selfConfidence: 2,
        baseRevision: 1,
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/draft"));
      assert.equal(capturedMethod, "PATCH");
      const body = JSON.parse(capturedBody);
      assert.equal(body.answer, "my answer");
      assert.equal(body.selfConfidence, 2);
      assert.equal(body.baseRevision, 1);
      assert.equal(body.idempotencyKey, "idem-1");

      assert.equal(result.revision, 2);
      assert.equal(result.answerHash, "abc123");
    });
  });

  describe("submitValidationAnswer", () => {
    it("calls POST /validation-sessions/:submissionId/submit", async () => {
      let capturedUrl = "";
      let capturedMethod = "";

      mockFetch((url, init) => {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        return Response.json({ status: "evaluation_pending", jobId: "job-1" });
      });

      const result = await api.submitValidationAnswer("sub-1", {
        answer: "final answer",
        baseRevision: 3,
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/submit"));
      assert.equal(capturedMethod, "POST");
      assert.equal(result.status, "evaluation_pending");
      assert.equal(result.jobId, "job-1");
    });
  });

  describe("unableValidationAnswer", () => {
    it("calls POST /validation-sessions/:submissionId/unable", async () => {
      let capturedUrl = "";

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json({ status: "completed", resultAvailable: true });
      });

      const result = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/unable"));
      assert.equal(result.status, "completed");
      assert.equal(result.resultAvailable, true);
    });

    it("unable response does not contain feedback or evidence (计划 §8.2)", async () => {
      mockFetch(() => Response.json({
        status: "completed",
        resultAvailable: true,
      }));

      const result = await api.unableValidationAnswer("sub-1", {
        baseRevision: 3,
        idempotencyKey: "idem-1",
      });

      // unable only returns { status, resultAvailable } — no feedback/rubric/evidence
      assertNoSensitiveFields(result, "unableResult");
      assert.deepEqual(Object.keys(result).sort(), ["resultAvailable", "status"]);
    });
  });

  describe("revealValidationSource", () => {
    it("calls POST /validation-sessions/:submissionId/reveal-source", async () => {
      let capturedUrl = "";

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json({ assistanceLevel: "source_viewed", sourceAvailable: true });
      });

      const result = await api.revealValidationSource("sub-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/reveal-source"));
      assert.equal(result.assistanceLevel, "source_viewed");
      assert.equal(result.sourceAvailable, true);
    });
  });

  describe("revealValidationResult", () => {
    it("calls POST /validation-sessions/:submissionId/reveal-result", async () => {
      let capturedUrl = "";

      const revealData: RevealResultData = {
        outcome: "preliminary_understanding",
        feedback: "Good understanding",
        rubricItems: [
          { criterion: "Explain CAP", verdict: "covered", rationale: "Correct" },
          { criterion: "Give example", verdict: "partial", rationale: "Partial" },
        ],
        userAnswer: "my answer",
        evidenceRefs: [
          { quoteText: "CAP theorem states...", alignment: "aligned" },
        ],
      };

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json(revealData);
      });

      const result = await api.revealValidationResult("sub-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/reveal-result"));
      assert.equal(result.outcome, "preliminary_understanding");
      assert.equal(result.rubricItems.length, 2);
      assert.equal(result.evidenceRefs.length, 1);
    });

    it("reveal-result response CAN contain feedback/rubric/evidence (only available after explicit reveal)", async () => {
      // This test verifies that reveal-result is the ONLY endpoint that returns
      // answer-bearing content (计划 §8.2: "答案化内容一律经 reveal-result 揭示")
      mockFetch(() => Response.json({
        outcome: "misunderstanding",
        feedback: "You have a misunderstanding",
        rubricItems: [
          { criterion: "test", verdict: "contradicted" },
        ],
        userAnswer: "wrong answer",
        evidenceRefs: [],
      }));

      const result = await api.revealValidationResult("sub-1", {
        idempotencyKey: "idem-1",
      });

      // These fields ARE expected in reveal-result (it's the explicit reveal action)
      assert.ok("outcome" in result);
      assert.ok("feedback" in result);
      assert.ok("rubricItems" in result);
      assert.ok("userAnswer" in result);
    });
  });

  describe("retryValidationQuestion", () => {
    it("calls POST /validation-sessions/:submissionId/retry-question", async () => {
      let capturedUrl = "";

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json({ status: "question_preparing", jobId: "job-2" });
      });

      const result = await api.retryValidationQuestion("sub-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/retry-question"));
      assert.equal(result.status, "question_preparing");
      assert.equal(result.jobId, "job-2");
    });
  });

  describe("retryValidationEvaluation", () => {
    it("calls POST /validation-sessions/:submissionId/retry-evaluation", async () => {
      let capturedUrl = "";

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json({ status: "evaluation_pending", jobId: "job-3" });
      });

      const result = await api.retryValidationEvaluation("sub-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/retry-evaluation"));
      assert.equal(result.status, "evaluation_pending");
      assert.equal(result.jobId, "job-3");
    });
  });

  describe("abandonValidationSession", () => {
    it("calls POST /validation-sessions/:submissionId/abandon", async () => {
      let capturedUrl = "";

      mockFetch((url) => {
        capturedUrl = url;
        return Response.json({ status: "abandoned" });
      });

      const result = await api.abandonValidationSession("sub-1", {
        idempotencyKey: "idem-1",
      });

      assert.ok(capturedUrl.includes("/validation-sessions/sub-1/abandon"));
      assert.equal(result.status, "abandoned");
    });
  });

  describe("Error handling", () => {
    it("surfaces SessionError codes from the server", async () => {
      mockFetch(() =>
        Response.json(
          { error: "assistance_cooldown", message: "冷却中，请稍后再试" },
          { status: 422 },
        ),
      );

      await assert.rejects(
        api.startValidationSession("card-1", { idempotencyKey: "idem-1" }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 422);
          assert.equal(error.code, "assistance_cooldown");
          return true;
        },
      );
    });

    it("surfaces blocked status without throwing", async () => {
      mockFetch(() => Response.json({
        status: "blocked",
        reason: "no_hard_evidence",
      }));

      const result = await api.startValidationSession("card-1", {
        idempotencyKey: "idem-1",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "no_hard_evidence");
    });
  });
});
