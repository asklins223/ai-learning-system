import type { CompanionVisualStateV1 } from "@/lib/learning-companion/companion-visual-state";

/**
 * Temporary local-development Live2D registration.
 *
 * This entry is deliberately development-only. The Mao PRO files are Live2D
 * sample material and must be removed/replaced before any public release.
 */
export const LIVE2D_DEV_MODEL = {
  id: "reference-live2d-mao-pro-dev",
  displayName: "Mao PRO (temporary development model)",
  modelUrl: "/live2d-dev/mao-pro/runtime/mao_pro.model3.json",
  vendorScripts: [
    "/live2d-dev/vendor/pixi.min.js",
    "/live2d-dev/vendor/live2dcubismcore.min.js",
    "/live2d-dev/vendor/cubism4.min.js",
  ],
  developmentOnly: true,
} as const;

/** Mao PRO's supplied motion groups, kept behind the app's semantic state contract. */
export const LIVE2D_DEV_MOTION_FOR_STATE: Record<
  CompanionVisualStateV1,
  { group: string; index: number }
> = {
  dormant: { group: "Idle", index: 0 },
  invite_once: { group: "", index: 0 },
  navigate: { group: "", index: 1 },
  present_evidence: { group: "", index: 2 },
  listen: { group: "Idle", index: 0 },
  co_manipulate: { group: "", index: 3 },
  explain: { group: "", index: 4 },
  assessment_handoff: { group: "Idle", index: 0 },
  committed_change: { group: "", index: 5 },
  uncertain_or_retry: { group: "", index: 2 },
  exit_or_hidden: { group: "Idle", index: 0 },
};

export function motionForLive2DState(state: CompanionVisualStateV1) {
  return LIVE2D_DEV_MOTION_FOR_STATE[state];
}

export type Live2DDevLoadState = "disabled" | "loading" | "ready" | "fallback";
