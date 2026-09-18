import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(import.meta.dirname, "../db/migrations/0185_companion_room_profiles.sql"),
  "utf8",
);
const drizzleSchema = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/shared/src/db-schema/companion-home.ts"),
  "utf8",
);
const journal = readFileSync(
  resolve(import.meta.dirname, "../db/migrations/meta/_journal.json"),
  "utf8",
);

function extractMigrationCheck(source: string, constraintName: string): string {
  const marker = `CONSTRAINT ${constraintName} CHECK (`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing migration constraint ${constraintName}`);

  const bodyStart = markerIndex + marker.length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  assert.fail(`unterminated migration constraint ${constraintName}`);
}

function extractDrizzleSqlTemplate(source: string, constraintName: string): string {
  const marker = `"${constraintName}",`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing Drizzle constraint ${constraintName}`);

  const templateStart = source.indexOf("sql`", markerIndex);
  assert.notEqual(templateStart, -1, `missing SQL template for ${constraintName}`);
  const bodyStart = templateStart + "sql`".length;
  const bodyEnd = source.indexOf("`", bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated SQL template for ${constraintName}`);
  return source.slice(bodyStart, bodyEnd);
}

function canonicalizeSlotShapePredicate(source: string): string {
  return source
    .replaceAll("${table.equippedDecorBySlot}", "equipped_decor_by_slot")
    .replace(/\s+/g, "")
    .toLowerCase();
}

test("0185 migration is journaled and repeat-safe", () => {
  assert.match(journal, /"tag": "0185_companion_room_profiles"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.companion_room_profiles/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS companion_room_profiles_workspace_user_unique/);
  assert.match(migration, /DROP POLICY IF EXISTS companion_room_profiles_workspace_user_isolation/);
});

test("0185 enforces the bounded equipment model in PostgreSQL", () => {
  for (const constraint of [
    "companion_room_profiles_revision_check",
    "companion_room_profiles_decor_ids_check",
    "companion_room_profiles_decor_ids_unique_check",
    "companion_room_profiles_effect_ids_check",
    "companion_room_profiles_effect_ids_unique_check",
    "companion_room_profiles_equipped_effect_check",
    "companion_room_profiles_equipped_effect_unlocked_check",
    "companion_room_profiles_slot_shape_check",
    "companion_room_profiles_slot_values_check",
    "companion_room_profiles_equipped_decor_unlocked_check",
    "companion_room_profiles_equipped_decor_unique_check",
  ]) {
    assert.match(migration, new RegExp(`CONSTRAINT ${constraint} CHECK`));
  }
  assert.match(
    migration,
    /equipped_decor_by_slot - ARRAY\['desk', 'shelf', 'window', 'rest'\] = '\{\}'::jsonb/,
  );
  assert.doesNotMatch(migration, /jsonb_object_length/);
});

test("Drizzle and 0185 use the same exact-key slot shape constraint", () => {
  const constraintName = "companion_room_profiles_slot_shape_check";
  const migrationPredicate = canonicalizeSlotShapePredicate(
    extractMigrationCheck(migration, constraintName),
  );
  const drizzlePredicate = canonicalizeSlotShapePredicate(
    extractDrizzleSqlTemplate(drizzleSchema, constraintName),
  );

  assert.equal(drizzlePredicate, migrationPredicate);
  assert.match(drizzlePredicate, /\?&array\['desk','shelf','window','rest'\]/);
  assert.match(
    drizzlePredicate,
    /-array\['desk','shelf','window','rest'\]='\{\}'::jsonb/,
  );
  assert.doesNotMatch(drizzlePredicate, /jsonb_object_length/);
});

test("0185 forces workspace and user RLS for API and worker roles", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /workspace_id = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)::uuid/);
  assert.match(migration, /user_id = NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
  assert.doesNotMatch(migration, /CURRENT_USER = 'ailearn_worker'/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.companion_room_profiles TO ailearn_api/,
  );
  assert.match(
    migration,
    /GRANT SELECT ON public\.companion_room_profiles TO ailearn_worker/,
  );
  assert.doesNotMatch(
    migration,
    /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*TO ailearn_worker/,
  );
});
