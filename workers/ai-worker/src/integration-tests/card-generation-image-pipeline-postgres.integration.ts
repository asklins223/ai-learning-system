import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { processJob } from "../index.ts";
import { claimJobs } from "../queue.ts";

const adminUrl = process.env.CARD_GENERATION_IMAGE_V2_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_IMAGE_V2_TEST_ADMIN_URL is required");

const storageEndpoint = process.env.STORAGE_ENDPOINT;
const storageUser = process.env.MINIO_ROOT_USER;
const storagePassword = process.env.MINIO_ROOT_PASSWORD;
if (!storageEndpoint || !storageUser || !storagePassword) {
  throw new Error("STORAGE_ENDPOINT and MinIO credentials are required");
}

const admin = postgres(adminUrl, { max: 1 });
const bucket = process.env.S3_BUCKET ?? "ailearn-workspaces";
const storage = new S3Client({
  endpoint: storageEndpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: { accessKeyId: storageUser, secretAccessKey: storagePassword },
  forcePathStyle: true,
});

const USER_ID = "12000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "22000000-0000-4000-8000-000000000001";
const NOTE_ID = "32000000-0000-4000-8000-000000000001";
const VERSION_ID = "42000000-0000-4000-8000-000000000001";
const CACHED_BLOCK_ID = "52000000-0000-4000-8000-000000000001";
const DECORATIVE_BLOCK_ID = "52000000-0000-4000-8000-000000000002";
const CACHED_ASSET_ID = "82000000-0000-4000-8000-000000000001";
const DECORATIVE_ASSET_ID = "82000000-0000-4000-8000-000000000002";
const CACHED_INSIGHT_ID = "92000000-0000-4000-8000-000000000001";
const CACHED_EVIDENCE_ID = "a2000000-0000-4000-8000-000000000001";
const RUN_ID = "62000000-0000-4000-8000-000000000001";
const PLANNER_UNIT_ID = "72000000-0000-4000-8000-000000000001";
const GOVERNANCE_VERSION = "workspace-policy-snapshot-v1";
const CACHED_OBJECT_KEY = `${WORKSPACE_ID}/notes/${NOTE_ID}/cached.png`;
const DECORATIVE_OBJECT_KEY = `${WORKSPACE_ID}/notes/${NOTE_ID}/decorative.png`;
const cachedBytes = Buffer.from("cached-image-bytes");
const decorativeBytes = Buffer.from("decorative-image-bytes");
const cachedEvidenceText = "图中流程明确说明：写入完成后必须验证缓存一致性。";

const PARTIAL_USER_ID = "13000000-0000-4000-8000-000000000001";
const PARTIAL_WORKSPACE_ID = "23000000-0000-4000-8000-000000000001";
const PARTIAL_NOTE_ID = "33000000-0000-4000-8000-000000000001";
const PARTIAL_VERSION_ID = "43000000-0000-4000-8000-000000000001";
const PARTIAL_TEXT_BLOCK_ID = "53000000-0000-4000-8000-000000000001";
const PARTIAL_IMAGE_BLOCK_ID = "53000000-0000-4000-8000-000000000002";
const PARTIAL_ASSET_ID = "83000000-0000-4000-8000-000000000001";
const PARTIAL_SOURCE_RUN_ID = "63000000-0000-4000-8000-000000000000";
const PARTIAL_RUN_ID = "63000000-0000-4000-8000-000000000001";
const PARTIAL_FAILED_UNIT_ID = "73000000-0000-4000-8000-000000000000";
const PARTIAL_PLANNER_UNIT_ID = "73000000-0000-4000-8000-000000000001";
const PARTIAL_OLD_CARD_ID = "d3000000-0000-4000-8000-000000000001";
const PARTIAL_REVIEW_ID = "e3000000-0000-4000-8000-000000000001";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

