import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0043_v06_rls_context_alignment.sql", import.meta.url),
  "utf8",
);
const executableMigration = migration.replace(/--.*$/gm, "");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const V06_POLICIES = [
  "val_submissions_user_isolation",
  "val_action_cmd_user_isolation",
  "val_assist_exp_user_isolation",
  "val_point_assess_user_isolation",
  "sched_shadow_user_isolation",
  "val_quality_sig_user_isolation",
  "vq_rubric_items_workspace_isolation",
  "val_sub_jobs_workspace_isolation",
] as const;

test("0043 recreates every v0.6 policy idempotently", () => {
  for (const policy of V06_POLICIES) {
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "${policy}"`));
    assert.match(migration, new RegExp(`CREATE POLICY "${policy}"`));
  }
  assert.equal(
    [...migration.matchAll(/\bCREATE POLICY\b/g)].length,
    V06_POLICIES.length,
  );
});

test("0043 uses the canonical runtime GUCs and fails closed on empty context", () => {
  assert.match(executableMigration, /current_setting\('app\.user_id', true\)/);
  assert.match(executableMigration, /current_setting\('app\.workspace_id', true\)/);
  assert.doesNotMatch(executableMigration, /app\.current_(?:user|workspace)_id/);
  assert.match(executableMigration, /NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
  assert.match(
    executableMigration,
    /NULLIF\(current_setting\('app\.workspace_id', true\), ''\)::uuid/,
  );
  assert.equal(
    [...executableMigration.matchAll(/\bWITH CHECK\b/g)].length,
    V06_POLICIES.length,
  );
});

test("0043 remains registered immediately before the generation-run bridge", () => {
  const entry0043 = journal.entries.find((entry) => entry.tag === "0043_v06_rls_context_alignment");
  assert.ok(entry0043);
  assert.deepEqual(entry0043, {
    idx: 43,
    version: "7",
    when: 1786683800000,
    tag: "0043_v06_rls_context_alignment",
    breakpoints: true,
  });
  assert.equal(journal.entries[entry0043.idx + 1]?.tag, "0044_card_generation_run_bridge");
  assert.match(
    server,
    /MIN_READY_MIGRATION_CREATED_AT \?\? "1786683800000"/,
  );
  for (const table of [
    "validation_question_rubric_items",
    "validation_submissions",
    "validation_submission_jobs",
    "validation_action_commands",
    "validation_assistance_exposures",
    "validation_point_assessments",
    "scheduling_shadow_decisions",
    "validation_quality_signals",
  ]) {
    assert.ok(server.includes(`"${table}"`), `/ready must require ${table}`);
  }
});
