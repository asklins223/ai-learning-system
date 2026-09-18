import type { CharacterPresentationStateV1 } from "@ailearn/shared/companion-character-contracts";
import {
  LIVE2D_NEUTRAL_FACS_PARAMETERS,
  parameterRequestsForLive2DEmotion,
} from "./live2d-emotion-map";
import type { Live2DEmotionState } from "./live2d-emotion";
import {
  arbitrateLive2DParameters,
  type Live2DParameterRequest,
} from "./live2d-parameter-priority";

export type WindowLive2DMotionMode = "full" | "lite" | "off";

export type WindowLive2DPresentation = CharacterPresentationStateV1;

// 2026-09-16 裁决：orb 已移除，加载失败不再回退替身形象，因此第三态是"不可用"
// （隐藏形象 + 父组件给可关闭说明），而不是"fallback 到另一个 renderer"。
export type WindowLive2DStatus = "loading" | "ready" | "unavailable";

/**
 * How the driver frames the model inside its canvas.
 * `full` keeps the entire character visible (home-page resident);
 * `bust` zooms to the head-and-torso region and crops the legs (task pages).
 */
export type WindowLive2DFraming = "full" | "bust";

/**
 * Fraction of the character's own visible height that the bust framing fills
 * (head through hands). Measured against the model's real content box, not the
 * canvas, so transparent canvas padding cannot shrink the character.
 */
export const WINDOW_LIVE2D_BUST_HEIGHT_RATIO = 0.7;

export interface WindowLive2DMotionCue {
  readonly group: string;
  readonly index: number;
}

/**
 * Renderer-local asset paths. They intentionally stay relative to
 * `document.baseURI`, so the same build works under Vite's dev origin and the
 * packaged `ailearn-app://bundle/` protocol without reaching outside the app.
 */
export const WINDOW_LIVE2D_ASSETS = {
  manifest: "assets/companion/live2d-v1/manifest.json",
  model: "assets/companion/live2d-v1/mao-pro/runtime/mao_pro.model3.json",
  vendorScripts: [
    "assets/companion/vendor/pixi.min.js",
    "assets/companion/vendor/live2dcubismcore.min.js",
    "assets/companion/vendor/cubism4.min.js",
  ],
} as const;

export function isApprovedWindowLive2DManifest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as {
    schemaVersion?: unknown;
    modelId?: unknown;
    status?: unknown;
    ownerApproved?: { by?: unknown; date?: unknown };
    modelLicense?: { name?: unknown; acceptanceRequired?: unknown; commercialReleaseAllowed?: unknown };
  };
  const isProductionMao = manifest.modelId === "companion-live2d-mao-pro-v1"
    && manifest.status === "production"
    && manifest.modelLicense?.commercialReleaseAllowed === true;
  return manifest.schemaVersion === 1
    && isProductionMao
    && typeof manifest.ownerApproved?.by === "string"
    && manifest.ownerApproved.by.trim().length > 0
    && typeof manifest.ownerApproved.date === "string"
    && manifest.ownerApproved.date.trim().length > 0
    && typeof manifest.modelLicense?.name === "string"
    && manifest.modelLicense.name.trim().length > 0
    && manifest.modelLicense.acceptanceRequired === true;
}

const MOTION_BY_PRESENTATION: Readonly<
  Record<WindowLive2DPresentation, WindowLive2DMotionCue | null>
> = {
  hidden: null,
  idle: { group: "Idle", index: 0 },
  invite: { group: "", index: 0 },
  listen: { group: "Idle", index: 0 },
  speak: { group: "Idle", index: 0 },
  think: { group: "", index: 2 },
  analyze: { group: "", index: 2 },
  navigate: { group: "", index: 0 },
  encourage: { group: "", index: 3 },
  celebrate: { group: "", index: 3 },
  uncertain: { group: "", index: 1 },
};

export const WINDOW_LIVE2D_INVITE_CUE: WindowLive2DMotionCue = {
  group: "",
  index: 0,
};

export function motionForWindowLive2D(
  presentation: WindowLive2DPresentation,
): WindowLive2DMotionCue | null {
  return MOTION_BY_PRESENTATION[presentation];
}

const EMOTION_MOTION_BY_NAME: Readonly<Record<string, WindowLive2DMotionCue>> = {
  happy: { group: "", index: 3 },
  excited: { group: "", index: 3 },
  amazed: { group: "", index: 1 },
  mischievously: { group: "", index: 3 },
  curious: { group: "", index: 2 },
  empathetic: { group: "", index: 3 },
  encouraged: { group: "", index: 3 },
  celebrate: { group: "", index: 3 },
  analyze: { group: "", index: 2 },
  think: { group: "", index: 2 },
  surprised: { group: "", index: 1 },
  panicked: { group: "", index: 1 },
};

