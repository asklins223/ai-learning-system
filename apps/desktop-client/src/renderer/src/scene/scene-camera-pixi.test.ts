import { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import { createSceneCameraPixiRig } from "./scene-camera-pixi";

describe("scene camera Pixi rig", () => {
  const viewport = { width: 1672, height: 941 };

  it("attaches a non-interactive rig and applies the shared affine matrix", () => {
    const parent = new Container();
    const rig = createSceneCameraPixiRig({ parent });
    const matrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport)!;

    expect(parent.children).toEqual([rig.root]);
    expect(rig.root.eventMode).toBe("none");
    expect(rig.root.interactiveChildren).toBe(false);
    expect(rig.root.visible).toBe(false);
    expect(rig.root.renderable).toBe(false);
    expect(rig.apply(matrix)).toBe(true);
    expect(rig.root.visible).toBe(true);
    expect(rig.root.renderable).toBe(true);
    expect(rig.root.localTransform.a).toBeCloseTo(matrix.a, 10);
    expect(rig.root.localTransform.b).toBeCloseTo(matrix.b, 10);
    expect(rig.root.localTransform.c).toBeCloseTo(matrix.c, 10);
    expect(rig.root.localTransform.d).toBeCloseTo(matrix.d, 10);
    expect(rig.root.localTransform.tx).toBeCloseTo(matrix.tx, 10);
    expect(rig.root.localTransform.ty).toBeCloseTo(matrix.ty, 10);

    rig.destroy();
    expect(parent.children).toHaveLength(0);
    expect(rig.root.destroyed).toBe(true);
  });

  it("fails closed for invalid matrices and clears to an invisible identity rig", () => {
    const parent = new Container();
    const rig = createSceneCameraPixiRig({ parent });
    const matrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport)!;

    expect(rig.apply(matrix)).toBe(true);
    expect(rig.apply({ ...matrix, a: Number.NaN })).toBe(false);
    expect(rig.root.visible).toBe(false);
    expect(rig.root.renderable).toBe(false);

    rig.clear();
    expect(rig.root.localTransform.a).toBe(1);
    expect(rig.root.localTransform.b).toBe(0);
    expect(rig.root.localTransform.c).toBe(0);
    expect(rig.root.localTransform.d).toBe(1);
    expect(rig.root.localTransform.tx).toBe(0);
    expect(rig.root.localTransform.ty).toBe(0);
    expect(rig.root.visible).toBe(false);
    expect(rig.root.renderable).toBe(false);

    rig.destroy();
    rig.clear();
    rig.destroy();
  });

  it("contains Pixi transform failures and can recover or tear down safely", () => {
    const parent = new Container();
    const rig = createSceneCameraPixiRig({ parent });
    const matrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport)!;
    const setFromMatrix = vi.spyOn(rig.root, "setFromMatrix").mockImplementation(() => {
      throw new Error("camera transform unavailable");
    });

    let applied = true;
    expect(() => {
      applied = rig.apply(matrix);
    }).not.toThrow();
    expect(applied).toBe(false);
    expect(rig.root.visible).toBe(false);
    expect(rig.root.renderable).toBe(false);
    expect(() => rig.clear()).not.toThrow();

    setFromMatrix.mockRestore();
    expect(rig.apply(matrix)).toBe(true);

    expect(() => rig.destroy()).not.toThrow();
    expect(() => rig.destroy()).not.toThrow();
  });
});
