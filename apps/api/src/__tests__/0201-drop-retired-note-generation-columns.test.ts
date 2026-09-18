import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0201_drop_retired_note_generation_columns.sql", import.meta.url),
  "utf8",
);

test("0201 drops the retired V1 note generation bridge", () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS notes_latest_generation_run_fk/);
  assert.match(migration, /DROP COLUMN IF EXISTS card_generation_epoch/);
  assert.match(migration, /DROP COLUMN IF EXISTS latest_generation_run_id/);
});
