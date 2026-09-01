import { Application, Container, Sprite, Texture } from "pixi.js";
import type { WindowState } from "../app/room-machine";
import type { SceneMotionMode, SceneMotionPhase } from "./scene-motion";
import { loadSceneImageTexture } from "./scene-texture-loader";

export type SceneRendererCapability = {
  readonly supported: boolean;
  readonly kind: "webgl2" | "webgl" | "unavailable";
};

export type StudyNotebookRendererBlockReason =
  | "asset-unavailable"
  | "compact"
  | "motion-off"
  | "window-hidden"
  | "webgl-unavailable";

export type StudyNotebookRendererEligibility = {
  readonly enabled: boolean;
  readonly reason: "eligible" | StudyNotebookRendererBlockReason;
};

export function shouldPresentStudyNotebookCanvas(input: {
  readonly sceneReady: boolean;
  readonly scenePhase: SceneMotionPhase;
  readonly compact: boolean;
  readonly motionMode: SceneMotionMode;
  readonly windowState: WindowState;
}): boolean {
  return input.sceneReady
    && input.scenePhase === "task"
    && !input.compact
    && input.motionMode !== "off"
    && input.windowState === "visible";
}

export type StudyNotebookViewport = {
  readonly width: number;
  readonly height: number;
};

export type FittedTexture = StudyNotebookViewport & {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
};

export type StudyNotebookScene = {
  readonly app: Application;
  readonly canvas: HTMLCanvasElement;
  readonly rendererName: string;
  readonly resize: () => void;
  readonly destroy: () => void;
};

type CreateStudyNotebookSceneOptions = {
  readonly host: HTMLElement;
  readonly assetUrl: string;
  readonly onContextLost?: () => void;
  readonly signal?: AbortSignal;
};

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function resolveStudyNotebookRendererEligibility(input: {
  readonly assetUrl: string | null;
  readonly compact: boolean;
  readonly motionMode: SceneMotionMode;
  readonly windowState: WindowState;
  readonly capability: SceneRendererCapability;
}): StudyNotebookRendererEligibility {
  if (!input.assetUrl) return { enabled: false, reason: "asset-unavailable" };
  if (input.compact) return { enabled: false, reason: "compact" };
  if (input.motionMode === "off") return { enabled: false, reason: "motion-off" };
  if (input.windowState !== "visible") return { enabled: false, reason: "window-hidden" };
  if (!input.capability.supported) return { enabled: false, reason: "webgl-unavailable" };
  return { enabled: true, reason: "eligible" };
}

export function probeWebGLCapability(
  documentLike: Pick<Document, "createElement"> | null = typeof document === "undefined" ? null : document,
): SceneRendererCapability {
  if (!documentLike) return { supported: false, kind: "unavailable" };

  const canvas = documentLike.createElement("canvas");
  try {
    if (canvas.getContext("webgl2")) return { supported: true, kind: "webgl2" };
    if (canvas.getContext("webgl")) return { supported: true, kind: "webgl" };
  } catch {
    return { supported: false, kind: "unavailable" };
  }
  return { supported: false, kind: "unavailable" };
}

export function fitTextureToViewport(
  texture: StudyNotebookViewport,
  viewport: StudyNotebookViewport,
): FittedTexture {
  if (!isPositiveFinite(texture.width) || !isPositiveFinite(texture.height)) {
    throw new RangeError("Study notebook texture dimensions must be positive finite numbers.");
  }
  if (!isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) {
    throw new RangeError("Study notebook viewport dimensions must be positive finite numbers.");
  }

  const scale = Math.min(viewport.width / texture.width, viewport.height / texture.height);
  const width = texture.width * scale;
  const height = texture.height * scale;
  return Object.freeze({
    width,
    height,
    scale,
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
  });
}

function createAbortError(): Error {
  const error = new Error("Study notebook renderer initialization was cancelled.");
  error.name = "AbortError";
  return error;
}

