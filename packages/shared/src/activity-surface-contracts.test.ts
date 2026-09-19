import assert from "node:assert/strict";
import test from "node:test";
import { activityTargetV1Schema } from "./activity-surface-contracts.ts";

const RUN_ID = "22222222-2222-4222-8222-222222222222";

test("today activity targets a stuck learning run directly", () => {
  assert.equal(activityTargetV1Schema.safeParse({
    kind: "learning_run",
    id: RUN_ID,
    noteVersionId: null,
  }).success, true);
});

test("today activity no longer disguises a learning run as a review target", () => {
  assert.equal(activityTargetV1Schema.safeParse({
    kind: "review",
    id: RUN_ID,
    noteVersionId: null,
  }).success, false);
});
