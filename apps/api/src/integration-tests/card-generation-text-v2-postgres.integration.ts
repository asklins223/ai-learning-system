import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db/client.ts";
import { createCardGenerationRun } from "../modules/card-generation/service.ts";

const adminUrl = process.env.CARD_GENERATION_V2_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_V2_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "12000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "22000000-0000-4000-8000-000000000001";
const NOTE_ID = "32000000-0000-4000-8000-000000000001";
const VERSION_ID = "42000000-0000-4000-8000-000000000001";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("unset server flag defaults a text snapshot to one durable v2 planner checkpoint", async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'text-v2-api@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Text v2 API test')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Planner route', ${USER_ID})`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "Every character must reach a primary span." }] })},
        'text-v2-api-source', ${USER_ID}
      )`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (
        ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph',
        'Every character must reach a primary span.'
      )`;
    await tx`UPDATE notes SET current_version_id = ${VERSION_ID} WHERE id = ${NOTE_ID}`;
  });

  const previous = process.env.CARD_GENERATION_V2_ENABLED;
  delete process.env.CARD_GENERATION_V2_ENABLED;
  try {
    const accepted = await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { noteVersionId: VERSION_ID, idempotencyKey: "text-v2-api-create-1" },
    );
    const [state] = await admin<{
      pipeline_version: string;
      prompt_bundle_version: string;
      execution_mode: string;
      job_type: string;
      unit_kind: string;
      unit_id_matches: boolean;
      legacy_jobs: number;
    }[]>`
      SELECT
        run.pipeline_version,
        run.prompt_bundle_version,
        run.provider_snapshot->>'executionMode' AS execution_mode,
        job.type AS job_type,
        unit.kind AS unit_kind,
        job.generation_unit_id = unit.id AS unit_id_matches,
        (SELECT count(*)::int FROM jobs
          WHERE generation_run_id = run.id
            AND type IN ('generate_card', 'align_evidence')) AS legacy_jobs
      FROM card_generation_runs AS run
      JOIN card_generation_units AS unit ON unit.run_id = run.id
      JOIN jobs AS job ON job.generation_unit_id = unit.id
      WHERE run.id = ${accepted.runId}
    `;
    assert.equal(state?.pipeline_version, "card-generation-v2-m5");
    assert.equal(state?.prompt_bundle_version, "map-candidate-v1+deck-plan-v1");
    assert.equal(state?.execution_mode, "text_v2");
    assert.equal(state?.job_type, "plan_card_generation");
    assert.equal(state?.unit_kind, "planner");
    assert.equal(state?.unit_id_matches, true);
    assert.equal(state?.legacy_jobs, 0);
  } finally {
    if (previous === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previous;
  }
});
