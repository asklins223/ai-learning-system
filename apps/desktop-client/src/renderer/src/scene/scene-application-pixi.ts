import { Application } from "pixi.js";
import type { RendererPreference } from "pixi.js";
import type { SceneAnchorPixiCoordinateSpace, SceneAnchorPixiNodeFactory } from "./scene-anchor-pixi";
import type { SceneProjectionFrame } from "./scene-anchor-projection";
import type { SceneAnchor } from "./scene-depth";
import type { ScenePixiParallaxInput } from "./scene-depth-pixi-motion";
import {
  createScenePixiPointerRuntime,
  type ScenePixiPointerRuntime,
  type ScenePixiPointerRuntimeOptions,
} from "./scene-pixi-pointer-runtime";
import {
  createScenePixiRendererHost,
  type ScenePixiRendererHost,
} from "./scene-renderer-pixi";
import type { SceneProjectionFrameInput } from "./scene-renderer-frame";

export type ScenePixiApplicationOptions = Readonly<{
  /** DOM host for the presentation-only Pixi canvas. */
  readonly host: HTMLElement;
  readonly registry: Readonly<Record<string, SceneAnchor>>;
  readonly createAnchorNode?: SceneAnchorPixiNodeFactory;
  readonly anchorCoordinateSpace?: SceneAnchorPixiCoordinateSpace;
  readonly label?: string;
  /** WebGL is the default because it is the approved production capability. */
  readonly preference?: RendererPreference;
  /** Resolution is capped at 2 to avoid unbounded DPR memory growth. */
  readonly resolution?: number;
  /** Injection seam for lifecycle tests; production callers should omit it. */
  readonly applicationFactory?: () => Application;
  readonly onContextLost?: () => void;
  readonly signal?: AbortSignal;
  /** Optional non-owning DOM pointer bridge; the Application owns its cleanup. */
  readonly pointerRuntime?: Omit<ScenePixiPointerRuntimeOptions, "onPointer">;
}>;

export type ScenePixiApplication = Readonly<{
  readonly app: Application;
  readonly canvas: HTMLCanvasElement;
  readonly rendererName: string;
  readonly rendererHost: ScenePixiRendererHost;
  readonly pointerRuntime: ScenePixiPointerRuntime | null;
  /** Trigger the renderer resize without starting an animation ticker. */
  readonly resize: () => void;
  /** Render the current scene graph once. */
  readonly render: () => void;
  /** Apply one complete projection frame and render it once. */
  readonly update: (frame: SceneProjectionFrame) => boolean;
  /** Build, apply, and render one complete viewport frame. */
  readonly updateViewport: (input: SceneProjectionFrameInput) => boolean;
  /** Apply bounded pointer parallax and render it once. */
  readonly updatePointer: (input: ScenePixiParallaxInput | null | undefined) => boolean;
  readonly clear: () => void;
  readonly destroy: () => void;
}>;

function createAbortError(): Error {
  const error = new Error("Scene Pixi application initialization was cancelled.");
  error.name = "AbortError";
  return error;
}

function resolveResolution(requested: number | undefined): number {
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const fallback = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const resolution = requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested
    : fallback;
  return Math.min(Math.max(resolution, 1), 2);
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // Teardown and browser callbacks must not replace the original failure.
  }
}

/**
 * Create an opt-in Pixi Application around the renderer host.
 *
 * This adapter deliberately uses `autoStart: false`: DOM remains the
 * interaction/accessibility authority, while callers explicitly commit a
 * validated frame through `update()` and one matching `app.render()` call.
 * The renderer host is destroyed before the Application so shared textures
 * remain caller-owned and async init cancellation cannot destroy Pixi's stage
 * halfway through initialization.
 */
