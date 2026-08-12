import type { CompanionVisualStateV1 } from "./companion-visual-state";

/**
 * Static character assets cut from the owner-provided action reference sheet.
 *
 * The sheet contains eight authored poses. States without a dedicated frame
 * intentionally reuse the nearest authored pose until the remaining three
 * production frames are supplied; this keeps the visual identity consistent
 * without inventing a second character.
 */
export const COMPANION_REFERENCE_ASSET_VERSION = "reference-sheet-v1";

export const COMPANION_REFERENCE_ASSET_STATUS = {
  dormant: "authored",
  invite_once: "authored",
  navigate: "authored",
  present_evidence: "authored",
  listen: "authored",
  co_manipulate: "authored",
  explain: "reused",
  assessment_handoff: "reused",
  committed_change: "authored",
  uncertain_or_retry: "authored",
  exit_or_hidden: "suppressed",
} as const;

export const COMPANION_REFERENCE_ASSET_MANIFEST = {
  version: COMPANION_REFERENCE_ASSET_VERSION,
  sourcePath: "/docs/image/learning-companion-character-action-reference.png",
  sourceSha256: "159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5",
  // Owner-provided source; commercial/license confirmation remains an owner gate.
  sourceLicenseRef: "owner-provided-reference-image-license-to-confirm",
  canvas: { width: 350, height: 430, alpha: true },
  stateStatus: COMPANION_REFERENCE_ASSET_STATUS,
} as const;

export const COMPANION_REFERENCE_ASSET_BY_STATE: Record<
  Exclude<CompanionVisualStateV1, "exit_or_hidden">,
  string
> = {
  dormant: "/images/companion/reference/dormant.png",
  invite_once: "/images/companion/reference/invite_once.png",
  navigate: "/images/companion/reference/navigate.png",
  present_evidence: "/images/companion/reference/present_evidence.png",
  listen: "/images/companion/reference/listen.png",
  co_manipulate: "/images/companion/reference/co_manipulate.png",
  explain: "/images/companion/reference/present_evidence.png",
  assessment_handoff: "/images/companion/reference/uncertain_or_retry.png",
  committed_change: "/images/companion/reference/committed_change.png",
  uncertain_or_retry: "/images/companion/reference/uncertain_or_retry.png",
};

export function companionReferenceAssetForState(
  state: CompanionVisualStateV1,
): string | null {
  if (state === "exit_or_hidden") return null;
  return COMPANION_REFERENCE_ASSET_BY_STATE[state];
}
