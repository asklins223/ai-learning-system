import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildGenerationFingerprint,
  buildGenerationManifests,
} from "../modules/card-generation/service.ts";

const migration = readFileSync(
  new URL("../db/migrations/0044_card_generation_run_bridge.sql", import.meta.url),
  "utf8",
);
const imageMigration = readFileSync(
  new URL("../db/migrations/0046_card_generation_image_pipeline.sql", import.meta.url),
  "utf8",
);
const partialTerminalMigration = readFileSync(
  new URL("../db/migrations/0047_card_generation_partial_terminal.sql", import.meta.url),
  "utf8",
);
const cardSetMigration = readFileSync(
  new URL("../db/migrations/0048_learning_card_sets.sql", import.meta.url),
  "utf8",
);
const m5IntegrityMigration = readFileSync(
  new URL("../db/migrations/0049_card_generation_m5_integrity.sql", import.meta.url),
  "utf8",
);
const cardGenerationDbSchema = readFileSync(
  new URL("../db/schema/card-generation.ts", import.meta.url),
  "utf8",
);
const cardDbSchema = readFileSync(
  new URL("../db/schema/card.ts", import.meta.url),
  "utf8",
);
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const routes = readFileSync(
  new URL("../modules/card-generation/routes.ts", import.meta.url),
  "utf8",
);
const generationService = readFileSync(
  new URL("../modules/card-generation/service.ts", import.meta.url),
  "utf8",
);
const generationRequestSchema = readFileSync(
  new URL("../modules/card-generation/schema.ts", import.meta.url),
  "utf8",
);
const noteService = readFileSync(
  new URL("../modules/note/service.ts", import.meta.url),
  "utf8",
);
const cardRoutes = readFileSync(
  new URL("../modules/card/routes.ts", import.meta.url),
  "utf8",
);
const cardService = readFileSync(
  new URL("../modules/card/service.ts", import.meta.url),
  "utf8",
);

test("generation manifests are ordered, complete, and content addressed", () => {
  const blocks = [
    { id: "block-b", ordinal: 1, type: "image", content: "![diagram](asset://1)" },
    { id: "block-a", ordinal: 0, type: "paragraph", content: "alpha" },
    { id: "block-c", ordinal: 2, type: "paragraph", content: "omega" },
  ];
  const first = buildGenerationManifests(blocks);
  const reordered = buildGenerationManifests([blocks[2]!, blocks[0]!, blocks[1]!]);

  assert.deepEqual(first, reordered, "input query order must not change the snapshot");
  assert.deepEqual(first.blockManifest.map((entry) => entry.blockId), [
    "block-a",
    "block-b",
    "block-c",
  ]);
  assert.deepEqual(first.assetManifest.map((entry) => entry.blockId), ["block-b"]);

  const changed = buildGenerationManifests([
    blocks[0]!,
    { ...blocks[1]!, content: "alpha changed" },
    blocks[2]!,
  ]);
  assert.notEqual(changed.blockManifestHash, first.blockManifestHash);
  assert.equal(changed.assetManifestHash, first.assetManifestHash);
});

test("image manifests bind immutable asset hashes instead of mutable markdown labels", () => {
  const assetId = "asset-1";
  const firstAssetHash = "a".repeat(64);
  const secondAssetHash = "b".repeat(64);
  const blocks = [
    {
      id: "image-block",
      ordinal: 0,
      type: "image",
      content: "![first label](https://example.test/image.png)",
      imageAssetId: assetId,
    },
  ];

  const first = buildGenerationManifests(
    blocks,
    new Map([[assetId, firstAssetHash]]),
  );
  assert.deepEqual(first.assetManifest, [{
    blockId: "image-block",
    ordinal: 0,
    sourceHash: firstAssetHash,
    assetId,
  }]);

  const relabelled = buildGenerationManifests(
    [{ ...blocks[0]!, content: "![different label](https://example.test/image.png)" }],
    new Map([[assetId, firstAssetHash]]),
  );
  assert.notEqual(relabelled.blockManifestHash, first.blockManifestHash);
  assert.equal(relabelled.assetManifestHash, first.assetManifestHash);

  const replacedAsset = buildGenerationManifests(
    blocks,
    new Map([[assetId, secondAssetHash]]),
  );
  assert.notEqual(replacedAsset.assetManifestHash, first.assetManifestHash);
});

