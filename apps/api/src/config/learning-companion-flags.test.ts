import { test } from "node:test";
import assert from "node:assert/strict";
import { isLearningRunEnabled } from "./learning-companion-flags.ts";

test("LearningRun gate defaults to closed", () => {
  const saved = process.env.LEARNING_RUN_ENABLED;
  delete process.env.LEARNING_RUN_ENABLED;
  try {
    assert.equal(isLearningRunEnabled(), false);
    process.env.LEARNING_RUN_ENABLED = "true";
    assert.equal(isLearningRunEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.LEARNING_RUN_ENABLED;
    else process.env.LEARNING_RUN_ENABLED = saved;
  }
});
