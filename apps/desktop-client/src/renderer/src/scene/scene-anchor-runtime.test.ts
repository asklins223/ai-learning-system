import { describe, expect, it, vi } from "vitest";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { createSceneAnchorProjectionRuntime } from "./scene-anchor-runtime";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";
import { projectSceneAnchorRegistry, type SceneProjectionFrame } from "./scene-anchor-projection";

describe("scene anchor projection runtime", () => {
  const viewport = { width: 1672, height: 941 };
  const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };
  const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.room, viewport)!;
  const frame: SceneProjectionFrame = { frameBounds, cameraMatrix };

  it("publishes a batch once and deduplicates repeated frames", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });

    expect(runtime.update(frame)).toBe(true);
    expect(runtime.update(frame)).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(Object.keys(ROOM_SCENE_ANCHORS).length);
  });

  it("publishes when camera or frame geometry changes", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });
    const resizedFrame: SceneProjectionFrame = {
      frameBounds: { ...frameBounds, width: frameBounds.width + 1 },
      cameraMatrix,
    };

    expect(runtime.update(frame)).toBe(true);
    expect(runtime.update(resizedFrame)).toBe(true);
    expect(received).toHaveLength(2);
  });

  it("accepts one caller-prepared batch without projecting it again", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });
    const projections = projectSceneAnchorRegistry(ROOM_SCENE_ANCHORS, frame);

    expect(runtime.updateProjections(projections)).toBe(true);
    expect(runtime.updateProjections(projections)).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(projections);

    runtime.updateProjections(null);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual([]);
  });

  it("turns a malformed prepared batch into one fail-closed empty batch", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });

    expect(runtime.update(frame)).toBe(true);
    expect(runtime.updateProjections([{} as never])).toBe(true);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual([]);
  });

  it("clears invalid geometry once and releases on destroy", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });
    const invalidFrame = {
      frameBounds: { ...frameBounds, width: 0 },
      cameraMatrix,
    } as SceneProjectionFrame;

    expect(runtime.update(frame)).toBe(true);
    expect(runtime.update(invalidFrame)).toBe(true);
    expect(runtime.update(invalidFrame)).toBe(false);
    expect(received[1]).toEqual([]);

    runtime.destroy();
    expect(received).toHaveLength(2);
    expect(runtime.update(frame)).toBe(false);
    expect(runtime.clear()).toBe(false);
  });

  it("does not emit a redundant clear before the first projection", () => {
    const received: Array<readonly unknown[]> = [];
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink: (projections) => received.push(projections),
    });

    expect(runtime.clear()).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("contains sink failures, retries the same frame, and always deactivates on destroy", () => {
    let shouldThrow = true;
    const received: Array<readonly unknown[]> = [];
    const sink = vi.fn((projections: readonly unknown[]) => {
      if (shouldThrow) throw new Error("renderer commit failed");
      received.push(projections);
    });
    const runtime = createSceneAnchorProjectionRuntime({
      registry: ROOM_SCENE_ANCHORS,
      sink,
    });

    expect(() => runtime.update(frame)).not.toThrow();
    expect(runtime.update(frame)).toBe(false);
    expect(received).toHaveLength(0);

    shouldThrow = false;
    expect(runtime.update(frame)).toBe(true);
    expect(received).toHaveLength(1);
    expect(sink).toHaveBeenCalledTimes(3);

    shouldThrow = true;
    expect(() => runtime.destroy()).not.toThrow();
    expect(runtime.update(frame)).toBe(false);
    expect(runtime.clear()).toBe(false);
    expect(sink).toHaveBeenCalledTimes(4);
  });
});
