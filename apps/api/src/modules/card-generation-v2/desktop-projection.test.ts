import assert from "node:assert/strict";
import test from "node:test";
import { projectCardGenerationRecoveryV1 } from "./desktop-projection.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function input(status: "needs_attention" | "failed" | "stale", overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status,
    sourceOutdated: false,
    error: null,
    ...overrides,
  } as Parameters<typeof projectCardGenerationRecoveryV1>[0];
}

test("Card Generation recovery projection maps all recovery states to strict safe actions", () => {
  const attention = projectCardGenerationRecoveryV1(input("needs_attention"));
  const failed = projectCardGenerationRecoveryV1(input("failed", { error: { code: "provider_timeout", message: "hidden" } }));
  const stale = projectCardGenerationRecoveryV1(input("stale", { sourceOutdated: true }));

  assert.equal(attention?.publicReasonCode, "attention_required");
  assert.equal(failed?.publicReasonCode, "provider_unavailable");
  assert.equal(stale?.publicReasonCode, "source_outdated");
  for (const recovery of [attention, failed, stale]) {
    assert.equal(recovery?.retryability, "resync_required");
    assert.deepEqual(recovery?.allowedActions.map((action) => action.kind), ["refresh_status", "return_note"]);
    const actionKinds = recovery?.allowedActions.map((action) => action.kind) ?? [];
    assert.equal((actionKinds as readonly string[]).includes("cancel_run"), false);
    const returnAction = recovery?.allowedActions.find((action) => action.kind === "return_note");
    assert.deepEqual(returnAction && "sourceRef" in returnAction ? returnAction.sourceRef : null, { noteId: NOTE_ID, noteVersionId: VERSION_ID });
  }
});

test("non-recovery run states do not receive a recovery projection", () => {
  const projection = projectCardGenerationRecoveryV1({
    ...input("needs_attention"),
    status: "planning",
  });
  assert.equal(projection, null);
});
