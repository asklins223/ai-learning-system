import {
  isValidSceneAnchorProjectionBatch,
  projectSceneAnchorRegistry,
  type SceneAnchorProjection,
  type SceneProjectionFrame,
} from "./scene-anchor-projection";
import type { SceneAnchor } from "./scene-depth";

const EMPTY_PROJECTIONS: readonly SceneAnchorProjection[] = Object.freeze([]);

export type SceneAnchorProjectionSink = (projections: readonly SceneAnchorProjection[]) => void;

export type SceneAnchorProjectionRuntime = Readonly<{
  /** Publish a changed projection batch; returns whether the sink was called. */
  update(frame: SceneProjectionFrame): boolean;
  /** Publish a caller-prepared batch without recomputing the projection. */
  updateProjections(projections: readonly SceneAnchorProjection[] | null | undefined): boolean;
  /** Clear a previously published batch; returns whether the sink was called. */
  clear(): boolean;
  /** Clear the sink once and disable all later updates. */
  destroy(): void;
}>;

function projectionFingerprint(projections: readonly SceneAnchorProjection[]): string {
  return JSON.stringify(projections);
}

/**
 * Adapt the pure AnchorRegistry projection bridge to a renderer-owned sink.
 * The runtime has no React, DOM, or Pixi ownership; callers provide the sink
 * that knows how to update and release their renderer objects.
 */
export function createSceneAnchorProjectionRuntime(options: Readonly<{
  registry: Readonly<Record<string, SceneAnchor>>;
  sink: SceneAnchorProjectionSink;
}>): SceneAnchorProjectionRuntime {
  let active = true;
  let lastFingerprint: string | null = null;

  const publish = (projections: readonly SceneAnchorProjection[]): boolean => {
    let fingerprint: string;
    try {
      fingerprint = projectionFingerprint(projections);
    } catch {
      // A malformed/cyclic caller batch must not escape through the renderer
      // boundary or poison the last successfully committed frame.
      return false;
    }
    if (fingerprint === lastFingerprint) return false;

    try {
      options.sink(projections);
    } catch {
      // Keep the old fingerprint so the caller can retry the same frame. The
      // sink owns its own partial-cleanup policy; this adapter only reports
      // that the commit did not complete.
      return false;
    }
    lastFingerprint = fingerprint;
    return true;
  };

  return {
    update(frame) {
      if (!active) return false;
      return publish(projectSceneAnchorRegistry(options.registry, frame));
    },
    updateProjections(projections) {
      if (!active) return false;
      return publish(
        isValidSceneAnchorProjectionBatch(projections) ? projections : EMPTY_PROJECTIONS,
      );
    },
    clear() {
      if (!active || lastFingerprint === null || lastFingerprint === projectionFingerprint(EMPTY_PROJECTIONS)) {
        return false;
      }
      return publish(EMPTY_PROJECTIONS);
    },
    destroy() {
      if (!active) return;
      try {
        publish(EMPTY_PROJECTIONS);
      } finally {
        active = false;
      }
    },
  };
}