export function motionForWindowLive2DEmotion(
  emotion: string | null | undefined,
): WindowLive2DMotionCue | null {
  const key = typeof emotion === "string" ? emotion.trim().toLowerCase() : "";
  return key ? EMOTION_MOTION_BY_NAME[key] ?? null : null;
}

type ParameterRange = { readonly min: number; readonly max: number };

/**
 * Mao PRO parameter allowlist. Unknown parameters fail closed and all
 * values are clamped before reaching Cubism Core.
 */
const PARAMETER_ALLOWLIST: Readonly<Record<string, ParameterRange>> = {
  ParamBodyAngleX: { min: -10, max: 10 },
  ParamBreath: { min: 0, max: 1 },
  ParamBrowLY: { min: -1, max: 1 },
  ParamBrowRY: { min: -1, max: 1 },
  ParamCheek: { min: 0, max: 1 },
  ParamEyeLOpen: { min: 0, max: 1 },
  ParamEyeROpen: { min: 0, max: 1 },
  ParamEyeLSmile: { min: 0, max: 1 },
  ParamEyeRSmile: { min: 0, max: 1 },
  ParamMouthUp: { min: 0, max: 1 },
  ParamA: { min: 0, max: 1 },
};

export interface WindowLive2DParameterValue {
  readonly parameter: string;
  readonly value: number;
}

function clampParameter(parameter: string, value: number): WindowLive2DParameterValue | null {
  const range = PARAMETER_ALLOWLIST[parameter];
  if (!range || !Number.isFinite(value)) return null;

  return {
    parameter,
    value: Math.min(range.max, Math.max(range.min, value)),
  };
}

/**
 * Deterministic parameter layer. Cubism motions keep ownership of choreography;
 * this layer supplies breathing, blinking, voice amplitude and the currently
 * active Mao semantic expression while the renderer is active.
 */
export function parameterValuesForWindowLive2D(input: {
  readonly presentation: WindowLive2DPresentation;
  readonly nowMs: number;
  readonly voiceLevel: number;
  readonly emotion?: Live2DEmotionState | null;
}): WindowLive2DParameterValue[] {
  const blinkPhase = input.nowMs % 4_500;
  const eyeOpen = blinkPhase >= 3_600 && blinkPhase < 3_750
    ? Math.abs((blinkPhase - 3_675) / 75)
    : 1;
  const requests: Live2DParameterRequest[] = [
    { layer: "idle", parameter: "ParamBreath", value: 0.5 + Math.sin(input.nowMs / 900) * 0.25 },
    { layer: "idle", parameter: "ParamBodyAngleX", value: Math.sin(input.nowMs / 2_400) * 2 },
    { layer: "blink", parameter: "ParamEyeLOpen", value: eyeOpen },
    { layer: "blink", parameter: "ParamEyeROpen", value: eyeOpen },
  ];

  const presentationFacs: Live2DParameterRequest[] = [];
  switch (input.presentation) {
    case "encourage":
    case "celebrate":
      presentationFacs.push(
        { layer: "facs", parameter: "ParamBrowLY", value: 0.25 },
        { layer: "facs", parameter: "ParamBrowRY", value: 0.25 },
        { layer: "facs", parameter: "ParamEyeLSmile", value: 0.35 },
        { layer: "facs", parameter: "ParamEyeRSmile", value: 0.35 },
        { layer: "facs", parameter: "ParamCheek", value: 0.3 },
        { layer: "facs", parameter: "ParamMouthUp", value: 0.25 },
      );
      break;
    case "think":
    case "analyze":
      presentationFacs.push(
        { layer: "facs", parameter: "ParamBrowLY", value: 0.1 },
        { layer: "facs", parameter: "ParamBrowRY", value: 0.1 },
      );
      break;
    default:
      break;
  }

  const emotionFacs = input.emotion?.emotion
    ? parameterRequestsForLive2DEmotion(input.emotion.emotion, input.emotion.intensity)
    : [];
  requests.push(...LIVE2D_NEUTRAL_FACS_PARAMETERS);
  requests.push(...(emotionFacs.length > 0 ? emotionFacs : presentationFacs));

  if (input.presentation === "speak" || input.voiceLevel > 0) {
    const voiceLevel = Math.min(1, Math.max(0, input.voiceLevel));
    requests.push(
      { layer: "lipsync", parameter: "ParamA", value: voiceLevel },
      { layer: "lipsync", parameter: "ParamMouthUp", value: voiceLevel * 0.2 },
    );
  }

  return arbitrateLive2DParameters(requests)
    .map(({ parameter, value }) => clampParameter(parameter, value))
    .filter((value): value is WindowLive2DParameterValue => value !== null);
}