test("generation fingerprint binds the entire sealed snapshot", () => {
  const input = {
    workspaceId: "workspace-a",
    noteId: "note-a",
    noteVersionId: "version-a",
    titleSnapshot: "Snapshot title",
    sourceContentHash: "content-hash",
    blockManifestHash: "block-hash",
    assetManifestHash: "asset-hash",
  };
  const fingerprint = buildGenerationFingerprint(input);
  assert.equal(fingerprint, buildGenerationFingerprint({ ...input }));
  for (const field of [
    "titleSnapshot",
    "sourceContentHash",
    "blockManifestHash",
    "assetManifestHash",
  ] as const) {
    assert.notEqual(
      fingerprint,
      buildGenerationFingerprint({ ...input, [field]: `${input[field]}-changed` }),
      field,
    );
  }
});

test("0044 installs tenant-safe run/event tables and immutable sealed snapshots", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.card_generation_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.card_generation_events/);
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, note_id, note_version_id\)[\s\S]*REFERENCES public\.note_versions\(workspace_id, note_id, id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workspace_id, run_id\)[\s\S]*REFERENCES public\.card_generation_runs\(workspace_id, id\)/,
  );
  assert.match(migration, /ALTER TABLE public\.card_generation_runs FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE public\.card_generation_events FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE TRIGGER note_versions_sealed_guard/);
  assert.match(migration, /CREATE TRIGGER note_blocks_sealed_guard/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_request_idem_unique_idx/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS card_generation_runs_active_fingerprint_unique_idx/);
});

