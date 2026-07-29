import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { processJob } from "../index.ts";
import { claimJobs } from "../queue.ts";

const adminUrl = process.env.CARD_GENERATION_V2_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_V2_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "11000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "21000000-0000-4000-8000-000000000001";
const NOTE_ID = "31000000-0000-4000-8000-000000000001";
const VERSION_ID = "41000000-0000-4000-8000-000000000001";
const BLOCK_ID = "51000000-0000-4000-8000-000000000001";
const RUN_ID = "61000000-0000-4000-8000-000000000001";
const PLANNER_UNIT_ID = "71000000-0000-4000-8000-000000000001";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("text v2 runs bounded Map/Reduce and publishes only exact span evidence", async () => {
  const source = `${Array.from(
    { length: 900 },
    (_, index) => `第${index}条结论：数据库索引缩小选择性查询的搜索空间。`,
  ).join("")}最终结论位于文末。`;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'text-v2-worker@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_provider)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Text v2 worker test', 'mock')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Index notes', ${USER_ID}, 1)`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash,
       created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: source }] })},
        ${sha256(source)}, ${USER_ID}
      )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${BLOCK_ID}, ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph', ${source})`;
    await tx`UPDATE note_versions
      SET sealed_at = now(), sealed_reason = 'card_generation_v2'
      WHERE id = ${VERSION_ID}`;
    await tx`INSERT INTO card_generation_runs (
      id, workspace_id, note_id, note_version_id, requested_by,
      request_idempotency_key, generation_fingerprint, generation_epoch,
      title_snapshot, source_content_hash, block_manifest_hash,
      asset_manifest_hash, block_manifest, asset_manifest,
      pipeline_version, prompt_bundle_version, provider_snapshot,
      governance_policy_version, status, stage, state_version,
      next_event_sequence, retryable, required_units, required_images,
      source_coverage_bps, image_coverage_bps, coverage_report
    ) VALUES (
      ${RUN_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${VERSION_ID}, ${USER_ID},
      'text-v2-integration', ${sha256(`run:${source}`)}, 1,
      'Index notes', ${sha256(source)}, ${sha256(`block:${source}`)},
      ${sha256("[]")}, ${tx.json([{ blockId: BLOCK_ID, ordinal: 0, type: "paragraph", contentHash: sha256(source) }])},
      '[]'::jsonb, 'card-generation-v2-m5', 'map-candidate-v1+deck-plan-v1',
      ${tx.json({ executionMode: "text_v2" })}, 'workspace-policy-snapshot-v1',
      'queued', 'queued', 1, 2, true, 0, 0, 0, 10000,
      ${tx.json({ measurement: "planned" })}
    )`;
    await tx`UPDATE notes
      SET current_version_id = ${VERSION_ID}, latest_generation_run_id = ${RUN_ID}
      WHERE id = ${NOTE_ID}`;
    await tx`INSERT INTO card_generation_events
      (run_id, workspace_id, sequence, stage, state, completed, total, unit, message_code)
      VALUES (${RUN_ID}, ${WORKSPACE_ID}, 1, 'snapshot', 'queued', 1, 1, 'blocks', 'source_snapshot_sealed')`;
    await tx`INSERT INTO card_generation_units (
      id, workspace_id, run_id, kind, level, ordinal, unit_key,
      pipeline_version, required, input_manifest, input_hash, token_estimate,
      status, scheduled_at
    ) VALUES (
      ${PLANNER_UNIT_ID}, ${WORKSPACE_ID}, ${RUN_ID}, 'planner', 0, 0,
      ${sha256(`planner:${source}`)}, 'card-generation-v2-m5', true,
      '{}'::jsonb, ${sha256(`run:${source}`)}, 0, 'pending', now()
    )`;
    await tx`INSERT INTO jobs (
      type, workspace_id, requested_by, payload, status, generation_run_id,
      generation_unit_id, stage, priority, resource_class, idempotency_key
    ) VALUES (
      'plan_card_generation', ${WORKSPACE_ID}, ${USER_ID},
      ${tx.json({ noteVersionId: VERSION_ID, generationRunId: RUN_ID, generationUnitId: PLANNER_UNIT_ID, userId: USER_ID })},
      'pending', ${RUN_ID}, ${PLANNER_UNIT_ID}, 'planner', 80,
      'card_foreground', 'text-v2-planner-job'
    )`;
  });

  let terminalStatus = "queued";
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const [run] = await admin<{ status: string }[]>`
      SELECT status FROM card_generation_runs WHERE id = ${RUN_ID}
    `;
    terminalStatus = run?.status ?? "missing";
    if (["succeeded", "needs_attention", "cancelled", "superseded"].includes(terminalStatus)) {
      break;
    }
    const claimed = await claimJobs(undefined, 3);
    assert.ok(claimed.length > 0, `pipeline stalled in ${terminalStatus} at iteration ${iteration}`);
    await Promise.all(claimed.map((job) => processJob(job)));
  }
  assert.equal(terminalStatus, "succeeded");

  const [result] = await admin<{
    required_units: number;
    completed_units: number;
    source_coverage_bps: number;
    map_units: number;
    deck_plan_units: number;
    card_render_units: number;
    publish_units: number;
    deck_plan_jobs: number;
    card_render_jobs: number;
    failed_jobs: number;
    align_jobs: number;
    result_card_set_id: string | null;
    result_card_id_is_overview: boolean;
    set_status: string;
    card_count: number;
    overview_cards: number;
    section_cards: number;
    active_cards: number;
    accepted_candidates: number;
    bad_candidate_assignments: number;
    key_points: number;
    exact_evidences: number;
    mismatched_quotes: number;
    span_chars: number;
    span_min: number;
    span_max: number;
  }[]>`
    SELECT
      run.required_units,
      run.completed_units,
      run.source_coverage_bps,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'text_map') AS map_units,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'deck_plan') AS deck_plan_units,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'card_render') AS card_render_units,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'publish') AS publish_units,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'plan_card_set') AS deck_plan_jobs,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'render_card_generation') AS card_render_jobs,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND status IN ('failed', 'dead')) AS failed_jobs,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'align_evidence') AS align_jobs,
      run.result_card_set_id,
      EXISTS (
        SELECT 1 FROM learning_cards AS overview
        WHERE overview.id = run.result_card_id
          AND overview.card_set_id = run.result_card_set_id
          AND overview.scope = 'overview'
          AND overview.ordinal = 0
      ) AS result_card_id_is_overview,
      result_set.status AS set_status,
      (SELECT count(*)::int FROM learning_cards
        WHERE card_set_id = run.result_card_set_id) AS card_count,
      (SELECT count(*)::int FROM learning_cards
        WHERE card_set_id = run.result_card_set_id AND scope = 'overview') AS overview_cards,
      (SELECT count(*)::int FROM learning_cards
        WHERE card_set_id = run.result_card_set_id AND scope = 'section') AS section_cards,
      (SELECT count(*)::int FROM learning_cards
        WHERE card_set_id = run.result_card_set_id AND status = 'active') AS active_cards,
      (SELECT count(*)::int FROM card_generation_candidates
        WHERE run_id = run.id AND validation_status = 'accepted') AS accepted_candidates,
      (SELECT count(*)::int FROM (
        SELECT kp.candidate_id
        FROM card_key_points AS kp
        JOIN learning_cards AS assigned_card ON assigned_card.id = kp.card_id
        WHERE assigned_card.card_set_id = run.result_card_set_id
        GROUP BY kp.candidate_id
        HAVING kp.candidate_id IS NULL OR count(*) <> 1
      ) AS invalid_assignment) AS bad_candidate_assignments,
      (SELECT count(*)::int FROM card_key_points AS kp
        JOIN learning_cards AS card ON card.id = kp.card_id
        WHERE card.card_set_id = run.result_card_set_id
          AND kp.candidate_id IS NOT NULL) AS key_points,
      (SELECT count(*)::int FROM evidences AS evidence
        JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
        JOIN learning_cards AS card ON card.id = kp.card_id
        WHERE card.card_set_id = run.result_card_set_id
          AND evidence.alignment_method = 'exact_span'
          AND evidence.evidence_span_id IS NOT NULL) AS exact_evidences,
      (SELECT count(*)::int FROM evidences AS evidence
        JOIN note_evidence_spans AS span ON span.id = evidence.evidence_span_id
        JOIN note_blocks AS block ON block.id = span.block_id
        JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
        JOIN learning_cards AS card ON card.id = kp.card_id
        WHERE card.card_set_id = run.result_card_set_id
          AND evidence.quote_text <> substring(
            block.content FROM span.char_start + 1 FOR span.char_end - span.char_start
          )) AS mismatched_quotes,
      (SELECT sum(char_end - char_start)::int FROM note_evidence_spans
        WHERE note_version_id = run.note_version_id) AS span_chars,
      (SELECT min(char_start)::int FROM note_evidence_spans
        WHERE note_version_id = run.note_version_id) AS span_min,
      (SELECT max(char_end)::int FROM note_evidence_spans
        WHERE note_version_id = run.note_version_id) AS span_max
    FROM card_generation_runs AS run
    JOIN learning_card_sets AS result_set ON result_set.id = run.result_card_set_id
    WHERE run.id = ${RUN_ID}
  `;
  assert.ok((result?.required_units ?? 0) > 1);
  assert.equal(result?.completed_units, result?.required_units);
  assert.equal(result?.source_coverage_bps, 10_000);
  assert.ok((result?.map_units ?? 0) > 1, "long input must use multiple map checkpoints");
  assert.equal(result?.deck_plan_units, 1);
  assert.equal(result?.publish_units, 1);
  assert.equal(result?.deck_plan_jobs, 1);
  assert.equal(result?.card_render_jobs, result?.card_render_units);
  assert.equal(result?.failed_jobs, 0);
  assert.equal(result?.align_jobs, 0);
  assert.ok(result?.result_card_set_id);
  assert.equal(result?.result_card_id_is_overview, true);
  assert.equal(result?.set_status, "active");
  assert.ok((result?.card_count ?? 0) >= 2, "more than five candidates must publish a card set");
  assert.equal(result?.overview_cards, 1);
  assert.ok((result?.section_cards ?? 0) >= 1);
  assert.equal(result?.active_cards, result?.card_count);
  assert.equal(result?.bad_candidate_assignments, 0);
  assert.equal(result?.key_points, result?.accepted_candidates);
  assert.ok((result?.key_points ?? 0) > 0);
  assert.equal(result?.exact_evidences, result?.key_points);
  assert.equal(result?.mismatched_quotes, 0);
  assert.equal(result?.span_chars, source.length);
  assert.equal(result?.span_min, 0);
  assert.equal(result?.span_max, source.length);

  await assert.rejects(
    admin`UPDATE note_evidence_spans SET text_hash = 'mutated' WHERE note_version_id = ${VERSION_ID}`,
    /note evidence span .* immutable/,
  );
});
