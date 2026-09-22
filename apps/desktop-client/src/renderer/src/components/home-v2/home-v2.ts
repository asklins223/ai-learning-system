import type { MotionMode } from "../../app/room-machine";
import { LIGHTHOUSE_HOME_SCENE_PROFILE } from "./home-scene-profile";

export type HomeV2Zone = "wide" | "desk" | "shelf" | "window" | "rest";

export type HomeV2CameraPreset = {
  readonly scale: number;
  readonly xPercent: number;
  readonly yPercent: number;
};

export const HOME_V2_CAMERA_PRESETS: Readonly<Record<HomeV2Zone, HomeV2CameraPreset>> =
  LIGHTHOUSE_HOME_SCENE_PROFILE.cameraPresets;

export function homeV2CameraDuration(mode: MotionMode): number {
  if (mode === "off") return 0;
  if (mode === "lite") return 0.22;
  return 0.48;
}

export function homeV2CameraCss(preset: HomeV2CameraPreset) {
  return {
    "--scene-camera-scale": preset.scale,
    "--scene-camera-x-percent": `${preset.xPercent}%`,
    "--scene-camera-y-percent": `${preset.yPercent}%`,
  } as const;
}

export function shouldRunHomeV2Ambient(input: {
  readonly unlocked: boolean;
  readonly masterMuted: boolean;
  readonly surfaceOpen: boolean;
  readonly windowVisible: boolean;
}): boolean {
  return input.unlocked
    && !input.masterMuted
    && !input.surfaceOpen
    && input.windowVisible;
}
