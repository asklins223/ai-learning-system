import gsap from "gsap";
import { homeV2CameraCss, type HomeV2CameraPreset } from "./home-v2";

export const HOME_V2_CAMERA_FRAME_EVENT = "ailearn:home-v2-camera-frame";

/**
 * The Home V2 scene camera is written to one element (`.desktop-app`) through
 * one set of CSS variables. Two consumers legitimately need to retarget it —
 * the semantic zone owner (object activation, catalog, Escape) and the scene
 * router (leaving and returning from a task surface) — so the tween itself
 * must have a single owner.
 *
 * This module is that owner. Every request supersedes the previous one
 * (latest command wins), and only the surviving command may settle the scene
 * phase, so a late route transition can never overwrite a newer zone command
 * or leave the camera mid-flight without a settling callback.
 */

export type HomeV2CameraSettleReason = "complete" | "superseded" | "cancelled";

export type HomeV2CameraRequest = Readonly<{
  readonly target: HTMLElement;
  readonly preset: HomeV2CameraPreset;
  readonly duration: number;
  readonly ease?: string;
  readonly onSettle?: (reason: HomeV2CameraSettleReason) => void;
}>;

type ActiveCommand = {
  readonly id: number;
  readonly settle: (reason: HomeV2CameraSettleReason) => void;
  tween: gsap.core.Tween | null;
};

let activeCommand: ActiveCommand | null = null;
let commandSequence = 0;
let cameraWriteCount = 0;

function markCameraState(target: HTMLElement, state: "idle" | "moving"): void {
  if (target.dataset.homeV2CameraState !== state) target.dataset.homeV2CameraState = state;
}

function publishCameraFrame(target: HTMLElement): void {
  target.dispatchEvent?.(new CustomEvent(HOME_V2_CAMERA_FRAME_EVENT, { bubbles: true }));
}

/**
 * Number of committed camera commands. Observability only: the capture contract
 * reads the rendered `data-home-v2-camera-state` attribute, never this counter.
 */
export function homeV2CameraWriteCount(): number {
  return cameraWriteCount;
}

function releaseCommand(command: ActiveCommand): void {
  if (activeCommand?.id === command.id) activeCommand = null;
}

function supersedeActiveCommand(): void {
  const previous = activeCommand;
  if (!previous) return;
  activeCommand = null;
  // Detach before killing so the kill cannot re-enter the settle path.
  previous.tween?.kill();
  previous.settle("superseded");
}

/**
 * Retargets the Home V2 camera. Returns a cancel handle that kills only this
 * command (a canceled command never settles the scene phase, matching the
 * previous per-effect cleanup behaviour).
 */
export function requestHomeV2Camera(request: HomeV2CameraRequest): () => void {
  const { target, preset, duration, ease = "power3.inOut" } = request;
  supersedeActiveCommand();

  const id = ++commandSequence;
  cameraWriteCount += 1;
  const values = homeV2CameraCss(preset);
  const settle = (reason: HomeV2CameraSettleReason) => {
    if (reason !== "superseded") markCameraState(target, "idle");
    request.onSettle?.(reason);
  };

  if (!(duration > 0)) {
    // Reduced motion and Off mode land immediately. A zero-duration command is
    // complete before it returns, so it never becomes the active command.
    gsap.set(target, values);
    publishCameraFrame(target);
    settle("complete");
    return () => {};
  }

  markCameraState(target, "moving");
  const command: ActiveCommand = { id, settle, tween: null };
  command.tween = gsap.to(target, {
    ...values,
    duration,
    ease,
    overwrite: "auto",
    onStart: () => publishCameraFrame(target),
    onUpdate: () => publishCameraFrame(target),
    onComplete: () => {
      publishCameraFrame(target);
      releaseCommand(command);
      settle("complete");
    },
  });
  activeCommand = command;

  return () => {
    const current = activeCommand;
    if (!current || current.id !== id) return;
    activeCommand = null;
    current.tween?.kill();
    settle("cancelled");
  };
}
