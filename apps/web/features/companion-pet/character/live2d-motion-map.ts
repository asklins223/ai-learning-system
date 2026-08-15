import type { CharacterPresentationStateV1 } from "@ailearn/shared/companion-character-contracts";

/**
 * P4 Live2D motion mapping (new presentation → current Mao PRO motion).
 *
 * Mao PRO (`/images/companion/pet/live2d-v1/mao-pro/runtime/mao_pro.model3.json`) exposes:
 *   - `Idle` group: mtn_01 (loop)
 *   - `""` group: mtn_02..mtn_04 + special_01..03 (single-shot)
 * plus 8 expressions. `hidden` returns null → the live surface is hidden.
 */

export interface Live2DMotionCueV1 {
  group: string;
  index: number;
}

export const LIVE2D_MOTION_FOR_PRESENTATION: Record<
  CharacterPresentationStateV1,
  Live2DMotionCueV1 | null
> = {
  hidden: null,
  idle: { group: "Idle", index: 0 },
  invite: { group: "", index: 0 },
  listen: { group: "Idle", index: 0 },
  think: { group: "", index: 2 },
  analyze: { group: "", index: 4 },
  speak: { group: "Idle", index: 0 },
  navigate: { group: "", index: 1 },
  encourage: { group: "", index: 5 },
  celebrate: { group: "", index: 3 },
  uncertain: { group: "", index: 2 },
};

/** Invite-once cue triggered by a character click (then back to idle). */
export const LIVE2D_INVITE_ONCE_CUE: Live2DMotionCueV1 = { group: "", index: 0 };

export function motionForLive2DPresentation(
  presentation: CharacterPresentationStateV1,
): Live2DMotionCueV1 | null {
  return LIVE2D_MOTION_FOR_PRESENTATION[presentation];
}