export async function createScenePixiApplication(
  options: ScenePixiApplicationOptions,
): Promise<ScenePixiApplication> {
  const app = options.applicationFactory?.() ?? new Application();
  let rendererHost: ScenePixiRendererHost | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let destroyed = false;
  let appDestroyed = false;
  let initStarted = false;
  let initSettled = false;
  let initialized = false;
  let canvas: HTMLCanvasElement | null = null;
  let contextLostHandler: ((event: Event) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let abortHandler: (() => void) | null = null;
  let pointerRuntime: ScenePixiPointerRuntime | null = null;

  const clearRendererHost = (): void => {
    safeCall(() => rendererHost?.clear());
  };

  const destroyApp = (): void => {
    const firstDestroyRequest = !destroyed;
    destroyed = true;

    if (firstDestroyRequest && abortHandler && options.signal) {
      safeCall(() => options.signal?.removeEventListener("abort", abortHandler!));
    }
    if (firstDestroyRequest) safeCall(() => resizeObserver?.disconnect());
    if (firstDestroyRequest && contextLostHandler && canvas) {
      safeCall(() => canvas?.removeEventListener("webglcontextlost", contextLostHandler!));
    }
    safeCall(() => pointerRuntime?.destroy());
    pointerRuntime = null;

    // Application.init() is asynchronous. Defer Pixi destruction until an
    // in-flight init settles; otherwise a renderer can retain a destroyed
    // stage. If init has not started yet, the plain stage is safe to release.
    if (!initSettled) {
      if (!initStarted && !appDestroyed) {
        appDestroyed = true;
        safeCall(() => app.stage.destroy({ children: true }));
      }
      return;
    }
    if (appDestroyed) return;

    appDestroyed = true;
    safeCall(() => rendererHost?.destroy());
    rendererHost = null;

    let rendererAvailable = false;
    try {
      rendererAvailable = Boolean(app.renderer);
    } catch {
      rendererAvailable = false;
    }

    if (initialized || rendererAvailable) {
      safeCall(() => app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true, texture: false, textureSource: false, context: true },
      ));
    } else {
      safeCall(() => app.stage.destroy({ children: true }));
    }
  };

  try {
    abortHandler = () => destroyApp();
    if (options.signal?.aborted) {
      destroyApp();
      throw createAbortError();
    }
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      initStarted = true;
      await app.init({
        antialias: true,
        autoDensity: true,
        autoStart: false,
        backgroundAlpha: 0,
        clearBeforeRender: true,
        preference: options.preference ?? "webgl",
        resolution: resolveResolution(options.resolution),
        resizeTo: options.host,
      });
    } finally {
      initSettled = true;
    }
    initialized = true;

    if (destroyed) {
      destroyApp();
      throw createAbortError();
    }

    canvas = app.canvas;
    canvas.setAttribute("aria-hidden", "true");
    canvas.tabIndex = -1;
    canvas.style.pointerEvents = "none";
    canvas.dataset.sceneRenderer = options.label ?? "pixi-scene";
    options.host.appendChild(canvas);

    contextLostHandler = (event: Event) => {
      safeCall(() => event.preventDefault());
      safeCall(() => options.onContextLost?.());
      clearRendererHost();
    };
    canvas.addEventListener("webglcontextlost", contextLostHandler, { passive: false });

    rendererHost = createScenePixiRendererHost({
      parent: app.stage,
      registry: options.registry,
      createAnchorNode: options.createAnchorNode,
      anchorCoordinateSpace: options.anchorCoordinateSpace,
      label: options.label,
    });

    resizeHandler = () => {
      if (destroyed) return;
      try {
        app.resize();
      } catch {
        clearRendererHost();
      }
    };
    resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeHandler);
    resizeObserver?.observe(options.host);
    resizeHandler();

    const renderOnce = (): boolean => {
      if (destroyed) return false;
      try {
        if (!rendererHost || !rendererHost.ensureDepthOrder()) {
          clearRendererHost();
          return false;
        }
        app.render();
        return true;
      } catch {
        clearRendererHost();
        return false;
      }
    };
    const render = (): void => {
      renderOnce();
    };
    const commitAndRender = (commit: () => boolean): boolean => {
      if (destroyed || !rendererHost) return false;
      let accepted = false;
      try {
        accepted = commit();
      } catch {
        clearRendererHost();
      }
      const rendered = renderOnce();
      return accepted && rendered;
    };
    const update = (frame: SceneProjectionFrame): boolean => {
      return commitAndRender(() => rendererHost!.update(frame));
    };
    const updateViewport = (input: SceneProjectionFrameInput): boolean => {
      return commitAndRender(() => rendererHost!.updateViewport(input));
    };
    const updatePointer = (input: ScenePixiParallaxInput | null | undefined): boolean => {
      return commitAndRender(() => rendererHost!.updatePointer(input));
    };

    if (options.pointerRuntime) {
      pointerRuntime = createScenePixiPointerRuntime({
        ...options.pointerRuntime,
        onPointer: updatePointer,
      });
    }

    return {
      app,
      canvas,
      rendererName: app.renderer.name,
      rendererHost,
      pointerRuntime,
      resize: resizeHandler,
      render,
      update,
      updateViewport,
      updatePointer,
      clear() {
        if (destroyed || !rendererHost) return;
        safeCall(() => rendererHost?.clear());
        renderOnce();
      },
      destroy: destroyApp,
    };
  } catch (error) {
    destroyApp();
    throw error;
  }
}
