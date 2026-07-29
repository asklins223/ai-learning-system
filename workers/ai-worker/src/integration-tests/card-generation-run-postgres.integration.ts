import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { processJob } from "../index.ts";
import { claimJobs } from "../queue.ts";

const adminUrl = process.env.CARD_GENERATION_V2_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_V2_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "10000000-0000-4000-8000-000000000011";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000011";
const NOTE_ID = "30000000-0000-4000-8000-000000000011";
const VERSION_ID = "40000000-0000-4000-8000-000000000011";
const RUN_ID = "50000000-0000-4000-8000-000000000011";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("worker fences and atomically publishes a run-backed legacy generation", async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'card-v2-worker@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_provider, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Card v2 worker test', 'mock', 'v1', now(), ${USER_ID})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Worker sealed title', ${USER_ID}, 1)`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{
          type: "paragraph",
          content: "Distributed consensus requires nodes to agree on one durable ordering before committed results become visible.",
        }] })},
        'worker-source-hash', ${USER_ID}
      )`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (
        ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph',
        'Distributed consensus requires nodes to agree on one durable ordering before committed results become visible.'
      )`;
    await tx`UPDATE note_versions
      SET sealed_at = now(), sealed_reason = 'card_generation_v2'
      WHERE id = ${VERSION_ID}`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units
      ) VALUES (
        ${RUN_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${VERSION_ID}, ${USER_ID},
        'worker-integration-run', 'worker-fingerprint', 1,
        'Worker sealed title', 'worker-source-hash', 'block-hash', 'asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 2, true, 1
      )`;
    await tx`UPDATE notes
      SET current_version_id = ${VERSION_ID}, latest_generation_run_id = ${RUN_ID}
      WHERE id = ${NOTE_ID}`;
    await tx`INSERT INTO card_generation_events
      (run_id, workspace_id, sequence, stage, state, completed, total, unit, message_code)
      VALUES (${RUN_ID}, ${WORKSPACE_ID}, 1, 'snapshot', 'queued', 1, 1, 'blocks', 'source_snapshot_sealed')`;
    await tx`INSERT INTO jobs
      (type, workspace_id, requested_by, payload, status, generation_run_id, stage,
       priority, resource_class, idempotency_key)
      VALUES (
        'generate_card', ${WORKSPACE_ID}, ${USER_ID},
        ${tx.json({ noteVersionId: VERSION_ID, generationRunId: RUN_ID, userId: USER_ID })},
        'pending', ${RUN_ID}, 'legacy_generate', 50, 'card_foreground',
        'worker-generation-run-job'
      )`;
  });

  const claimed = await claimJobs(undefined, 1);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.payload.generationRunId, RUN_ID);
  await processJob(claimed[0]!);

  const [run] = await admin<{
    status: string;
    stage: string;
    result_card_id: string | null;
    event_count: number;
    active_card_count: number;
  }[]>`
    SELECT
      run.status,
      run.stage,
      run.result_card_id,
      (SELECT count(*)::int FROM card_generation_events WHERE run_id = run.id) AS event_count,
      (SELECT count(*)::int FROM learning_cards
        WHERE workspace_id = run.workspace_id
          AND note_version_id = run.note_version_id
          AND status = 'active') AS active_card_count
    FROM card_generation_runs AS run
    WHERE run.id = ${RUN_ID}
  `;
  assert.equal(run?.status, "succeeded");
  assert.equal(run?.stage, "complete");
  assert.ok(run?.result_card_id);
  assert.equal(run?.event_count, 4);
  assert.equal(run?.active_card_count, 1);

  const [job] = await admin<{ status: string; lease_token: string | null }[]>`
    SELECT status, lease_token FROM jobs WHERE generation_run_id = ${RUN_ID} AND type = 'generate_card'
  `;
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.lease_token, null);
});
