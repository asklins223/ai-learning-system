import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCapabilityProjection } from "./capability-projection.ts";

const originalRun = process.env.LEARNING_RUN_V1;
const originalCard = process.env.CARD_GENERATION_V2_ENABLED;

function restoreFlags(): void {
  if (originalRun === undefined) delete process.env.LEARNING_RUN_V1;
  else process.env.LEARNING_RUN_V1 = originalRun;
  if (originalCard === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
  else process.env.CARD_GENERATION_V2_ENABLED = originalCard;
}

test("desktop capability projection: disabled flags fail closed and member writes stay denied", () => {
  try {
    process.env.LEARNING_RUN_V1 = "false";
    process.env.CARD_GENERATION_V2_ENABLED = "false";
    const projection = buildDesktopCapabilityProjection("member");
    assert.equal(projection.actionCapabilities["learning_run.start"], "denied");
    assert.equal(projection.actionCapabilities["note.save"], "denied");
    assert.equal(projection.featureAvailability.learning_run_v2.state, "disabled");
    assert.equal(projection.featureAvailability.card_generation_v2.state, "disabled");
  } finally {
    restoreFlags();
  }
});

test("desktop capability projection: enabled flags expose only the matching owner path", () => {
  try {
    process.env.LEARNING_RUN_V1 = "true";
    process.env.CARD_GENERATION_V2_ENABLED = "true";
    const projection = buildDesktopCapabilityProjection("owner");
    assert.equal(projection.actionCapabilities["learning_run.start"], "allowed");
    assert.equal(projection.actionCapabilities["card_generation.activate"], "allowed");
    assert.equal(projection.featureAvailability.learning_run_v2.state, "enabled");
    assert.equal(projection.featureAvailability.card_generation_v2.state, "enabled");
  } finally {
    restoreFlags();
  }
});
