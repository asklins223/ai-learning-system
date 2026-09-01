import { Container, Matrix } from "pixi.js";
import { isValidSceneCameraMatrix, type SceneCameraMatrix } from "./scene-camera";

export type SceneCameraPixiRig = Readonly<{
  /** Container that owns the world-space scene subtree. */
  readonly root: Container;
  /** Apply one validated world → camera-viewport affine transform. */
  apply(matrix: SceneCameraMatrix): boolean;
  /** Reset the transform and hide the rig until the next valid apply. */
  clear(): void;
  /** Detach and destroy the rig and its child scene graph. */
  destroy(): void;
}>;

function hideRig(root: Container): void {
  try {
    root.visible = false;
  } catch {
    // A damaged Pixi node must not leak an exception through the adapter.
  }
  try {
    root.renderable = false;
  } catch {
    // Keep the visibility boundary best-effort if the node is already broken.
  }
}

function resetRig(root: Container): void {
  try {
    root.setFromMatrix(new Matrix());
    root.updateLocalTransform();
  } catch {
    // Clearing remains fail-closed even when the transform graph is broken.
  }
  hideRig(root);
}

function releaseRig(root: Container): void {
  try {
    root.removeFromParent();
  } catch {
    // Continue to destroy the owned scene graph after a malformed parent link.
  }
  if (root.destroyed) return;
  try {
    // Child textures remain caller-owned/shared resources.
    root.destroy({ children: true });
  } catch {
    // One broken rig must not abort host teardown or make destroy non-idempotent.
  }
}

/**
 * Adapt the pure scene camera contract to a Pixi Container.
 *
 * The rig is deliberately update-driven: callers decide when a camera frame
 * changes, while Pixi owns the actual local transform for every world child.
 * Invalid matrices hide the whole subtree so a stale camera cannot remain
 * visible. Child textures are intentionally not destroyed here because they
 * may be shared by the supplied scene node factories.
 */
export function createSceneCameraPixiRig(options: Readonly<{
  parent: Container;
  label?: string;
}>): SceneCameraPixiRig {
  const root = new Container({
    label: options.label ?? "scene-camera-rig",
    eventMode: "none",
    interactiveChildren: false,
    visible: false,
    renderable: false,
  });
  let destroyed = false;

  options.parent.addChild(root);

  return {
    root,
    apply(matrix) {
      let valid = false;
      try {
        valid = isValidSceneCameraMatrix(matrix);
      } catch {
        valid = false;
      }
      if (destroyed || !valid) {
        if (!destroyed) hideRig(root);
        return false;
      }

      try {
        root.setFromMatrix(new Matrix(
          matrix.a,
          matrix.b,
          matrix.c,
          matrix.d,
          matrix.tx,
          matrix.ty,
        ));
        // `setFromMatrix()` decomposes into observable properties; refresh the
        // cached local matrix so an explicit update is immediately inspectable.
        root.updateLocalTransform();
        root.visible = true;
        root.renderable = true;
        return true;
      } catch {
        hideRig(root);
        return false;
      }
    },
    clear() {
      if (destroyed) return;
      resetRig(root);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseRig(root);
    },
  };
}
