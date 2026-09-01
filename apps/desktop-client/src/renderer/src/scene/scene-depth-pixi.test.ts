import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { SCENE_DEPTH_BANDS } from "./scene-depth";
import {
  createScenePixiDepthLayers,
  SCENE_PIXI_DEPTH_ORDER_SIGNATURE,
} from "./scene-depth-pixi";

describe("scene Pixi depth layers", () => {
  it("creates one non-interactive ordered container for every D0-D6 band", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent, label: "room-depth" });

    expect(parent.children).toEqual([depth.root]);
    expect(depth.root.eventMode).toBe("none");
    expect(depth.root.interactiveChildren).toBe(false);
    expect(depth.root.sortableChildren).toBe(true);
    expect(depth.root.children.map((child) => child.label)).toEqual(
      SCENE_DEPTH_BANDS.map((band) => `room-depth:${band.id}`),
    );
    expect(depth.root.children.map((child) => child.zIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(depth.order).toEqual(SCENE_DEPTH_BANDS.map((band) => band.id));
    expect(depth.orderSignature).toBe(SCENE_PIXI_DEPTH_ORDER_SIGNATURE);
    expect(depth.isOrderIntact()).toBe(true);

    for (const band of SCENE_DEPTH_BANDS) {
      const layer = depth.get(band.id);
      expect(layer).toBe(depth.layers[band.id]);
      expect(layer.parent).toBe(depth.root);
      expect(layer.eventMode).toBe("none");
      expect(layer.interactiveChildren).toBe(false);
      expect(layer.sortableChildren).toBe(true);
    }

    depth.destroy();
    expect(parent.children).toHaveLength(0);
    expect(depth.root.destroyed).toBe(true);
    depth.destroy();
  });

  it("repairs child-index, zIndex, and sortableChildren drift before a frame", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });

    depth.root.setChildIndex(depth.layers.D6, 0);
    depth.layers.D6.zIndex = 99;
    depth.root.sortableChildren = false;
    depth.layers.D4.sortableChildren = false;

    expect(depth.isOrderIntact()).toBe(false);
    expect(depth.ensureOrder()).toBe(true);
    expect(depth.isOrderIntact()).toBe(true);
    expect(depth.root.sortableChildren).toBe(true);
    expect(depth.layers.D4.sortableChildren).toBe(true);
    expect(depth.root.children.map((child) => child.label)).toEqual(
      SCENE_DEPTH_BANDS.map((band) => `scene-depth:${band.id}`),
    );
    expect(depth.root.children.map((child) => child.zIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    depth.destroy();
  });

  it("fails closed when a depth band is removed or an extra child is attached", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });

    depth.root.removeChild(depth.layers.D3);
    expect(depth.isOrderIntact()).toBe(false);
    expect(depth.ensureOrder()).toBe(false);

    depth.root.addChild(depth.layers.D3);
    depth.root.addChild(new Container({ label: "unexpected-depth-child" }));
    expect(depth.ensureOrder()).toBe(false);

    depth.destroy();
  });
});
