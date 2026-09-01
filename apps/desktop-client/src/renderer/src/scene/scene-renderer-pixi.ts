import { Container } from "pixi.js";
import {
  createSceneAnchorPixiProjectionRuntime,
  type SceneAnchorPixiCoordinateSpace,
  type SceneAnchorPixiNodeFactory,
  type SceneAnchorPixiProjectionRuntime,
} from "./scene-anchor-pixi";
import {
  isValidSceneProjectionFrame,
  projectSceneAnchorRegistry,
  type SceneProjectionFrame,
} from "./scene-anchor-projection";
import { createSceneCameraPixiRig, type SceneCameraPixiRig } from "./scene-camera-pixi";
import {
  createSceneProjectionFrame,
  type SceneProjectionFrameInput,
} from "./scene-renderer-frame";
import {
  createScenePixiDepthLayers,
  type ScenePixiDepthLayers,
} from "./scene-depth-pixi";
import {
  createScenePixiParallaxController,
  type ScenePixiParallaxController,
  type ScenePixiParallaxInput,
} from "./scene-depth-pixi-motion";
import {
  createScenePixiNodeRegistry,
  type ScenePixiNodeRegistry,
} from "./scene-node-pixi";
import type { SceneAnchor } from "./scene-depth";

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // A broken child must not prevent the rest of the renderer graph from
    // reaching its own cleanup boundary.
  }
}

function releaseContainer(root: Container): void {
  safeCall(() => root.removeFromParent());
  if (root.destroyed) return;
  safeCall(() => root.destroy({ children: true }));
}

export type ScenePixiRendererHost = Readonly<{
  /** Root attached to the caller-owned Pixi stage. */
  readonly root: Container;
  /** World subtree; add renderer-owned scene layers below this container. */
  readonly cameraRoot: Container;
  /** Ordered D0 → D6 containers below the camera root. */
  readonly depthRoot: Container;
  readonly depthLayers: ScenePixiDepthLayers["layers"];
  readonly depthOrder: ScenePixiDepthLayers["order"];
  readonly depthOrderSignature: string;
  /** Reassert the D0 → D6 root order before a presentation commit/render. */
  ensureDepthOrder(): boolean;
  /** Read the current D0 → D6 order without mutating it. */
  isDepthOrderIntact(): boolean;
  /** Explicit scene-node lifecycle at the D0-D6 boundary. */
  readonly nodeRegistry: ScenePixiNodeRegistry;
  /** Apply bounded mouse/pen parallax to the registered depth layers. */
  updatePointer(input: ScenePixiParallaxInput | null | undefined): boolean;
  /** Anchor subtree, either below cameraRoot or beside it per coordinateSpace. */
  readonly anchorRoot: Container;
  readonly anchorCoordinateSpace: SceneAnchorPixiCoordinateSpace;
  /** Apply one complete frame; false hides and clears on invalid input. */
  update(frame: SceneProjectionFrame): boolean;
  /** Build and apply one complete frame from the shared viewport contract. */
  updateViewport(input: SceneProjectionFrameInput): boolean;
  /** Hide the world and release the current anchor batch. */
  clear(): void;
  /** Detach and destroy the complete host-owned scene graph. */
  destroy(): void;
}>;

/**
 * Compose the Pixi camera rig and AnchorRegistry sink behind one frame gate.
 *
 * This is an explicit scene-graph adapter, not an Application or ticker. The
 * caller owns the renderer lifecycle and invokes `update()` when the shared
 * camera/frame contract changes. The default world anchor mode keeps anchor
 * nodes under the camera root; use `viewport` only for a sibling overlay.
 */
