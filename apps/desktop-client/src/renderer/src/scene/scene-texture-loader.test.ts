import { afterEach, describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import { loadSceneImageTexture } from "./scene-texture-loader";

class DeferredImage {
  static instances: DeferredImage[] = [];
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private currentSrc = "";

  constructor() {
    DeferredImage.instances.push(this);
  }

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
  }
}

class SynchronouslyFailingImage extends DeferredImage {
  set src(value: string) {
    if (value === "/assets/throws.webp") throw new Error("image source rejected");
    super.src = value;
  }
}

class SynchronouslyErroringClearImage extends DeferredImage {
  set src(value: string) {
    super.src = value;
    if (value === "") this.onerror?.();
  }
}

afterEach(() => {
  DeferredImage.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scene Image to Texture loader", () => {
  it("resolves the caller-owned Texture after the image decodes", async () => {
    vi.stubGlobal("Image", DeferredImage);
    const texture = Texture.WHITE;
    const from = vi.spyOn(Texture, "from").mockReturnValue(texture);
    const pending = loadSceneImageTexture("/assets/scene.webp");
    const image = DeferredImage.instances[0];

    image.onload?.();

    await expect(pending).resolves.toBe(texture);
    expect(from).toHaveBeenCalledWith(image, true);
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("passes an explicit Pixi alpha upload mode when a layer supplies one", async () => {
    vi.stubGlobal("Image", DeferredImage);
    const texture = Texture.WHITE;
    const from = vi.spyOn(Texture, "from").mockReturnValue(texture);
    const pending = loadSceneImageTexture("/assets/transparent-layer.png", undefined, {
      alphaMode: "premultiplied-alpha",
    });
    const image = DeferredImage.instances[0];

    image.onload?.();

    await expect(pending).resolves.toBe(texture);
    expect(from).toHaveBeenCalledWith({
      resource: image,
      alphaMode: "premultiplied-alpha",
    }, true);
  });

  it("rejects and clears handlers when the image fails", async () => {
    vi.stubGlobal("Image", DeferredImage);
    const pending = loadSceneImageTexture("/assets/missing.webp");
    const image = DeferredImage.instances[0];

    image.onerror?.();

    await expect(pending).rejects.toThrow("/assets/missing.webp");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("returns AbortError and clears the image request on cancellation", async () => {
    vi.stubGlobal("Image", DeferredImage);
    const controller = new AbortController();
    const pending = loadSceneImageTexture("/assets/scene.webp", controller.signal);
    const image = DeferredImage.instances[0];

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(image.src).toBe("");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("lets cancellation win when clearing src synchronously emits an error", async () => {
    vi.stubGlobal("Image", SynchronouslyErroringClearImage);
    const controller = new AbortController();
    const pending = loadSceneImageTexture("/assets/scene.webp", controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const image = SynchronouslyErroringClearImage.instances[0];
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("clears handlers when assigning the source throws synchronously", async () => {
    vi.stubGlobal("Image", SynchronouslyFailingImage);
    const pending = loadSceneImageTexture("/assets/throws.webp");
    const image = SynchronouslyFailingImage.instances[0];

    await expect(pending).rejects.toThrow("image source rejected");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });
});
