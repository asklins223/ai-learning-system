import { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { SCENE_DEPTH_BANDS } from "./scene-depth";
import {
  createScenePixiParallaxController,
  sceneDepthPointerOffsets,
} from "./scene-depth-pixi-motion";
import { createScenePixiDepthLayers } from "./scene-depth-pixi";

describe("scene Pixi depth parallax", () => {
  const frameBounds = { left: 100, top: 40, width: 800, height: 400 };

  it("maps mouse/pen coordinates into each band's bounded offset", () => {
    const offsets = sceneDepthPointerOffsets({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    });

    expect(offsets.D0).toEqual([-2, -1]);
    expect(offsets.D6).toEqual([-12, -6]);
    expect(Object.isFrozen(offsets)).toBe(true);
    expect(Object.isFrozen(offsets.D4)).toBe(true);
  });

  it("keeps touch, disabled and malformed input at zero", () => {
    const cases = [
      { pointerType: "touch", enabled: true },
      { pointerType: "mouse", enabled: false },
      { pointerType: "mouse", enabled: true, clientX: Number.NaN },
    ];

    for (const overrides of cases) {
      const offsets = sceneDepthPointerOffsets({
        clientX: overrides.clientX ?? 500,
        clientY: 240,
        frameBounds,
        enabled: overrides.enabled,
        pointerType: overrides.pointerType,
      });
      expect(offsets.D0).toEqual([0, 0]);
      expect(offsets.D6).toEqual([0, 0]);
    }
    expect(sceneDepthPointerOffsets(null)).toEqual({
      D0: [0, 0],
      D1: [0, 0],
      D2: [0, 0],
      D3: [0, 0],
      D4: [0, 0],
      D5: [0, 0],
      D6: [0, 0],
    });
  });

  it("applies and clears offsets without taking ownership of layers", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const controller = createScenePixiParallaxController(depth.layers);

    expect(controller.update({
      clientX: 100,
      clientY: 40,
      frameBounds,
      enabled: true,
      pointerType: "pen",
    })).toBe(true);
    expect(depth.layers.D0.position.x).toBe(2);
    expect(depth.layers.D6.position.y).toBe(6);

    controller.clear();
    expect(depth.layers.D0.position.x).toBe(0);
    expect(depth.layers.D6.position.y).toBe(0);
    controller.destroy();
    expect(controller.update({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(false);
    depth.destroy();
  });

  it("returns a previously active pointer to zero when input becomes inactive", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const controller = createScenePixiParallaxController(depth.layers);

    expect(controller.update({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(true);
    expect(depth.layers.D6.position.x).toBe(-12);
    expect(depth.layers.D6.position.y).toBe(-6);

    expect(controller.update({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "touch",
    })).toBe(false);
    expect(depth.layers.D0.position.x).toBe(0);
    expect(depth.layers.D0.position.y).toBe(0);
    expect(depth.layers.D6.position.x).toBe(0);
    expect(depth.layers.D6.position.y).toBe(0);

    controller.destroy();
    depth.destroy();
  });

  it("keeps the offsets aligned with the registered band order", () => {
    expect(SCENE_DEPTH_BANDS.map((band) => band.id)).toEqual(["D0", "D1", "D2", "D3", "D4", "D5", "D6"]);
  });

  it("contains one broken depth layer while continuing healthy parallax updates", () => {
    const parent = new Container();
    const depth = createScenePixiDepthLayers({ parent });
    const controller = createScenePixiParallaxController(depth.layers);
    const failingPositionSpy = vi.spyOn(depth.layers.D3.position, "set").mockImplementation(() => {
      throw new Error("depth layer unavailable");
    });
    depth.layers.D2.destroy();

    expect(() => controller.update({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).not.toThrow();
    expect(controller.update({
      clientX: 900,
      clientY: 440,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(false);
    expect(depth.layers.D6.position.x).toBe(-12);
    expect(depth.layers.D6.position.y).toBe(-6);

    expect(() => controller.clear()).not.toThrow();
    expect(depth.layers.D6.position.x).toBe(0);
    expect(depth.layers.D6.position.y).toBe(0);
    expect(failingPositionSpy).toHaveBeenCalled();

    failingPositionSpy.mockRestore();
    controller.destroy();
    depth.destroy();
  });
});
