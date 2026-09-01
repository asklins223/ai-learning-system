import { afterEach, describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import {
  createStudyNotebookScene,
  loadStudyNotebookTexture,
  fitTextureToViewport,
  probeWebGLCapability,
  resolveStudyNotebookRendererEligibility,
  shouldPresentStudyNotebookCanvas,
  type SceneRendererCapability,
} from "./study-notebook-renderer";

const webglCapability: SceneRendererCapability = { supported: true, kind: "webgl2" };

class DeferredImage {
  static instances: DeferredImage[] = [];
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private currentSrc = "";

  constructor() {
    DeferredImage.instances.push(this);
  }

  get src() {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
  }
}

afterEach(() => {
  DeferredImage.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Study notebook Canvas progressive enhancement", () => {
  it("keeps the renderer eligible only when the canonical task can safely host it", () => {
    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: "/assets/study-open-notebook.png",
      compact: false,
      motionMode: "full",
      windowState: "visible",
      capability: webglCapability,
    })).toEqual({ enabled: true, reason: "eligible" });

    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: "/assets/study-open-notebook.png",
      compact: true,
      motionMode: "full",
      windowState: "visible",
      capability: webglCapability,
    })).toEqual({ enabled: false, reason: "compact" });

    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: "/assets/study-open-notebook.png",
      compact: false,
      motionMode: "off",
      windowState: "visible",
      capability: webglCapability,
    })).toEqual({ enabled: false, reason: "motion-off" });

    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: "/assets/study-open-notebook.png",
      compact: false,
      motionMode: "full",
      windowState: "hidden",
      capability: webglCapability,
    })).toEqual({ enabled: false, reason: "window-hidden" });

    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: "/assets/study-open-notebook.png",
      compact: false,
      motionMode: "full",
      windowState: "visible",
      capability: { supported: false, kind: "unavailable" },
    })).toEqual({ enabled: false, reason: "webgl-unavailable" });
  });

  it("falls back when the reviewed blank-base asset is not available", () => {
    expect(resolveStudyNotebookRendererEligibility({
      assetUrl: null,
      compact: false,
      motionMode: "full",
      windowState: "visible",
      capability: webglCapability,
    })).toEqual({ enabled: false, reason: "asset-unavailable" });
  });

  it("probes WebGL in order and fails closed when the browser throws", () => {
    const contexts: string[] = [];
    expect(probeWebGLCapability({
      createElement: () => ({
        getContext: (kind: string) => {
          contexts.push(kind);
          return kind === "webgl" ? {} : null;
        },
      }) as HTMLCanvasElement,
    })).toEqual({ supported: true, kind: "webgl" });
    expect(contexts).toEqual(["webgl2", "webgl"]);

    expect(probeWebGLCapability({
      createElement: () => ({
        getContext: () => { throw new Error("context unavailable"); },
      }) as unknown as HTMLCanvasElement,
    })).toEqual({ supported: false, kind: "unavailable" });
  });

  it("promotes the Canvas only after the camera reaches the stable task phase", () => {
    const base = {
      sceneReady: true,
      compact: false,
      motionMode: "full" as const,
      windowState: "visible" as const,
    };
    expect(shouldPresentStudyNotebookCanvas({ ...base, scenePhase: "focusing" })).toBe(false);
    expect(shouldPresentStudyNotebookCanvas({ ...base, scenePhase: "task" })).toBe(true);
    expect(shouldPresentStudyNotebookCanvas({ ...base, scenePhase: "returning" })).toBe(false);
    expect(shouldPresentStudyNotebookCanvas({ ...base, scenePhase: "task", motionMode: "off" })).toBe(false);
    expect(shouldPresentStudyNotebookCanvas({ ...base, scenePhase: "task", compact: true })).toBe(false);
  });

  it("cancels before initialization without requiring a DOM host", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createStudyNotebookScene({
      host: {} as HTMLElement,
      assetUrl: "/assets/study-open-notebook.png",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a pending image request and clears its handlers", async () => {
    vi.stubGlobal("Image", DeferredImage);
    const controller = new AbortController();
    const promise = loadStudyNotebookTexture("/assets/study-open-notebook.png", controller.signal);
    const image = DeferredImage.instances[0];

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(image.src).toBe("");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("rejects when Pixi cannot construct the loaded texture instead of hanging", async () => {
    vi.stubGlobal("Image", DeferredImage);
    vi.spyOn(Texture, "from").mockImplementation(() => {
      throw new Error("texture source rejected");
    });
    const promise = loadStudyNotebookTexture("/assets/study-open-notebook.png");
    const image = DeferredImage.instances[0];

    image.onload?.();

    await expect(promise).rejects.toThrow("texture source rejected");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("matches the DOM object-fit contain contract without changing world coordinates", () => {
    expect(fitTextureToViewport({ width: 1536, height: 1024 }, { width: 780, height: 520 })).toEqual({
      width: 780,
      height: 520,
      scale: 0.5078125,
      x: 0,
      y: 0,
    });
    expect(fitTextureToViewport({ width: 1536, height: 1024 }, { width: 780, height: 600 })).toEqual({
      width: 780,
      height: 520,
      scale: 0.5078125,
      x: 0,
      y: 40,
    });
    expect(() => fitTextureToViewport({ width: 0, height: 1024 }, { width: 780, height: 600 })).toThrow(RangeError);
  });
});
