import { Container } from "pixi.js";
import {
  SCENE_DEPTH_BANDS,
  type SceneDepthBandId,
} from "./scene-depth";

/** Canonical render order for the Pixi D0 → D6 carrier. */
export const SCENE_PIXI_DEPTH_ORDER = Object.freeze(
  SCENE_DEPTH_BANDS.map((band) => band.id),
);

/** Stable diagnostic signature shared by renderer and capture evidence. */
export const SCENE_PIXI_DEPTH_ORDER_SIGNATURE = SCENE_PIXI_DEPTH_ORDER.join(">");

export type ScenePixiDepthLayers = Readonly<{
  /** Root containing the ordered D0 → D6 layer containers. */
  readonly root: Container;
  /** Stable layer lookup; callers add visual children to these containers. */
  readonly layers: Readonly<Record<SceneDepthBandId, Container>>;
  /** Immutable D0 → D6 order used by the root sorter. */
  readonly order: readonly SceneDepthBandId[];
  readonly orderSignature: string;
  /** Read the order contract without changing the scene graph. */
  isOrderIntact(): boolean;
  /** Restore sortable ordering when only order metadata drifted. */
  ensureOrder(): boolean;
  get(id: SceneDepthBandId): Container;
  destroy(): void;
}>;

/**
 * Create the Pixi counterpart of the V1 D0–D6 carrier contract.
 *
 * The root owns render order, while each band owns only its local children.
 * All interaction remains DOM-canonical, so the Pixi subtree is explicitly
 * non-interactive. The layer registry does not load or destroy textures; those
 * resources remain owned by the scene node factory that supplies them.
 */
export function createScenePixiDepthLayers(options: Readonly<{
  parent: Container;
  label?: string;
}>): ScenePixiDepthLayers {
  const label = options.label ?? "scene-depth";
  const root = new Container({
    label,
    eventMode: "none",
    interactiveChildren: false,
    sortableChildren: true,
  });
  const layers = {} as Record<SceneDepthBandId, Container>;
  let destroyed = false;

  SCENE_DEPTH_BANDS.forEach((band, index) => {
    const layer = new Container({
      label: `${label}:${band.id}`,
      eventMode: "none",
      interactiveChildren: false,
      sortableChildren: true,
      zIndex: index,
    });
    layers[band.id] = layer;
    root.addChild(layer);
  });
  options.parent.addChild(root);

  const isOrderIntact = (): boolean => {
    if (destroyed || root.destroyed || !root.parent || !root.sortableChildren) return false;
    if (root.children.length !== SCENE_PIXI_DEPTH_ORDER.length) return false;

    return SCENE_PIXI_DEPTH_ORDER.every((id, index) => {
      const layer = layers[id];
      return Boolean(layer)
        && !layer.destroyed
        && layer.parent === root
        && layer.sortableChildren
        && root.children[index] === layer
        && layer.zIndex === index;
    });
  };

  const ensureOrder = (): boolean => {
    if (destroyed || root.destroyed || !root.parent) return false;

    try {
      if (root.children.length !== SCENE_PIXI_DEPTH_ORDER.length) return false;
      for (const id of SCENE_PIXI_DEPTH_ORDER) {
        const layer = layers[id];
        if (!layer || layer.destroyed || layer.parent !== root) return false;
      }

      // zIndex is the only supported ordering input. Reassert it before the
      // explicit sort so an external setChildIndex/zIndex mutation cannot
      // leak into the next presentation frame.
      root.sortableChildren = true;
      SCENE_PIXI_DEPTH_ORDER.forEach((id, index) => {
        layers[id].sortableChildren = true;
        layers[id].zIndex = index;
        layers[id].sortChildren();
      });
      root.sortChildren();
      return isOrderIntact();
    } catch {
      return false;
    }
  };

  return {
    root,
    layers: Object.freeze(layers),
    order: SCENE_PIXI_DEPTH_ORDER,
    orderSignature: SCENE_PIXI_DEPTH_ORDER_SIGNATURE,
    isOrderIntact,
    ensureOrder,
    get(id) {
      return layers[id];
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeFromParent();
      root.destroy({ children: true });
    },
  };
}
