import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db/client.ts";
import {
  cancelCardGenerationRun,
  createCardGenerationRun,
  getCardGenerationRun,
  listCardGenerationEvents,
} from "../modules/card-generation/service.ts";

const adminUrl = process.env.CARD_GENERATION_V2_TEST_ADMIN_URL;
if (!adminUrl) {
  throw new Error("CARD_GENERATION_V2_TEST_ADMIN_URL is required");
}

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const NOTE_ID = "30000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000001";

async function withCardGenerationFlag<T>(
  value: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = process.env.CARD_GENERATION_V2_ENABLED;
  process.env.CARD_GENERATION_V2_ENABLED = value;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previous;
  }
}

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("explicit false seals the source and keeps one linked legacy rollback job", async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'card-v2-test@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Card v2 test')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Sealed title', ${USER_ID})`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [
          { type: "heading", content: "Section" },
          { type: "paragraph", content: "The complete source text." },
        ] })},
        'source-content-hash', ${USER_ID}
      )`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES
        (${VERSION_ID}, ${WORKSPACE_ID}, 0, 'heading', 'Section'),
        (${VERSION_ID}, ${WORKSPACE_ID}, 1, 'paragraph', 'The complete source text.')`;
    await tx`UPDATE notes SET current_version_id = ${VERSION_ID} WHERE id = ${NOTE_ID}`;
  });

  await withCardGenerationFlag("false", async () => {
  const context = { workspaceId: WORKSPACE_ID, userId: USER_ID };
  const accepted = await createCardGenerationRun(context, {
    noteVersionId: VERSION_ID,
    idempotencyKey: "integration-card-v2-create-1",
  });
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.canContinueEditing, true);
  assert.equal(accepted.sourceSnapshot.versionNo, 1);

  const [state] = await admin<{
    sealed_at: Date | null;
    epoch: number;
    latest_run_id: string | null;
    job_count: number;
    linked_job_count: number;
    event_count: number;
    execution_mode: string;
    job_type: string;
    align_evidence_jobs: number;
    planner_jobs: number;
  }[]>`
    SELECT
      version.sealed_at,
      note.card_generation_epoch AS epoch,
      note.latest_generation_run_id AS latest_run_id,
      run.provider_snapshot->>'executionMode' AS execution_mode,
      (SELECT type FROM jobs WHERE generation_run_id = run.id LIMIT 1) AS job_type,
      (SELECT count(*)::int FROM jobs WHERE generation_run_id = run.id) AS job_count,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id
          AND payload->>'generationRunId' = run.id::text) AS linked_job_count,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'align_evidence') AS align_evidence_jobs,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'plan_card_generation') AS planner_jobs,
      (SELECT count(*)::int FROM card_generation_events WHERE run_id = run.id) AS event_count
    FROM card_generation_runs AS run
    JOIN notes AS note ON note.id = run.note_id
    JOIN note_versions AS version ON version.id = run.note_version_id
    WHERE run.id = ${accepted.runId}
  `;
  assert.ok(state?.sealed_at);
  assert.equal(state?.epoch, 1);
  assert.equal(state?.latest_run_id, accepted.runId);
  assert.equal(state?.job_count, 1);
  assert.equal(state?.linked_job_count, 1);
  assert.equal(state?.event_count, 1);
  assert.equal(state?.execution_mode, "legacy_bridge");
  assert.equal(state?.job_type, "generate_card");
  assert.equal(state?.align_evidence_jobs, 0);
  assert.equal(state?.planner_jobs, 0);

  const replay = await createCardGenerationRun(context, {
    noteVersionId: VERSION_ID,
    idempotencyKey: "integration-card-v2-create-1",
  });
  assert.equal(replay.runId, accepted.runId);
  const [{ epoch }] = await admin<{ epoch: number }[]>`
    SELECT card_generation_epoch AS epoch FROM notes WHERE id = ${NOTE_ID}
  `;
  assert.equal(epoch, 1, "idempotent replay must not advance the epoch");

  await assert.rejects(
    admin`UPDATE note_versions SET content_hash = 'mutated' WHERE id = ${VERSION_ID}`,
    /sealed note version .* immutable/,
  );
  await assert.rejects(
    admin`UPDATE note_blocks SET content = 'mutated' WHERE version_id = ${VERSION_ID}`,
    /blocks for sealed note version .* immutable/,
  );

  const crossTenant = await getCardGenerationRun(
    { workspaceId: OTHER_WORKSPACE_ID, userId: USER_ID },
    accepted.runId,
  );
  assert.equal(crossTenant, null);

  const events = await listCardGenerationEvents(context, accepted.runId, 0);
  assert.equal(events?.items.length, 1);
  assert.equal(events?.items[0]?.messageCode, "source_snapshot_sealed");

  const cancelled = await cancelCardGenerationRun(context, accepted.runId);
  assert.equal(cancelled?.status, "cancelled");
  const [job] = await admin<{ status: string; lease_token: string | null }[]>`
    SELECT status, lease_token FROM jobs WHERE generation_run_id = ${accepted.runId}
  `;
  assert.equal(job?.status, "dead");
  assert.equal(job?.lease_token, null);
  });
});
