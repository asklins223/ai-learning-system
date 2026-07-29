import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  new URL("../../components/ValidationFocus.tsx", import.meta.url),
  "utf8",
);

describe("v0.6 validation focus resilience", () => {
  it("does not publish raw API or worker error messages to the alert UI", () => {
    assert.doesNotMatch(source, /job\.lastError\s*\|\|/);
    assert.doesNotMatch(source, /err instanceof Error\s*\?\s*err\.message/);
    assert.match(source, /getValidationActionErrorMessage/);
  });

  it("clears stale retry errors and renders only the mapped safe feedback", () => {
    assert.match(
      source,
      /handleRetryQuestion[\s\S]*?acquireActionLock\("retry-question"\)[\s\S]*?error: undefined[\s\S]*?api\.retryValidationQuestion/,
    );
    assert.match(
      source,
      /handleRetryEvaluation[\s\S]*?acquireActionLock\("retry-evaluation"\)[\s\S]*?error: undefined[\s\S]*?api\.retryValidationEvaluation/,
    );
    assert.match(
      source,
      /state\.phase === "question_retryable"[\s\S]*?detail=\{state\.error \?\? "你的学习进度没有受到影响，可以立即重试，或稍后再回来。"\}/,
    );
    assert.match(
      source,
      /state\.phase === "evaluation_retryable"[\s\S]*?detail=\{state\.error \?\? "你的最终答案已经保存，不会丢失。可以重新发起评估。"\}/,
    );
  });

  it("pairs the keyboard shortcut listener with lifecycle cleanup", () => {
    assert.equal(
      source.match(/document\.addEventListener\("keydown", handler\)/g)?.length,
      1,
    );
    assert.equal(
      source.match(/document\.removeEventListener\("keydown", handler\)/g)?.length,
      1,
    );
  });

  it("reconciles failed jobs against the authoritative session state", () => {
    assert.match(
      source,
      /job\.status === "failed"[\s\S]*api\.getValidationSession\(submissionId\)/,
    );
    assert.match(source, /session\.status === "question_blocked" \? "unsafe_fallback"/);
  });

  it("retains action keys for uncertain retries", () => {
    assert.match(source, /getOrCreateActionKey/);
    assert.match(source, /clearActionKeyOnDefinitiveFailure/);
    assert.doesNotMatch(source, /idempotencyKeyRef/);
  });
});
