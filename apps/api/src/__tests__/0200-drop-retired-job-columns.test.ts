import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0200_drop_retired_job_columns.sql", import.meta.url),
  "utf8",
);

test("0200 drops legacy V1 generation and repair job columns", () => {
  for (const column of [
    "generation_run_id",
    "generation_unit_id",
    "stage",
    "repair_state",
    "repair_attempt_count",
  ]) {
    assert.match(migration, new RegExp(`DROP COLUMN IF EXISTS ${column}`));
  }
});
