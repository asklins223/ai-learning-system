import { Container, Sprite, type Texture } from "pixi.js";
import type { ScenePoint } from "./scene-geometry";
import {
  isValidSceneDepthChildOrder,
  type SceneDepthBandId,
} from "./scene-depth";
import type { ScenePixiDepthLayers } from "./scene-depth-pixi";
import {
  isValidSceneAnchorProjectionBatch,
  type SceneAnchorProjection,
} from "./scene-anchor-projection";

export type ScenePixiNodeMountInput = Readonly<{
  /** Stable identity used for replacement and teardown. */
  readonly id: string;
  /** The only depth band the node may be mounted into. */
  readonly depth: SceneDepthBandId;
  /** Stable ascending order within the selected depth band. */
  readonly order: number;
  /** Anchor id whose world point drives this node; defaults to `id`; `null` keeps a static node visible. */
  readonly anchorId?: string | null;
  /** A caller-created Pixi display node. The registry owns this node after mount. */
  readonly node: Container;
}>;

export type ScenePixiTextureNodeOptions = Readonly<{
  /** Shared texture supplied by the caller; this factory never loads or destroys it. */
  readonly texture: Texture;
  readonly label?: string;
  readonly position?: ScenePoint;
  /** Normalized texture anchor; accepts one value or an [x, y] pair. */
  readonly anchor?: number | ScenePoint;
  /** Optional canonical-world size. Omit to preserve the texture's native size. */
  readonly size?: Readonly<{ width: number; height: number }>;
  readonly alpha?: number;
  readonly visible?: boolean;
}>;

export type ScenePixiNodeRegistry = Readonly<{
  /** Mount a node into one D0-D6 layer; malformed or duplicate-node input is rejected. */
  readonly mount: (input: ScenePixiNodeMountInput | null | undefined) => boolean;
  readonly get: (id: string) => Container | null;
  /** Apply the already-projected world anchor batch to bound depth nodes. */
  readonly updateAnchors: (projections: readonly SceneAnchorProjection[] | null | undefined) => boolean;
  /** Hide bound nodes without releasing their display objects. */
  readonly clearProjection: () => void;
  /** Remove and destroy the mounted display node, while leaving its texture caller-owned. */
  readonly unmount: (id: string) => boolean;
  readonly clear: () => void;
  readonly destroy: () => void;
}>;

type ScenePixiNodeEntry = Readonly<{
  readonly anchorId: string | null;
  readonly depth: SceneDepthBandId;
  readonly order: number;
  readonly node: Container;
}>;

function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}

function isFinitePoint(point: unknown): point is ScenePoint {
  return Array.isArray(point)
    && point.length === 2
    && point.every(Number.isFinite);
}

function releaseNode(node: Container): void {
  try {
    node.removeFromParent();
  } catch {
    // Continue to the destroy attempt; a malformed parent link must not block
    // cleanup of the registry's remaining nodes.
  }
  if (node.destroyed) return;
  try {
    // Deliberately omit texture/textureSource: scene nodes may use shared assets.
    node.destroy({ children: true });
  } catch {
    // The entry is already being discarded; do not let one broken node abort
    // the caller's batch or the rest of the scene teardown.
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
 * Own the display-node lifecycle at the D0-D6 boundary.
 *
 * The registry owns mounted display nodes, but never owns the textures those
 * nodes reference. It also keeps the Pixi subtree presentation-only: DOM
 * remains the interaction and accessibility authority.
 */
export function createScenePixiNodeRegistry(
  layers: ScenePixiDepthLayers["layers"],
): ScenePixiNodeRegistry {
  const entries = new Map<string, ScenePixiNodeEntry>();
  let destroyed = false;

  const clear = (): void => {
    if (destroyed) return;
    for (const entry of entries.values()) releaseNode(entry.node);
    entries.clear();
  };

  const clearProjection = (): void => {
    if (destroyed) return;
    for (const [id, entry] of entries) {
      if (entry.anchorId === null) continue;
      if (hideNode(entry.node)) continue;
      entries.delete(id);
      releaseNode(entry.node);
    }
  };

  return {
    mount(input) {
      if (
        destroyed
        || !input
        || !isValidId(input.id)
        || !isValidSceneDepthChildOrder(input.order)
        || (input.anchorId !== undefined && input.anchorId !== null && !isValidId(input.anchorId))
        || !input.node
        || input.node.destroyed
      ) {
        return false;
      }

      const target = layers[input.depth];
      if (!target || target.destroyed || !target.parent || !target.sortableChildren) return false;

      for (const [id, entry] of entries) {
        if (id !== input.id && entry.node === input.node) return false;
        if (id !== input.id && entry.depth === input.depth && entry.order === input.order) return false;
      }

      const existing = entries.get(input.id);
      try {
        if (existing?.node !== input.node) {
          if (existing) releaseNode(existing.node);
        } else {
          input.node.removeFromParent();
        }

        input.node.eventMode = "none";
        input.node.interactiveChildren = false;
        input.node.zIndex = input.order;
        const anchorId = input.anchorId === null ? null : input.anchorId ?? input.id;
        input.node.visible = anchorId === null;
        input.node.renderable = anchorId === null;
        target.addChild(input.node);
        target.sortChildren();
        entries.set(input.id, {
          anchorId,
          depth: input.depth,
          order: input.order,
          node: input.node,
        });
        return true;
      } catch {
        entries.delete(input.id);
        return false;
      }
    },
    get(id) {
      if (destroyed || !isValidId(id)) return null;
      return entries.get(id)?.node ?? null;
    },
    updateAnchors(projections) {
      if (destroyed) return false;
      clearProjection();
      if (!isValidSceneAnchorProjectionBatch(projections)) return false;

      for (const projection of projections) {
        for (const [id, entry] of entries) {
          if (entry.anchorId !== projection.id) continue;
          if (entry.node.destroyed) {
            entries.delete(id);
            releaseNode(entry.node);
            continue;
          }
          try {
            entry.node.position.set(projection.worldPoint[0], projection.worldPoint[1]);
            entry.node.visible = projection.visible;
            entry.node.renderable = projection.visible;
          } catch {
            entries.delete(id);
            releaseNode(entry.node);
          }
        }
      }
      return true;
    },
    clearProjection,
    unmount(id) {
      if (destroyed || !isValidId(id)) return false;
      const entry = entries.get(id);
      if (!entry) return false;
      entries.delete(id);
      releaseNode(entry.node);
      return true;
    },
    clear,
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
    },
  };
}

/**
 * Create a presentation-only Sprite for an approved/shared texture.
 *
 * Loading and texture lifetime stay outside this helper. Destroying the
 * resulting node therefore cannot invalidate a texture shared by other nodes.
 */
export function createScenePixiTextureNode(
  options: ScenePixiTextureNodeOptions,
): Sprite {
  const node = new Sprite({ texture: options.texture });
  node.label = options.label ?? "scene-texture-node";
  node.eventMode = "none";
  node.interactiveChildren = false;
  if (options.anchor === undefined) node.anchor.set(0);
  else if (typeof options.anchor === "number") node.anchor.set(options.anchor);
  else node.anchor.set(options.anchor[0], options.anchor[1]);

  if (options.position) node.position.set(options.position[0], options.position[1]);
  if (
    options.size
    && Number.isFinite(options.size.width)
    && Number.isFinite(options.size.height)
    && options.size.width > 0
    && options.size.height > 0
  ) {
    node.setSize(options.size.width, options.size.height);
  }
  if (options.alpha !== undefined && Number.isFinite(options.alpha)) node.alpha = options.alpha;
  if (options.visible !== undefined) node.visible = options.visible;

  return node;
}
