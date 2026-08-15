import type { CharacterPresentationStateV1 } from "@ailearn/shared/companion-character-contracts";
import type { Live2DParameterRequest } from "./live2d-priority";
import { parameterRequestsForEmotion } from "./emotion-expression-map";

export interface Live2DParameterFrameInput {
  presentation: CharacterPresentationStateV1;
  nowMs: number;
  voiceLevel: number;
  /**
   * 15 方案 emotion 表现层：VAD 平滑后的情绪（null/undefined = 无情绪信号）。
   * 有 emotion 时 facs 层由 emotion 接管（intensity 缩放），presentation
   * 的 facs 投影降级为兜底（仅在无 emotion 时生效）。
   */
  emotion?: { emotion: string | null; intensity: number } | null;
}

/**
 * Produces only high-level, deterministic parameter intents. The driver is
 * responsible for arbitration and allowlist/clamp before touching Cubism.
 */
export function parameterRequestsForLive2DFrame(
  input: Live2DParameterFrameInput,
): Live2DParameterRequest[] {
  const requests: Live2DParameterRequest[] = [
    {
      layer: "idle",
      parameter: "ParamBreath",
      value: 0.5 + Math.sin(input.nowMs / 900) * 0.25,
    },
    {
      layer: "idle",
      parameter: "ParamBodyAngleX",
      value: Math.sin(input.nowMs / 2400) * 2,
    },
    // Gaze remains neutral until a pointer target is supplied. Keeping the
    // layer explicit prevents future FACS/lipsync additions from writing an
    // arbitrary parameter outside the priority system.
    { layer: "gaze", parameter: "ParamEyeBallX", value: 0 },
    { layer: "gaze", parameter: "ParamEyeBallY", value: 0 },
  ];

  const blinkPhase = input.nowMs % 4500;
  const blinkProgress = blinkPhase >= 3600 && blinkPhase < 3750
    ? Math.abs((blinkPhase - 3675) / 75)
    : 1;
  requests.push(
    { layer: "blink", parameter: "ParamEyeLOpen", value: blinkProgress },
    { layer: "blink", parameter: "ParamEyeROpen", value: blinkProgress },
  );

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
    case "uncertain":
      presentationFacs.push(
        { layer: "facs", parameter: "ParamBrowLY", value: -0.25 },
        { layer: "facs", parameter: "ParamBrowRY", value: -0.1 },
        { layer: "facs", parameter: "ParamMouthDown", value: 0.15 },
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

  // 15 方案 emotion 表现层：有情绪信号 → facs 由 emotion 接管（intensity
  // 缩放）；无情绪 → presentation facs 兜底（原行为）。
  const emotionFacs = input.emotion?.emotion
    ? parameterRequestsForEmotion(input.emotion.emotion, input.emotion.intensity)
    : null;
  requests.push(...(emotionFacs ?? presentationFacs));

  const voiceLevel = Number.isFinite(input.voiceLevel)
    ? Math.min(1, Math.max(0, input.voiceLevel))
    : 0;
  if (input.presentation === "speak" || voiceLevel > 0) {
    requests.push(
      { layer: "lipsync", parameter: "ParamA", value: voiceLevel },
      { layer: "lipsync", parameter: "ParamMouthUp", value: voiceLevel * 0.2 },
    );
  }
  return requests;
}
