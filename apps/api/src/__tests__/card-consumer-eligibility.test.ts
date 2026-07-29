import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { learningCards } from "../db/schema/card.ts";
import { reviewSchedules } from "../db/schema/evidence.ts";
import { activeLearningCardConsumerPredicate } from "../modules/card/consumer-eligibility.ts";
import { reviewScheduleTargetsConsumableCardPredicate } from "../modules/review/consumer-eligibility.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function readModule(modulePath: string): string {
  return readFileSync(new URL(`../modules/${modulePath}`, import.meta.url), "utf8");
}

function exportedFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing exported function ${name}`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("active-card predicate remains alias-safe in Drizzle relational queries", () => {
  const query = db.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, WORKSPACE_ID),
      activeLearningCardConsumerPredicate(),
    ),
  }).toSQL();

  assert.match(query.sql, /"learningCards"\."status" = \$\d+/);
  assert.match(query.sql, /"learningCards"\."card_set_id" is null/);
  assert.match(
    query.sql,
    /FROM learning_card_sets AS consumer_parent_set/,
  );
  assert.match(
    query.sql,
    /consumer_parent_set\.id = "learningCards"\."card_set_id"/,
  );
  assert.match(
    query.sql,
    /consumer_parent_set\.workspace_id = "learningCards"\."workspace_id"/,
  );
  assert.match(query.sql, /consumer_parent_set\.status = 'active'/);
  assert.doesNotMatch(
    query.sql,
    /WHERE "learningCards"\."id" = "learningCards"\."card_set_id"/,
  );
  assert.ok(query.params.includes("active"));
});

test("polymorphic review predicate remains alias-safe and supports legacy cards", () => {
  const query = db.query.reviewSchedules.findMany({
    where: and(
      eq(reviewSchedules.workspaceId, WORKSPACE_ID),
      reviewScheduleTargetsConsumableCardPredicate(),
    ),
  }).toSQL();

  assert.match(query.sql, /"reviewSchedules"\."subject_type" = 'card'/);
  assert.match(query.sql, /consumer_card\.card_set_id IS NULL/);
  assert.match(query.sql, /consumer_parent_set\.id = consumer_card\.card_set_id/);
  assert.match(query.sql, /consumer_parent_set\.status = 'active'/);
  assert.match(query.sql, /"reviewSchedules"\."subject_type" = 'validation'/);
  assert.match(query.sql, /"reviewSchedules"\."subject_type" = 'key_point'/);
  assert.doesNotMatch(
    query.sql,
    /"reviewSchedules"\."status" = 'active'/,
  );
});

test("validation and review mutations enforce consumer-active targets", () => {
  const validation = readModule("validation/service.ts");
  for (const name of ["createValidationQuestion", "submitValidation"]) {
    assert.match(
      exportedFunction(validation, name),
      /activeLearningCardConsumerPredicate\(\)/,
      `${name} must require an active card under an active parent set`,
    );
  }

  const session = readModule("validation/session-service.ts");
  for (const name of [
    "startValidationSession",
    "draftAnswer",
    "revealSource",
    "submitAnswer",
    "unableToAnswer",
    "retryQuestion",
    "retryEvaluation",
  ]) {
    assert.match(
      exportedFunction(session, name),
      /requireConsumableLearningCard\(/,
      `${name} must reject a non-consumable card`,
    );
  }

  const attempts = readModule("review/attempt-service.ts");
  for (const name of [
    "startReviewAttempt",
    "submitReviewAttempt",
    "laterReviewAttempt",
  ]) {
    assert.match(
      exportedFunction(attempts, name),
      /reviewScheduleTargetsConsumableCardPredicate\(\)/,
      `${name} must reject schedules targeting non-consumable cards`,
    );
  }
});

test("active projections and learning-state mutations use Card Set eligibility", () => {
  const search = readModule("search/service.ts");
  assert.match(search, /object_type = 'card_set'/);
  assert.match(search, /parent_set\.status = 'active'/);
  assert.match(search, /cardSetId: card\.cardSetId/);
  assert.match(search, /scope: card\.scope/);
  assert.match(search, /ordinal: card\.ordinal/);

  const review = readModule("review/service.ts");
  assert.match(
    exportedFunction(review, "listReviews"),
    /reviewScheduleTargetsConsumableCardPredicate\(\)/,
  );
  assert.match(
    exportedFunction(review, "getSanitizedReviewMeta"),
    /activeLearningCardConsumerPredicate\(\)/,
  );

  const understanding = readModule("understanding/service.ts");
  assert.ok(
    (understanding.match(/activeLearningCardConsumerPredicate\(\)/g) ?? []).length >= 3,
  );

  const stats = readModule("stats/service.ts");
  assert.match(
    exportedFunction(stats, "getStatsOverview"),
    /activeLearningCardConsumerPredicate\(\)/,
  );

  const evidence = readModule("evidence/service.ts");
  assert.match(evidence, /resolveConsumableEvidenceTarget\(/);
  assert.match(evidence, /activeLearningCardConsumerPredicate\(\)/);
});
