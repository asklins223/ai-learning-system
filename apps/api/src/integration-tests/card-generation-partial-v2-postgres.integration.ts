import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db/client.ts";
import {
  CardGenerationServiceError,
  continueCardGenerationRunWithExclusions,
  createCardGenerationRun,
  getCardGenerationRun,
} from "../modules/card-generation/service.ts";

const adminUrl = process.env.CARD_GENERATION_IMAGE_V2_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_IMAGE_V2_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "14000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "24000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "24000000-0000-4000-8000-000000000002";
const NOTE_ID = "34000000-0000-4000-8000-000000000001";
const VERSION_ID = "44000000-0000-4000-8000-000000000001";
const TEXT_BLOCK_ID = "54000000-0000-4000-8000-000000000001";
const IMAGE_BLOCK_ID = "54000000-0000-4000-8000-000000000002";
const IMAGE_ASSET_ID = "84000000-0000-4000-8000-000000000001";
const SUCCEEDED_IMAGE_UNIT_ID = "74000000-0000-4000-8000-000000000002";

const CUMULATIVE_USER_ID = "14000000-0000-4000-8000-000000000010";
const CUMULATIVE_WORKSPACE_ID = "24000000-0000-4000-8000-000000000010";
const CUMULATIVE_NOTE_ID = "34000000-0000-4000-8000-000000000010";
const CUMULATIVE_VERSION_ID = "44000000-0000-4000-8000-000000000010";
const CUMULATIVE_TEXT_BLOCK_ID = "54000000-0000-4000-8000-000000000010";
const CUMULATIVE_IMAGE_BLOCK_1_ID = "54000000-0000-4000-8000-000000000011";
const CUMULATIVE_IMAGE_BLOCK_2_ID = "54000000-0000-4000-8000-000000000012";
const CUMULATIVE_IMAGE_ASSET_1_ID = "84000000-0000-4000-8000-000000000010";
const CUMULATIVE_IMAGE_ASSET_2_ID = "84000000-0000-4000-8000-000000000011";
const CUMULATIVE_FAILED_UNIT_1_ID = "74000000-0000-4000-8000-000000000010";
const CUMULATIVE_FAILED_UNIT_2_ID = "74000000-0000-4000-8000-000000000011";

