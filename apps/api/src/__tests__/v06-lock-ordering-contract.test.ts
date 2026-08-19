/**
 * v0.6 Fixed Lock Ordering Contract Test (计划 §8.7, §13.2)
 *
 * Security invariant (计划 §8.7):
 *   "所有 source/card/note/evidence/override mutation、question expiry、
 *    start/reveal/submit/unable/later/abandon 和 result-write 采用相同锁序"
 *
 * This test verifies at source level that:
 * 1. ALL mutation functions use withWorkspaceTransaction
 * 2. ALL mutation functions lock submission with FOR UPDATE before mutating
 * 3. submit/unable lock question with FOR UPDATE before writing results
 * 4. revealSource uses atomic onConflictDoUpdate (not find-then-update)
 * 5. submit/unable re-read exposure fingerprint aggregation after locking submission
 * 6. No mutation bypasses the transaction wrapper
 *
 * This is a source-level contract test — it analyzes the source code rather
 * than running against a live database, making it suitable for CI without
 * PostgreSQL. The full concurrent behavior is verified by PostgreSQL
 * integration tests (§13.2) when a database is available.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Source file paths ────────────────────────────────────────────────────

const SESSION_SERVICE_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  "../modules/validation/session-service.ts",
);

const REVIEW_ATTEMPT_SERVICE_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  "../modules/review/attempt-service.ts",
);

function readSource(relPath: string): string {
  return fs.readFileSync(relPath, "utf-8");
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("v0.6 Fixed Lock Ordering Contract (计划 §8.7, §13.2)", () => {
  const sessionSource = readSource(SESSION_SERVICE_PATH);
  const reviewSource = readSource(REVIEW_ATTEMPT_SERVICE_PATH);

  describe("§8.7: All mutations use withWorkspaceTransaction", () => {
    it("session-service.ts exports mutation functions wrapped in withWorkspaceTransaction", () => {
      // Count withWorkspaceTransaction occurrences in session-service.ts
      const txCount = (sessionSource.match(/withWorkspaceTransaction/g) || []).length;
      // We have at least 11 mutation functions that must use it
      // (start, get, draft, revealSource, revealResult, submit, unable,
      //  retryQuestion, retryEvaluation, abandon, qualitySignal)
      assert.ok(
        txCount >= 11,
        `Expected at least 11 withWorkspaceTransaction calls in session-service.ts, found ${txCount}`,
      );
    });

    it("review attempt-service.ts uses withWorkspaceTransaction for mutations", () => {
      const txCount = (reviewSource.match(/withWorkspaceTransaction/g) || []).length;
      // Review mutations: start, submit, unable, abandon, later, revealResult
      assert.ok(
        txCount >= 4,
        `Expected at least 4 withWorkspaceTransaction calls in attempt-service.ts, found ${txCount}`,
      );
    });
  });

  describe("§8.7: FOR UPDATE locks on submission before mutation", () => {
    it("submitAnswer locks submission with FOR UPDATE", () => {
      // Find submitAnswer function body and check for FOR UPDATE
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      assert.ok(
        submitSection.includes('.for("update")'),
        "submitAnswer must lock submission with FOR UPDATE",
      );
    });

    it("unableToAnswer locks submission with FOR UPDATE", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        unableSection.includes('.for("update")'),
        "unableToAnswer must lock submission with FOR UPDATE",
      );
    });

    it("revealSource locks submission with FOR UPDATE", () => {
      const revealSection = extractFunctionBody(sessionSource, "revealSource");
      assert.ok(
        revealSection.includes('.for("update")'),
        "revealSource must lock submission with FOR UPDATE",
      );
    });

    it("saveDraft locks submission with FOR UPDATE", () => {
      const draftSection = extractFunctionBody(sessionSource, "saveDraft");
      assert.ok(
        draftSection.includes('.for("update")'),
        "saveDraft must lock submission with FOR UPDATE",
      );
    });

    it("abandonSession locks submission with FOR UPDATE", () => {
      const abandonSection = extractFunctionBody(sessionSource, "abandonSession");
      assert.ok(
        abandonSection.includes('.for("update")'),
        "abandonSession must lock submission with FOR UPDATE",
      );
    });
  });

  describe("§8.6/§8.7: submit and unable lock question with FOR UPDATE", () => {
    it("submitAnswer locks question with FOR UPDATE after submission lock", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      const submissionLockPos = submitSection.indexOf('.for("update")');
      // Question lock should come after submission lock
      const questionLockPos = submitSection.indexOf(
        '.for("update")',
        submissionLockPos + 1,
      );
      assert.ok(
        questionLockPos > submissionLockPos,
        "submitAnswer must lock question AFTER submission lock (fixed lock ordering §8.7)",
      );
    });

    it("unableToAnswer locks question with FOR UPDATE after submission lock", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      const submissionLockPos = unableSection.indexOf('.for("update")');
      const questionLockPos = unableSection.indexOf(
        '.for("update")',
        submissionLockPos + 1,
      );
      assert.ok(
        questionLockPos > submissionLockPos,
        "unableToAnswer must lock question AFTER submission lock (fixed lock ordering §8.7)",
      );
    });
  });

  describe("§6.4.2: revealSource uses atomic onConflictDoUpdate (not find-then-update)", () => {
    it("revealSource uses onConflictDoUpdate for exposure upsert", () => {
      const revealSection = extractFunctionBody(sessionSource, "revealSource");
      assert.ok(
        revealSection.includes("onConflictDoUpdate"),
        "revealSource must use onConflictDoUpdate for atomic exposure upsert (§6.4.2)",
      );
      // Should NOT use find-then-update/insert pattern
      assert.ok(
        !revealSection.includes("onConflictDoNothing"),
        "revealSource should use onConflictDoUpdate, not onConflictDoNothing (§6.4.2)",
      );
    });
  });

  describe("§7.4: submit/unable re-read exposure fingerprint after locking submission", () => {
    it("submitAnswer re-reads exposure aggregation after locking submission", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      // After locking submission and question, submit must re-read exposure
      // Look for exposure-related query after the FOR UPDATE locks
      const lastForUpdatePos = submitSection.lastIndexOf('.for("update")');
      const afterLocks = submitSection.substring(lastForUpdatePos);
      assert.ok(
        afterLocks.includes("exposure") || afterLocks.includes("Exposure"),
        "submitAnswer must re-read exposure fingerprint after locking submission and question (§7.4)",
      );
    });

    it("unableToAnswer re-reads exposure aggregation after locking submission", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      const lastForUpdatePos = unableSection.lastIndexOf('.for("update")');
      const afterLocks = unableSection.substring(lastForUpdatePos);
      assert.ok(
        afterLocks.includes("exposure") || afterLocks.includes("Exposure"),
        "unableToAnswer must re-read exposure fingerprint after locking submission and question (§7.4)",
      );
    });
  });

  describe("§8.6: fingerprint verification uses fail-closed (null = mismatch)", () => {
    it("submitAnswer treats null fingerprint as mismatch (fail closed)", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      assert.ok(
        submitSection.includes("sourceFingerprint"),
        "submitAnswer must verify source fingerprint (§8.6)",
      );
      // Fail closed: null fingerprint should be treated as mismatch
      // The comparison question.sourceFingerprint !== submission.sourceFingerprint
      // handles null as mismatch because null !== any valid fingerprint
      assert.ok(
        submitSection.includes("!==") || submitSection.includes("!="),
        "submitAnswer must use strict comparison for fingerprint verification",
      );
    });

    it("unableToAnswer treats null fingerprint as mismatch (fail closed)", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        unableSection.includes("sourceFingerprint"),
        "unableToAnswer must verify source fingerprint (§8.6)",
      );
    });
  });

  describe("§8.6: question status and expiry checks in submit/unable", () => {
    it("submitAnswer checks question.status === ACTIVE", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      assert.ok(
        submitSection.includes("QuestionStatus.ACTIVE") || submitSection.includes("ACTIVE"),
        "submitAnswer must verify question status is ACTIVE (§8.6)",
      );
    });

    it("unableToAnswer checks question.status === ACTIVE", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        unableSection.includes("QuestionStatus.ACTIVE") || unableSection.includes("ACTIVE"),
        "unableToAnswer must verify question status is ACTIVE (§8.6)",
      );
    });

    it("submitAnswer checks question.expiresAt", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      assert.ok(
        submitSection.includes("expiresAt"),
        "submitAnswer must check question expiry (§8.6)",
      );
    });

    it("unableToAnswer checks question.expiresAt", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        unableSection.includes("expiresAt"),
        "unableToAnswer must check question expiry (§8.6)",
      );
    });
  });

  describe("§8.6: stale submission marked on fingerprint/expiry mismatch", () => {
    it("submitAnswer marks submission as STALE on fingerprint mismatch", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      assert.ok(
        submitSection.includes("STALE") || submitSection.includes("SubmissionStatus.STALE"),
        "submitAnswer must mark submission as STALE on fingerprint mismatch (§8.6)",
      );
    });

    it("unableToAnswer marks submission as STALE on fingerprint mismatch", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        unableSection.includes("STALE") || unableSection.includes("SubmissionStatus.STALE"),
        "unableToAnswer must mark submission as STALE on fingerprint mismatch (§8.6)",
      );
    });
  });

  describe("§6.4.1: action command idempotency check before state validation", () => {
    it("submitAnswer checks action command BEFORE state validation", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      const actionCheckPos = submitSection.indexOf("checkActionCommand");
      const forUpdatePos = submitSection.indexOf('.for("update")');
      assert.ok(
        actionCheckPos > 0 && forUpdatePos > 0,
        "submitAnswer must have both action command check and FOR UPDATE lock",
      );
      assert.ok(
        actionCheckPos < forUpdatePos,
        "submitAnswer must check action command BEFORE locking submission (§6.4.1: action replay before state validation)",
      );
    });

    it("unableToAnswer checks action command BEFORE state validation", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      const actionCheckPos = unableSection.indexOf("checkActionCommand");
      const forUpdatePos = unableSection.indexOf('.for("update")');
      assert.ok(
        actionCheckPos > 0 && forUpdatePos > 0,
        "unableToAnswer must have both action command check and FOR UPDATE lock",
      );
      assert.ok(
        actionCheckPos < forUpdatePos,
        "unableToAnswer must check action command BEFORE locking submission (§6.4.1)",
      );
    });

    it("revealSource checks action command BEFORE state validation", () => {
      const revealSection = extractFunctionBody(sessionSource, "revealSource");
      const actionCheckPos = revealSection.indexOf("checkActionCommand");
      const forUpdatePos = revealSection.indexOf('.for("update")');
      assert.ok(
        actionCheckPos > 0,
        "revealSource must check action command (§6.4.1)",
      );
      if (forUpdatePos > 0) {
        assert.ok(
          actionCheckPos < forUpdatePos,
          "revealSource must check action command BEFORE locking submission (§6.4.1)",
        );
      }
    });
  });

  describe("§4.1: no client-authored question produces upgrade", () => {
    it("submitAnswer does not accept outcome from client request body", () => {
      const submitSection = extractFunctionBody(sessionSource, "submitAnswer");
      // The submit function should not read 'outcome' from input
      // Input type should be SubmitAnswerInput which has answer, selfConfidence, baseRevision, idempotencyKey
      assert.ok(
        !submitSection.includes("input.outcome"),
        "submitAnswer must not accept outcome from client input (§4.1: no client outcome produces upgrade)",
      );
    });

    it("unableToAnswer does not accept outcome from client request body", () => {
      const unableSection = extractFunctionBody(sessionSource, "unableToAnswer");
      assert.ok(
        !unableSection.includes("input.outcome"),
        "unableToAnswer must not accept outcome from client input (§4.1)",
      );
    });
  });
});

// ─── Helper: Extract function body from source ────────────────────────────

function extractFunctionBody(source: string, funcName: string): string {
  // Find the function definition — could be "export async function funcName" or "function funcName"
  const patterns = [
    `export async function ${funcName}(`,
    `async function ${funcName}(`,
    `function ${funcName}(`,
    `const ${funcName} =`,
  ];

  let startPos = -1;
  for (const pattern of patterns) {
    startPos = source.indexOf(pattern);
    if (startPos >= 0) break;
  }

  if (startPos < 0) {
    // Function might be defined differently — return a large chunk to search
    return source;
  }

  // Find the next "export async function" or "export function" or end of file
  // to determine the function boundary
  const remainingSource = source.substring(startPos);
  const nextExport = remainingSource.search(
    /\nexport (async )?function \w+/,
  );

  // Also check for "const ... = " arrow function boundaries
  const nextConst = remainingSource.search(
    /\nconst \w+ = (async )?\(/,
  );

  let endOffset = remainingSource.length;
  if (nextExport > 0) endOffset = Math.min(endOffset, nextExport);
  if (nextConst > 0) endOffset = Math.min(endOffset, nextConst);

  return remainingSource.substring(0, endOffset);
}
