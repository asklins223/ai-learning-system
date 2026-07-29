import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const API_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const REPO_ROOT = resolve(API_ROOT, "../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("v0.6 legacy review target compatibility", () => {
  const sessionSource = read("apps/api/src/modules/validation/session-service.ts");
  const attemptSource = read("apps/api/src/modules/review/attempt-service.ts");
  const workerSource = read("workers/ai-worker/src/handlers/index.ts");

  it("resolves the key point from the locked schedule instead of requiring the new column", () => {
    assert.ok(!sessionSource.includes('if (!schedule.keyPointId) throw new SessionError("no_key_point")'));
    assert.ok(sessionSource.includes("schedule.validationEventId ?? schedule.subjectId"));
    assert.ok(sessionSource.includes("resolvedReviewKeyPointId"));
    assert.ok(sessionSource.includes("scheduleCardId !== cardId"));
    assert.ok(sessionSource.includes("keyPointId: resolvedReviewKeyPointId"));
  });

  it("does not let the client override the target of a review schedule", () => {
    assert.ok(
      sessionSource.includes("submissionContext === SubmissionContext.REVIEW")
        && sessionSource.includes("? resolvedReviewKeyPointId"),
    );
    assert.ok(!sessionSource.includes('(input as { keyPointId?: string }).keyPointId'));
  });

  it("all active legacy writers carry a resolved key point into new schedules", () => {
    assert.match(
      workerSource,
      /subjectType:\s*"validation"[\s\S]{0,180}keyPointId:\s*kp!\.id[\s\S]{0,120}status:\s*ReviewStatus\.PENDING/,
    );
    assert.match(
      attemptSource,
      /\.insert\(reviewSchedules\)[\s\S]{0,350}keyPointId,[\s\S]{0,120}status:\s*ReviewStatus\.PENDING/,
    );
  });
});
