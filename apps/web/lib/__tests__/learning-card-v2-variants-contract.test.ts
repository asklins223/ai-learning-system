import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { demoPublicCards } from "../../features/card-generation-v2/demo/demo-data";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const source = (path: string) => readFileSync(resolve(WEB_ROOT, path), "utf8");

describe("Learning Card V2 interaction variants", () => {
  it("ships seven genuinely different answer-free public interactions", () => {
    assert.deepEqual(
      new Set(demoPublicCards.map((card) => card.front.kind)),
      new Set(["recall", "cloze", "compare", "sequence", "why", "boundary", "application"]),
    );
    assert.equal(demoPublicCards.length, 7);
    assert.equal(new Set(demoPublicCards.map((card) => card.objectiveId)).size, 7);

    const publicPayload = JSON.stringify(demoPublicCards);
    assert.doesNotMatch(publicPayload, /canonicalAnswer|exposureId|misconception|evidenceId/);
  });

  it("uses a complete renderer registry instead of one generic prompt template", () => {
    const registry = source("features/learning-card-v2/renderers/InteractionRendererRegistry.tsx");
    const activeCard = source("features/learning-card-v2/ActiveLearningCardV2.tsx");

    for (const kind of ["recall", "cloze", "compare", "sequence", "why", "boundary", "application"]) {
      assert.match(registry, new RegExp(`${kind}: ${kind}Renderer`));
    }
    assert.match(activeCard, /learningCardInteractionRendererRegistry\[card\.front\.kind\]/);
    assert.doesNotMatch(registry, /canonicalAnswer|exposureId|misconception/);
  });

  it("keeps canonical ordering and causal edges out of public interaction DTOs", () => {
    const contracts = source("features/card-generation-v2/contracts/ui-contracts.ts");
    const publicSection = contracts.slice(
      contracts.indexOf("interface PublicLearningCardInteractionBaseV2"),
      contracts.indexOf("export interface LearningCardRevealContentV2"),
    );

    assert.match(publicSection, /LearningRun may substitute another interaction/);
    assert.doesNotMatch(publicSection, /canonicalOrder|correctOption|correctAnswer|causalEdges/);
  });
});
