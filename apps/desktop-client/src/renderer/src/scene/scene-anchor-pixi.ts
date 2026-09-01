import { Container } from "pixi.js";
import {
  createSceneAnchorProjectionRuntime,
  type SceneAnchorProjectionRuntime,
  type SceneAnchorProjectionSink,
} from "./scene-anchor-runtime";
import type { SceneAnchor } from "./scene-depth";
import type { SceneAnchorProjection, SceneProjectionFrame } from "./scene-anchor-projection";

export type SceneAnchorPixiNodeFactory = (projection: SceneAnchorProjection) => Container;

/**
 * `viewport` is for a sibling overlay whose parent already represents the
 * camera viewport. `world` is for a layer nested below SceneCameraPixiRig.
 */
export type SceneAnchorPixiCoordinateSpace = "viewport" | "world";

export type SceneAnchorPixiLayer = Readonly<{
  readonly root: Container;
  readonly sink: SceneAnchorProjectionSink;
  destroy(): void;
}>;

export type SceneAnchorPixiProjectionRuntime = SceneAnchorProjectionRuntime & Readonly<{
  readonly root: Container;
}>;

function defaultNodeFactory(): Container {
  return new Container();
}

function releaseNode(node: Container): void {
  try {
    node.removeFromParent();
  } catch {
    // Keep trying to release the node even if its parent link is malformed.
  }
  if (node.destroyed) return;
  try {
    // Anchor nodes may reference caller-owned/shared textures.
    node.destroy({ children: true });
  } catch {
    // One broken node must not abort the rest of the scene teardown.
  }
}

function hideNode(node: Container): boolean {
  if (node.destroyed) return false;
  try {
    node.visible = false;
    node.renderable = false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a non-interactive Pixi layer that owns anchor display containers.
 * Nodes are recycled between projection batches; the layer owns the nodes,
 * while their textures remain the responsibility of the supplied factory.
 */
export function createSceneAnchorPixiLayer(options: Readonly<{
  parent: Container;
  createNode?: SceneAnchorPixiNodeFactory;
  label?: string;
  coordinateSpace?: SceneAnchorPixiCoordinateSpace;
}>): SceneAnchorPixiLayer {
  const root = new Container({
    label: options.label ?? "scene-anchor-layer",
    eventMode: "none",
    interactiveChildren: false,
  });
  const createNode = options.createNode ?? defaultNodeFactory;
  const coordinateSpace = options.coordinateSpace ?? "viewport";
  const nodes = new Map<string, Container>();
  let destroyed = false;

  options.parent.addChild(root);

  const sink: SceneAnchorProjectionSink = (projections) => {
    if (destroyed) return;

    for (const [id, node] of nodes) {
      if (hideNode(node)) continue;
      nodes.delete(id);
      releaseNode(node);
    }

    for (const projection of projections) {
      let node = nodes.get(projection.id);
      if (!node) {
        let createdNode: Container | null = null;
        try {
          createdNode = createNode(projection);
          if (!createdNode || createdNode.destroyed) continue;
          createdNode.label = `scene-anchor:${projection.id}`;
          createdNode.eventMode = "none";
          createdNode.interactiveChildren = false;
          root.addChild(createdNode);
          nodes.set(projection.id, createdNode);
          node = createdNode;
        } catch {
          if (createdNode) releaseNode(createdNode);
          continue;
        }
      }

      try {
        const point = coordinateSpace === "world"
          ? projection.worldPoint
          : projection.viewportPoint;
        node.position.set(point[0], point[1]);
        node.visible = projection.visible;
        node.renderable = projection.visible;
      } catch {
        nodes.delete(projection.id);
        releaseNode(node);
      }
    }
  };

  return {
    root,
    sink,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      nodes.clear();
      root.removeFromParent();
      root.destroy({ children: true });
    },
  };
}

/** Compose the pure projection runtime with an owned Pixi scene graph. */
export function createSceneAnchorPixiProjectionRuntime(options: Readonly<{
  parent: Container;
  registry: Readonly<Record<string, SceneAnchor>>;
  createNode?: SceneAnchorPixiNodeFactory;
  label?: string;
  coordinateSpace?: SceneAnchorPixiCoordinateSpace;
}>): SceneAnchorPixiProjectionRuntime {
  const layer = createSceneAnchorPixiLayer(options);
  const projectionRuntime = createSceneAnchorProjectionRuntime({
    registry: options.registry,
    sink: layer.sink,
  });

  return {
    root: layer.root,
    update(frame: SceneProjectionFrame) {
      return projectionRuntime.update(frame);
    },
    updateProjections(projections) {
      return projectionRuntime.updateProjections(projections);
    },
    clear() {
      return projectionRuntime.clear();
    },
    destroy() {
      projectionRuntime.destroy();
      layer.destroy();
    },
  };
}
