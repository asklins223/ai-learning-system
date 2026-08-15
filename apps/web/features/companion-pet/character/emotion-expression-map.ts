/**
 * 15 方案 §5 待办 3：emotion → Live2D 参数映射。
 *
 * 对齐 `live2d-parameter-frames.ts` 现有 facs 参数（ParamBrowL/RY、
 * ParamEyeLSmile/RSmile、ParamCheek、ParamMouthUp/Down、ParamMouthOpen 等），
 * 覆盖两个 emotion 名称空间：
 * - character.cue 的 emotion（neutral/happy/curious/concerned/surprised）；
 * - voice.segment.emotion（阿里百炼控制类标签，如 excited/sad/angry…）。
 *
 * 未覆盖的 emotion 名 → 空参数（neutral）；调用方按 intensity 缩放后
 * 由 priority/allowlist/clamp 仲裁（与 presentation 同机制）。
 */
import type { Live2DParameterRequest } from "./live2d-priority";

const F = (parameter: string, value: number): Live2DParameterRequest => ({
  layer: "facs",
  parameter,
  value,
});

/**
 * 各情绪的基础 facs 参数（value 为 intensity=1 时的目标值，调用方缩放）。
 * 数值范围对齐现有 presentation 投影（-0.5..0.5 区间）。
 */
export const EMOTION_FACS_PARAMETERS: Record<string, Live2DParameterRequest[]> = {
  // ── character.cue emotion ─────────────────────────────────────────────
  neutral: [],
  happy: [
    F("ParamBrowLY", 0.15),
    F("ParamBrowRY", 0.15),
    F("ParamEyeLSmile", 0.35),
    F("ParamEyeRSmile", 0.35),
    F("ParamCheek", 0.3),
    F("ParamMouthUp", 0.25),
  ],
  curious: [
    F("ParamBrowLY", 0.2),
    F("ParamBrowRY", 0.2),
    F("ParamMouthUp", 0.1),
  ],
  concerned: [
    F("ParamBrowLY", -0.2),
    F("ParamBrowRY", -0.3),
    F("ParamMouthDown", 0.12),
  ],
  surprised: [
    F("ParamBrowLY", 0.45),
    F("ParamBrowRY", 0.45),
    F("ParamMouthOpen", 0.3),
  ],
  // ── 标签 emotion（控制类，精选映射；节奏类/无表情类 → 空） ─────────────
  excited: [
    F("ParamBrowLY", 0.3),
    F("ParamBrowRY", 0.3),
    F("ParamEyeLSmile", 0.45),
    F("ParamEyeRSmile", 0.45),
    F("ParamCheek", 0.4),
    F("ParamMouthOpen", 0.15),
    F("ParamMouthUp", 0.3),
  ],
  sad: [
    F("ParamBrowLY", 0.3),
    F("ParamBrowRY", 0.3),
    F("ParamEyeLOpen", -0.1),
    F("ParamEyeROpen", -0.1),
    F("ParamMouthDown", 0.25),
  ],
  angry: [
    F("ParamBrowLY", -0.3),
    F("ParamBrowRY", -0.35),
    F("ParamMouthDown", 0.2),
  ],
  bored: [
    F("ParamEyeLOpen", -0.15),
    F("ParamEyeROpen", -0.15),
    F("ParamMouthDown", 0.1),
  ],
  tired: [
    F("ParamEyeLOpen", -0.2),
    F("ParamEyeROpen", -0.2),
    F("ParamMouthDown", 0.08),
  ],
  serious: [
    F("ParamBrowLY", -0.1),
    F("ParamBrowRY", -0.1),
  ],
  sarcastic: [
    F("ParamBrowLY", 0.15),
    F("ParamBrowRY", -0.2),
    F("ParamMouthUp", 0.15),
  ],
  mischievously: [
    F("ParamBrowLY", 0.25),
    F("ParamBrowRY", 0.1),
    F("ParamEyeLSmile", 0.35),
    F("ParamEyeRSmile", 0.35),
    F("ParamMouthUp", 0.3),
  ],
  empathetic: [
    F("ParamBrowLY", 0.15),
    F("ParamBrowRY", 0.15),
    F("ParamEyeLSmile", 0.2),
    F("ParamEyeRSmile", 0.2),
    F("ParamMouthUp", 0.15),
  ],
  crying: [
    F("ParamBrowLY", 0.35),
    F("ParamBrowRY", 0.35),
    F("ParamMouthDown", 0.3),
  ],
  panicked: [
    F("ParamBrowLY", 0.4),
    F("ParamBrowRY", 0.4),
    F("ParamMouthOpen", 0.3),
  ],
  trembling: [
    F("ParamBrowLY", -0.2),
    F("ParamBrowRY", -0.2),
    F("ParamMouthDown", 0.15),
  ],
  shouting: [
    F("ParamBrowLY", -0.2),
    F("ParamBrowRY", -0.2),
    F("ParamMouthOpen", 0.45),
  ],
  "deep and loud shouting": [
    F("ParamBrowLY", -0.2),
    F("ParamBrowRY", -0.2),
    F("ParamMouthOpen", 0.45),
  ],
  whispers: [
    F("ParamMouthUp", 0.05),
  ],
  asmr: [
    F("ParamMouthUp", 0.05),
  ],
  reluctantly: [
    F("ParamBrowLY", 0.1),
    F("ParamMouthDown", 0.12),
  ],
  scornful: [
    F("ParamBrowLY", -0.2),
    F("ParamBrowRY", -0.3),
    F("ParamMouthDown", 0.15),
  ],
  "like dracula": [
    F("ParamBrowLY", -0.3),
    F("ParamBrowRY", -0.3),
    F("ParamEyeLOpen", -0.2),
    F("ParamEyeROpen", -0.2),
    F("ParamMouthDown", 0.2),
  ],
  amazed: [
    F("ParamBrowLY", 0.45),
    F("ParamBrowRY", 0.45),
    F("ParamMouthOpen", 0.35),
  ],
  // 节奏类标签无固定表情（语气由 TTS 表达）——保持 neutral
  "very slowly": [],
  "very fast": [],
};

/**
 * emotion → facs 参数请求（按 intensity 缩放；未知 emotion → 空）。
 * 返回 layer=facs 的请求，由调用方与 presentation/其他层合并仲裁。
 */
export function parameterRequestsForEmotion(
  emotion: string | null | undefined,
  intensity: number,
): Live2DParameterRequest[] {
  if (!emotion) return [];
  const base = EMOTION_FACS_PARAMETERS[emotion];
  if (!base) return [];
  const scale = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  if (scale <= 0) return [];
  return base.map((req) => ({ ...req, value: req.value * scale }));
}
