import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../db/migrations/0213_companion_agent_v1.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0213 is journaled and persists Agent settings and waiting state", () => {
  assert.match(journal, /"idx": 213/);
  assert.match(journal, /"tag": "0213_companion_agent_v1"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS agent_settings jsonb NOT NULL/);
  assert.match(migration, /'waiting_for_confirmation'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS provider_capability_fingerprint text/);
});

test("0213 creates bounded, RLS-protected Agent audit ledgers", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.companion_agent_steps/);
  assert.match(migration, /step_no integer NOT NULL CHECK \(step_no BETWEEN 1 AND 8\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.companion_agent_tool_calls/);
  assert.match(migration, /CONSTRAINT companion_agent_tool_calls_run_call_unique UNIQUE \(run_id, tool_call_id\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test("0213 allows only the registered Agent job type through the worker insert fence", () => {
  assert.match(migration, /'companion_agent', 'companion_memory_extract'/);
  assert.match(migration, /'companion_daily_summary'/);
  assert.match(migration, /CURRENT_USER = 'ailearn_worker'::name/);
});
