import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../db/migrations/0212_companion_memory_maintenance_once_per_day.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0212 is journaled and has a durable once-per-day gate", () => {
  assert.match(journal, /"tag": "0212_companion_memory_maintenance_once_per_day"/);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS public\.companion_memory_maintenance_runs \(/,
  );
  assert.match(migration, /run_date date PRIMARY KEY/);
  assert.match(migration, /ON CONFLICT \(run_date\) DO NOTHING/);
});

test("0212 runs archive and familiarity decay behind the same date gate", () => {
  assert.match(migration, /UPDATE public\.assistant_memory_items/);
  assert.match(migration, /UPDATE public\.pet_profiles/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.ailearn_run_companion_memory_maintenance\(\) TO ailearn_worker/);
  assert.match(
    migration,
    /AND "type" IN \('companion_memory_extract', 'companion_summarizer', 'companion_daily_summary'\)/,
  );
  assert.doesNotMatch(migration, /companion_memory_maintenance'\)/);
});
