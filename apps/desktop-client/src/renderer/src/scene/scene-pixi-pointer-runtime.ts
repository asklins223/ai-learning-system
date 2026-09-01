import {
  createScenePointerRuntime,
  type ScenePointerRuntime,
  type ScenePointerRuntimeOptions,
  type ScenePointerVisibilityTarget,
} from "./scene-pointer-runtime";
import type { ScenePixiParallaxInput } from "./scene-depth-pixi-motion";

export type ScenePixiVisibilityTarget = ScenePointerVisibilityTarget;

export type ScenePixiPointerRuntimeOptions = Omit<ScenePointerRuntimeOptions, "onPointer"> & Readonly<{
  /** Existing Application.updatePointer() or an equivalent presentation sink. */
  readonly onPointer: (input: ScenePixiParallaxInput | null) => unknown;
}>;

export type ScenePixiPointerRuntime = ScenePointerRuntime;

/** Backwards-compatible Pixi adapter over the shared DOM pointer runtime. */
export function createScenePixiPointerRuntime(
  options: ScenePixiPointerRuntimeOptions,
): ScenePixiPointerRuntime {
  return createScenePointerRuntime({
    ...options,
    onPointer: (input) => options.onPointer(input as ScenePixiParallaxInput | null),
  });
}
