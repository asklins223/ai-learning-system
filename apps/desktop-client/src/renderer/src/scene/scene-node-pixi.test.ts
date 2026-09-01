import { Container, Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { projectSceneAnchor } from "./scene-anchor-projection";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { createScenePixiDepthLayers } from "./scene-depth-pixi";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";
import {
  createScenePixiNodeRegistry,
  createScenePixiTextureNode,
} from "./scene-node-pixi";

describe("scene Pixi node registry", () => {
  it("mounts presentation nodes into one depth band and replaces by stable id", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent, label: "node-depth" });
    const registry = createScenePixiNodeRegistry(depth.layers);
    const texture = Texture.WHITE;
    const first = createScenePixiTextureNode({
      texture,
      label: "first-node",
      position: [12, 24],
      anchor: [0.25, 0.75],
      size: { width: 80, height: 40 },
    });
    const second = createScenePixiTextureNode({ texture, label: "second-node" });

    expect(registry.mount({
      id: "notebook-visual",
      anchorId: "room.notebook",
      depth: "D2",
      order: 10,
      node: first,
    })).toBe(true);
    expect(first.parent).toBe(depth.layers.D2);
    expect(first.eventMode).toBe("none");
    expect(first.interactiveChildren).toBe(false);
    expect(first.anchor.x).toBe(0.25);
    expect(first.anchor.y).toBe(0.75);
    expect(first.width).toBe(80);
    expect(first.height).toBe(40);
    expect(first.visible).toBe(false);
    expect(registry.get("notebook-visual")).toBe(first);

    expect(registry.mount({
      id: "notebook-visual",
      anchorId: "room.notebook",
      depth: "D5",
      order: 20,
      node: second,
    })).toBe(true);
    expect(first.destroyed).toBe(true);
    expect(second.parent).toBe(depth.layers.D5);
    expect(registry.get("notebook-visual")).toBe(second);
    expect(texture.destroyed).toBe(false);

    const frame = {
      frameBounds: { left: 120, top: 48, width: 836, height: 470.5 },
      cameraMatrix: sceneCameraMatrixForViewport(
        SCENE_CAMERA_PRESETS.room,
        { width: 1672, height: 941 },
      )!,
    };
    const projection = projectSceneAnchor(ROOM_SCENE_ANCHORS["room.notebook"], frame)!;
    expect(registry.updateAnchors([projection])).toBe(true);
    expect(second.position.x).toBe(ROOM_SCENE_ANCHORS["room.notebook"].point[0]);
    expect(second.position.y).toBe(ROOM_SCENE_ANCHORS["room.notebook"].point[1]);
    expect(second.visible).toBe(true);
    expect(second.renderable).toBe(true);

    expect(registry.updateAnchors([{ ...projection, visible: false }])).toBe(true);
    expect(second.visible).toBe(false);
    expect(second.renderable).toBe(false);
    expect(registry.updateAnchors(null)).toBe(false);
    expect(second.visible).toBe(false);
    expect(registry.updateAnchors([{
      ...projection,
      worldPoint: [Number.NaN, projection.worldPoint[1]],
    }])).toBe(false);
    expect(second.visible).toBe(false);

    expect(registry.unmount("notebook-visual")).toBe(true);
    expect(second.destroyed).toBe(true);
    expect(registry.get("notebook-visual")).toBeNull();
    expect(texture.destroyed).toBe(false);

    registry.destroy();
    depth.destroy();
  });

  it("rejects malformed input and prevents one node from being owned twice", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const registry = createScenePixiNodeRegistry(depth.layers);
    const node = new Container();

    expect(registry.mount(null)).toBe(false);
    expect(registry.mount(undefined)).toBe(false);
    expect(registry.mount({ id: "", depth: "D0", order: 0, node })).toBe(false);
    expect(registry.mount({ id: "node", anchorId: "", depth: "D0", order: 0, node })).toBe(false);
    expect(registry.mount({ id: "node", depth: "unknown" as "D0", order: 0, node })).toBe(false);
    expect(registry.mount({ id: "node", depth: "D0", order: 0, node })).toBe(true);
    expect(registry.mount({ id: "other", depth: "D1", order: 0, node })).toBe(false);
    expect(node.parent).toBe(depth.layers.D0);

    registry.clear();
    expect(node.destroyed).toBe(true);
    expect(registry.unmount("node")).toBe(false);
    expect(registry.updateAnchors([])).toBe(true);

    registry.destroy();
    expect(registry.mount({ id: "after-destroy", depth: "D0", order: 0, node: new Container() })).toBe(false);
    depth.destroy();
  });

  it("sorts same-band nodes by explicit order instead of mount completion order", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const registry = createScenePixiNodeRegistry(depth.layers);
    const nearer = new Container({ label: "nearer" });
    const farther = new Container({ label: "farther" });
    const duplicateOrder = new Container();
    const invalidOrder = new Container();

    expect(registry.mount({ id: "nearer", depth: "D4", order: 20, node: nearer })).toBe(true);
    expect(registry.mount({ id: "farther", depth: "D4", order: 10, node: farther })).toBe(true);
    expect(depth.layers.D4.children).toEqual([farther, nearer]);
    expect(depth.layers.D4.children.map((child) => child.zIndex)).toEqual([10, 20]);
    expect(registry.mount({ id: "duplicate-order", depth: "D4", order: 20, node: duplicateOrder })).toBe(false);
    expect(registry.mount({ id: "invalid-order", depth: "D4", order: -1, node: invalidOrder })).toBe(false);

    duplicateOrder.destroy();
    invalidOrder.destroy();
    registry.destroy();
    depth.destroy();
  });

  it("keeps static presentation nodes visible while anchor projections clear", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const registry = createScenePixiNodeRegistry(depth.layers);
    const staticNode = createScenePixiTextureNode({
      texture: Texture.WHITE,
      position: [80, 60],
      visible: true,
    });

    expect(registry.mount({
      id: "static-foreground",
      anchorId: null,
      depth: "D6",
      order: 0,
      node: staticNode,
    })).toBe(true);
    expect(staticNode.visible).toBe(true);
    expect(staticNode.renderable).toBe(true);
    expect(registry.updateAnchors([])).toBe(true);
    expect(staticNode.visible).toBe(true);
    expect(staticNode.renderable).toBe(true);

    registry.clear();
    expect(staticNode.destroyed).toBe(true);
    registry.destroy();
    depth.destroy();
  });

  it("quarantines destroyed or write-failing nodes without blocking healthy projections", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const registry = createScenePixiNodeRegistry(depth.layers);
    const destroyedNode = new Container();
    const failingNode = new Container();
    const healthyNode = new Container();

    expect(registry.mount({ id: "destroyed", anchorId: "room.notebook", depth: "D2", order: 10, node: destroyedNode })).toBe(true);
    expect(registry.mount({ id: "failing", anchorId: "room.review", depth: "D2", order: 20, node: failingNode })).toBe(true);
    expect(registry.mount({ id: "healthy", anchorId: "room.lamp", depth: "D2", order: 30, node: healthyNode })).toBe(true);

    destroyedNode.destroy();
    const positionSpy = vi.spyOn(failingNode.position, "set").mockImplementation(() => {
      throw new Error("node position unavailable");
    });
    const frame = {
      frameBounds: { left: 120, top: 48, width: 836, height: 470.5 },
      cameraMatrix: sceneCameraMatrixForViewport(
        SCENE_CAMERA_PRESETS.room,
        { width: 1672, height: 941 },
      )!,
    };
    const projections = [
      projectSceneAnchor(ROOM_SCENE_ANCHORS["room.notebook"], frame)!,
      projectSceneAnchor(ROOM_SCENE_ANCHORS["room.review"], frame)!,
      projectSceneAnchor(ROOM_SCENE_ANCHORS["room.lamp"], frame)!,
    ];

    expect(() => registry.updateAnchors(projections)).not.toThrow();
    expect(registry.updateAnchors(projections)).toBe(true);
    expect(registry.get("destroyed")).toBeNull();
    expect(registry.get("failing")).toBeNull();
    expect(registry.get("healthy")).toBe(healthyNode);
    expect(healthyNode.position.x).toBe(ROOM_SCENE_ANCHORS["room.lamp"].point[0]);
    expect(healthyNode.position.y).toBe(ROOM_SCENE_ANCHORS["room.lamp"].point[1]);
    expect(healthyNode.visible).toBe(true);
    expect(healthyNode.renderable).toBe(true);

    positionSpy.mockRestore();
    registry.destroy();
    depth.destroy();
  });
});
