import type { Live2DParameterRequest } from "./live2d-parameter-priority";

const facs = (parameter: string, value: number): Live2DParameterRequest => ({
  layer: "facs",
  parameter,
  value,
});

const brows = (value: number): readonly Live2DParameterRequest[] => [
  facs("ParamBrowLY", value),
  facs("ParamBrowRY", value),
];

const mouth = (value: number): readonly Live2DParameterRequest[] => [
  facs("ParamMouthUp", Math.max(0, value)),
];

const smile = (
  eyeSmile: number,
  cheek: number,
  mouthUp: number,
): readonly Live2DParameterRequest[] => [
  facs("ParamEyeLSmile", eyeSmile),
  facs("ParamEyeRSmile", eyeSmile),
  facs("ParamCheek", cheek),
  facs("ParamMouthUp", mouthUp),
];

const expression = (...requests: readonly Live2DParameterRequest[]): readonly Live2DParameterRequest[] => requests;

/**
 * Semantic emotion to the parameters that actually exist in the Mao PRO
 * export. Unknown labels intentionally produce no FACS request.
 */
export const LIVE2D_EMOTION_PARAMETERS: Readonly<Record<string, readonly Live2DParameterRequest[]>> = {
  neutral: [],
  happy: expression(...brows(0.25), ...smile(0.8, 0.55, 0.75)),
  curious: expression(...brows(0.2), ...smile(0.25, 0.1, 0.15)),
  concerned: expression(...brows(-0.25), ...mouth(0)),
  surprised: expression(...brows(0.45), ...mouth(0.05)),
  excited: expression(...brows(0.3), ...smile(0.95, 0.8, 0.9)),
  sad: expression(...brows(0.2), ...mouth(0)),
  angry: expression(...brows(-0.3), ...mouth(0)),
  bored: mouth(0),
  tired: mouth(0),
  serious: brows(-0.2),
  sarcastic: expression(facs("ParamBrowLY", 0.15), facs("ParamBrowRY", -0.2), ...mouth(0.2)),
  mischievously: expression(facs("ParamBrowLY", 0.25), facs("ParamBrowRY", 0.1), ...smile(0.65, 0.45, 0.6)),
  empathetic: expression(...brows(0.15), ...smile(0.55, 0.35, 0.5)),
  crying: expression(...brows(0.35), ...mouth(0)),
  panicked: expression(...brows(0.4), ...mouth(0.1)),
  trembling: expression(...brows(-0.2), ...mouth(0)),
  shouting: expression(...brows(-0.2), ...mouth(0.1)),
  "deep and loud shouting": expression(...brows(-0.2), ...mouth(0.15)),
  whispers: mouth(0.05),
  asmr: mouth(0.05),
  reluctantly: expression(facs("ParamBrowLY", 0.1), ...mouth(0)),
  scornful: expression(...brows(-0.25), ...mouth(0)),
  "like dracula": expression(...brows(-0.3), ...mouth(0)),
  amazed: expression(...brows(0.45), ...mouth(0.1)),
  "very slowly": [],
  "very fast": [],
};

/**
 * Direct Cubism writes are persistent. This layer intentionally does not reset
 * Mao's expression channels every frame: doing so would flatten authored
 * motion keyforms. Lip-sync owns ParamA when speech is active.
 */
export const LIVE2D_NEUTRAL_FACS_PARAMETERS: readonly Live2DParameterRequest[] = [];

export function parameterRequestsForLive2DEmotion(
  emotion: string | null | undefined,
  intensity: number,
): Live2DParameterRequest[] {
  const key = typeof emotion === "string" ? emotion.trim().toLowerCase() : "";
  if (!key) return [];

  const base = LIVE2D_EMOTION_PARAMETERS[key];
  if (!base) return [];
  const scale = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  if (scale <= 0) return [];
  return base.map((request) => ({ ...request, value: request.value * scale }));
}
