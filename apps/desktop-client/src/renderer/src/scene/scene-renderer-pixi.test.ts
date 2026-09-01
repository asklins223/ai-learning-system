import { Container, Point, Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { projectSceneAnchor, type SceneProjectionFrame } from "./scene-anchor-projection";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";
import { createScenePixiTextureNode } from "./scene-node-pixi";
import { createScenePixiRendererHost } from "./scene-renderer-pixi";

describe("scene Pixi renderer host", () => {
  const viewport = { width: 1672, height: 941 };
  const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };
  const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport)!;
  const frame: SceneProjectionFrame = { frameBounds, cameraMatrix };

  it("keeps world anchors below the camera and composes one world-to-viewport transform", () => {
    const parent = new Container();
    const host = createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    expect(parent.children).toEqual([host.root]);
    expect(host.root.eventMode).toBe("none");
    expect(host.root.interactiveChildren).toBe(false);
    expect(host.anchorCoordinateSpace).toBe("world");
    expect(host.depthRoot.parent).toBe(host.cameraRoot);
    expect(host.depthLayers.D0.parent).toBe(host.depthRoot);
    expect(host.depthLayers.D6.parent).toBe(host.depthRoot);
    expect(host.depthOrderSignature).toBe("D0>D1>D2>D3>D4>D5>D6");
    expect(host.isDepthOrderIntact()).toBe(true);
    const texture = Texture.WHITE;
    const depthNode = createScenePixiTextureNode({ texture, label: "depth-node" });
    expect(host.nodeRegistry.mount({
      id: "depth-node",
      anchorId: "room.notebook",
      depth: "D4",
      order: 10,
      node: depthNode,
    })).toBe(true);
    expect(depthNode.parent).toBe(host.depthLayers.D4);
    expect(depthNode.visible).toBe(false);
    expect(host.anchorRoot.parent).toBe(host.cameraRoot);
    expect(host.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(true);

    const anchor = ROOM_SCENE_ANCHORS["room.notebook"];
    const projection = projectSceneAnchor(anchor, frame)!;
    const node = host.anchorRoot.children[0] as Container;
    const cameraPoint = host.cameraRoot.localTransform.apply(new Point(node.x, node.y));

    expect(node.position.x).toBe(anchor.point[0]);
    expect(node.position.y).toBe(anchor.point[1]);
    expect(cameraPoint.x).toBeCloseTo(projection.viewportPoint[0], 8);
    expect(cameraPoint.y).toBeCloseTo(projection.viewportPoint[1], 8);
    expect(depthNode.position.x).toBe(anchor.point[0]);
    expect(depthNode.position.y).toBe(anchor.point[1]);
    expect(depthNode.visible).toBe(true);
    expect(depthNode.renderable).toBe(true);
    expect(host.cameraRoot.visible).toBe(true);
    expect(host.cameraRoot.renderable).toBe(true);
    expect(host.updatePointer({
      clientX: frameBounds.left,
      clientY: frameBounds.top,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(true);
    expect(host.depthLayers.D6.position.x).toBe(12);
    expect(host.depthLayers.D6.position.y).toBe(6);

    host.clear();
    expect(host.cameraRoot.visible).toBe(false);
    expect(host.cameraRoot.renderable).toBe(false);
    expect(host.depthLayers.D6.position.x).toBe(0);
    expect(host.depthLayers.D6.position.y).toBe(0);
    expect(node.visible).toBe(false);
    expect(node.renderable).toBe(false);
    expect(depthNode.visible).toBe(false);
    expect(depthNode.renderable).toBe(false);
    expect(depthNode.destroyed).toBe(false);

    host.destroy();
    expect(parent.children).toHaveLength(0);
    expect(host.root.destroyed).toBe(true);
    expect(depthNode.destroyed).toBe(true);
    expect(texture.destroyed).toBe(false);
    host.destroy();
  });

  it("restores depth metadata drift and rejects structural depth corruption", () => {
    const parent = new Container();
    const host = createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    host.depthRoot.setChildIndex(host.depthLayers.D6, 0);
    host.depthLayers.D6.zIndex = 42;
    host.depthRoot.sortableChildren = false;
    expect(host.isDepthOrderIntact()).toBe(false);
    expect(host.ensureDepthOrder()).toBe(true);
    expect(host.isDepthOrderIntact()).toBe(true);
    expect(host.depthRoot.children.map((child) => child.label)).toEqual([
      "scene-renderer:depth:D0",
      "scene-renderer:depth:D1",
      "scene-renderer:depth:D2",
      "scene-renderer:depth:D3",
      "scene-renderer:depth:D4",
      "scene-renderer:depth:D5",
      "scene-renderer:depth:D6",
    ]);

    host.depthRoot.removeChild(host.depthLayers.D3);
    expect(host.ensureDepthOrder()).toBe(false);
    expect(host.update(frame)).toBe(false);
    expect(host.cameraRoot.visible).toBe(false);

    host.destroy();
  });

  it("uses viewport-space anchors beside the camera and clears the whole frame on invalid bounds", () => {
    const parent = new Container();
    const host = createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
      anchorCoordinateSpace: "viewport",
    });

    expect(host.anchorRoot.parent).toBe(host.root);
    expect(host.update(frame)).toBe(true);

    const projection = projectSceneAnchor(ROOM_SCENE_ANCHORS["room.notebook"], frame)!;
    const node = host.anchorRoot.children[0] as Container;
    expect(node.position.x).toBe(projection.viewportPoint[0]);
    expect(node.position.y).toBe(projection.viewportPoint[1]);

    expect(host.updateViewport({
      viewport,
      frameBounds: { ...frameBounds, width: 0 },
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(false);
    expect(host.cameraRoot.visible).toBe(false);
    expect(node.visible).toBe(false);
    expect(node.renderable).toBe(false);

    host.destroy();
  });

  it("contains malformed frame reads and clears the active scene", () => {
    const parent = new Container();
    const host = createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    expect(host.update(frame)).toBe(true);
    expect(host.cameraRoot.visible).toBe(true);
    expect(host.updatePointer({
      clientX: frameBounds.left,
      clientY: frameBounds.top,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(true);
    expect(host.depthLayers.D6.position.x).toBe(12);

    const malformedFrame = {
      get frameBounds(): never {
        throw new Error("frame bounds unavailable");
      },
      cameraMatrix,
    } as unknown as SceneProjectionFrame;

    expect(() => host.update(malformedFrame)).not.toThrow();
    expect(host.cameraRoot.visible).toBe(false);
    expect(host.cameraRoot.renderable).toBe(false);
    expect(host.depthLayers.D6.position.x).toBe(0);
    expect(host.depthLayers.D6.position.y).toBe(0);

    host.destroy();
  });

  it("continues teardown when detaching the root reports an error", () => {
    const parent = new Container();
    const host = createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });
    const removeFromParent = vi.spyOn(host.root, "removeFromParent").mockImplementationOnce(() => {
      throw new Error("root parent unavailable");
    });

    expect(() => host.destroy()).not.toThrow();
    expect(host.root.destroyed).toBe(true);
    expect(parent.children).toHaveLength(0);
    expect(() => host.destroy()).not.toThrow();

    removeFromParent.mockRestore();
  });

  it("releases the owned graph when the caller rejects root attachment", () => {
    const parent = new Container();
    const addChild = vi.spyOn(parent, "addChild").mockImplementationOnce(() => {
      throw new Error("renderer parent unavailable");
    });

    expect(() => createScenePixiRendererHost({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    })).toThrow("renderer parent unavailable");
    expect(parent.children).toHaveLength(0);

    addChild.mockRestore();
  });
});
