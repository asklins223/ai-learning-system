import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HOME_V2_CAMERA_PRESETS } from "./home-v2";
import {
  homeV2CameraWriteCount,
  requestHomeV2Camera,
  type HomeV2CameraSettleReason,
} from "./home-v2-camera";

/**
 * The serializer only touches `dataset.homeV2CameraState`, so a plain object
 * stands in for the room host element without a DOM environment. GSAP animates
 * plain-object properties, which is exactly what the CSS-variable command is.
 */
function fakeCameraHost() {
  return { dataset: {} as Record<string, string> } as unknown as HTMLElement;
}

const openHandles: Array<() => void> = [];
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  while (openHandles.length) openHandles.pop()?.();
});

afterAll(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
});

/**
 * GSAP's CSSPlugin only owns custom properties on real elements, so a plain
 * stand-in target makes it warn once per variable — sometimes lazily on the next
 * tick, which is why the filter lives for the whole file. Swallow exactly those
 * messages and let any other warning through.
 */
function requestWithoutCssVarNoise(request: Parameters<typeof requestHomeV2Camera>[0]) {
  if (!warnSpy) {
    const originalWarn = console.warn.bind(console);
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      if (args.map(String).join(" ").startsWith("Invalid property --scene-camera-")) return;
      originalWarn(...args);
    });
  }
  return requestHomeV2Camera(request);
}

function settleRecorder() {
  const reasons: HomeV2CameraSettleReason[] = [];
  return { reasons, onSettle: (reason: HomeV2CameraSettleReason) => { reasons.push(reason); } };
}

describe("home V2 camera serializer", () => {
  it("lands an immediate command synchronously and marks the camera idle", () => {
    const host = fakeCameraHost();
    const { reasons, onSettle } = settleRecorder();
    const before = homeV2CameraWriteCount();

    requestWithoutCssVarNoise({ target: host, preset: HOME_V2_CAMERA_PRESETS.desk, duration: 0, onSettle });

    expect(reasons).toEqual(["complete"]);
    expect(host.dataset.homeV2CameraState).toBe("idle");
    expect(homeV2CameraWriteCount()).toBe(before + 1);
  });

  it("supersedes the previous command exactly once and keeps the camera moving", () => {
    const host = fakeCameraHost();
    const first = settleRecorder();
    const second = settleRecorder();

    const cancelFirst = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.shelf,
      duration: 0.48,
      onSettle: first.onSettle,
    });
    openHandles.push(cancelFirst);
    expect(host.dataset.homeV2CameraState).toBe("moving");

    const cancelSecond = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.window,
      duration: 0.48,
      onSettle: second.onSettle,
    });
    openHandles.push(cancelSecond);

    // The superseded command settles its owner's state without ever completing,
    // and the newer command keeps ownership of the moving state.
    expect(first.reasons).toEqual(["superseded"]);
    expect(second.reasons).toEqual([]);
    expect(host.dataset.homeV2CameraState).toBe("moving");
  });

  it("ignores a cancel handle that no longer owns the camera", () => {
    const host = fakeCameraHost();
    const first = settleRecorder();
    const second = settleRecorder();

    const cancelFirst = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.desk,
      duration: 0.48,
      onSettle: first.onSettle,
    });
    const cancelSecond = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.rest,
      duration: 0.48,
      onSettle: second.onSettle,
    });
    openHandles.push(cancelSecond);

    cancelFirst();

    expect(first.reasons).toEqual(["superseded"]);
    expect(second.reasons).toEqual([]);
    expect(host.dataset.homeV2CameraState).toBe("moving");
  });

  it("settles a cancelled command as cancelled and parks the camera", () => {
    const host = fakeCameraHost();
    const recorder = settleRecorder();

    const cancel = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.shelf,
      duration: 0.48,
      onSettle: recorder.onSettle,
    });
    cancel();

    expect(recorder.reasons).toEqual(["cancelled"]);
    expect(host.dataset.homeV2CameraState).toBe("idle");
  });

  it("never lets a superseded command settle the scene phase", () => {
    const host = fakeCameraHost();
    const first = vi.fn();
    const second = vi.fn();

    const cancelFirst = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.wide,
      duration: 0.48,
      onSettle: first,
    });
    openHandles.push(cancelFirst);
    const cancelSecond = requestWithoutCssVarNoise({
      target: host,
      preset: HOME_V2_CAMERA_PRESETS.desk,
      duration: 0.48,
      onSettle: second,
    });
    openHandles.push(cancelSecond);

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith("superseded");
    expect(second).not.toHaveBeenCalled();
  });
});