test.after(async () => {
  await Promise.allSettled([
    storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: CACHED_OBJECT_KEY })),
    storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: DECORATIVE_OBJECT_KEY })),
  ]);
  storage.destroy();
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("multimodal v2 reuses cached OCR, analyzes remaining images, and publishes typed region evidence", async () => {
  await Promise.all([
    storage.send(new PutObjectCommand({
      Bucket: bucket,
      Key: CACHED_OBJECT_KEY,
      Body: cachedBytes,
      ContentType: "image/png",
    })),
    storage.send(new PutObjectCommand({
      Bucket: bucket,
      Key: DECORATIVE_OBJECT_KEY,
      Body: decorativeBytes,
      ContentType: "image/png",
    })),
  ]);

  const cachedContent = `![业务流程](/api/uploads/${CACHED_OBJECT_KEY})`;
  const decorativeContent = `![装饰插图](/api/uploads/${DECORATIVE_OBJECT_KEY})`;
  const cachedAssetHash = sha256(cachedBytes);
  const decorativeAssetHash = sha256(decorativeBytes);
  const cacheKey = hashJson({
    workspaceId: WORKSPACE_ID,
    assetSha256: cachedAssetHash,
    extractorVersion: "image-insight-v1",
    visionModelId: "mock-vision-v1",
    promptVersion: "image-understanding-v1",
    governancePolicyVersion: GOVERNANCE_VERSION,
  });

  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'image-v2-worker@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_provider, ai_data_policy)
      VALUES (
        ${WORKSPACE_ID}, ${USER_ID}, 'Image v2 worker test', 'mock',
        ${tx.json({
          sendToExternal: true,
          sendImageContent: true,
          piiDetection: true,
          auditLogging: true,
        })}
      )`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Image-only notes', ${USER_ID}, 1)`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({
          blocks: [
            { type: "image", content: cachedContent },
            { type: "image", content: decorativeContent },
          ],
        })},
        ${sha256(`${cachedContent}\n${decorativeContent}`)}, ${USER_ID}
      )`;
    await tx`INSERT INTO note_image_assets (
      id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type,
      byte_size, width, height, status, created_by
    ) VALUES
      (
        ${CACHED_ASSET_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${CACHED_OBJECT_KEY},
        ${cachedAssetHash}, 'image/png', ${cachedBytes.length}, 640, 480,
        'ready', ${USER_ID}
      ),
      (
        ${DECORATIVE_ASSET_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${DECORATIVE_OBJECT_KEY},
        ${decorativeAssetHash}, 'image/png', ${decorativeBytes.length}, 800, 600,
        'ready', ${USER_ID}
      )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content, image_asset_id)
      VALUES
        (${CACHED_BLOCK_ID}, ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'image', ${cachedContent}, ${CACHED_ASSET_ID}),
        (${DECORATIVE_BLOCK_ID}, ${VERSION_ID}, ${WORKSPACE_ID}, 1, 'image', ${decorativeContent}, ${DECORATIVE_ASSET_ID})`;
    await tx`UPDATE note_versions
      SET sealed_at = now(), sealed_reason = 'card_generation_v2'
      WHERE id = ${VERSION_ID}`;
    await tx`INSERT INTO note_image_insights (
      id, workspace_id, image_asset_id, cache_key, extractor_version,
      vision_model_id, prompt_version, governance_policy_version, status,
      content_type, caption, ocr_json, facts_json, safety_json, artifact_hash,
      attempts, finished_at
    ) VALUES (
      ${CACHED_INSIGHT_ID}, ${WORKSPACE_ID}, ${CACHED_ASSET_ID}, ${cacheKey},
      'image-insight-v1', 'mock-vision-v1', 'image-understanding-v1',
      ${GOVERNANCE_VERSION}, 'succeeded', 'document', '缓存一致性流程图',
      ${tx.json([{ text: cachedEvidenceText, region: { x: 100, y: 200, width: 4_000, height: 1_000 }, confidence: 0.99 }])},
      '[]'::jsonb, ${tx.json({ decorative: false, promptInjectionDetected: false, safetyFlags: [] })},
      ${sha256("cached-insight-artifact")}, 1, now()
    )`;
    await tx`INSERT INTO note_image_evidence_units (
      id, workspace_id, image_insight_id, image_asset_id, unit_key, ordinal,
      source_kind, text, text_hash, region, confidence_bps, evidence_level, required
    ) VALUES (
      ${CACHED_EVIDENCE_ID}, ${WORKSPACE_ID}, ${CACHED_INSIGHT_ID}, ${CACHED_ASSET_ID},
      ${sha256("cached-ocr-unit")}, 0, 'image_ocr', ${cachedEvidenceText},
      ${sha256(cachedEvidenceText)},
      ${tx.json({ x: 100, y: 200, width: 4_000, height: 1_000 })},
      9900, 'image_ocr_exact', true
    )`;
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
      'image-v2-integration', ${sha256("image-v2-run")}, 1,
      'Image-only notes', ${sha256(`${cachedContent}\n${decorativeContent}`)},
      ${sha256("image-block-manifest")}, ${sha256("image-asset-manifest")},
      ${tx.json([
        { blockId: CACHED_BLOCK_ID, ordinal: 0, type: "image", contentHash: sha256(cachedContent) },
        { blockId: DECORATIVE_BLOCK_ID, ordinal: 1, type: "image", contentHash: sha256(decorativeContent) },
      ])},
      ${tx.json([
        { blockId: CACHED_BLOCK_ID, ordinal: 0, assetId: CACHED_ASSET_ID, sourceHash: cachedAssetHash },
        { blockId: DECORATIVE_BLOCK_ID, ordinal: 1, assetId: DECORATIVE_ASSET_ID, sourceHash: decorativeAssetHash },
      ])},
      'card-generation-v2-m5', 'map-candidate-v1+image-understanding-v1+deck-plan-v1',
      ${tx.json({ executionMode: "multimodal_v2" })}, ${GOVERNANCE_VERSION},
      'queued', 'queued', 1, 2, true, 0, 2, 10000, 0,
      ${tx.json({ measurement: "planned" })}
    )`;
    await tx`UPDATE notes
      SET current_version_id = ${VERSION_ID}, latest_generation_run_id = ${RUN_ID}
      WHERE id = ${NOTE_ID}`;
    await tx`INSERT INTO card_generation_events
      (run_id, workspace_id, sequence, stage, state, completed, total, unit, message_code)
      VALUES (${RUN_ID}, ${WORKSPACE_ID}, 1, 'snapshot', 'queued', 2, 2, 'blocks', 'source_snapshot_sealed')`;
    await tx`INSERT INTO card_generation_units (
      id, workspace_id, run_id, kind, level, ordinal, unit_key,
      pipeline_version, required, input_manifest, input_hash, token_estimate,
      status, scheduled_at
    ) VALUES (
      ${PLANNER_UNIT_ID}, ${WORKSPACE_ID}, ${RUN_ID}, 'planner', 0, 0,
      ${sha256("image-v2-planner")}, 'card-generation-v2-m5', true,
      '{}'::jsonb, ${sha256("image-v2-run")}, 0, 'pending', now()
    )`;
    await tx`INSERT INTO jobs (
      type, workspace_id, requested_by, payload, status, generation_run_id,
      generation_unit_id, stage, priority, resource_class, idempotency_key
    ) VALUES (
      'plan_card_generation', ${WORKSPACE_ID}, ${USER_ID},
      ${tx.json({
        noteVersionId: VERSION_ID,
        generationRunId: RUN_ID,
        generationUnitId: PLANNER_UNIT_ID,
        userId: USER_ID,
      })},
      'pending', ${RUN_ID}, ${PLANNER_UNIT_ID}, 'planner', 80,
      'card_foreground', 'image-v2-planner-job'
    )`;
  });

  let terminalStatus = "queued";
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const [run] = await admin<{ status: string }[]>`
      SELECT status FROM card_generation_runs WHERE id = ${RUN_ID}
    `;
    terminalStatus = run?.status ?? "missing";
    if (["succeeded", "needs_attention", "cancelled", "superseded"].includes(terminalStatus)) {
      break;
    }
    const claimed = await claimJobs(undefined, 4);
    assert.ok(claimed.length > 0, `image pipeline stalled in ${terminalStatus} at iteration ${iteration}`);
    await Promise.all(claimed.map((job) => processJob(job)));
  }
  assert.equal(terminalStatus, "succeeded");

  const [result] = await admin<{
    required_units: number;
    completed_units: number;
    required_images: number;
    completed_images: number;
    source_coverage_bps: number;
    image_coverage_bps: number;
    image_units: number;
    insights: number;
    decorative_insights: number;
    deck_plan_units: number;
    card_render_units: number;
    publish_units: number;
    result_card_set_id: string | null;
    result_card_id_is_overview: boolean;
    set_status: string;
    card_count: number;
    image_evidences: number;
    text_evidences: number;
    mismatched_hashes: number;
    align_jobs: number;
  }[]>`
    SELECT
      run.required_units,
      run.completed_units,
      run.required_images,
      run.completed_images,
      run.source_coverage_bps,
      run.image_coverage_bps,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'image' AND status = 'succeeded') AS image_units,
      (SELECT count(*)::int FROM note_image_insights
        WHERE workspace_id = run.workspace_id AND status = 'succeeded') AS insights,
      (SELECT count(*)::int FROM note_image_insights
        WHERE workspace_id = run.workspace_id
          AND status = 'succeeded'
          AND safety_json->>'decorative' = 'true') AS decorative_insights,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'deck_plan') AS deck_plan_units,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'card_render') AS card_render_units,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'publish') AS publish_units,
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
      (SELECT count(*)::int FROM evidences AS evidence
        JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
        JOIN learning_cards AS card ON card.id = kp.card_id
        WHERE card.card_set_id = run.result_card_set_id
          AND evidence.source_kind = 'image_region'
          AND evidence.image_asset_id = ${CACHED_ASSET_ID}
          AND evidence.image_insight_id = ${CACHED_INSIGHT_ID}
          AND evidence.image_evidence_unit_id = ${CACHED_EVIDENCE_ID}
          AND evidence.alignment_method = 'image_ocr'
          AND jsonb_typeof(evidence.region_json) = 'object') AS image_evidences,
      (SELECT count(*)::int FROM evidences AS evidence
        JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
        JOIN learning_cards AS card ON card.id = kp.card_id
        WHERE card.card_set_id = run.result_card_set_id
          AND evidence.source_kind = 'text_span') AS text_evidences,
      (SELECT count(*)::int FROM evidences AS evidence
        JOIN note_image_evidence_units AS unit
          ON unit.id = evidence.image_evidence_unit_id
        JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
        WHERE kp.card_id = run.result_card_id
          AND evidence.source_hash <> unit.text_hash) AS mismatched_hashes,
      (SELECT count(*)::int FROM jobs
        WHERE generation_run_id = run.id AND type = 'align_evidence') AS align_jobs
    FROM card_generation_runs AS run
    JOIN learning_card_sets AS result_set ON result_set.id = run.result_card_set_id
    WHERE run.id = ${RUN_ID}
  `;
  assert.equal(result?.required_units, 0);
  assert.equal(result?.completed_units, 0);
  assert.equal(result?.required_images, 2);
  assert.equal(result?.completed_images, 2);
  assert.equal(result?.source_coverage_bps, 10_000);
  assert.equal(result?.image_coverage_bps, 10_000);
  assert.equal(result?.image_units, 2);
  assert.equal(result?.insights, 2);
  assert.equal(result?.decorative_insights, 1);
  assert.equal(result?.deck_plan_units, 1);
  assert.equal(result?.card_render_units, 1);
  assert.equal(result?.publish_units, 1);
  assert.ok(result?.result_card_set_id);
  assert.equal(result?.result_card_id_is_overview, true);
  assert.equal(result?.set_status, "active");
  assert.equal(result?.card_count, 1);
  assert.equal(result?.image_evidences, 1);
  assert.equal(result?.text_evidences, 0);
  assert.equal(result?.mismatched_hashes, 0);
  assert.equal(result?.align_jobs, 0);

  const [published] = await admin<{
    quote_text: string;
    region_json: { x: number; y: number; width: number; height: number };
    extractor_version: string;
  }[]>`
    SELECT evidence.quote_text, evidence.region_json, evidence.extractor_version
    FROM evidences AS evidence
    JOIN card_key_points AS kp ON kp.id = evidence.key_point_id
    JOIN learning_cards AS card ON card.id = kp.card_id
    JOIN card_generation_runs AS run ON run.result_card_set_id = card.card_set_id
    WHERE run.id = ${RUN_ID} AND evidence.source_kind = 'image_region'
  `;
  assert.equal(published?.quote_text, cachedEvidenceText);
  assert.deepEqual(published?.region_json, { x: 100, y: 200, width: 4_000, height: 1_000 });
  assert.equal(published?.extractor_version, "image-insight-v1");
});

