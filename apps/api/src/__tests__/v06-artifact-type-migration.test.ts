import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0042_v06_artifact_types_and_integrity.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as {
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

test("0042 adds every v0.6 artifact enum value idempotently", () => {
  for (const artifactType of [
    "validation_question",
    "rubric_evaluation",
    "deterministic_question",
  ]) {
    assert.match(
      migration,
      new RegExp(`ALTER TYPE public\\.artifact_type[\\s\\S]*?ADD VALUE IF NOT EXISTS '${artifactType}'`),
      `0042 must add ${artifactType} with IF NOT EXISTS`,
    );
  }

  const enumStatements = migration
    .split("--> statement-breakpoint")
    .filter((statement) => /ALTER TYPE public\.artifact_type/.test(statement));
  assert.equal(enumStatements.length, 3);
  assert.ok(enumStatements.every((statement) => /ADD VALUE IF NOT EXISTS/.test(statement)));
});

test("0042 redacts only recognisable sensitive v0.6 job errors", () => {
  assert.match(
    migration,
    /WHERE type IN \('generate_validation_question', 'evaluate_validation'\)/,
  );
  assert.match(migration, /DrizzleQueryError\|Failed query:/);
  assert.match(migration, /params\[\[:space:\]\]\*:/);
  assert.match(migration, /SET last_error = 'database_error_redacted'/);
  assert.doesNotMatch(migration, /SET\s+(?:payload|last_error)\s*=\s*NULL/i);
});

test("0042 installs the successor-schedule FK after clearing only orphan references", () => {
  assert.match(migration, /SET next_schedule_id = NULL/);
  assert.match(migration, /AND NOT EXISTS \(/);
  assert.match(
    migration,
    /ADD CONSTRAINT review_attempts_next_schedule_id_review_schedules_id_fk/,
  );
  assert.match(migration, /REFERENCES public\.review_schedules\(id\)/);
  assert.match(migration, /ON DELETE SET NULL/);
});

test("0042 remains registered immediately before the RLS context repair", () => {
  const entry0042 = journal.entries.find((entry) => entry.tag === "0042_v06_artifact_types_and_integrity");
  assert.ok(entry0042);
  assert.deepEqual(entry0042, {
    idx: 42,
    version: "7",
    when: 1786597400000,
    tag: "0042_v06_artifact_types_and_integrity",
    breakpoints: true,
  });
  assert.equal(journal.entries[entry0042.idx + 1]?.tag, "0043_v06_rls_context_alignment");
});
