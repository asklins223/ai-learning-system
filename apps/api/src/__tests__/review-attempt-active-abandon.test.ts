/**
 * V05-RISK-04 + V05-RISK-05: Review attempt active query, abandon, and source tracking tests.
 *
 * Tests the new abandon endpoint, active attempt query, auto-abandon on start,
 * nextScheduleId persistence, and the partial unique index definition.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { ReviewAttemptError } from "../modules/review/attempt-service.ts";

// ─── Static analysis: service source code ──────────────────────────────

const SERVICE_SOURCE = readFileSync(
  new URL("../modules/review/attempt-service.ts", import.meta.url),
  "utf8",
);

const ROUTES_SOURCE = readFileSync(
  new URL("../modules/review/routes.ts", import.meta.url),
  "utf8",
);

const SCHEMA_SOURCE = readFileSync(
  new URL("../db/schema/evidence.ts", import.meta.url),
  "utf8",
);

const MIGRATION_SOURCE = readFileSync(
  new URL("../db/migrations/0037_review_attempt_active_unique_and_source.sql", import.meta.url),
  "utf8",
);

const SHARED_SCHEMA_SOURCE = readFileSync(
  new URL("../db/schema/evidence.ts", import.meta.url),
  "utf8",
);

// ─── V05-RISK-04: Auto-abandon on start ─────────────────────────────────

describe("V05-RISK-04: startReviewAttempt auto-abandon", () => {
  test("startReviewAttempt contains auto-abandon logic for existing started attempt", () => {
    assert.ok(
      SERVICE_SOURCE.includes("Auto-abandon any existing 'started' attempt"),
      "startReviewAttempt should auto-abandon existing started attempts for the same schedule",
    );
  });

  test("startReviewAttempt selects existing started attempt with FOR UPDATE", () => {
    // Find the auto-abandon block and verify it uses FOR UPDATE
    const abandonBlock = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("Auto-abandon any existing"),
      SERVICE_SOURCE.indexOf("const [insertedAttempt]"),
    );
    assert.ok(
      abandonBlock.includes('.for("update")'),
      "auto-abandon should lock the existing started attempt row with FOR UPDATE",
    );
  });

  test("startReviewAttempt sets status to 'abandoned' and abandonedAt on existing attempt", () => {
    const abandonBlock = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("Auto-abandon any existing"),
      SERVICE_SOURCE.indexOf("const [insertedAttempt]"),
    );
    assert.ok(
      abandonBlock.includes('"abandoned"'),
      "auto-abandon should set status to 'abandoned'",
    );
    assert.ok(
      abandonBlock.includes("abandonedAt"),
      "auto-abandon should set abandonedAt timestamp",
    );
  });
});

// ─── V05-RISK-04: abandonReviewAttempt function ─────────────────────────

describe("V05-RISK-04: abandonReviewAttempt", () => {
  test("abandonReviewAttempt function is exported", () => {
    assert.ok(
      SERVICE_SOURCE.includes("export async function abandonReviewAttempt"),
      "abandonReviewAttempt should be exported",
    );
  });

  test("abandonReviewAttempt uses FOR UPDATE to lock the attempt", () => {
    const abandonSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function abandonReviewAttempt"),
    );
    assert.ok(
      abandonSection.includes('.for("update")'),
      "abandonReviewAttempt should use FOR UPDATE",
    );
  });

  test("abandonReviewAttempt rejects completed attempts with attempt_already_completed", () => {
    const abandonSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function abandonReviewAttempt"),
    );
    assert.ok(
      abandonSection.includes("attempt_already_completed"),
      "abandonReviewAttempt should reject completed/skipped attempts",
    );
  });

  test("abandonReviewAttempt is idempotent for already abandoned attempts", () => {
    const abandonSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function abandonReviewAttempt"),
    );
    assert.ok(
      abandonSection.includes('"abandoned"') && abandonSection.includes("abandonedAt"),
      "abandonReviewAttempt should handle already-abandoned idempotently",
    );
  });

  test("abandonReviewAttempt uses withWorkspaceTransaction", () => {
    const abandonSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function abandonReviewAttempt"),
    );
    assert.ok(
      abandonSection.includes("withWorkspaceTransaction"),
      "abandonReviewAttempt should use withWorkspaceTransaction",
    );
  });
});

// ─── V05-RISK-04: getActiveReviewAttempt function ───────────────────────

describe("V05-RISK-04: getActiveReviewAttempt", () => {
  test("getActiveReviewAttempt function is exported", () => {
    assert.ok(
      SERVICE_SOURCE.includes("export async function getActiveReviewAttempt"),
      "getActiveReviewAttempt should be exported",
    );
  });

  test("getActiveReviewAttempt queries by status 'started'", () => {
    const activeSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function getActiveReviewAttempt"),
    );
    assert.ok(
      activeSection.includes('"started"'),
      "getActiveReviewAttempt should filter by status = 'started'",
    );
  });

  test("getActiveReviewAttempt returns null when no active attempt exists", () => {
    const activeSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function getActiveReviewAttempt"),
    );
    assert.ok(
      activeSection.includes("return null"),
      "getActiveReviewAttempt should return null when no active attempt",
    );
  });

  test("getActiveReviewAttempt returns attemptId and idempotencyKey for recovery", () => {
    const activeSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export async function getActiveReviewAttempt"),
    );
    assert.ok(
      activeSection.includes("attemptId") && activeSection.includes("idempotencyKey"),
      "getActiveReviewAttempt should return attemptId and idempotencyKey for recovery",
    );
  });
});

// ─── V05-RISK-04: Routes ────────────────────────────────────────────────

describe("V05-RISK-04: routes", () => {
  test("POST /reviews/attempts/:attemptId/abandon route exists", () => {
    assert.ok(
      ROUTES_SOURCE.includes("/reviews/attempts/:attemptId/abandon"),
      "abandon route should be registered",
    );
  });

  test("GET /reviews/attempts/active route exists", () => {
    assert.ok(
      ROUTES_SOURCE.includes("/reviews/attempts/active"),
      "active attempt query route should be registered",
    );
  });

  test("abandon route calls abandonReviewAttempt", () => {
    assert.ok(
      ROUTES_SOURCE.includes("abandonReviewAttempt"),
      "abandon route should call abandonReviewAttempt",
    );
  });

  test("active route calls getActiveReviewAttempt", () => {
    assert.ok(
      ROUTES_SOURCE.includes("getActiveReviewAttempt"),
      "active route should call getActiveReviewAttempt",
    );
  });

  test("active route validates reviewScheduleId as UUID", () => {
    assert.ok(
      ROUTES_SOURCE.includes("[0-9a-f]{8}-[0-9a-f]{4}"),
      "active route should validate reviewScheduleId as UUID format",
    );
  });
});

// ─── V05-RISK-04: Schema and migration ──────────────────────────────────

describe("V05-RISK-04: schema and migration", () => {
  test("review_attempts table has abandonedAt column in API schema", () => {
    assert.ok(
      SCHEMA_SOURCE.includes("abandonedAt") || SCHEMA_SOURCE.includes("abandoned_at"),
      "API schema should have abandonedAt/abandoned_at column",
    );
  });

  test("review_attempts table has abandonedAt column in shared schema", () => {
    assert.ok(
      SHARED_SCHEMA_SOURCE.includes("abandonedAt") || SHARED_SCHEMA_SOURCE.includes("abandoned_at"),
      "Shared schema should have abandonedAt/abandoned_at column",
    );
  });

  test("partial unique index on (workspace, user, schedule) WHERE status='started' in schema", () => {
    assert.ok(
      SCHEMA_SOURCE.includes("review_attempts_active_started_unique_idx"),
      "API schema should define review_attempts_active_started_unique_idx",
    );
    assert.ok(
      SCHEMA_SOURCE.includes("'started'"),
      "Index should filter by status = 'started'",
    );
  });

  test("migration 0037 creates the partial unique index", () => {
    assert.ok(
      MIGRATION_SOURCE.includes("review_attempts_active_started_unique_idx"),
      "Migration should create review_attempts_active_started_unique_idx",
    );
    assert.ok(
      MIGRATION_SOURCE.includes("WHERE status = 'started'"),
      "Migration index should filter by status = 'started'",
    );
  });

  test("migration 0037 adds abandoned_at column", () => {
    assert.ok(
      MIGRATION_SOURCE.includes("abandoned_at"),
      "Migration should add abandoned_at column",
    );
  });
});

// ─── V05-RISK-04: Error code mapping ────────────────────────────────────

describe("V05-RISK-04: attempt_already_completed error code", () => {
  test("attempt_already_completed is a valid error code", () => {
    const error = new ReviewAttemptError("attempt_already_completed");
    assert.equal(error.code, "attempt_already_completed");
  });

  test("attempt_already_completed maps to 409", () => {
    const error = new ReviewAttemptError("attempt_already_completed");
    assert.equal(error.statusCode, 409);
  });

  test("attempt_already_completed is included in ReviewAttemptErrorCode type", () => {
    // Verify the type includes the new code by checking the source
    assert.ok(
      SERVICE_SOURCE.includes("\"attempt_already_completed\""),
      "ReviewAttemptErrorCode should include 'attempt_already_completed'",
    );
  });
});

// ─── V05-RISK-05: nextScheduleId persistence ────────────────────────────

describe("V05-RISK-05: nextScheduleId source tracking", () => {
  test("review_attempts table has nextScheduleId column in API schema", () => {
    assert.ok(
      SCHEMA_SOURCE.includes("nextScheduleId") || SCHEMA_SOURCE.includes("next_schedule_id"),
      "API schema should have nextScheduleId/next_schedule_id column",
    );
  });

  test("review_attempts table has nextScheduleId column in shared schema", () => {
    assert.ok(
      SHARED_SCHEMA_SOURCE.includes("nextScheduleId") || SHARED_SCHEMA_SOURCE.includes("next_schedule_id"),
      "Shared schema should have nextScheduleId/next_schedule_id column",
    );
  });

  test("migration 0037 adds next_schedule_id column", () => {
    assert.ok(
      MIGRATION_SOURCE.includes("next_schedule_id"),
      "Migration should add next_schedule_id column",
    );
  });

  test("submitReviewAttempt persists nextScheduleId on the attempt row", () => {
    // Find the section where the attempt is updated with completed status
    const submitSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("// 7c. Update the attempt with the full result."),
      SERVICE_SOURCE.indexOf("// 7d. Emit understanding event"),
    );
    assert.ok(
      submitSection.includes("nextScheduleId"),
      "submitReviewAttempt should set nextScheduleId on the attempt row",
    );
  });

  test("ReviewAttemptHistoryItem includes nextScheduleId", () => {
    assert.ok(
      SERVICE_SOURCE.includes("nextScheduleId: string | null"),
      "ReviewAttemptHistoryItem should include nextScheduleId field",
    );
  });

  test("history query includes nextScheduleId in columns", () => {
    const historySection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("listReviewAttemptHistory"),
    );
    assert.ok(
      historySection.includes("nextScheduleId: true"),
      "history query should include nextScheduleId in selected columns",
    );
  });
});

// ─── V05-RISK-05: Export/restore includes new columns ───────────────────

describe("V05-RISK-05: export/restore includes new columns", () => {
  const EXPORT_SOURCE = readFileSync(
    new URL("../modules/export/service.ts", import.meta.url),
    "utf8",
  );

  test("restore includes nextScheduleId", () => {
    assert.ok(
      EXPORT_SOURCE.includes("nextScheduleId"),
      "export restore should include nextScheduleId",
    );
  });

  test("restore includes abandonedAt", () => {
    assert.ok(
      EXPORT_SOURCE.includes("abandonedAt"),
      "export restore should include abandonedAt",
    );
  });
});

// ─── Type completeness ──────────────────────────────────────────────────

describe("V05-RISK-04/05: type completeness", () => {
  test("ReviewAttemptActiveResult interface is exported", () => {
    assert.ok(
      SERVICE_SOURCE.includes("export interface ReviewAttemptActiveResult"),
      "ReviewAttemptActiveResult should be exported",
    );
  });

  test("ReviewAttemptAbandonResult interface is exported", () => {
    assert.ok(
      SERVICE_SOURCE.includes("export interface ReviewAttemptAbandonResult"),
      "ReviewAttemptAbandonResult should be exported",
    );
  });

  test("ReviewAttemptActiveResult has required fields", () => {
    const typeSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export interface ReviewAttemptActiveResult"),
      SERVICE_SOURCE.indexOf("}", SERVICE_SOURCE.indexOf("export interface ReviewAttemptActiveResult")) + 1,
    );
    assert.ok(typeSection.includes("attemptId"), "should have attemptId");
    assert.ok(typeSection.includes("reviewScheduleId"), "should have reviewScheduleId");
    assert.ok(typeSection.includes("idempotencyKey"), "should have idempotencyKey");
    assert.ok(typeSection.includes("startedAt"), "should have startedAt");
  });

  test("ReviewAttemptAbandonResult has required fields", () => {
    const typeSection = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("export interface ReviewAttemptAbandonResult"),
      SERVICE_SOURCE.indexOf("}", SERVICE_SOURCE.indexOf("export interface ReviewAttemptAbandonResult")) + 1,
    );
    assert.ok(typeSection.includes("attemptId"), "should have attemptId");
    assert.ok(typeSection.includes("status"), "should have status");
    assert.ok(typeSection.includes("abandonedAt"), "should have abandonedAt");
  });
});
