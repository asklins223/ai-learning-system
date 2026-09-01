import type { RoomIntent, RoomSurface } from "../app/room-machine";

export type SceneMotionMode = "full" | "lite" | "off";
export type SceneMotionPhase = "idle" | "focusing" | "task" | "returning";
export type SceneMotionKind = "camera" | "surfaceEnter" | "surfaceExit" | "return" | "parallax";

export type DoorEntryMotionProfile = Readonly<{
  durationScale: number;
  swing: number;
  interior: number;
  camera: number;
}>;

export type DoorEntryVisibility = "visible" | "hidden";

export type DoorEntryPlaybackState = Readonly<{
  timelinePaused: boolean;
  rendererRunning: boolean;
}>;

const MOTION_BUDGETS = Object.freeze({
  full: Object.freeze({ camera: 0.64, surfaceEnter: 0.46, surfaceExit: 0.25, return: 0.42, parallax: 0.72 }),
  lite: Object.freeze({ camera: 0.3, surfaceEnter: 0.22, surfaceExit: 0.14, return: 0.24, parallax: 0 }),
  off: Object.freeze({ camera: 0, surfaceEnter: 0, surfaceExit: 0, return: 0, parallax: 0 }),
});

const DOOR_ENTRY_MOTION = Object.freeze({
  full: Object.freeze({ durationScale: 1, swing: 1, interior: 1, camera: 1 }),
  lite: Object.freeze({ durationScale: 0.56, swing: 0.82, interior: 0.78, camera: 0.35 }),
  off: Object.freeze({ durationScale: 0, swing: 0, interior: 0, camera: 0 }),
});

export function sceneMotionDuration(mode: SceneMotionMode, kind: SceneMotionKind): number {
  return MOTION_BUDGETS[mode][kind];
}

export function doorEntryMotionProfile(mode: SceneMotionMode): DoorEntryMotionProfile {
  return DOOR_ENTRY_MOTION[mode];
}

export function doorEntryPlaybackState(
  visibility: DoorEntryVisibility,
  captureMode: boolean,
): DoorEntryPlaybackState {
  return Object.freeze({
    timelinePaused: captureMode || visibility === "hidden",
    rendererRunning: visibility === "visible",
  });
}

export function resolveSceneMotionMode(mode: SceneMotionMode, reducedMotion: boolean): SceneMotionMode {
  return reducedMotion ? "off" : mode;
}

export function scenePhaseForIntent(intent: RoomIntent, currentSurface: RoomSurface): SceneMotionPhase {
  if (intent === "home") return currentSurface ? "returning" : "idle";
  return "focusing";
}

export function settledScenePhase(surface: RoomSurface): SceneMotionPhase {
  return surface ? "task" : "idle";
}

/**
 * A useGSAP update can tear down an in-flight camera timeline before its
 * onComplete callback runs. If only the motion preference changed, the
 * camera must still land on a stable phase instead of remaining focusing.
 */
export function shouldSettleAfterMotionPreferenceChange(input: {
  readonly routeChanged: boolean;
  readonly modeChanged: boolean;
  readonly scenePhase: SceneMotionPhase;
}): boolean {
  return !input.routeChanged && input.modeChanged && input.scenePhase === "focusing";
}

export function motionBudgetSnapshot(): typeof MOTION_BUDGETS {
  return MOTION_BUDGETS;
}
