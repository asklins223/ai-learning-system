import { describe, expect, it } from "vitest";
import { Live2DEmotionController } from "./live2d-emotion";

describe("Live2D emotion controller", () => {
  it("smooths a new emotion and keeps the emotion name during decay", () => {
    const controller = new Live2DEmotionController();
    controller.push({ emotion: " HAPPY ", intensity: 1, at: 0 });

    const first = controller.update(16);
    expect(first.emotion).toBe("happy");
    expect(first.intensity).toBeGreaterThan(0.3);
    expect(first.intensity).toBeLessThan(0.4);

    let settled = first;
    for (let index = 0; index < 30; index += 1) settled = controller.update(32 + index * 16);
    expect(settled.intensity).toBeGreaterThan(0.99);

    const decaying = controller.update(3_000);
    expect(decaying.emotion).toBe("happy");
    expect(decaying.intensity).toBeLessThan(settled.intensity);

    let expired = decaying;
    for (let index = 0; index < 220; index += 1) expired = controller.update(3_016 + index * 16);
    expect(expired).toEqual({ emotion: null, intensity: 0 });
  });

  it("switches emotion immediately while smoothing toward the new target", () => {
    const controller = new Live2DEmotionController();
    controller.push({ emotion: "happy", intensity: 1, at: 0 });
    for (let index = 1; index <= 10; index += 1) controller.update(index * 16);

    controller.push({ emotion: "concerned", intensity: 0.8, at: 200 });
    const next = controller.update(216);
    expect(next.emotion).toBe("concerned");

    let settled = next;
    for (let index = 1; index <= 45; index += 1) settled = controller.update(216 + index * 16);
    expect(settled.intensity).toBeCloseTo(0.8, 2);
  });

  it("ignores empty and non-positive events and clamps intensity", () => {
    const controller = new Live2DEmotionController();
    controller.push({ emotion: "happy", intensity: 0, at: 0 });
    controller.push({ emotion: "", intensity: 0.8, at: 0 });
    expect(controller.update(16)).toEqual({ emotion: null, intensity: 0 });

    controller.push({ emotion: "happy", intensity: 4, at: 16 });
    expect(controller.update(32).intensity).toBeLessThanOrEqual(1);
  });
});
