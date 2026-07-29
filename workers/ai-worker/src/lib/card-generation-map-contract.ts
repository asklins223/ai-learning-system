import { createHash } from "node:crypto";
import type { CardMapInput, CardMapOutput } from "@ailearn/shared";

export class CardMapContractError extends Error {
  readonly code:
    | "map_unknown_evidence_ref"
    | "map_incomplete_coverage"
    | "map_conflicting_coverage"
    | "map_invalid_relation"
    | "map_invalid_claim";

  constructor(code: CardMapContractError["code"], message: string) {
    super(message);
    this.name = "CardMapContractError";
    this.code = code;
  }
}

export type ValidatedMapCandidate = CardMapOutput["candidates"][number] & {
  normalizedClaimHash: string;
  sectionKey: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeCandidateClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

/**
 * Enforce the invariant the model schema cannot express by itself: every
 * primary allowlisted ref is accounted for, and no ref is both evidence and a
 * no-candidate declaration.
 */
export function validateCardMapOutput(
  input: CardMapInput,
  output: CardMapOutput,
): {
  candidates: ValidatedMapCandidate[];
  noCandidateUnitIds: CardMapOutput["noCandidateUnitIds"];
  coveredPrimaryRefIds: string[];
} {
  const allowlist = new Map(input.evidenceUnits.map((unit) => [unit.refId, unit]));
  const primary = new Set(
    input.evidenceUnits.filter((unit) => !unit.contextOnly).map((unit) => unit.refId),
  );
  const candidateLocalIds = new Set(output.candidates.map((candidate) => candidate.localId));
  const candidateCovered = new Set<string>();

  const candidates = output.candidates.map((rawCandidate) => {
    // 模型可能对同一 candidate 重复引用同一 evidence ID；下游
    // card_generation_candidate_evidence 有 (candidate, evidence) 唯一索引，
    // 不去重会在插入时报 23505 并浪费最多 2 次完整的 provider 重试。
    const candidate = {
      ...rawCandidate,
      evidenceRefIds: [...new Set(rawCandidate.evidenceRefIds)],
    };
    const normalizedClaim = normalizeCandidateClaim(candidate.claim);
    if (normalizedClaim.length < 6) {
      throw new CardMapContractError(
        "map_invalid_claim",
        `candidate ${candidate.localId} is not a substantive atomic claim`,
      );
    }
    for (const refId of candidate.evidenceRefIds) {
      if (!allowlist.has(refId)) {
        throw new CardMapContractError(
          "map_unknown_evidence_ref",
          `candidate ${candidate.localId} referenced an unknown evidence ID`,
        );
      }
      if (primary.has(refId)) candidateCovered.add(refId);
    }
    for (const relation of candidate.relationHints ?? []) {
      if (!candidateLocalIds.has(relation.localTargetId)) {
        throw new CardMapContractError(
          "map_invalid_relation",
          `candidate ${candidate.localId} referenced an unknown local relation target`,
        );
      }
    }
    const firstEvidence = candidate.evidenceRefIds
      .map((refId) => allowlist.get(refId))
      .find((unit) => unit !== undefined);
    return {
      ...candidate,
      normalizedClaimHash: sha256(normalizedClaim),
      sectionKey: firstEvidence?.sectionPath.join(" > ") || "__intro__",
    };
  });

  const noCandidate = new Set<string>();
  for (const item of output.noCandidateUnitIds) {
    if (!primary.has(item.unitId)) {
      throw new CardMapContractError(
        "map_unknown_evidence_ref",
        "no-candidate output referenced an unknown or context-only evidence ID",
      );
    }
    if (noCandidate.has(item.unitId) || candidateCovered.has(item.unitId)) {
      throw new CardMapContractError(
        "map_conflicting_coverage",
        "a primary evidence ID was classified more than once",
      );
    }
    noCandidate.add(item.unitId);
  }

  const accounted = new Set([...candidateCovered, ...noCandidate]);
  if (accounted.size !== primary.size || [...primary].some((refId) => !accounted.has(refId))) {
    throw new CardMapContractError(
      "map_incomplete_coverage",
      "map output did not account for every primary evidence ID",
    );
  }

  return {
    candidates,
    noCandidateUnitIds: output.noCandidateUnitIds,
    coveredPrimaryRefIds: [...accounted].sort(),
  };
}

export type ReducibleCandidate = {
  id: string;
  claim: string;
  normalizedClaimHash: string;
  topic: string;
  sectionKey: string;
  importance: string;
  cognitiveType: string;
  localOrdinal: number;
};

export type ReducedCandidatePool = {
  selected: ReducibleCandidate[];
  excluded: Array<{ candidateId: string; reason: "duplicate" }>;
};

const IMPORTANCE_RANK: Record<string, number> = { core: 0, supporting: 1, detail: 2 };

/** Exact normalized duplicates are removed deterministically before any model reduce. */
export function reduceCandidatePool(candidates: ReducibleCandidate[]): ReducedCandidatePool {
  const ordered = [...candidates].sort((left, right) =>
    (IMPORTANCE_RANK[left.importance] ?? 9) - (IMPORTANCE_RANK[right.importance] ?? 9)
    || left.sectionKey.localeCompare(right.sectionKey)
    || left.topic.localeCompare(right.topic)
    || left.localOrdinal - right.localOrdinal
    || left.id.localeCompare(right.id));
  const selected: ReducibleCandidate[] = [];
  const excluded: ReducedCandidatePool["excluded"] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (seen.has(candidate.normalizedClaimHash)) {
      excluded.push({ candidateId: candidate.id, reason: "duplicate" });
      continue;
    }
    seen.add(candidate.normalizedClaimHash);
    selected.push(candidate);
  }
  return { selected, excluded };
}
