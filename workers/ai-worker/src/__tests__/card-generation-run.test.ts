import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decideGenerationRunFence,
  generationRunErrorCode,
  generationRunIdFromPayload,
} from "../lib/card-generation-run.ts";

const CURRENT_NOTE = {
  cardGenerationEpoch: 7,
  latestGenerationRunId: "run-7",
};

test("generation run fence accepts only the note's latest epoch and run id", () => {
  assert.equal(
    decideGenerationRunFence(
      { id: "run-7", status: "planning", generationEpoch: 7 },
      CURRENT_NOTE,
    ),
    "active",
  );
  assert.equal(
    decideGenerationRunFence(
      { id: "run-6", status: "planning", generationEpoch: 6 },
      CURRENT_NOTE,
    ),
    "stale",
  );
  assert.equal(
    decideGenerationRunFence(
      { id: "another-run-7", status: "planning", generationEpoch: 7 },
      CURRENT_NOTE,
    ),
    "stale",
  );
});

test("generation run fence does not rewrite terminal historical states", () => {
  for (const status of ["succeeded", "needs_attention", "cancelled", "superseded"]) {
    assert.equal(
      decideGenerationRunFence(
        { id: "old-run", status, generationEpoch: 1 },
        CURRENT_NOTE,
      ),
      "terminal",
      status,
    );
  }
});

test("generationRunId payload keeps legacy absence compatible and rejects malformed linkage", () => {
  assert.equal(generationRunIdFromPayload({ noteVersionId: "version-1" }), null);
  assert.equal(
    generationRunIdFromPayload({ generationRunId: "run-1" }),
    "run-1",
  );
  assert.throws(
    () => generationRunIdFromPayload({ generationRunId: "" }),
    /generationRunId must be a non-empty string/,
  );
  assert.throws(
    () => generationRunIdFromPayload({ generationRunId: 42 }),
    /generationRunId must be a non-empty string/,
  );
});

test("terminal run error codes contain only a safe allowlisted category", () => {
  const secret = "private-note-answer-should-never-be-persisted";
  const code = generationRunErrorCode(new Error(`Provider request failed: ${secret}`));
  assert.equal(code, "legacy_generate_provider");
  assert.equal(code.includes(secret), false);
});

test("runGenerateCard fences before Provider and before every legacy publish mutation", () => {
  const source = readFileSync(
    new URL("../handlers/index.ts", import.meta.url),
    "utf8",
  );

  const handlerStart = source.indexOf("export async function runGenerateCard");
  const startFence = source.indexOf("await startCardGenerationRun", handlerStart);
  const providerCall = source.indexOf("await provider.generateCard", handlerStart);
  assert.ok(handlerStart >= 0 && startFence > handlerStart);
  assert.ok(providerCall > startFence, "start fence must precede the Provider call");

  const publishTransaction = source.indexOf("const publication = await withJobTransaction", handlerStart);
  const publishFence = source.indexOf("await beginCardGenerationPublish", publishTransaction);
  const oldCardMutation = source.indexOf(".update(schema.learningCards)", publishFence);
  const reviewMutation = source.indexOf(".update(schema.reviewSchedules)", publishFence);
  const searchMutation = source.indexOf(".delete(schema.searchDocuments)", publishFence);
  assert.ok(publishFence > publishTransaction);
  assert.ok(oldCardMutation > publishFence, "old cards must not change before the epoch fence");
  assert.ok(reviewMutation > publishFence, "reviews must not change before the epoch fence");
  assert.ok(searchMutation > publishFence, "search projection must not change before the epoch fence");

  const cardInsert = source.indexOf(".insert(schema.learningCards)", publishFence);
  const runCompletion = source.indexOf("await completeCardGenerationRun", cardInsert);
  assert.ok(cardInsert > publishFence);
  assert.ok(runCompletion > cardInsert, "run completion must share the card publish transaction");
  assert.ok(
    source.includes("activeGenerationRun?.titleSnapshot ?? note.title"),
    "run-aware jobs must use the sealed title snapshot",
  );
});

test("processJob projects both terminal failure branches without persisting raw errors", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const nonRetryableDead = source.indexOf("const failure = await markJobDead");
  const nonRetryableProjection = source.indexOf(
    "await projectGenerationFailure(job, err, true, false)",
    nonRetryableDead,
  );
  const retryFailure = source.indexOf("const failure = await markJobFailed");
  const exhaustedProjection = source.indexOf(
    "await projectGenerationFailure(job, err, true, true)",
    retryFailure,
  );
  assert.ok(nonRetryableProjection > nonRetryableDead);
  assert.ok(exhaustedProjection > retryFailure);
  assert.ok(source.includes("sanitizeOperationalError(projectionError)"));
});
