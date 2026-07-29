import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const handler = readFileSync(
  new URL("../handlers/card-generation-text.ts", import.meta.url),
  "utf8",
);
const runFence = readFileSync(
  new URL("../lib/card-generation-run.ts", import.meta.url),
  "utf8",
);

test("partial exclusions are typed, cumulative inputs backed by failed image checkpoints", () => {
  assert.match(handler, /policy\.mode !== "explicit_image_exclusions_v1"/);
  assert.match(handler, /entry\.kind !== CardGenerationUnitKind\.IMAGE/);
  assert.match(handler, /typeof entry\.inputHash !== "string"/);
  assert.match(
    handler,
    /new Set\(exclusions\.map\(\(entry\) => entry\.imageAssetId\)\)\.size !== exclusions\.length/,
  );
  assert.match(
    handler,
    /sourceUnit\.kind !== CardGenerationUnitKind\.IMAGE[\s\S]{0,160}sourceUnit\.status !== "terminal_failed"[\s\S]{0,160}sourceUnit\.inputHash !== entry\.inputHash/,
  );
  assert.match(
    handler,
    /sourceUnit\.inputManifest\.imageAssetId !== entry\.imageAssetId[\s\S]{0,100}sourceUnit\.inputManifest\.imageBlockId !== entry\.imageBlockId/,
  );
});

test("the planner skips excluded assets but retains the original image denominator", () => {
  assert.match(
    handler,
    /const excludedImageAssetIds = new Set\(imageExclusions\.map\(\(entry\) => entry\.imageAssetId\)\)/,
  );
  assert.match(
    handler,
    /const imageBlocks = allImageBlocks\.filter\([\s\S]{0,160}!excludedImageAssetIds\.has\(block\.imageAssetId\)/,
  );
  assert.match(
    handler,
    /requiredImages: snapshot\.imageAssets\.length/,
  );
  assert.match(
    handler,
    /imageCoverageBps: snapshot\.imageAssets\.length === 0 \? 10_000 : 0/,
  );
  assert.match(
    handler,
    /policyAdjustedImageCoverageBps: imageUnits\.length === 0 \? 10_000 : 0/,
  );
  assert.match(
    handler,
    /manifest\.sourceHash !== asset\.sha256/,
    "the planner must fence every typed asset against the sealed manifest hash",
  );
});

test("partial image progress separates raw snapshot coverage from policy-adjusted completion", () => {
  assert.match(
    handler,
    /const processableImages = requiredProcessableImages\(locked\.run\)/,
  );
  assert.match(
    handler,
    /Math\.floor\(completedImages \* 10_000 \/ locked\.run\.requiredImages\)/,
  );
  assert.match(
    handler,
    /policyAdjustedImageCoverageBps: processableImages === 0[\s\S]{0,140}Math\.floor\(completedImages \* 10_000 \/ processableImages\)/,
  );
  assert.match(
    handler,
    /const allImagesComplete = completedImages === processableImages/,
  );
});

test("publish accepts only policy-complete coverage and preserves the raw partial ratio", () => {
  assert.match(
    handler,
    /const processableRequiredImages = requiredProcessableImages\(locked\.run\)/,
  );
  assert.match(
    handler,
    /processableRequiredImages \* 10_000 \/ locked\.run\.requiredImages/,
  );
  assert.match(
    handler,
    /locked\.run\.completedImages !== processableRequiredImages[\s\S]{0,160}locked\.run\.imageCoverageBps !== expectedImageCoverageBps/,
  );
  assert.match(
    handler,
    /policyAdjustedImageCoverageBps: 10_000/,
  );
  assert.match(
    handler,
    /imageCoverageBps: locked\.run\.imageCoverageBps/,
    "publication must not rewrite a partial raw ratio to 100%",
  );
  assert.match(
    handler,
    /CardGenerationRunStatus\.PARTIAL_READY/,
  );
  assert.match(
    handler,
    /messageCode: partialResult \? "generation_partial_ready" : "generation_succeeded"/,
  );
});

test("partial_ready is terminal for both run fencing and late failure projection", () => {
  assert.match(
    runFence,
    /const TERMINAL_RUN_STATUSES = new Set\(\[[\s\S]{0,100}"partial_ready"/,
  );
  assert.match(
    handler,
    /\["cancelled", "superseded", "partial_ready", "succeeded"\]\.includes\(run\.status\)/,
  );
});