test("explicit image exclusions publish a visible partial result without replacing the complete card", async () => {
  const paragraph = "缓存写入完成后必须验证读取结果，以避免把陈旧数据交给调用方。";
  const imageContent = "![暂时无法解析的流程图](/api/uploads/partial/missing.png)";
  const imageHash = sha256("partial-image-bytes");
  const sourceFingerprint = sha256("partial-source-run");
  const failedInput = {
    imageAssetId: PARTIAL_ASSET_ID,
    imageBlockId: PARTIAL_IMAGE_BLOCK_ID,
  };
  const failedInputHash = hashJson({ assetSha256: imageHash, inputManifest: failedInput });

  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${PARTIAL_USER_ID}, 'partial-v2-worker@example.invalid', 'unused')`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_provider, ai_data_policy)
      VALUES (
        ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_USER_ID}, 'Partial v2 worker test', 'mock',
        ${tx.json({
          sendToExternal: true,
          sendImageContent: true,
          piiDetection: true,
          auditLogging: true,
        })}
      )`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${PARTIAL_WORKSPACE_ID}, ${PARTIAL_USER_ID}, 'owner')`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (
        ${PARTIAL_NOTE_ID}, ${PARTIAL_WORKSPACE_ID}, 'Partial generation',
        ${PARTIAL_USER_ID}, 2
      )`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash,
       created_by)
      VALUES (
        ${PARTIAL_VERSION_ID}, ${PARTIAL_NOTE_ID}, ${PARTIAL_WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [
          { type: "paragraph", content: paragraph },
          { type: "image", content: imageContent },
        ] })},
        ${sha256(`${paragraph}\n${imageContent}`)}, ${PARTIAL_USER_ID}
      )`;
    await tx`INSERT INTO note_image_assets (
      id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type,
      byte_size, width, height, status, created_by
    ) VALUES (
      ${PARTIAL_ASSET_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_NOTE_ID},
      'partial/missing.png', ${imageHash}, 'image/png', 64, 640, 480,
      'ready', ${PARTIAL_USER_ID}
    )`;
    await tx`INSERT INTO note_blocks
      (id, version_id, workspace_id, ordinal, type, content, image_asset_id)
      VALUES
        (
          ${PARTIAL_TEXT_BLOCK_ID}, ${PARTIAL_VERSION_ID}, ${PARTIAL_WORKSPACE_ID},
          0, 'paragraph', ${paragraph}, NULL
        ),
        (
          ${PARTIAL_IMAGE_BLOCK_ID}, ${PARTIAL_VERSION_ID}, ${PARTIAL_WORKSPACE_ID},
          1, 'image', ${imageContent}, ${PARTIAL_ASSET_ID}
        )`;
    await tx`UPDATE note_versions
      SET sealed_at = now(), sealed_reason = 'card_generation_v2'
      WHERE id = ${PARTIAL_VERSION_ID}`;
    await tx`INSERT INTO learning_cards (
      id, note_version_id, workspace_id, status, schema_json
    ) VALUES (
      ${PARTIAL_OLD_CARD_ID}, ${PARTIAL_VERSION_ID}, ${PARTIAL_WORKSPACE_ID},
      'active', ${tx.json({ title: "已接受的完整卡", summary: "必须保持可用。" })}
    )`;
    await tx`INSERT INTO review_schedules (
      id, workspace_id, user_id, subject_type, subject_id, status,
      next_review_at, interval_days
    ) VALUES (
      ${PARTIAL_REVIEW_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_USER_ID},
      'card', ${PARTIAL_OLD_CARD_ID}, 'pending', now() + interval '1 day', 1
    )`;
    await tx`INSERT INTO search_documents (
      workspace_id, object_type, object_id, title, body
    ) VALUES (
      ${PARTIAL_WORKSPACE_ID}, 'card', ${PARTIAL_OLD_CARD_ID},
      '已接受的完整卡', '必须保持可搜索。'
    )`;
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
      ${PARTIAL_SOURCE_RUN_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_NOTE_ID},
      ${PARTIAL_VERSION_ID}, ${PARTIAL_USER_ID}, 'partial-source-history',
      ${sourceFingerprint}, 1, 'Partial generation',
      ${sha256(`${paragraph}\n${imageContent}`)}, ${sha256("partial-blocks")},
      ${sha256("partial-assets")},
      ${tx.json([
        { blockId: PARTIAL_TEXT_BLOCK_ID, ordinal: 0, type: "paragraph", contentHash: sha256(paragraph) },
        { blockId: PARTIAL_IMAGE_BLOCK_ID, ordinal: 1, type: "image", contentHash: sha256(imageContent) },
      ])},
      ${tx.json([
        { blockId: PARTIAL_IMAGE_BLOCK_ID, ordinal: 1, assetId: PARTIAL_ASSET_ID, sourceHash: imageHash },
      ])},
      'card-generation-v2-m5', 'map-candidate-v1+image-understanding-v1+deck-plan-v1',
      ${tx.json({ executionMode: "multimodal_v2" })}, ${GOVERNANCE_VERSION},
      'superseded', 'complete', 3, 3, false, 1, 1, 0, 0,
      ${tx.json({ measurement: "exact_primary_units" })}
    )`;
    await tx`INSERT INTO card_generation_units (
      id, workspace_id, run_id, kind, level, ordinal, unit_key,
      pipeline_version, required, input_manifest, input_hash, token_estimate,
      status, error_code, finished_at
    ) VALUES (
      ${PARTIAL_FAILED_UNIT_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_SOURCE_RUN_ID},
      'image', 0, 0, ${sha256("partial-failed-unit")},
      'card-generation-v2-m5', true, ${tx.json(failedInput)},
      ${failedInputHash}, 0, 'terminal_failed', 'image_provider_timeout', now()
    )`;
    await tx`INSERT INTO card_generation_runs (
      id, workspace_id, note_id, note_version_id, requested_by,
      request_idempotency_key, generation_fingerprint, generation_epoch,
      supersedes_run_id, title_snapshot, source_content_hash,
      block_manifest_hash, asset_manifest_hash, block_manifest, asset_manifest,
      pipeline_version, prompt_bundle_version, provider_snapshot,
      governance_policy_version, status, stage, state_version,
      next_event_sequence, retryable, required_units, required_images,
      source_coverage_bps, image_coverage_bps, coverage_report, exclusion_policy
    ) VALUES (
      ${PARTIAL_RUN_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_NOTE_ID},
      ${PARTIAL_VERSION_ID}, ${PARTIAL_USER_ID}, 'partial-derived-worker',
      ${sha256("partial-derived-run")}, 2, ${PARTIAL_SOURCE_RUN_ID},
      'Partial generation', ${sha256(`${paragraph}\n${imageContent}`)},
      ${sha256("partial-blocks")}, ${sha256("partial-assets")},
      ${tx.json([
        { blockId: PARTIAL_TEXT_BLOCK_ID, ordinal: 0, type: "paragraph", contentHash: sha256(paragraph) },
        { blockId: PARTIAL_IMAGE_BLOCK_ID, ordinal: 1, type: "image", contentHash: sha256(imageContent) },
      ])},
      ${tx.json([
        { blockId: PARTIAL_IMAGE_BLOCK_ID, ordinal: 1, assetId: PARTIAL_ASSET_ID, sourceHash: imageHash },
      ])},
      'card-generation-v2-m5', 'map-candidate-v1+image-understanding-v1+deck-plan-v1',
      ${tx.json({
        executionMode: "multimodal_v2",
        partialPolicy: "explicit_image_exclusions_v1",
        sourceRunId: PARTIAL_SOURCE_RUN_ID,
      })},
      ${GOVERNANCE_VERSION}, 'queued', 'queued', 1, 2, true, 0, 1, 0, 0,
      ${tx.json({
        measurement: "planned",
        resultCompleteness: "partial",
        originalRequiredImages: 1,
        excludedImages: [{
          sourceUnitId: PARTIAL_FAILED_UNIT_ID,
          imageAssetId: PARTIAL_ASSET_ID,
          imageBlockId: PARTIAL_IMAGE_BLOCK_ID,
          reason: "image_provider_timeout",
        }],
      })},
      ${tx.json({
        mode: "explicit_image_exclusions_v1",
        sourceRunId: PARTIAL_SOURCE_RUN_ID,
        requestedBy: PARTIAL_USER_ID,
        requestedAt: new Date().toISOString(),
        excludedUnits: [{
          sourceUnitId: PARTIAL_FAILED_UNIT_ID,
          kind: "image",
          inputHash: failedInputHash,
          imageAssetId: PARTIAL_ASSET_ID,
          imageBlockId: PARTIAL_IMAGE_BLOCK_ID,
          errorCode: "image_provider_timeout",
        }],
      })}
    )`;
    await tx`UPDATE notes
      SET current_version_id = ${PARTIAL_VERSION_ID},
          latest_generation_run_id = ${PARTIAL_RUN_ID}
      WHERE id = ${PARTIAL_NOTE_ID}`;
    await tx`INSERT INTO card_generation_events (
      run_id, workspace_id, sequence, stage, state, completed, total, unit,
      message_code
    ) VALUES (
      ${PARTIAL_RUN_ID}, ${PARTIAL_WORKSPACE_ID}, 1, 'snapshot', 'queued',
      0, 1, 'run', 'partial_generation_derived'
    )`;
    await tx`INSERT INTO card_generation_units (
      id, workspace_id, run_id, kind, level, ordinal, unit_key,
      pipeline_version, required, input_manifest, input_hash, token_estimate,
      status, scheduled_at
    ) VALUES (
      ${PARTIAL_PLANNER_UNIT_ID}, ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_RUN_ID},
      'planner', 0, 0, ${sha256("partial-planner")},
      'card-generation-v2-m5', true, '{}'::jsonb,
      ${sha256("partial-derived-run")}, 0, 'pending', now()
    )`;
    await tx`INSERT INTO jobs (
      type, workspace_id, requested_by, payload, status, generation_run_id,
      generation_unit_id, stage, priority, resource_class, idempotency_key
    ) VALUES (
      'plan_card_generation', ${PARTIAL_WORKSPACE_ID}, ${PARTIAL_USER_ID},
      ${tx.json({
        noteVersionId: PARTIAL_VERSION_ID,
        generationRunId: PARTIAL_RUN_ID,
        generationUnitId: PARTIAL_PLANNER_UNIT_ID,
        userId: PARTIAL_USER_ID,
      })},
      'pending', ${PARTIAL_RUN_ID}, ${PARTIAL_PLANNER_UNIT_ID}, 'planner', 80,
      'card_foreground', 'partial-v2-planner-job'
    )`;
  });

  let terminalStatus = "queued";
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const [run] = await admin<{ status: string }[]>`
      SELECT status FROM card_generation_runs WHERE id = ${PARTIAL_RUN_ID}
    `;
    terminalStatus = run?.status ?? "missing";
    if (["partial_ready", "needs_attention", "cancelled", "superseded"].includes(terminalStatus)) {
      break;
    }
    const claimed = await claimJobs(undefined, 4);
    assert.ok(claimed.length > 0, `partial pipeline stalled in ${terminalStatus} at iteration ${iteration}`);
    await Promise.all(claimed.map((job) => processJob(job)));
  }
  assert.equal(terminalStatus, "partial_ready");

  const [result] = await admin<{
    required_images: number;
    completed_images: number;
    image_coverage_bps: number;
    policy_coverage_bps: number;
    image_units: number;
    result_card_set_id: string | null;
    result_card_id_is_overview: boolean;
    result_set_status: string;
    result_card_count: number;
    result_status: string;
    warning_code: string;
    warning_count: number;
    warning_asset_id: string;
    warning_block_id: string;
    old_status: string;
    old_superseded_by: string | null;
    old_review_status: string;
    old_search_rows: number;
    partial_search_rows: number;
  }[]>`
    SELECT
      run.required_images,
      run.completed_images,
      run.image_coverage_bps,
      (run.coverage_report->>'policyAdjustedImageCoverageBps')::int
        AS policy_coverage_bps,
      (SELECT count(*)::int FROM card_generation_units
        WHERE run_id = run.id AND kind = 'image') AS image_units,
      run.result_card_set_id,
      (
        result.id = run.result_card_id
        AND result.card_set_id = run.result_card_set_id
        AND result.scope = 'overview'
        AND result.ordinal = 0
      ) AS result_card_id_is_overview,
      result_set.status AS result_set_status,
      (SELECT count(*)::int FROM learning_cards
        WHERE card_set_id = run.result_card_set_id) AS result_card_count,
      result.status AS result_status,
      result.schema_json->'coverageWarning'->>'code' AS warning_code,
      (result.schema_json->'coverageWarning'->>'excludedImageCount')::int
        AS warning_count,
      result.schema_json->'coverageWarning'->'excludedImages'->0->>'imageAssetId'
        AS warning_asset_id,
      result.schema_json->'coverageWarning'->'excludedImages'->0->>'imageBlockId'
        AS warning_block_id,
      old.status AS old_status,
      old.superseded_by_card_id AS old_superseded_by,
      review.status AS old_review_status,
      (SELECT count(*)::int FROM search_documents
        WHERE workspace_id = run.workspace_id
          AND object_type = 'card' AND object_id = old.id) AS old_search_rows,
      (SELECT count(*)::int FROM search_documents
        WHERE workspace_id = run.workspace_id
          AND object_id = result.id) AS partial_search_rows
    FROM card_generation_runs AS run
    JOIN learning_card_sets AS result_set ON result_set.id = run.result_card_set_id
    JOIN learning_cards AS result ON result.id = run.result_card_id
    JOIN learning_cards AS old ON old.id = ${PARTIAL_OLD_CARD_ID}
    JOIN review_schedules AS review ON review.id = ${PARTIAL_REVIEW_ID}
    WHERE run.id = ${PARTIAL_RUN_ID}
  `;
  assert.equal(result?.required_images, 1);
  assert.equal(result?.completed_images, 0);
  assert.equal(result?.image_coverage_bps, 0);
  assert.equal(result?.policy_coverage_bps, 10_000);
  assert.equal(result?.image_units, 0, "planner must not schedule an excluded image");
  assert.ok(result?.result_card_set_id);
  assert.equal(result?.result_card_id_is_overview, true);
  assert.equal(result?.result_set_status, "partial_ready");
  assert.equal(result?.result_card_count, 1);
  assert.equal(result?.result_status, "archived");
  assert.equal(result?.warning_code, "partial_generation");
  assert.equal(result?.warning_count, 1);
  assert.equal(result?.warning_asset_id, PARTIAL_ASSET_ID);
  assert.equal(result?.warning_block_id, PARTIAL_IMAGE_BLOCK_ID);
  assert.equal(result?.old_status, "active");
  assert.equal(result?.old_superseded_by, null);
  assert.equal(result?.old_review_status, "pending");
  assert.equal(result?.old_search_rows, 1);
  assert.equal(result?.partial_search_rows, 0);
});