test("0046 installs typed immutable image evidence with tenant RLS and least-privilege grants", () => {
  for (const table of [
    "note_image_assets",
    "note_image_insights",
    "note_image_evidence_units",
  ]) {
    assert.match(
      imageMigration,
      new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`),
      `missing ${table}`,
    );
    assert.match(
      imageMigration,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`),
      `${table} must enable RLS`,
    );
    assert.match(
      imageMigration,
      new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`),
      `${table} must force RLS`,
    );
    assert.match(
      imageMigration,
      new RegExp(`CREATE POLICY ${table}_workspace_isolation[\\s\\S]*?current_setting\\('app\\.workspace_id', true\\)`),
      `${table} must scope reads and writes to app.workspace_id`,
    );
  }

  assert.match(
    imageMigration,
    /FOREIGN KEY \(workspace_id, image_asset_id\)[\s\S]*REFERENCES public\.note_image_assets\(workspace_id, id\) ON DELETE RESTRICT/,
  );
  assert.match(
    imageMigration,
    /CONSTRAINT note_blocks_image_asset_type_check[\s\S]*image_asset_id IS NULL OR type = 'image'/,
  );
  assert.match(
    imageMigration,
    /FOREIGN KEY \(workspace_id, image_insight_id, image_asset_id\)[\s\S]*REFERENCES public\.note_image_insights\(workspace_id, id, image_asset_id\)/,
  );
  assert.match(
    imageMigration,
    /card_generation_candidate_evidence_typed_check[\s\S]*source_kind = 'text_span'[\s\S]*source_kind = 'image_region'/,
  );
  assert.match(
    imageMigration,
    /evidences_typed_source_check[\s\S]*alignment_method = 'exact_span'[\s\S]*alignment_method IN \('image_ocr', 'image_structured'\)/,
  );
  assert.match(imageMigration, /CREATE TRIGGER note_image_assets_identity_guard/);
  assert.match(imageMigration, /CREATE TRIGGER note_image_insights_immutable_guard/);
  assert.match(imageMigration, /CREATE TRIGGER note_image_evidence_units_immutable_guard/);

  assert.match(
    imageMigration,
    /GRANT SELECT ON public\.note_image_assets TO ailearn_worker/,
  );
  assert.match(
    imageMigration,
    /GRANT SELECT, INSERT, UPDATE ON public\.note_image_insights TO ailearn_worker/,
  );
  assert.match(
    imageMigration,
    /GRANT SELECT, INSERT ON public\.note_image_evidence_units TO ailearn_worker/,
  );
  assert.equal(
    /GRANT[\s\S]{0,120}INSERT[\s\S]{0,120}public\.note_image_assets[\s\S]{0,80}TO ailearn_worker/.test(
      imageMigration,
    ),
    false,
    "workers must not create immutable upload assets",
  );
});

test("0047 and the Drizzle schema treat partial_ready as a terminal fingerprint outcome", () => {
  assert.match(
    partialTerminalMigration,
    /DROP INDEX IF EXISTS public\.card_generation_runs_active_fingerprint_unique_idx/,
  );
  assert.match(
    partialTerminalMigration,
    /WHERE status NOT IN \('partial_ready', 'succeeded', 'cancelled', 'superseded'\)/,
  );
  assert.match(
    cardGenerationDbSchema,
    /status} NOT IN \('partial_ready', 'succeeded', 'cancelled', 'superseded'\)/,
  );
});

test("0048 installs tenant-safe card sets while preserving legacy active-card compatibility", () => {
  assert.match(
    cardSetMigration,
    /CREATE TABLE IF NOT EXISTS public\.learning_card_sets/,
  );
  assert.match(
    cardSetMigration,
    /FOREIGN KEY \(workspace_id, note_id, note_version_id\)[\s\S]*?REFERENCES public\.note_versions\(workspace_id, note_id, id\)/,
  );
  assert.match(
    cardSetMigration,
    /FOREIGN KEY \(workspace_id, generation_run_id, note_id, note_version_id\)[\s\S]*?REFERENCES public\.card_generation_runs\(workspace_id, id, note_id, note_version_id\)/,
  );
  assert.match(
    cardSetMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_card_sets_active_note_unique_idx[\s\S]*?WHERE status = 'active'/,
  );
  assert.match(
    cardSetMigration,
    /CONSTRAINT learning_cards_card_set_shape_check[\s\S]*?card_set_id IS NULL[\s\S]*?card_set_id IS NOT NULL[\s\S]*?scope IN \('overview', 'section'\)/,
  );
  assert.match(
    cardSetMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_workspace_note_version_legacy_active_unique_idx[\s\S]*?WHERE status = 'active' AND card_set_id IS NULL/,
  );
  assert.match(
    cardSetMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_ordinal_unique_idx[\s\S]*?WHERE card_set_id IS NOT NULL AND ordinal IS NOT NULL/,
  );
  assert.match(
    cardSetMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_overview_unique_idx[\s\S]*?scope = 'overview'/,
  );
  assert.match(
    cardSetMigration,
    /ALTER TABLE public\.learning_card_sets ENABLE ROW LEVEL SECURITY/,
  );
  assert.match(
    cardSetMigration,
    /ALTER TABLE public\.learning_card_sets FORCE ROW LEVEL SECURITY/,
  );
  assert.match(
    cardSetMigration,
    /CREATE POLICY learning_card_sets_workspace_isolation[\s\S]*?current_setting\('app\.workspace_id', true\)/,
  );

  assert.match(cardDbSchema, /export const learningCardSets = pgTable/);
  assert.match(cardDbSchema, /cardSetId: uuid\("card_set_id"\)/);
  assert.match(cardDbSchema, /generationRunId: uuid\("generation_run_id"\)/);
  assert.match(cardDbSchema, /scope: text\("scope"\)\.\$type<LearningCardScope>/);
  assert.match(
    cardDbSchema,
    /legacyActiveVersionUnique:[\s\S]*?status} = 'active' AND \$\{t\.cardSetId} IS NULL/,
  );
  assert.match(cardGenerationDbSchema, /resultCardSetId: uuid\("result_card_set_id"\)/);
});

test("0049 tightens M5 terminal and card-set identity without rejecting legacy nulls", () => {
  assert.match(
    m5IntegrityMigration,
    /pipeline_version = 'card-generation-v2-m5'[\s\S]*?status IN \('succeeded', 'partial_ready'\)[\s\S]*?result_card_set_id IS NULL[\s\S]*?result_card_id IS NULL/,
  );
  assert.match(
    m5IntegrityMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_generation_set_identity_unique_idx[\s\S]*?workspace_id, generation_run_id, card_set_id, id/,
  );
  assert.match(
    m5IntegrityMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS learning_cards_set_scope_key_unique_idx[\s\S]*?workspace_id, card_set_id, scope_key/,
  );
  assert.match(
    m5IntegrityMigration,
    /CONSTRAINT learning_cards_card_set_shape_check[\s\S]*?\(scope = 'overview' AND ordinal = 0\)[\s\S]*?\(scope = 'section' AND ordinal > 0\)/,
  );
  assert.match(
    m5IntegrityMigration,
    /CONSTRAINT card_generation_runs_m5_terminal_result_check[\s\S]*?pipeline_version <> 'card-generation-v2-m5'[\s\S]*?result_card_set_id IS NOT NULL[\s\S]*?result_card_id IS NOT NULL/,
  );
  assert.match(
    m5IntegrityMigration,
    /CONSTRAINT card_generation_runs_result_card_identity_fk[\s\S]*?FOREIGN KEY \(workspace_id, id, result_card_set_id, result_card_id\)[\s\S]*?REFERENCES public\.learning_cards\([\s\S]*?workspace_id,[\s\S]*?generation_run_id,[\s\S]*?card_set_id,[\s\S]*?id[\s\S]*?\)[\s\S]*?ON DELETE NO ACTION[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  for (const constraint of [
    "card_generation_runs_result_card_fk",
    "card_generation_runs_result_card_set_fk",
    "card_generation_runs_result_card_identity_fk",
  ]) {
    assert.match(
      m5IntegrityMigration,
      new RegExp(
        `CONSTRAINT ${constraint}[\\s\\S]*?ON DELETE NO ACTION[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`,
      ),
    );
  }

  assert.match(
    cardDbSchema,
    /learning_cards_generation_set_identity_unique_idx/,
  );
  assert.match(cardDbSchema, /learning_cards_set_scope_key_unique_idx/);
  assert.match(cardDbSchema, /learning_cards_card_set_shape_check/);
  assert.match(
    cardGenerationDbSchema,
    /card_generation_runs_m5_terminal_result_check/,
  );
});

test("the API exposes the run lifecycle with no-store recovery reads", () => {
  assert.ok(server.includes('import { cardGenerationRoutes }'));
  assert.ok(server.includes("await app.register(cardGenerationRoutes)"));
  assert.ok(server.includes('"card_generation_runs"'));
  assert.ok(server.includes('"card_generation_events"'));

  for (const path of [
    '"/card-generation-runs"',
    '"/card-generation-runs/:id"',
    '"/card-generation-runs/:id/events"',
    '"/card-generation-runs/:id/cancel"',
    '"/card-generation-runs/:id/retry"',
    '"/card-generation-runs/:id/continue-with-exclusions"',
    '"/note-versions/:id/card-generation-latest"',
  ]) {
    assert.ok(routes.includes(path), `missing ${path}`);
  }
  assert.ok(routes.includes('const NO_STORE = { "Cache-Control": "private, no-store" }'));
});

test("continue-with-exclusions is a real, owner-gated derived-run workflow", () => {
  assert.ok(routes.includes("continueCardGenerationRunWithExclusions"));
  assert.ok(routes.includes("const body = parseBody(app, continueWithExclusionsSchema, req.body)"));
  assert.ok(routes.includes("reply.code(202).send(run)"));
  assert.equal(routes.includes("exclusions_not_available"), false);

  assert.match(generationRequestSchema, /excludedUnitIds:[\s\S]*z\.string\(\)\.uuid\(\)/);
  assert.match(generationRequestSchema, /\.min\(1\)/);
  assert.match(
    generationRequestSchema,
    /new Set\(unitIds\)\.size === unitIds\.length/,
  );

  assert.match(
    generationService,
    /unit\.kind !== CardGenerationUnitKind\.IMAGE[\s\S]{0,180}unit\.status !== "terminal_failed"[\s\S]{0,180}!unit\.required/,
  );
  assert.match(generationService, /const inheritedExclusions = sourceRun\.exclusionPolicy/);
  assert.match(generationService, /const exclusionsByAssetId = new Map/);
  assert.match(generationService, /excludedUnits: cumulativeExclusions/);
  assert.match(generationService, /supersedesRunId: sourceRun\.id/);
  assert.match(
    generationService,
    /status: CardGenerationRunStatus\.SUPERSEDED[\s\S]{0,180}errorCode: "continued_with_exclusions"/,
  );
  assert.match(generationService, /latestGenerationRunId: derivedRun\.id/);
  assert.match(
    generationService,
    /latestNoteFence\?\.cardGenerationEpoch === run\.generationEpoch[\s\S]{0,120}latestNoteFence\.latestGenerationRunId === run\.id/,
  );
});

test("partial run API reports original image coverage and policy-adjusted completion separately", () => {
  assert.match(
    generationService,
    /requiredImages: sourceRun\.requiredImages/,
  );
  assert.match(
    generationService,
    /originalRequiredImages: sourceRun\.requiredImages/,
  );
  assert.match(
    generationService,
    /policyAdjustedImageCoverageBps:/,
  );
  assert.match(
    generationService,
    /imagesCompleted: run\.completedImages[\s\S]{0,100}imagesTotal: run\.requiredImages[\s\S]{0,100}imageCoverageBps: run\.imageCoverageBps[\s\S]{0,140}policyAdjustedImageCoverageBps:/,
  );
  assert.match(generationService, /code: "partial_coverage"/);
  assert.match(generationService, /excludedImages: run\.exclusionPolicy\.excludedUnits\.map/);
});

test("sealed versions force autosave copy-on-write and legacy entry points use runs", () => {
  assert.match(
    noteService,
    /select\(\{ id: noteVersions\.id, sealedAt: noteVersions\.sealedAt \}\)/,
  );
  assert.match(noteService, /if \(versionRows\[0\]\?\.sealedAt\) return false/);
  assert.ok(cardRoutes.includes("createCardGenerationRun"));
  assert.ok(cardService.includes("createCardGenerationRun"));
  assert.equal(cardRoutes.includes("createGenerateCardJob"), false);
  assert.equal(cardService.includes("createJob({"), false);
});
