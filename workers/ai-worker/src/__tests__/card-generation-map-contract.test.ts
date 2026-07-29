import assert from "node:assert/strict";
import test from "node:test";
import type { CardMapInput, CardMapOutput } from "@ailearn/shared";
import {
  CardMapContractError,
  normalizeCandidateClaim,
  reduceCandidatePool,
  validateCardMapOutput,
} from "../lib/card-generation-map-contract.ts";

const input: CardMapInput = {
  noteTitle: "Indexes",
  evidenceUnits: [
    { refId: "opaque-a", kind: "text", text: "Indexes narrow the search space.", sectionPath: ["DB"], contextOnly: false },
    { refId: "opaque-b", kind: "text", text: "A heading with no standalone fact.", sectionPath: ["DB"], contextOnly: false },
  ],
};

const valid: CardMapOutput = {
  sectionSummary: "Database indexes",
  candidates: [{
    localId: "c1",
    claim: "Indexes reduce the amount of data a selective query must inspect.",
    evidenceRefIds: ["opaque-a"],
    topic: "Indexes",
    cognitiveType: "causal",
    importance: "core",
  }],
  noCandidateUnitIds: [{ unitId: "opaque-b", reason: "metadata" }],
};

test("map contract accepts exact allowlist coverage and derives stable metadata", () => {
  const result = validateCardMapOutput(input, valid);
  assert.deepEqual(result.coveredPrimaryRefIds, ["opaque-a", "opaque-b"]);
  assert.equal(result.candidates[0]?.sectionKey, "DB");
  assert.match(result.candidates[0]?.normalizedClaimHash ?? "", /^[a-f0-9]{64}$/);
});

test("map contract rejects invented, missing, and conflicting evidence refs", () => {
  assert.throws(
    () => validateCardMapOutput(input, {
      ...valid,
      candidates: [{ ...valid.candidates[0]!, evidenceRefIds: ["invented"] }],
    }),
    (error) => error instanceof CardMapContractError && error.code === "map_unknown_evidence_ref",
  );
  assert.throws(
    () => validateCardMapOutput(input, { ...valid, noCandidateUnitIds: [] }),
    (error) => error instanceof CardMapContractError && error.code === "map_incomplete_coverage",
  );
  assert.throws(
    () => validateCardMapOutput(input, {
      ...valid,
      noCandidateUnitIds: [{ unitId: "opaque-a", reason: "duplicate" }, { unitId: "opaque-b", reason: "metadata" }],
    }),
    (error) => error instanceof CardMapContractError && error.code === "map_conflicting_coverage",
  );
});

test("deterministic reduce keeps the strongest exact-normalized duplicate", () => {
  const first = {
    id: "detail",
    claim: "Cache invalidation is safer.",
    normalizedClaimHash: normalizeCandidateClaim("Cache invalidation is safer."),
    topic: "Cache",
    sectionKey: "A",
    importance: "detail",
    cognitiveType: "concept",
    localOrdinal: 0,
  };
  const core = {
    ...first,
    id: "core",
    claim: "CACHE invalidation is safer!",
    importance: "core",
    normalizedClaimHash: normalizeCandidateClaim("CACHE invalidation is safer!"),
  };
  // The production rows carry SHA-256 hashes. Equal normalized strings imply
  // equal hashes; use the same marker here to isolate ordering behaviour.
  first.normalizedClaimHash = "same";
  core.normalizedClaimHash = "same";
  const result = reduceCandidatePool([first, core]);
  assert.deepEqual(result.selected.map((item) => item.id), ["core"]);
  assert.deepEqual(result.excluded, [{ candidateId: "detail", reason: "duplicate" }]);
});
