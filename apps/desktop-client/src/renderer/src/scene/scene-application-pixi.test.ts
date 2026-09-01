import { Application, Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { SCENE_CAMERA_PRESETS } from "./scene-camera";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";
import {
  createScenePixiApplication,
  type ScenePixiApplicationOptions,
} from "./scene-application-pixi";

type FakeCanvas = {
  readonly canvas: HTMLCanvasElement;
  readonly listeners: Map<string, EventListenerOrEventListenerObject>;
  dispatch(type: string, event: Event): void;
};

type FakeApplication = {
  readonly app: Application;
  readonly canvas: FakeCanvas;
  readonly init: ReturnType<typeof vi.fn>;
  readonly initOptions: () => Record<string, unknown> | undefined;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly render: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
};

function createFakeCanvas(): FakeCanvas {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  const canvas = {
    dataset: {},
    tabIndex: 0,
    style: { pointerEvents: "" },
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    listeners,
    dispatch(type, event) {
      const listener = listeners.get(type);
      if (typeof listener === "function") listener(event);
      else listener?.handleEvent(event);
    },
  };
}

function createFakeApplication(): FakeApplication {
  const canvas = createFakeCanvas();
  let options: Record<string, unknown> | undefined;
  const init = vi.fn(async (nextOptions: Record<string, unknown>) => {
    options = nextOptions;
  });
  const resize = vi.fn();
  const render = vi.fn();
  const destroy = vi.fn();
  const app = {
    stage: new Container(),
    renderer: { name: "webgl" },
    canvas: canvas.canvas,
    init,
    resize,
    render,
    destroy,
  } as unknown as Application;

  return {
    app,
    canvas,
    init,
    initOptions: () => options,
    resize,
    render,
    destroy,
  };
}

function createHost(): HTMLElement {
  return {
    clientWidth: 800,
    clientHeight: 450,
    appendChild: vi.fn(),
  } as unknown as HTMLElement;
}

function createOptions(
  fake: FakeApplication,
  host: HTMLElement,
  overrides: Partial<ScenePixiApplicationOptions> = {},
): ScenePixiApplicationOptions {
  return {
    host,
    registry: ROOM_SCENE_ANCHORS,
    applicationFactory: () => fake.app,
    ...overrides,
  };
}

describe("scene Pixi Application adapter", () => {
  const viewport = { width: 1672, height: 941 };
  const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };

  it("initializes manually, attaches a presentation canvas, and renders accepted frames", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const scene = await createScenePixiApplication(createOptions(fake, host, {
      label: "scene-application-test",
      preference: "webgpu",
      resolution: 4,
    }));

    expect(fake.init).toHaveBeenCalledOnce();
    expect(fake.initOptions()).toMatchObject({
      autoStart: false,
      clearBeforeRender: true,
      preference: "webgpu",
      resolution: 2,
      resizeTo: host,
    });
    expect(fake.canvas.canvas.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    expect(fake.canvas.canvas.tabIndex).toBe(-1);
    expect(fake.canvas.canvas.style.pointerEvents).toBe("none");
    expect(fake.canvas.canvas.dataset.sceneRenderer).toBe("scene-application-test");
    expect(host.appendChild).toHaveBeenCalledWith(fake.canvas.canvas);
    expect(scene.rendererName).toBe("webgl");
    expect(fake.resize).toHaveBeenCalledOnce();

    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(true);
    expect(scene.rendererHost.cameraRoot.visible).toBe(true);
    expect(fake.render).toHaveBeenCalled();

    scene.destroy();
  });

  it("does not render a structurally corrupted depth root", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const scene = await createScenePixiApplication(createOptions(fake, host));

    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(true);
    const renderCount = fake.render.mock.calls.length;

    scene.rendererHost.depthRoot.removeChild(scene.rendererHost.depthLayers.D3);
    expect(scene.rendererHost.isDepthOrderIntact()).toBe(false);
    scene.render();

    expect(fake.render).toHaveBeenCalledTimes(renderCount);
    expect(scene.rendererHost.cameraRoot.visible).toBe(false);
    expect(scene.rendererHost.cameraRoot.renderable).toBe(false);

    scene.destroy();
  });

  it("forwards context loss, keeps pointer rendering explicit, and destroys once", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const onContextLost = vi.fn();
    const scene = await createScenePixiApplication(createOptions(fake, host, {
      onContextLost,
    }));
    const contextEvent = { preventDefault: vi.fn() } as unknown as Event;

    fake.canvas.dispatch("webglcontextlost", contextEvent);
    expect(contextEvent.preventDefault).toHaveBeenCalledOnce();
    expect(onContextLost).toHaveBeenCalledOnce();

    expect(scene.updatePointer({
      clientX: frameBounds.left,
      clientY: frameBounds.top,
      frameBounds,
      enabled: true,
      pointerType: "mouse",
    })).toBe(true);
    const renderCountBeforeDestroy = fake.render.mock.calls.length;

    scene.destroy();
    scene.destroy();
    scene.render();
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(scene.rendererHost.root.destroyed).toBe(true);
    expect(fake.render).toHaveBeenCalledTimes(renderCountBeforeDestroy);
    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(false);
  });

  it("contains callback, resize, and render failures while failing closed", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const onContextLost = vi.fn(() => {
      throw new Error("context callback failed");
    });
    const scene = await createScenePixiApplication(createOptions(fake, host, {
      onContextLost,
    }));
    const contextEvent = { preventDefault: vi.fn() } as unknown as Event;

    expect(() => fake.canvas.dispatch("webglcontextlost", contextEvent)).not.toThrow();
    expect(contextEvent.preventDefault).toHaveBeenCalledOnce();
    expect(onContextLost).toHaveBeenCalledOnce();

    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(true);
    expect(scene.rendererHost.cameraRoot.visible).toBe(true);

    fake.resize.mockImplementationOnce(() => {
      throw new Error("resize failed");
    });
    expect(() => scene.resize()).not.toThrow();
    expect(scene.rendererHost.cameraRoot.visible).toBe(false);

    fake.render.mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(false);
    expect(scene.rendererHost.cameraRoot.visible).toBe(false);

    fake.render.mockImplementation(() => undefined);
    expect(scene.updateViewport({
      viewport,
      frameBounds,
      cameraPreset: SCENE_CAMERA_PRESETS.study,
    })).toBe(true);

    const renderCountBeforeInvalidFrame = fake.render.mock.calls.length;
    expect(scene.update({} as never)).toBe(false);
    expect(fake.render.mock.calls.length).toBe(renderCountBeforeInvalidFrame + 1);
    expect(scene.rendererHost.cameraRoot.visible).toBe(false);

    scene.destroy();
  });

  it("can own a non-interactive pointer bridge and render its coalesced updates", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    let pendingFrame: (() => void) | null = null;
    const scene = await createScenePixiApplication(createOptions(fake, host, {
      pointerRuntime: {
        target: fake.canvas.canvas,
        getFrameBounds: () => frameBounds,
        requestFrame: (callback) => {
          pendingFrame = callback;
          return 11;
        },
        cancelFrame: () => {
          pendingFrame = null;
        },
      },
    }));

    const takePendingFrame = () => {
      const callback = pendingFrame as (() => void) | null;
      pendingFrame = null;
      if (callback) callback();
    };

    fake.canvas.dispatch("pointermove", {
      clientX: frameBounds.left + 10,
      clientY: frameBounds.top + 10,
      pointerType: "mouse",
      isPrimary: true,
    } as unknown as Event);
    expect(fake.render).not.toHaveBeenCalled();
    takePendingFrame();
    expect(fake.render).toHaveBeenCalledOnce();

    const renderCountBeforeDestroy = fake.render.mock.calls.length;
    scene.destroy();
    fake.canvas.dispatch("pointermove", {
      clientX: frameBounds.left + 20,
      clientY: frameBounds.top + 20,
      pointerType: "mouse",
      isPrimary: true,
    } as unknown as Event);
    takePendingFrame();
    expect(fake.render).toHaveBeenCalledTimes(renderCountBeforeDestroy);
  });

  it("keeps teardown idempotent when browser cleanup or Pixi destroy throws", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const scene = await createScenePixiApplication(createOptions(fake, host));

    fake.canvas.canvas.removeEventListener = vi.fn(() => {
      throw new Error("listener cleanup failed");
    }) as unknown as HTMLCanvasElement["removeEventListener"];
    fake.destroy.mockImplementationOnce(() => {
      throw new Error("application destroy failed");
    });

    expect(() => scene.destroy()).not.toThrow();
    expect(scene.rendererHost.root.destroyed).toBe(true);
    expect(() => scene.destroy()).not.toThrow();
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("defers Pixi destruction when abort happens during async init", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const controller = new AbortController();
    let resolveInit: (() => void) | undefined;
    fake.app.init = vi.fn(() => new Promise<void>((resolve) => {
      resolveInit = resolve;
    })) as unknown as Application["init"];

    const pending = createScenePixiApplication(createOptions(fake, host, {
      signal: controller.signal,
    }));
    controller.abort();
    expect(fake.destroy).not.toHaveBeenCalled();

    resolveInit?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("releases an unstarted Application when the signal is already aborted", async () => {
    const fake = createFakeApplication();
    const host = createHost();
    const controller = new AbortController();
    controller.abort();

    await expect(createScenePixiApplication(createOptions(fake, host, {
      signal: controller.signal,
    }))).rejects.toMatchObject({ name: "AbortError" });

    expect(fake.init).not.toHaveBeenCalled();
    expect(fake.app.stage.destroyed).toBe(true);
    expect(fake.destroy).not.toHaveBeenCalled();
  });
});
