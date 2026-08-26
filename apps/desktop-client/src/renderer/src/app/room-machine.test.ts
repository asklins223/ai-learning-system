import { describe, expect, it } from "vitest";
import { nextMotionMode, resolveRoomIntent } from "./room-machine";

describe("room intent mapping", () => {
  it("keeps every domain action on a deterministic 2D view preset", () => {
    expect(resolveRoomIntent("continue")).toEqual({
      destination: "study",
      viewPreset: "study",
      surface: "study",
    });
    expect(resolveRoomIntent("open-notebook").viewPreset).toBe("notebook");
    expect(resolveRoomIntent("review").viewPreset).toBe("review");
    expect(resolveRoomIntent("search").viewPreset).toBe("search");
    expect(resolveRoomIntent("graph").viewPreset).toBe("graph");
    expect(resolveRoomIntent("validate").viewPreset).toBe("validation");
  });

  it("cycles through the explicit V1 motion modes", () => {
    expect(nextMotionMode("full")).toBe("lite");
    expect(nextMotionMode("lite")).toBe("off");
    expect(nextMotionMode("off")).toBe("full");
  });
});