const IMAGE_ONLY_USER_ID = "14000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_WORKSPACE_ID = "24000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_NOTE_ID = "34000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_VERSION_ID = "44000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_BLOCK_ID = "54000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_ASSET_ID = "84000000-0000-4000-8000-000000000020";
const IMAGE_ONLY_FAILED_UNIT_ID = "74000000-0000-4000-8000-000000000020";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertServiceError(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedStatusCode: number,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof CardGenerationServiceError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.statusCode, expectedStatusCode);
    return true;
  });
}

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("explicit failed-image exclusion creates an auditable derived run", async () => {
  const imageContent = "![失败的架构图](/api/uploads/partial/image.png)";
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'partial-v2-api@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Partial v2 API test')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Strict partial policy', ${USER_ID})`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [
          { type: "paragraph", content: "正文仍可独立生成学习要点。" },
          { type: "image", content: imageContent },
        ] })},
        ${sha256("partial-source")}, ${USER_ID}
      )`;
    await tx`INSERT INTO note_image_assets (
      id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type,
      byte_size, width, height, status, created_by
    ) VALUES (
      ${IMAGE_ASSET_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, 'partial/image.png',
      ${sha256("partial-image")}, 'image/png', 128, 640, 480, 'ready', ${USER_ID}
    )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content, image_asset_id)
      VALUES
        (${TEXT_BLOCK_ID}, ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph',
          '正文仍可独立生成学习要点。', NULL),
        (${IMAGE_BLOCK_ID}, ${VERSION_ID}, ${WORKSPACE_ID}, 1, 'image',
          ${imageContent}, ${IMAGE_ASSET_ID})`;
    await tx`UPDATE notes SET current_version_id = ${VERSION_ID} WHERE id = ${NOTE_ID}`;
  });

  const previous = process.env.CARD_GENERATION_V2_ENABLED;
  delete process.env.CARD_GENERATION_V2_ENABLED;
  try {
    const context = { workspaceId: WORKSPACE_ID, userId: USER_ID };
    const accepted = await createCardGenerationRun(context, {
      noteVersionId: VERSION_ID,
      idempotencyKey: "partial-v2-source-run",
    });
    const [defaultRouting] = await admin<{
      execution_mode: string;
      planner_jobs: number;
      legacy_jobs: number;
    }[]>`
      SELECT
        run.provider_snapshot->>'executionMode' AS execution_mode,
        (SELECT count(*)::int FROM jobs
          WHERE generation_run_id = run.id
            AND type = 'plan_card_generation') AS planner_jobs,
        (SELECT count(*)::int FROM jobs
          WHERE generation_run_id = run.id
            AND type IN ('generate_card', 'align_evidence')) AS legacy_jobs
      FROM card_generation_runs AS run
      WHERE run.id = ${accepted.runId}
    `;
    assert.equal(defaultRouting?.execution_mode, "multimodal_v2");
    assert.equal(defaultRouting?.planner_jobs, 1);
    assert.equal(defaultRouting?.legacy_jobs, 0);

    const [planner] = await admin<{ id: string }[]>`
      SELECT id FROM card_generation_units
      WHERE run_id = ${accepted.runId} AND kind = 'planner'
    `;
    assert.ok(planner);
    const failedUnitId = "74000000-0000-4000-8000-000000000001";
    const failedInput = {
      imageAssetId: IMAGE_ASSET_ID,
      imageBlockId: IMAGE_BLOCK_ID,
    };
    await admin.begin(async (tx) => {
      await tx`UPDATE jobs
        SET status = 'succeeded', finished_at = now()
        WHERE generation_run_id = ${accepted.runId}`;
      await tx`UPDATE card_generation_units
        SET status = 'succeeded', finished_at = now()
        WHERE id = ${planner.id}`;
      await tx`INSERT INTO card_generation_units (
        id, workspace_id, run_id, parent_unit_id, kind, level, ordinal,
        unit_key, pipeline_version, required, input_manifest, input_hash,
        token_estimate, status, error_code, finished_at
      ) VALUES (
        ${failedUnitId}, ${WORKSPACE_ID}, ${accepted.runId}, ${planner.id},
        'image', 0, 0, ${sha256("failed-image-unit")},
        'card-generation-v2-m5', true, ${tx.json(failedInput)},
        ${sha256(JSON.stringify(failedInput))}, 0, 'terminal_failed',
        'image_provider_timeout', now()
      )`;
      await tx`INSERT INTO card_generation_units (
        id, workspace_id, run_id, parent_unit_id, kind, level, ordinal,
        unit_key, pipeline_version, required, input_manifest, input_hash,
        token_estimate, status, finished_at
      ) VALUES (
        ${SUCCEEDED_IMAGE_UNIT_ID}, ${WORKSPACE_ID}, ${accepted.runId}, ${planner.id},
        'image', 0, 1, ${sha256("succeeded-image-unit")},
        'card-generation-v2-m5', true, ${tx.json(failedInput)},
        ${sha256("succeeded-image-input")}, 0, 'succeeded', now()
      )`;
      await tx`UPDATE card_generation_runs
        SET status = 'needs_attention', stage = 'image_analysis',
            state_version = 2, next_event_sequence = 3,
            error_code = 'image_provider_timeout', retryable = true,
            required_units = 1, required_images = 1,
            source_coverage_bps = 0, image_coverage_bps = 0,
            finished_at = now(), updated_at = now()
        WHERE id = ${accepted.runId}`;
      await tx`INSERT INTO card_generation_events (
        run_id, workspace_id, sequence, stage, state, completed, total,
        unit, message_code, safe_details
      ) VALUES (
        ${accepted.runId}, ${WORKSPACE_ID}, 2, 'image_analysis',
        'needs_attention', 0, 1, 'images', 'image_provider_timeout',
        ${tx.json({ unitId: failedUnitId })}
      )`;
    });

    const attention = await getCardGenerationRun(context, accepted.runId);
    assert.equal(attention?.status, "needs_attention");
    assert.equal(attention?.actions.canContinueWithExclusions, true);
    const failedWarning = attention?.warnings.find(
      (warning) => warning.code === "generation_units_failed",
    );
    assert.ok(failedWarning);

    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [failedUnitId, failedUnitId],
        idempotencyKey: "partial-v2-duplicate-unit",
      }),
      "invalid_exclusion_units",
      422,
    );
    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [SUCCEEDED_IMAGE_UNIT_ID],
        idempotencyKey: "partial-v2-succeeded-unit",
      }),
      "invalid_exclusion_units",
      422,
    );
    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [planner.id],
        idempotencyKey: "partial-v2-invalid-unit",
      }),
      "invalid_exclusion_units",
      422,
    );

    const derived = await continueCardGenerationRunWithExclusions(
      context,
      accepted.runId,
      {
        excludedUnitIds: [failedUnitId],
        idempotencyKey: "partial-v2-derived-run",
      },
    );
    assert.ok(derived);
    assert.notEqual(derived.runId, accepted.runId);
    assert.equal(derived.status, "queued");

    const [state] = await admin<{
      source_status: string;
      derived_status: string;
      epoch: number;
      latest_run_id: string;
      required_images: number;
      image_coverage_bps: number;
      exclusion_mode: string;
      exclusion_count: number;
      source_unit_id: string;
      planner_units: number;
      planner_jobs: number;
    }[]>`
      SELECT
        source.status AS source_status,
        derived.status AS derived_status,
        note.card_generation_epoch AS epoch,
        note.latest_generation_run_id AS latest_run_id,
        derived.required_images,
        derived.image_coverage_bps,
        derived.exclusion_policy->>'mode' AS exclusion_mode,
        jsonb_array_length(derived.exclusion_policy->'excludedUnits') AS exclusion_count,
        derived.exclusion_policy->'excludedUnits'->0->>'sourceUnitId' AS source_unit_id,
        (SELECT count(*)::int FROM card_generation_units
          WHERE run_id = derived.id AND kind = 'planner') AS planner_units,
        (SELECT count(*)::int FROM jobs
          WHERE generation_run_id = derived.id AND type = 'plan_card_generation') AS planner_jobs
      FROM card_generation_runs AS source
      JOIN card_generation_runs AS derived ON derived.supersedes_run_id = source.id
      JOIN notes AS note ON note.id = derived.note_id
      WHERE source.id = ${accepted.runId} AND derived.id = ${derived.runId}
    `;
    assert.equal(state?.source_status, "superseded");
    assert.equal(state?.derived_status, "queued");
    assert.equal(state?.epoch, 2);
    assert.equal(state?.latest_run_id, derived.runId);
    assert.equal(state?.required_images, 1, "partial coverage keeps the original image denominator");
    assert.equal(state?.image_coverage_bps, 0);
    assert.equal(state?.exclusion_mode, "explicit_image_exclusions_v1");
    assert.equal(state?.exclusion_count, 1);
    assert.equal(state?.source_unit_id, failedUnitId);
    assert.equal(state?.planner_units, 1);
    assert.equal(state?.planner_jobs, 1);

    const derivedView = await getCardGenerationRun(context, derived.runId);
    assert.equal(derivedView?.coverage.imagesTotal, 1);
    assert.equal(derivedView?.coverage.imagesCompleted, 0);
    assert.equal(derivedView?.warnings.some((warning) => warning.code === "partial_coverage"), true);

    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [SUCCEEDED_IMAGE_UNIT_ID],
        idempotencyKey: "partial-v2-derived-run",
      }),
      "idempotency_key_reused",
      409,
    );

    const supersededView = await getCardGenerationRun(context, accepted.runId);
    assert.equal(supersededView?.status, "superseded");
    assert.equal(supersededView?.actions.canContinueWithExclusions, false);
    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [failedUnitId],
        idempotencyKey: "partial-v2-stale-source-run",
      }),
      "run_exclusions_not_available",
      409,
    );

    const replay = await continueCardGenerationRunWithExclusions(
      context,
      accepted.runId,
      {
        excludedUnitIds: [failedUnitId],
        idempotencyKey: "partial-v2-derived-run",
      },
    );
    assert.equal(replay?.runId, derived.runId);
    const [{ epoch }] = await admin<{ epoch: number }[]>`
      SELECT card_generation_epoch AS epoch FROM notes WHERE id = ${NOTE_ID}
    `;
    assert.equal(epoch, 2);

    const crossTenant = await continueCardGenerationRunWithExclusions(
      { workspaceId: OTHER_WORKSPACE_ID, userId: USER_ID },
      accepted.runId,
      {
        excludedUnitIds: [failedUnitId],
        idempotencyKey: "partial-v2-cross-tenant",
      },
    );
    assert.equal(crossTenant, null);
  } finally {
    if (previous === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previous;
  }
});

test("consecutive derived runs retain cumulative image exclusions and root fingerprint", async () => {
  const image1Content = "![第一张失败图](/api/uploads/partial/cumulative-1.png)";
  const image2Content = "![第二张失败图](/api/uploads/partial/cumulative-2.png)";
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${CUMULATIVE_USER_ID}, 'partial-v2-cumulative@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${CUMULATIVE_WORKSPACE_ID}, ${CUMULATIVE_USER_ID}, 'Partial v2 cumulative test')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${CUMULATIVE_WORKSPACE_ID}, ${CUMULATIVE_USER_ID}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (
        ${CUMULATIVE_NOTE_ID}, ${CUMULATIVE_WORKSPACE_ID},
        'Cumulative partial policy', ${CUMULATIVE_USER_ID}
      )`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${CUMULATIVE_VERSION_ID}, ${CUMULATIVE_NOTE_ID}, ${CUMULATIVE_WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [
          { type: "paragraph", content: "正文保证两张图片均排除后仍有生成输入。" },
          { type: "image", content: image1Content },
          { type: "image", content: image2Content },
        ] })},
        ${sha256("partial-cumulative-source")}, ${CUMULATIVE_USER_ID}
      )`;
    await tx`INSERT INTO note_image_assets (
      id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type,
      byte_size, width, height, status, created_by
    ) VALUES
      (
        ${CUMULATIVE_IMAGE_ASSET_1_ID}, ${CUMULATIVE_WORKSPACE_ID},
        ${CUMULATIVE_NOTE_ID}, 'partial/cumulative-1.png',
        ${sha256("partial-cumulative-image-1")}, 'image/png',
        128, 640, 480, 'ready', ${CUMULATIVE_USER_ID}
      ),
      (
        ${CUMULATIVE_IMAGE_ASSET_2_ID}, ${CUMULATIVE_WORKSPACE_ID},
        ${CUMULATIVE_NOTE_ID}, 'partial/cumulative-2.png',
        ${sha256("partial-cumulative-image-2")}, 'image/png',
        256, 800, 600, 'ready', ${CUMULATIVE_USER_ID}
      )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content, image_asset_id)
      VALUES
        (
          ${CUMULATIVE_TEXT_BLOCK_ID}, ${CUMULATIVE_VERSION_ID},
          ${CUMULATIVE_WORKSPACE_ID}, 0, 'paragraph',
          '正文保证两张图片均排除后仍有生成输入。', NULL
        ),
        (
          ${CUMULATIVE_IMAGE_BLOCK_1_ID}, ${CUMULATIVE_VERSION_ID},
          ${CUMULATIVE_WORKSPACE_ID}, 1, 'image',
          ${image1Content}, ${CUMULATIVE_IMAGE_ASSET_1_ID}
        ),
        (
          ${CUMULATIVE_IMAGE_BLOCK_2_ID}, ${CUMULATIVE_VERSION_ID},
          ${CUMULATIVE_WORKSPACE_ID}, 2, 'image',
          ${image2Content}, ${CUMULATIVE_IMAGE_ASSET_2_ID}
        )`;
    await tx`UPDATE notes
      SET current_version_id = ${CUMULATIVE_VERSION_ID}
      WHERE id = ${CUMULATIVE_NOTE_ID}`;
  });

  const previous = process.env.CARD_GENERATION_V2_ENABLED;
  process.env.CARD_GENERATION_V2_ENABLED = "true";
  try {
    const context = {
      workspaceId: CUMULATIVE_WORKSPACE_ID,
      userId: CUMULATIVE_USER_ID,
    };
    const root = await createCardGenerationRun(context, {
      noteVersionId: CUMULATIVE_VERSION_ID,
      idempotencyKey: "partial-v2-cumulative-root",
    });
    const [rootPlanner] = await admin<{ id: string }[]>`
      SELECT id FROM card_generation_units
      WHERE run_id = ${root.runId} AND kind = 'planner'
    `;
    assert.ok(rootPlanner);
    const firstFailedInput = {
      imageAssetId: CUMULATIVE_IMAGE_ASSET_1_ID,
      imageBlockId: CUMULATIVE_IMAGE_BLOCK_1_ID,
    };
    await admin.begin(async (tx) => {
      await tx`UPDATE jobs
        SET status = 'succeeded', finished_at = now()
        WHERE generation_run_id = ${root.runId}`;
      await tx`UPDATE card_generation_units
        SET status = 'succeeded', finished_at = now()
        WHERE id = ${rootPlanner.id}`;
      await tx`INSERT INTO card_generation_units (
        id, workspace_id, run_id, parent_unit_id, kind, level, ordinal,
        unit_key, pipeline_version, required, input_manifest, input_hash,
        token_estimate, status, error_code, finished_at
      ) VALUES (
        ${CUMULATIVE_FAILED_UNIT_1_ID}, ${CUMULATIVE_WORKSPACE_ID},
        ${root.runId}, ${rootPlanner.id}, 'image', 0, 0,
        ${sha256("partial-cumulative-failed-unit-1")}, 'card-generation-v2-m5',
        true, ${tx.json(firstFailedInput)}, ${sha256(JSON.stringify(firstFailedInput))},
        0, 'terminal_failed', 'image_provider_timeout', now()
      )`;
      await tx`UPDATE card_generation_runs
        SET status = 'needs_attention', stage = 'image_analysis',
            state_version = 2, next_event_sequence = 3,
            error_code = 'image_provider_timeout', retryable = true,
            required_units = 1, failed_units = 1, required_images = 2,
            source_coverage_bps = 0, image_coverage_bps = 0,
            finished_at = now(), updated_at = now()
        WHERE id = ${root.runId}`;
      await tx`INSERT INTO card_generation_events (
        run_id, workspace_id, sequence, stage, state, completed, total,
        unit, message_code, safe_details
      ) VALUES (
        ${root.runId}, ${CUMULATIVE_WORKSPACE_ID}, 2, 'image_analysis',
        'needs_attention', 0, 2, 'images', 'image_provider_timeout',
        ${tx.json({ unitId: CUMULATIVE_FAILED_UNIT_1_ID })}
      )`;
    });

    const firstDerived = await continueCardGenerationRunWithExclusions(
      context,
      root.runId,
      {
        excludedUnitIds: [CUMULATIVE_FAILED_UNIT_1_ID],
        idempotencyKey: "partial-v2-cumulative-first-derived",
      },
    );
    assert.ok(firstDerived);
    const [firstPlanner] = await admin<{ id: string }[]>`
      SELECT id FROM card_generation_units
      WHERE run_id = ${firstDerived.runId} AND kind = 'planner'
    `;
    assert.ok(firstPlanner);

    const secondFailedInput = {
      imageAssetId: CUMULATIVE_IMAGE_ASSET_2_ID,
      imageBlockId: CUMULATIVE_IMAGE_BLOCK_2_ID,
    };
    await admin.begin(async (tx) => {
      await tx`UPDATE jobs
        SET status = 'succeeded', finished_at = now()
        WHERE generation_run_id = ${firstDerived.runId}`;
      await tx`UPDATE card_generation_units
        SET status = 'succeeded', finished_at = now()
        WHERE id = ${firstPlanner.id}`;
      await tx`INSERT INTO card_generation_units (
        id, workspace_id, run_id, parent_unit_id, kind, level, ordinal,
        unit_key, pipeline_version, required, input_manifest, input_hash,
        token_estimate, status, error_code, finished_at
      ) VALUES (
        ${CUMULATIVE_FAILED_UNIT_2_ID}, ${CUMULATIVE_WORKSPACE_ID},
        ${firstDerived.runId}, ${firstPlanner.id}, 'image', 0, 1,
        ${sha256("partial-cumulative-failed-unit-2")}, 'card-generation-v2-m5',
        true, ${tx.json(secondFailedInput)}, ${sha256(JSON.stringify(secondFailedInput))},
        0, 'terminal_failed', 'image_provider_timeout', now()
      )`;
      await tx`UPDATE card_generation_runs
        SET status = 'needs_attention', stage = 'image_analysis',
            state_version = 2, next_event_sequence = 3,
            error_code = 'image_provider_timeout', retryable = true,
            required_units = 1, failed_units = 1, required_images = 2,
            completed_images = 0, source_coverage_bps = 0, image_coverage_bps = 0,
            finished_at = now(), updated_at = now()
        WHERE id = ${firstDerived.runId}`;
      await tx`INSERT INTO card_generation_events (
        run_id, workspace_id, sequence, stage, state, completed, total,
        unit, message_code, safe_details
      ) VALUES (
        ${firstDerived.runId}, ${CUMULATIVE_WORKSPACE_ID}, 2, 'image_analysis',
        'needs_attention', 0, 2, 'images', 'image_provider_timeout',
        ${tx.json({ unitId: CUMULATIVE_FAILED_UNIT_2_ID })}
      )`;
    });

    const firstAttention = await getCardGenerationRun(context, firstDerived.runId);
    assert.equal(firstAttention?.actions.canContinueWithExclusions, true);
    const secondDerived = await continueCardGenerationRunWithExclusions(
      context,
      firstDerived.runId,
      {
        excludedUnitIds: [CUMULATIVE_FAILED_UNIT_2_ID],
        idempotencyKey: "partial-v2-cumulative-second-derived",
      },
    );
    assert.ok(secondDerived);

    const [chain] = await admin<{
      root_status: string;
      first_status: string;
      second_status: string;
      root_fingerprint: string;
      first_fingerprint: string;
      second_fingerprint: string;
      first_root_fingerprint: string | null;
      second_root_fingerprint: string | null;
      second_source_run_id: string | null;
      second_policy_source_run_id: string | null;
      first_required_images: number;
      second_required_images: number;
      second_exclusion_count: number;
      second_requested_count: number;
      second_requested_unit_id: string | null;
      second_policy_coverage_bps: number;
      latest_run_id: string;
      generation_epoch: number;
    }[]>`
      SELECT
        root.status AS root_status,
        first.status AS first_status,
        second.status AS second_status,
        root.generation_fingerprint AS root_fingerprint,
        first.generation_fingerprint AS first_fingerprint,
        second.generation_fingerprint AS second_fingerprint,
        first.provider_snapshot->>'rootGenerationFingerprint' AS first_root_fingerprint,
        second.provider_snapshot->>'rootGenerationFingerprint' AS second_root_fingerprint,
        second.provider_snapshot->>'sourceRunId' AS second_source_run_id,
        second.exclusion_policy->>'sourceRunId' AS second_policy_source_run_id,
        first.required_images AS first_required_images,
        second.required_images AS second_required_images,
        jsonb_array_length(second.exclusion_policy->'excludedUnits') AS second_exclusion_count,
        jsonb_array_length(second.exclusion_policy->'requestedUnitIds') AS second_requested_count,
        second.exclusion_policy->'requestedUnitIds'->>0 AS second_requested_unit_id,
        (second.coverage_report->>'policyAdjustedImageCoverageBps')::int
          AS second_policy_coverage_bps,
        note.latest_generation_run_id AS latest_run_id,
        note.card_generation_epoch AS generation_epoch
      FROM card_generation_runs AS root
      JOIN card_generation_runs AS first ON first.supersedes_run_id = root.id
      JOIN card_generation_runs AS second ON second.supersedes_run_id = first.id
      JOIN notes AS note ON note.id = root.note_id
      WHERE root.id = ${root.runId}
        AND first.id = ${firstDerived.runId}
        AND second.id = ${secondDerived.runId}
    `;
    assert.equal(chain?.root_status, "superseded");
    assert.equal(chain?.first_status, "superseded");
    assert.equal(chain?.second_status, "queued");
    assert.ok(chain?.root_fingerprint);
    assert.equal(chain?.first_root_fingerprint, chain?.root_fingerprint);
    assert.equal(chain?.second_root_fingerprint, chain?.root_fingerprint);
    assert.notEqual(chain?.first_fingerprint, chain?.root_fingerprint);
    assert.notEqual(chain?.second_fingerprint, chain?.first_fingerprint);
    assert.equal(chain?.second_source_run_id, firstDerived.runId);
    assert.equal(chain?.second_policy_source_run_id, firstDerived.runId);
    assert.equal(chain?.first_required_images, 2);
    assert.equal(chain?.second_required_images, 2);
    assert.equal(chain?.second_exclusion_count, 2);
    assert.equal(chain?.second_requested_count, 1);
    assert.equal(chain?.second_requested_unit_id, CUMULATIVE_FAILED_UNIT_2_ID);
    assert.equal(chain?.second_policy_coverage_bps, 10_000);
    assert.equal(chain?.latest_run_id, secondDerived.runId);
    assert.equal(chain?.generation_epoch, 3);

    const exclusions = await admin<{
      source_unit_id: string;
      image_asset_id: string;
      image_block_id: string;
    }[]>`
      SELECT
        exclusion->>'sourceUnitId' AS source_unit_id,
        exclusion->>'imageAssetId' AS image_asset_id,
        exclusion->>'imageBlockId' AS image_block_id
      FROM card_generation_runs AS run
      CROSS JOIN LATERAL jsonb_array_elements(
        run.exclusion_policy->'excludedUnits'
      ) AS exclusion
      WHERE run.id = ${secondDerived.runId}
      ORDER BY exclusion->>'imageAssetId'
    `;
    assert.deepEqual(exclusions.map((row) => ({ ...row })), [
      {
        source_unit_id: CUMULATIVE_FAILED_UNIT_1_ID,
        image_asset_id: CUMULATIVE_IMAGE_ASSET_1_ID,
        image_block_id: CUMULATIVE_IMAGE_BLOCK_1_ID,
      },
      {
        source_unit_id: CUMULATIVE_FAILED_UNIT_2_ID,
        image_asset_id: CUMULATIVE_IMAGE_ASSET_2_ID,
        image_block_id: CUMULATIVE_IMAGE_BLOCK_2_ID,
      },
    ]);

    const [{ reintroduced_count: reintroducedCount }] = await admin<{
      reintroduced_count: number;
    }[]>`
      SELECT count(*)::int AS reintroduced_count
      FROM card_generation_units
      WHERE run_id IN (${firstDerived.runId}, ${secondDerived.runId})
        AND kind = 'image'
        AND input_manifest->>'imageAssetId' = ${CUMULATIVE_IMAGE_ASSET_1_ID}
    `;
    assert.equal(reintroducedCount, 0, "the first excluded image must not return in later runs");
  } finally {
    if (previous === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previous;
  }
});

test("an image-only run cannot exclude every generation input", async () => {
  const imageContent = "![唯一图片](/api/uploads/partial/image-only.png)";
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${IMAGE_ONLY_USER_ID}, 'partial-v2-image-only@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${IMAGE_ONLY_WORKSPACE_ID}, ${IMAGE_ONLY_USER_ID}, 'Partial v2 image-only test')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${IMAGE_ONLY_WORKSPACE_ID}, ${IMAGE_ONLY_USER_ID}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (
        ${IMAGE_ONLY_NOTE_ID}, ${IMAGE_ONLY_WORKSPACE_ID},
        'Image-only exclusion guard', ${IMAGE_ONLY_USER_ID}
      )`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${IMAGE_ONLY_VERSION_ID}, ${IMAGE_ONLY_NOTE_ID}, ${IMAGE_ONLY_WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{ type: "image", content: imageContent }] })},
        ${sha256("partial-image-only-source")}, ${IMAGE_ONLY_USER_ID}
      )`;
    await tx`INSERT INTO note_image_assets (
      id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type,
      byte_size, width, height, status, created_by
    ) VALUES (
      ${IMAGE_ONLY_ASSET_ID}, ${IMAGE_ONLY_WORKSPACE_ID}, ${IMAGE_ONLY_NOTE_ID},
      'partial/image-only.png', ${sha256("partial-image-only-asset")},
      'image/png', 128, 640, 480, 'ready', ${IMAGE_ONLY_USER_ID}
    )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content, image_asset_id)
      VALUES (
        ${IMAGE_ONLY_BLOCK_ID}, ${IMAGE_ONLY_VERSION_ID}, ${IMAGE_ONLY_WORKSPACE_ID},
        0, 'image', ${imageContent}, ${IMAGE_ONLY_ASSET_ID}
      )`;
    await tx`UPDATE notes
      SET current_version_id = ${IMAGE_ONLY_VERSION_ID}
      WHERE id = ${IMAGE_ONLY_NOTE_ID}`;
  });

  const previous = process.env.CARD_GENERATION_V2_ENABLED;
  process.env.CARD_GENERATION_V2_ENABLED = "true";
  try {
    const context = {
      workspaceId: IMAGE_ONLY_WORKSPACE_ID,
      userId: IMAGE_ONLY_USER_ID,
    };
    const accepted = await createCardGenerationRun(context, {
      noteVersionId: IMAGE_ONLY_VERSION_ID,
      idempotencyKey: "partial-v2-image-only-root",
    });
    const [planner] = await admin<{ id: string }[]>`
      SELECT id FROM card_generation_units
      WHERE run_id = ${accepted.runId} AND kind = 'planner'
    `;
    assert.ok(planner);
    const failedInput = {
      imageAssetId: IMAGE_ONLY_ASSET_ID,
      imageBlockId: IMAGE_ONLY_BLOCK_ID,
    };
    await admin.begin(async (tx) => {
      await tx`UPDATE jobs
        SET status = 'succeeded', finished_at = now()
        WHERE generation_run_id = ${accepted.runId}`;
      await tx`UPDATE card_generation_units
        SET status = 'succeeded', finished_at = now()
        WHERE id = ${planner.id}`;
      await tx`INSERT INTO card_generation_units (
        id, workspace_id, run_id, parent_unit_id, kind, level, ordinal,
        unit_key, pipeline_version, required, input_manifest, input_hash,
        token_estimate, status, error_code, finished_at
      ) VALUES (
        ${IMAGE_ONLY_FAILED_UNIT_ID}, ${IMAGE_ONLY_WORKSPACE_ID}, ${accepted.runId},
        ${planner.id}, 'image', 0, 0, ${sha256("partial-image-only-failed-unit")},
        'card-generation-v2-m5', true, ${tx.json(failedInput)},
        ${sha256(JSON.stringify(failedInput))}, 0, 'terminal_failed',
        'image_provider_timeout', now()
      )`;
      await tx`UPDATE card_generation_runs
        SET status = 'needs_attention', stage = 'image_analysis',
            state_version = 2, next_event_sequence = 3,
            error_code = 'image_provider_timeout', retryable = true,
            required_units = 0, failed_units = 1, required_images = 1,
            source_coverage_bps = 0, image_coverage_bps = 0,
            finished_at = now(), updated_at = now()
        WHERE id = ${accepted.runId}`;
      await tx`INSERT INTO card_generation_events (
        run_id, workspace_id, sequence, stage, state, completed, total,
        unit, message_code, safe_details
      ) VALUES (
        ${accepted.runId}, ${IMAGE_ONLY_WORKSPACE_ID}, 2, 'image_analysis',
        'needs_attention', 0, 1, 'images', 'image_provider_timeout',
        ${tx.json({ unitId: IMAGE_ONLY_FAILED_UNIT_ID })}
      )`;
    });

    await assertServiceError(
      continueCardGenerationRunWithExclusions(context, accepted.runId, {
        excludedUnitIds: [IMAGE_ONLY_FAILED_UNIT_ID],
        idempotencyKey: "partial-v2-image-only-no-input",
      }),
      "no_remaining_generation_input",
      422,
    );
    const [unchanged] = await admin<{
      status: string;
      generation_epoch: number;
      latest_run_id: string;
      derived_count: number;
    }[]>`
      SELECT
        run.status,
        note.card_generation_epoch AS generation_epoch,
        note.latest_generation_run_id AS latest_run_id,
        (
          SELECT count(*)::int
          FROM card_generation_runs AS derived
          WHERE derived.supersedes_run_id = run.id
        ) AS derived_count
      FROM card_generation_runs AS run
      JOIN notes AS note ON note.id = run.note_id
      WHERE run.id = ${accepted.runId}
    `;
    assert.equal(unchanged?.status, "needs_attention");
    assert.equal(unchanged?.generation_epoch, 1);
    assert.equal(unchanged?.latest_run_id, accepted.runId);
    assert.equal(unchanged?.derived_count, 0);
  } finally {
    if (previous === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previous;
  }
});
