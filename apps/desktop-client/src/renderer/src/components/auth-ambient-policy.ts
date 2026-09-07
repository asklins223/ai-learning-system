import type { SceneMotionMode } from "../scene/scene-motion";

export const AUTH_AMBIENT_PERFORMANCE_BUDGET = Object.freeze({
  maxParticles: 24,
  maxDayLeaves: 9,
  maxLampMotes: 10,
  maxFps: 24,
  maxResolution: 1.5,
});

export type AuthAmbientPolicy = Readonly<{
  enabled: boolean;
  reason: "enabled" | "motion-mode" | "compact";
}>;

export function resolveAuthAmbientPolicy(input: {
  motionMode: SceneMotionMode;
  compact: boolean;
}): AuthAmbientPolicy {
  if (input.motionMode !== "full") return { enabled: false, reason: "motion-mode" };
  if (input.compact) return { enabled: false, reason: "compact" };
  return { enabled: true, reason: "enabled" };
}
