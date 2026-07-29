/** Effective evidence semantics shared by server-side mutation paths. */
export type EffectiveEvidenceAlignment =
  | "aligned"
  | "soft"
  | "unaligned"
  | "stale_alignment";

export type EffectiveEvidenceOverride = "confirmed" | "downgraded" | "rejected";

/**
 * Resolve the alignment seen by a user. A row in evidence_overrides takes
 * precedence over the legacy evidences.user_override value.
 */
export function effectiveEvidenceAlignment(
  alignment: string,
  legacyOverride: string | null,
  userOverride?: string | null,
): EffectiveEvidenceAlignment | null {
  const override = userOverride ?? legacyOverride;
  if (override === "rejected") return null;
  if (override === "downgraded") return "soft";
  if (override === "confirmed") return "aligned";

  switch (alignment) {
    case "aligned":
    case "soft":
    case "unaligned":
    case "stale_alignment":
      return alignment;
    default:
      return null;
  }
}

export function isEffectiveHardEvidence(
  alignment: string,
  legacyOverride: string | null,
  userOverride?: string | null,
): boolean {
  return effectiveEvidenceAlignment(alignment, legacyOverride, userOverride) === "aligned";
}
