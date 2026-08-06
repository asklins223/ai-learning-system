import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardMapOutputSchema,
  imageInsightOutputSchema,
} from "./schemas.ts";
import {
  sanitizeCardMapOutput,
  sanitizeImageInsightOutput,
} from "./output-sanitizer.ts";

test("card map sanitizer repairs common enum, optional-field, and length violations", () => {
  const output = sanitizeCardMapOutput({
    sectionSummary: "summary",
    candidates: [{
      localId: "c1",
      claim: "A substantive claim that can be checked.",
      evidenceRefIds: Array.from({ length: 15 }, (_, index) => `u${index + 1}`),
      cognitiveType: "detail",
      importance: "causal",
      relationHints: ["malformed"],
    }],
    noCandidateUnitIds: [{ unitId: "u20", reason: "metadata" }],
  });

  assert.ok(output);
  assert.equal(cardMapOutputSchema.safeParse(output).success, true);
  assert.equal(output.candidates[0]?.evidenceRefIds.length, 12);
  assert.equal(output.candidates[0]?.cognitiveType, "causal");
  assert.equal(output.candidates[0]?.importance, "detail");
  assert.equal(output.candidates[0]?.topic, "A substantive claim that can be checked.");
  assert.equal(output.candidates[0]?.relationHints, undefined);
  assert.equal(output.candidates[0]?.difficulty, "intermediate");
  assert.deepEqual(output.noCandidateUnitIds, [{
    unitId: "u20",
    reason: "metadata",
  }]);
});

test("card map sanitizer rejects repairs that still violate the provider schema", () => {
  assert.equal(sanitizeCardMapOutput({
    sectionSummary: "",
    candidates: [
      {
        localId: "duplicate",
        claim: "First substantive claim.",
        evidenceRefIds: ["u1"],
        topic: "Topic",
      },
      {
        localId: "duplicate",
        claim: "Second substantive claim.",
        evidenceRefIds: ["u2"],
        topic: "Topic",
      },
    ],
    noCandidateUnitIds: [],
  }), null);
});

test("image sanitizer converts array regions and revalidates the repaired output", () => {
  const output = sanitizeImageInsightOutput({
    contentType: "DOCUMENT",
    decorative: false,
    caption: "A page",
    ocr: [{
      text: "Visible text",
      region: [100, 200, 300, 400],
      confidence: "0.95",
    }],
    facts: [],
    promptInjectionDetected: false,
    safetyFlags: [],
  });

  assert.ok(output);
  assert.equal(imageInsightOutputSchema.safeParse(output).success, true);
  assert.equal(output.contentType, "document");
  assert.equal(output.decorative, false);
  assert.deepEqual(output.ocr[0]?.region, {
    x: 100,
    y: 200,
    width: 300,
    height: 400,
  });
  assert.equal(output.ocr[0]?.confidence, 0.95);
});

test("image sanitizer never manufactures evidence from an invalid region", () => {
  const output = sanitizeImageInsightOutput({
    contentType: "document",
    decorative: false,
    caption: "",
    ocr: [{ text: "No usable coordinates", region: {}, confidence: 1 }],
    facts: [],
    promptInjectionDetected: false,
    safetyFlags: [],
    unresolvedReason: null,
  });

  assert.ok(output);
  assert.deepEqual(output.ocr, []);
  assert.equal(output.unresolvedReason, "no_learnable_content");
  assert.equal(imageInsightOutputSchema.safeParse(output).success, true);
});

test("image sanitizer does not guess missing safety decisions", () => {
  assert.equal(sanitizeImageInsightOutput({
    contentType: "document",
    decorative: false,
    caption: "Page",
    ocr: [],
    facts: [],
    safetyFlags: [],
    unresolvedReason: "no_learnable_content",
  }), null);
});

test("sanitizers reject non-object payloads", () => {
  assert.equal(sanitizeCardMapOutput(null), null);
  assert.equal(sanitizeImageInsightOutput("not-an-object"), null);
});