export function loadStudyNotebookTexture(url: string, signal?: AbortSignal): Promise<Texture> {
  return loadSceneImageTexture(url, signal);
}

export async function createStudyNotebookScene({
  host,
  assetUrl,
  onContextLost,
  signal,
}: CreateStudyNotebookSceneOptions): Promise<StudyNotebookScene> {
  const app = new Application();
  let texture: Texture | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let destroyed = false;
  let appDestroyed = false;
  let initSettled = false;
  let initialized = false;
  let canvas: HTMLCanvasElement | null = null;
  let contextLostHandler: ((event: Event) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let abortHandler: (() => void) | null = null;

  const destroyApp = () => {
    const firstDestroyRequest = !destroyed;
    destroyed = true;
    if (firstDestroyRequest && abortHandler && signal) signal.removeEventListener("abort", abortHandler);
    if (firstDestroyRequest && resizeObserver) resizeObserver.disconnect();
    if (firstDestroyRequest && resizeHandler) window.removeEventListener("resize", resizeHandler);
    if (firstDestroyRequest && contextLostHandler && canvas) canvas.removeEventListener("webglcontextlost", contextLostHandler);
    // If abort fires while Application.init() is still in flight, defer Pixi's
    // destroy call until init settles; destroying the stage mid-init can leave
    // an initialized renderer holding a detached, already-destroyed stage.
    if (!initSettled || appDestroyed) return;
    appDestroyed = true;
    if (initialized || app.renderer) {
      app.destroy(
        { removeView: true, releaseGlobalResources: false },
        { children: true, texture: false, textureSource: false, context: true },
      );
    } else {
      app.stage.destroy({ children: true });
    }
    texture?.destroy(false);
    texture = null;
  };

  try {
    abortHandler = () => destroyApp();
    if (signal?.aborted) {
      destroyApp();
      throw createAbortError();
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      await app.init({
        antialias: true,
        autoDensity: true,
        autoStart: false,
        backgroundAlpha: 0,
        clearBeforeRender: true,
        preference: "webgl",
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        resizeTo: host,
      });
    } finally {
      initSettled = true;
    }
    initialized = true;

    if (destroyed) {
      destroyApp();
      throw new Error("Study notebook renderer was cancelled during initialization.");
    }

    canvas = app.canvas;
    canvas.setAttribute("aria-hidden", "true");
    canvas.tabIndex = -1;
    canvas.dataset.sceneRenderer = "pixi-study-notebook-base";
    host.appendChild(canvas);

    contextLostHandler = (event: Event) => {
      event.preventDefault();
      onContextLost?.();
    };
    canvas.addEventListener("webglcontextlost", contextLostHandler, { once: true });

    texture = await loadStudyNotebookTexture(assetUrl, signal);
    if (destroyed) {
      texture.destroy(false);
      texture = null;
      throw new Error("Study notebook renderer was cancelled during asset loading.");
    }

    const root = new Container();
    root.label = "study-notebook-canvas-root";
    const sprite = new Sprite(texture);
    sprite.label = "study-notebook-blank-base";
    sprite.eventMode = "none";
    root.addChild(sprite);
    app.stage.addChild(root);

    resizeHandler = () => {
      if (destroyed) return;
      const width = Math.max(1, host.clientWidth || app.screen.width);
      const height = Math.max(1, host.clientHeight || app.screen.height);
      const fit = fitTextureToViewport(
        { width: texture?.width ?? 1, height: texture?.height ?? 1 },
        { width, height },
      );
      sprite.position.set(fit.x, fit.y);
      sprite.scale.set(fit.scale);
      app.render();
    };
    resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeHandler);
    resizeObserver?.observe(host);
    window.addEventListener("resize", resizeHandler, { passive: true });
    resizeHandler();

    const scene: StudyNotebookScene = {
      app,
      canvas,
      rendererName: app.renderer.name,
      resize: resizeHandler,
      destroy: destroyApp,
    };
    return scene;
  } catch (error) {
    destroyApp();
    throw error;
  }
}
