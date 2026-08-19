/**
 * Shared deterministic pieces of the fail-closed Learning Session assessment.
 *
 * API and worker must derive the same decision/report hashes when a request is
 * processed synchronously or after an outbox retry. This module contains no
 * database, HTTP, provider, or user-content side effects.
 */

import { sha256Hex, stableStringify } from "./content-hash.ts";
import { TrustClass } from "./learning-session-contracts.ts";

export function computeAssessmentInputHash(value: string): string {
  return sha256Hex(value);
}

// stableStringify imported from ./content-hash.ts

/** Same deterministic trust decision hash used by the API assessment path. */
export function computeFailClosedAssessmentDecisionHash(input: {
  episodeId: string;
  artifactId: string;
  reducerResult: string;
  canonicalCommitEnabled: boolean;
}): string {
  const reasonCodes = [
    "assessment_critic_unavailable",
    `reducer:${input.reducerResult}`,
    ...(input.canonicalCommitEnabled ? [] : ["canonical_commit_disabled"]),
  ].sort((left, right) => left.localeCompare(right));
  const decision = {
    episodeId: input.episodeId,
    effectiveClass: TrustClass.NOT_ASSESSABLE,
    sourceArtifactIds: [input.artifactId].sort((left, right) => left.localeCompare(right)),
    frozenProbeSetHash: sha256Hex("assessment-critic-unavailable"),
    requiredRubricCoverageHash: sha256Hex("assessment-coverage-unavailable"),
    assistanceSnapshotHash: sha256Hex("assessment-assistance-unavailable"),
    reasonCodes,
  };
  return sha256Hex(`episode-trust-v1:${stableStringify(decision)}`);
}

export function computeAssessmentReportHash(
  episodeId: string,
  artifactId: string,
  decisionHash: string,
): string {
  return sha256Hex(`${episodeId}:${artifactId}:${decisionHash}`);
}
