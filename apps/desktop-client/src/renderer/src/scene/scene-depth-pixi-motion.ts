import type { ScenePoint } from "./scene-geometry";
import { SCENE_DEPTH_BANDS, type SceneDepthBandId } from "./scene-depth";
import type { SceneFrameBounds } from "./scene-input";
import { scenePointerOffset } from "./scene-foreground";
import type { ScenePixiDepthLayers } from "./scene-depth-pixi";

export type ScenePixiParallaxInput = Readonly<{
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType?: string;
  readonly frameBounds: SceneFrameBounds;
  /** Caller supplies the already-resolved Full/active scene policy. */
  readonly enabled: boolean;
}>;

export type SceneDepthPointerOffsets = Readonly<Record<SceneDepthBandId, ScenePoint>>;

export type ScenePixiParallaxController = Readonly<{
  readonly update: (input: ScenePixiParallaxInput | null | undefined) => boolean;
  readonly clear: () => void;
  readonly destroy: () => void;
}>;

function zeroOffset(): ScenePoint {
  return Object.freeze([0, 0]) as unknown as ScenePoint;
}

function zeroOffsets(): SceneDepthPointerOffsets {
  const offsets = {} as Record<SceneDepthBandId, ScenePoint>;
  for (const band of SCENE_DEPTH_BANDS) offsets[band.id] = zeroOffset();
  return Object.freeze(offsets);
}

function isValidFrameBounds(bounds: SceneFrameBounds | null | undefined): boolean {
  return Boolean(bounds)
    && [bounds!.left, bounds!.top, bounds!.width, bounds!.height].every(Number.isFinite)
    && bounds!.width > 0
    && bounds!.height > 0;
}

function canUsePointer(input: ScenePixiParallaxInput | null | undefined): input is ScenePixiParallaxInput {
  if (!input || typeof input !== "object") return false;
  return input.enabled
    && (!input.pointerType || input.pointerType === "mouse" || input.pointerType === "pen")
    && Number.isFinite(input.clientX)
    && Number.isFinite(input.clientY)
    && isValidFrameBounds(input.frameBounds);
}

/**
 * Convert one client pointer into the same bounded per-band offset budget as
 * the DOM depth carriers. Touch and invalid input stay neutral rather than
 * synthesizing motion from an unreliable coordinate space.
 */
export function sceneDepthPointerOffsets(
  input: ScenePixiParallaxInput | null | undefined,
): SceneDepthPointerOffsets {
  if (!canUsePointer(input)) return zeroOffsets();

  const offsets = {} as Record<SceneDepthBandId, ScenePoint>;
  for (const band of SCENE_DEPTH_BANDS) {
    offsets[band.id] = Object.freeze(scenePointerOffset({
      clientX: input.clientX,
      clientY: input.clientY,
      pointerType: input.pointerType,
      frameBounds: input.frameBounds,
      maxOffsetX: band.maxOffsetX,
      maxOffsetY: band.maxOffsetY,
    })) as unknown as ScenePoint;
  }
  return Object.freeze(offsets);
}

/** Apply the pure offset contract to caller-owned depth layer containers. */
export function createScenePixiParallaxController(
  layers: ScenePixiDepthLayers["layers"],
): ScenePixiParallaxController {
  let destroyed = false;

  const apply = (offsets: SceneDepthPointerOffsets): boolean => {
    let applied = true;
    for (const band of SCENE_DEPTH_BANDS) {
      const layer = layers[band.id];
      const [x, y] = offsets[band.id];
      if (layer.destroyed) {
        applied = false;
        continue;
      }
      try {
        layer.position.set(x, y);
      } catch {
        applied = false;
      }
    }
    return applied;
  };

  return {
    update(input) {
      if (destroyed) return false;
      try {
        if (!canUsePointer(input)) {
          apply(zeroOffsets());
          return false;
        }
        return apply(sceneDepthPointerOffsets(input));
      } catch {
        // Treat hostile/malformed runtime input as inactive and neutralize
        // any offset left by the preceding valid pointer frame.
        try {
          apply(zeroOffsets());
        } catch {
          // Keep the host boundary closed if the layer registry is also broken.
        }
        return false;
      }
    },
    clear() {
      if (destroyed) return;
      apply(zeroOffsets());
    },
    destroy() {
      destroyed = true;
    },
  };
}
