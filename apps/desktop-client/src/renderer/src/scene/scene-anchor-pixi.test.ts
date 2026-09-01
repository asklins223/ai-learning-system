import { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { createSceneAnchorPixiProjectionRuntime } from "./scene-anchor-pixi";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";
import type { SceneProjectionFrame } from "./scene-anchor-projection";

describe("scene anchor Pixi projection runtime", () => {
  const viewport = { width: 1672, height: 941 };
  const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };
  const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.room, viewport)!;
  const frame: SceneProjectionFrame = { frameBounds, cameraMatrix };

  it("attaches a non-interactive layer and maps projections to reusable nodes", () => {
    const parent = new Container();
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    expect(parent.children).toHaveLength(1);
    expect(runtime.root.eventMode).toBe("none");
    expect(runtime.root.interactiveChildren).toBe(false);
    expect(runtime.update(frame)).toBe(true);

    const firstNode = runtime.root.children[0] as Container;
    expect(firstNode.label).toBe("scene-anchor:room.notebook");
    expect(firstNode.position.x).toBe(836);
    expect(firstNode.position.y).toBe(545.78);
    expect(firstNode.visible).toBe(true);
    expect(firstNode.renderable).toBe(true);
    expect(firstNode.eventMode).toBe("none");

    runtime.clear();
    expect(firstNode.visible).toBe(false);
    expect(firstNode.renderable).toBe(false);
    expect(runtime.update(frame)).toBe(true);
    expect(runtime.root.children[0]).toBe(firstNode);

    runtime.destroy();
    expect(parent.children).toHaveLength(0);
    expect(runtime.root.destroyed).toBe(true);
  });

  it("keeps offscreen coordinates without making the Pixi node interactive", () => {
    const parent = new Container();
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });
    const shiftedFrame: SceneProjectionFrame = {
      frameBounds,
      cameraMatrix: Object.freeze({ ...cameraMatrix, tx: cameraMatrix.tx + viewport.width * 2 }),
    };

    runtime.update(shiftedFrame);

    const firstNode = runtime.root.children[0] as Container;
    expect(firstNode.position.x).toBeGreaterThan(viewport.width);
    expect(firstNode.visible).toBe(false);
    expect(firstNode.eventMode).toBe("none");
    runtime.destroy();
  });

  it("releases the layer and ignores updates after destroy", () => {
    const parent = new Container();
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    runtime.destroy();
    expect(runtime.update(frame)).toBe(false);
    runtime.destroy();
    expect(parent.children).toHaveLength(0);
  });

  it("uses world coordinates when the layer is nested below a camera rig", () => {
    const parent = new Container();
    const rig = new Container();
    parent.addChild(rig);
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent: rig,
      registry: ROOM_SCENE_ANCHORS,
      coordinateSpace: "world",
    });
    const studyMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport)!;

    expect(runtime.update({ frameBounds, cameraMatrix: studyMatrix })).toBe(true);

    const firstNode = runtime.root.children[0] as Container;
    expect(firstNode.position.x).toBe(836);
    expect(firstNode.position.y).toBe(545.78);
    expect(runtime.root.parent).toBe(rig);
    expect(firstNode.eventMode).toBe("none");

    runtime.destroy();
    rig.destroy({ children: true });
  });

  it("fails closed for one node factory error without blocking the projection batch", () => {
    const parent = new Container();
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent,
      registry: ROOM_SCENE_ANCHORS,
      createNode: (projection) => {
        if (projection.id === "room.notebook") throw new Error("asset node unavailable");
        return new Container();
      },
    });

    expect(() => runtime.update(frame)).not.toThrow();
    expect(runtime.root.children.length).toBe(Object.keys(ROOM_SCENE_ANCHORS).length - 1);
    expect(runtime.root.children.every((node) => node.eventMode === "none")).toBe(true);

    runtime.destroy();
  });

  it("quarantines destroyed or write-failing nodes while keeping healthy anchors alive", () => {
    const parent = new Container();
    const runtime = createSceneAnchorPixiProjectionRuntime({
      parent,
      registry: ROOM_SCENE_ANCHORS,
    });

    expect(runtime.update(frame)).toBe(true);
    const destroyedNode = runtime.root.children.find(
      (node) => node.label === "scene-anchor:room.notebook",
    ) as Container;
    const failingNode = runtime.root.children.find(
      (node) => node.label === "scene-anchor:room.review",
    ) as Container;
    const healthyNode = runtime.root.children.find(
      (node) => node.label === "scene-anchor:room.lamp",
    ) as Container;
    const positionSpy = vi.spyOn(failingNode.position, "set").mockImplementation(() => {
      throw new Error("anchor position unavailable");
    });

    destroyedNode.destroy();
    expect(runtime.clear()).toBe(true);
    expect(() => runtime.update(frame)).not.toThrow();
    expect(runtime.root.children).toHaveLength(Object.keys(ROOM_SCENE_ANCHORS).length - 1);
    expect(runtime.root.children).not.toContain(failingNode);
    expect(runtime.root.children).toContain(healthyNode);
    expect(failingNode.destroyed).toBe(true);
    expect(healthyNode.visible).toBe(true);
    expect(healthyNode.renderable).toBe(true);
    expect(positionSpy).toHaveBeenCalled();

    positionSpy.mockRestore();
    runtime.destroy();
  });
});
