export type WindowLive2DMotionMode = "full" | "lite" | "off";

export type WindowLive2DPresentation =
  | "idle"
  | "invite"
  | "listen"
  | "speak"
  | "think"
  | "celebrate";

export type WindowLive2DStatus = "loading" | "ready" | "fallback";

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
  model: "assets/companion/live2d-v1/mao-pro/runtime/mao_pro.model3.json",
  vendorScripts: [
    "assets/companion/vendor/pixi.min.js",
    "assets/companion/vendor/live2dcubismcore.min.js",
    "assets/companion/vendor/cubism4.min.js",
  ],
  fallbackOrb: "assets/learning-room/v1/objects/companion-orb.webp",
} as const;

const MOTION_BY_PRESENTATION: Readonly<
  Record<WindowLive2DPresentation, WindowLive2DMotionCue>
> = {
  idle: { group: "Idle", index: 0 },
  invite: { group: "", index: 0 },
  listen: { group: "Idle", index: 0 },
  speak: { group: "Idle", index: 0 },
  think: { group: "", index: 2 },
  celebrate: { group: "", index: 3 },
};

export const WINDOW_LIVE2D_INVITE_CUE: WindowLive2DMotionCue = {
  group: "",
  index: 0,
};

export function motionForWindowLive2D(
  presentation: WindowLive2DPresentation,
): WindowLive2DMotionCue {
  return MOTION_BY_PRESENTATION[presentation];
}

export function shouldUseWindowLive2D(input: {
  readonly active: boolean;
  readonly motionMode: WindowLive2DMotionMode;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return input.active && input.motionMode === "full" && !input.prefersReducedMotion;
}

type ParameterRange = { readonly min: number; readonly max: number };

/**
 * Mao PRO parameter allowlist. Unknown parameters fail closed and all values
 * are clamped before reaching Cubism Core.
 */
const PARAMETER_ALLOWLIST: Readonly<Record<string, ParameterRange>> = {
  ParamBodyAngleX: { min: -10, max: 10 },
  ParamBreath: { min: 0, max: 1 },
  ParamBrowLY: { min: -1, max: 1 },
  ParamBrowRY: { min: -1, max: 1 },
  ParamCheek: { min: 0, max: 1 },
  ParamEyeLOpen: { min: 0, max: 1 },
  ParamEyeLSmile: { min: 0, max: 1 },
  ParamEyeROpen: { min: 0, max: 1 },
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
 * Deterministic, low-amplitude parameter layer. Cubism motions keep ownership
 * of choreography; this layer only supplies breathing, blinking and optional
 * voice amplitude while the renderer is active.
 */
export function parameterValuesForWindowLive2D(input: {
  readonly presentation: WindowLive2DPresentation;
  readonly nowMs: number;
  readonly voiceLevel: number;
}): WindowLive2DParameterValue[] {
  const blinkPhase = input.nowMs % 4_500;
  const eyeOpen = blinkPhase >= 3_600 && blinkPhase < 3_750
    ? Math.abs((blinkPhase - 3_675) / 75)
    : 1;
  const values: Array<WindowLive2DParameterValue | null> = [
    clampParameter("ParamBreath", 0.5 + Math.sin(input.nowMs / 900) * 0.25),
    clampParameter("ParamBodyAngleX", Math.sin(input.nowMs / 2_400) * 2),
    clampParameter("ParamEyeLOpen", eyeOpen),
    clampParameter("ParamEyeROpen", eyeOpen),
  ];

  if (input.presentation === "think") {
    values.push(
      clampParameter("ParamBrowLY", 0.1),
      clampParameter("ParamBrowRY", 0.1),
    );
  } else if (input.presentation === "celebrate") {
    values.push(
      clampParameter("ParamBrowLY", 0.25),
      clampParameter("ParamBrowRY", 0.25),
      clampParameter("ParamEyeLSmile", 0.35),
      clampParameter("ParamEyeRSmile", 0.35),
      clampParameter("ParamCheek", 0.3),
      clampParameter("ParamMouthUp", 0.25),
    );
  }

  if (input.presentation === "speak" || input.voiceLevel > 0) {
    const voiceLevel = Math.min(1, Math.max(0, input.voiceLevel));
    values.push(
      clampParameter("ParamA", voiceLevel),
      clampParameter("ParamMouthUp", voiceLevel * 0.2),
    );
  }

  return values.filter((value): value is WindowLive2DParameterValue => value !== null);
}
