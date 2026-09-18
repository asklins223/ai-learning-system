import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0199_drop_retired_generate_card_job_index.sql", import.meta.url),
  "utf8",
);

test("0199 drops the retired generate_card job index", () => {
  assert.match(migration, /DROP INDEX IF EXISTS public\.jobs_generate_card_active_unique_idx/);
});
