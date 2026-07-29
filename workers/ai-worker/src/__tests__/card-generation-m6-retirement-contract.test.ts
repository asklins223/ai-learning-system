import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const legacyHandler = readFileSync(
  new URL("../handlers/index.ts", import.meta.url),
  "utf8",
);
const v2Handler = readFileSync(
  new URL("../handlers/card-generation-text.ts", import.meta.url),
  "utf8",
);
const workerIndex = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const sharedFlags = readFileSync(
  new URL("../../../../packages/shared/src/feature-flags.ts", import.meta.url),
  "utf8",
);
const envExample = readFileSync(
  new URL("../../../../.env.example", import.meta.url),
  "utf8",
);
const productionCompose = readFileSync(
  new URL("../../../../docker-compose.yml", import.meta.url),
  "utf8",
);

test("M6 makes generation v2 the default while retaining an explicit rollback switch", () => {
  assert.match(
    sharedFlags,
    /if \(value === undefined \|\| value === ""\) return true;/,
  );
  assert.match(sharedFlags, /return value === "true";/);
  assert.match(envExample, /^CARD_GENERATION_V2_ENABLED=true$/m);
  assert.match(envExample, /^NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true$/m);
  assert.equal(
    (productionCompose.match(/CARD_GENERATION_V2_ENABLED:-true/g) ?? []).length,
    3,
  );
});

test("the legacy rollback handler no longer silently drops content at 12k characters", () => {
  assert.doesNotMatch(legacyHandler, /MAX_CONTENT_CHARS/);
  assert.doesNotMatch(legacyHandler, /truncatedBlocks/);
  assert.match(legacyHandler, /blocks: textBlocks/);
});

test("the v2 path publishes typed evidence without fuzzy post-alignment jobs", () => {
  assert.doesNotMatch(v2Handler, /align_evidence/);
  assert.doesNotMatch(v2Handler, /\bfuzzy\b/);
  assert.match(v2Handler, /alignmentMethod: "exact_span"/);
  assert.match(v2Handler, /alignmentMethod: evidence\.alignmentMethod/);
});

test("legacy job handlers stay dispatchable for history and explicit rollback", () => {
  assert.match(workerIndex, /generate_card: runGenerateCard/);
  assert.match(workerIndex, /align_evidence: runAlignEvidence/);
});
