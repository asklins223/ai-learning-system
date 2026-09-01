import { SCENE_DEPTH_BANDS } from "./scene-depth";
import type { SceneFrameBounds } from "./scene-input";
import type { SceneMotionMode, SceneMotionPhase } from "./scene-motion";
import type { ScenePoint } from "./scene-geometry";

export type SceneForegroundMotionReason =
  | "active"
  | "asset-not-ready"
  | "compact"
  | "motion-off"
  | "scene-not-settled"
  | "window-hidden";

export type SceneForegroundMotionPolicy = Readonly<{
  readonly enabled: boolean;
  readonly reason: SceneForegroundMotionReason;
  readonly maxOffsetX: number;
  readonly maxOffsetY: number;
}>;

const D6_BAND = SCENE_DEPTH_BANDS.find((band) => band.id === "D6");
if (!D6_BAND) throw new Error("D6 scene depth band is required for foreground motion.");

/**
 * Search foreground stays inside the registered D6 budget, but uses half of
 * the room-wide allowance because the task surface is already in focus.
 */
export const SEARCH_FOREGROUND_MOTION_LIMIT = Object.freeze({
  maxOffsetX: D6_BAND.maxOffsetX * 0.5,
  maxOffsetY: D6_BAND.maxOffsetY * 0.5,
});

function inactivePolicy(reason: Exclude<SceneForegroundMotionReason, "active">): SceneForegroundMotionPolicy {
  return Object.freeze({
    enabled: false,
    reason,
    maxOffsetX: SEARCH_FOREGROUND_MOTION_LIMIT.maxOffsetX,
    maxOffsetY: SEARCH_FOREGROUND_MOTION_LIMIT.maxOffsetY,
  });
}

export function resolveSceneForegroundMotionPolicy(input: {
  readonly assetReady: boolean;
  readonly compact: boolean;
  readonly motionMode: SceneMotionMode;
  readonly scenePhase: SceneMotionPhase;
  readonly windowVisible: boolean;
}): SceneForegroundMotionPolicy {
  if (!input.assetReady) return inactivePolicy("asset-not-ready");
  if (input.compact) return inactivePolicy("compact");
  if (input.motionMode !== "full") return inactivePolicy("motion-off");
  if (input.scenePhase !== "task") return inactivePolicy("scene-not-settled");
  if (!input.windowVisible) return inactivePolicy("window-hidden");
  return Object.freeze({
    enabled: true,
    reason: "active",
    maxOffsetX: SEARCH_FOREGROUND_MOTION_LIMIT.maxOffsetX,
    maxOffsetY: SEARCH_FOREGROUND_MOTION_LIMIT.maxOffsetY,
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export type ScenePointerOffsetInput = Readonly<{
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType?: string;
  readonly frameBounds: SceneFrameBounds;
  readonly maxOffsetX: number;
  readonly maxOffsetY: number;
}>;

/**
 * Convert a pointer position to a bounded local scene offset. Touch input is
 * intentionally neutral: a finger should never synthesize desktop parallax.
 */
export function scenePointerOffset(input: ScenePointerOffsetInput): ScenePoint {
  if (input.pointerType && input.pointerType !== "mouse" && input.pointerType !== "pen") return [0, 0];
  if (
    !Number.isFinite(input.clientX)
    || !Number.isFinite(input.clientY)
    || !positiveFinite(input.frameBounds.width)
    || !positiveFinite(input.frameBounds.height)
    || !positiveFinite(input.maxOffsetX)
    || !positiveFinite(input.maxOffsetY)
  ) return [0, 0];

  const normalizedX = clamp(((input.clientX - input.frameBounds.left) / input.frameBounds.width) * 2 - 1, -1, 1);
  const normalizedY = clamp(((input.clientY - input.frameBounds.top) / input.frameBounds.height) * 2 - 1, -1, 1);
  return [
    Number((-normalizedX * input.maxOffsetX).toFixed(4)),
    Number((-normalizedY * input.maxOffsetY).toFixed(4)),
  ];
}

/** Backwards-compatible name for the Search D6 foreground consumer. */
export function sceneForegroundPointerOffset(input: ScenePointerOffsetInput): ScenePoint {
  return scenePointerOffset(input);
}