export function createScenePixiRendererHost(options: Readonly<{
  parent: Container;
  registry: Readonly<Record<string, SceneAnchor>>;
  createAnchorNode?: SceneAnchorPixiNodeFactory;
  anchorCoordinateSpace?: SceneAnchorPixiCoordinateSpace;
  label?: string;
}>): ScenePixiRendererHost {
  const label = options.label ?? "scene-renderer";
  const anchorCoordinateSpace = options.anchorCoordinateSpace ?? "world";
  const root = new Container({
    label,
    eventMode: "none",
    interactiveChildren: false,
  });
  const cameraRig: SceneCameraPixiRig = createSceneCameraPixiRig({
    parent: root,
    label: `${label}:camera`,
  });
  const depthLayers: ScenePixiDepthLayers = createScenePixiDepthLayers({
    parent: cameraRig.root,
    label: `${label}:depth`,
  });
  const nodeRegistry: ScenePixiNodeRegistry = createScenePixiNodeRegistry(depthLayers.layers);
  const parallax: ScenePixiParallaxController = createScenePixiParallaxController(depthLayers.layers);
  const anchorRuntime: SceneAnchorPixiProjectionRuntime = createSceneAnchorPixiProjectionRuntime({
    parent: anchorCoordinateSpace === "world" ? cameraRig.root : root,
    registry: options.registry,
    createNode: options.createAnchorNode,
    label: `${label}:anchors`,
    coordinateSpace: anchorCoordinateSpace,
  });
  let destroyed = false;

  const releaseOwnedGraph = (): void => {
    safeCall(() => parallax.destroy());
    safeCall(() => anchorRuntime.destroy());
    safeCall(() => nodeRegistry.destroy());
    safeCall(() => depthLayers.destroy());
    safeCall(() => cameraRig.destroy());
    releaseContainer(root);
  };

  try {
    options.parent.addChild(root);
  } catch (error) {
    destroyed = true;
    releaseOwnedGraph();
    throw error;
  }

  const clear = (): void => {
    if (destroyed) return;
    safeCall(() => cameraRig.clear());
    safeCall(() => anchorRuntime.clear());
    safeCall(() => nodeRegistry.clearProjection());
    safeCall(() => parallax.clear());
  };

  const ensureDepthOrder = (): boolean => {
    if (destroyed) return false;
    try {
      return depthLayers.ensureOrder();
    } catch {
      return false;
    }
  };

  const isDepthOrderIntact = (): boolean => {
    if (destroyed) return false;
    try {
      return depthLayers.isOrderIntact();
    } catch {
      return false;
    }
  };

  const update = (frame: SceneProjectionFrame): boolean => {
    if (destroyed) return false;
    try {
      if (!ensureDepthOrder()) {
        clear();
        return false;
      }
      if (!isValidSceneProjectionFrame(frame)) {
        clear();
        return false;
      }
      if (!cameraRig.apply(frame.cameraMatrix)) {
        clear();
        return false;
      }
      const projections = projectSceneAnchorRegistry(options.registry, frame);
      if (!nodeRegistry.updateAnchors(projections)) {
        clear();
        return false;
      }
      anchorRuntime.updateProjections(projections);
      return true;
    } catch {
      clear();
      return false;
    }
  };

  const updateViewport = (input: SceneProjectionFrameInput): boolean => {
    if (destroyed) return false;
    try {
      const frame = createSceneProjectionFrame(input);
      if (!frame) {
        clear();
        return false;
      }
      return update(frame);
    } catch {
      clear();
      return false;
    }
  };

  return {
    root,
    cameraRoot: cameraRig.root,
    depthRoot: depthLayers.root,
    depthLayers: depthLayers.layers,
    depthOrder: depthLayers.order,
    depthOrderSignature: depthLayers.orderSignature,
    ensureDepthOrder,
    isDepthOrderIntact,
    nodeRegistry,
    anchorRoot: anchorRuntime.root,
    anchorCoordinateSpace,
    update,
    updateViewport,
    updatePointer(input) {
      if (destroyed) return false;
      try {
        if (!ensureDepthOrder()) {
          clear();
          return false;
        }
        return parallax.update(input);
      } catch {
        safeCall(() => parallax.clear());
        return false;
      }
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseOwnedGraph();
    },
  };
}
