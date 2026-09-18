import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0198_fix_companion_daily_summary_activity.sql", import.meta.url),
  "utf8",
);

test("0198 companion daily-summary activity uses the V2 card table", () => {
  assert.match(migration, /FROM learning_cards_v2/);
  assert.doesNotMatch(migration, /FROM learning_cards\b/);
  assert.match(migration, /IF\s+FOUND\s+THEN\s+v_inserted\s*:=\s*v_inserted\s*\+\s*1/);
});
