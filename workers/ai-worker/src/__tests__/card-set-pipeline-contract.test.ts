import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const handler = readFileSync(
  new URL("../handlers/card-generation-text.ts", import.meta.url),
  "utf8",
);
const workerIndex = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const sharedEnums = readFileSync(
  new URL("../../../../packages/shared/src/enums.ts", import.meta.url),
  "utf8",
);
const apiService = readFileSync(
  new URL("../../../../apps/api/src/modules/card-generation/service.ts", import.meta.url),
  "utf8",
);
const textFixture = readFileSync(
  new URL("../integration-tests/card-generation-text-pipeline-postgres.integration.ts", import.meta.url),
  "utf8",
);
const imageFixture = readFileSync(
  new URL("../integration-tests/card-generation-image-pipeline-postgres.integration.ts", import.meta.url),
  "utf8",
);

function sourceSlice(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("M5 pipeline and prompt-bundle versions are consistent across API and worker fixtures", () => {
  assert.match(handler, /const TEXT_PIPELINE_VERSION = "card-generation-v2-m5"/);
  assert.match(apiService, /const TEXT_PIPELINE_VERSION = "card-generation-v2-m5"/);
  assert.match(
    apiService,
    /const TEXT_PROMPT_BUNDLE_VERSION = "map-candidate-v1\+deck-plan-v1"/,
  );
  assert.match(
    apiService,
    /"map-candidate-v1\+image-understanding-v1\+deck-plan-v1"/,
  );
  for (const fixture of [textFixture, imageFixture]) {
    assert.equal(
      fixture.includes("card-generation-v2-m4"),
      false,
      "Postgres fixtures must not seed an incompatible M4 run",
    );
  }
  assert.match(textFixture, /map-candidate-v1\+deck-plan-v1/);
  assert.match(
    imageFixture,
    /map-candidate-v1\+image-understanding-v1\+deck-plan-v1/,
  );
});

test("new deck-plan and card-render job types are dispatchable and failure-projected", () => {
  assert.match(sharedEnums, /PLAN_CARD_SET: "plan_card_set"/);
  assert.match(sharedEnums, /RENDER_CARD_GENERATION: "render_card_generation"/);
  assert.match(workerIndex, /plan_card_set: runPlanCardSet/);
  assert.match(workerIndex, /render_card_generation: runRenderCardGeneration/);

  const projectedTypes = sourceSlice(
    workerIndex,
    "const TEXT_GENERATION_JOB_TYPES",
    "async function projectGenerationFailure",
  );
  assert.match(projectedTypes, /"plan_card_set"/);
  assert.match(projectedTypes, /"render_card_generation"/);
});

test("reduce schedules deck planning and cannot directly schedule publication", () => {
  const reduce = sourceSlice(
    handler,
    "export async function runReduceCardGeneration",
    "function sectionsForCandidateIds",
  );
  assert.match(reduce, /kind: CardGenerationUnitKind\.DECK_PLAN/);
  assert.match(reduce, /units: \[deckPlanUnit\]/);
  assert.match(reduce, /stage: CardGenerationStage\.DECK_PLAN/);
  assert.equal(
    reduce.includes("CardGenerationUnitKind.PUBLISH"),
    false,
    "section reduce must not bypass deck planning and card rendering",
  );

  const descriptors = sourceSlice(
    handler,
    "function jobDescriptorForUnit",
    "async function availablePendingSlots",
  );
  assert.match(
    descriptors,
    /unit\.kind === CardGenerationUnitKind\.DECK_PLAN[\s\S]*?type: JobType\.PLAN_CARD_SET/,
  );
  assert.match(
    descriptors,
    /unit\.kind === CardGenerationUnitKind\.CARD_RENDER[\s\S]*?type: JobType\.RENDER_CARD_GENERATION/,
  );
});

test("deck planning creates one bounded render checkpoint per planned card", () => {
  const deckPlan = sourceSlice(
    handler,
    "export async function runPlanCardSet",
    "async function scheduleRemainingCardRenders",
  );
  assert.match(deckPlan, /const plan = planCardSet\(material\.candidates\)/);
  assert.match(deckPlan, /version: "deck-plan-v1"/);
  assert.match(deckPlan, /kind: CardGenerationUnitKind\.CARD_RENDER/);
  assert.match(deckPlan, /version: "card-render-v1"/);
  assert.match(deckPlan, /values\(cardDescriptors\.map/);
  assert.match(deckPlan, /limit: Math\.min\(CARD_GENERATION_RENDER_WINDOW, renderUnits\.length\)/);
});

test("publication is created only after every required render checkpoint succeeds", () => {
  const render = sourceSlice(
    handler,
    "export async function runRenderCardGeneration",
    "type TextCandidateEvidence",
  );
  assert.match(
    render,
    /eq\(schema\.cardGenerationUnits\.kind, CardGenerationUnitKind\.CARD_RENDER\)[\s\S]*?eq\(schema\.cardGenerationUnits\.required, true\)/,
  );
  assert.match(
    render,
    /const rendersComplete =[\s\S]*?completedCount === renderUnits\.length/,
  );
  const completionGate = render.indexOf("if (rendersComplete)");
  const publishCreation = render.indexOf("kind: CardGenerationUnitKind.PUBLISH");
  assert.ok(completionGate >= 0);
  assert.ok(
    publishCreation > completionGate,
    "publish checkpoint must be created inside the all-renders-complete gate",
  );
});

test("publish revalidates deck/render artifacts and atomically records the overview compatibility pointer", () => {
  const loadMaterial = sourceSlice(
    handler,
    "async function loadPublishMaterial",
    "async function insertInBatches",
  );
  assert.match(
    loadMaterial,
    /CardGenerationUnitKind\.DECK_PLAN[\s\S]*?eq\(schema\.cardGenerationUnits\.status, "succeeded"\)/,
  );
  assert.match(loadMaterial, /CardGenerationUnitKind\.CARD_RENDER/);
  assert.match(loadMaterial, /const deckPlan = validateCardSetPlan/);
  assert.match(loadMaterial, /deckArtifact\.candidateSetHash !== candidateSetHash/);
  assert.match(loadMaterial, /unit\.status !== "succeeded"/);
  assert.match(loadMaterial, /renderArtifact\.version !== "card-render-v1"/);
  assert.match(
    loadMaterial,
    /publish found a card-render artifact outside the deck-plan allowlist/,
  );

  const publish = sourceSlice(
    handler,
    "export async function runPublishCardGeneration",
    "export async function projectTextPipelineJobFailure",
  );
  const setInsert = publish.indexOf(".insert(schema.learningCardSets)");
  const cardInsert = publish.indexOf(".insert(schema.learningCards)");
  const completion = publish.indexOf("resultCardSetId: cardSet.id");
  assert.ok(setInsert >= 0);
  assert.ok(cardInsert > setInsert);
  assert.ok(completion > cardInsert);
  assert.match(publish, /for \(const descriptor of material\.cards\)/);
  assert.match(publish, /cardSetId: cardSet\.id/);
  assert.match(publish, /generationRunId: locked\.run\.id/);
  assert.match(publish, /scope: descriptor\.scope/);
  assert.match(publish, /ordinal: descriptor\.ordinal/);
  assert.match(publish, /resultCardId: overview\.card\.id/);
  assert.match(
    publish,
    /persistedKeyPoints\.length !== material\.selectedCandidateIds\.length/,
  );
});
