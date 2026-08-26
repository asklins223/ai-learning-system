import {
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_INVITE_CUE,
  motionForWindowLive2D,
  parameterValuesForWindowLive2D,
  type WindowLive2DPresentation,
} from "./window-live2d-contract";

type DriverStatus = "loading" | "ready" | "failed";

interface PixiPoint {
  x: number;
  y: number;
  set: (x: number, y?: number) => void;
}

interface Live2DCoreModel {
  setParameterValueById?: (parameter: string, value: number, weight?: number) => void;
}

interface Live2DModel {
  anchor: PixiPoint;
  position: PixiPoint;
  scale: PixiPoint;
  internalModel?: {
    coreModel?: Live2DCoreModel;
    originalWidth?: number;
    originalHeight?: number;
  };
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>;
  destroy?: () => void;
}

interface PixiApplication {
  stage: {
    addChild: (child: Live2DModel) => void;
    removeChild?: (child: Live2DModel) => void;
  };
  ticker?: {
    add: (callback: () => void) => void;
    remove: (callback: () => void) => void;
    start?: () => void;
    stop?: () => void;
  };
  destroy: (removeView?: boolean) => void;
}

interface PixiGlobal {
  VERSION?: string;
  Application: new (options: {
    view: HTMLCanvasElement;
    resizeTo: HTMLElement;
    context: WebGLRenderingContext;
    autoStart: boolean;
    antialias: boolean;
    backgroundAlpha: number;
    resolution: number;
    autoDensity: boolean;
  }) => PixiApplication;
  live2d?: {
    Live2DModel?: {
      from: (
        modelUrl: string,
        options: { autoInteract: boolean },
      ) => Promise<Live2DModel>;
    };
  };
}

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

const scriptPromises = new Map<string, Promise<void>>();

function resolveBundledAsset(path: string): string {
  const base = new URL(".", document.baseURI);
  const url = new URL(path.replace(/^\/+/, ""), base);

  // Only renderer-bundled, same-origin assets may be executed or loaded.
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error(`Refusing non-bundled Live2D asset: ${url.href}`);
  }

  return url.href;
}

function loadBundledScript(path: string): Promise<void> {
  const src = resolveBundledAsset(path);
  const pending = scriptPromises.get(src);
  if (pending) return pending;

  const promise = new Promise<void>((resolve, reject) => {
    const previous = Array.from(document.scripts).find(
      (script) => script.dataset.windowLive2dSrc === src,
    );

    if (previous?.dataset.loaded === "true") {
      resolve();
      return;
    }

    if (previous?.dataset.failed === "true") previous.remove();

    const script = previous?.dataset.failed === "true"
      ? document.createElement("script")
      : previous ?? document.createElement("script");
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      callback();
    };
    const handleLoad = () => settle(() => {
      script.dataset.loaded = "true";
      resolve();
    });
    const handleError = () => settle(() => {
      script.dataset.failed = "true";
      reject(new Error(`Live2D vendor script failed: ${src}`));
    });
    const timeout = window.setTimeout(() => settle(() => {
      script.dataset.failed = "true";
      reject(new Error(`Live2D vendor script timed out: ${src}`));
    }), 15_000);

    script.dataset.windowLive2dSrc = src;
    script.async = false;
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!script.isConnected) {
      script.src = src;
      document.head.appendChild(script);
    }
  });

  scriptPromises.set(src, promise);
  void promise.then(
    () => {
      if (scriptPromises.get(src) === promise) scriptPromises.delete(src);
    },
    () => {
      if (scriptPromises.get(src) === promise) scriptPromises.delete(src);
    },
  );
  return promise;
}

function getPixi(): PixiGlobal | undefined {
  return (window as unknown as { PIXI?: PixiGlobal }).PIXI;
}

function usableWebGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const context = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
    stencil: true,
  });
  if (!context) return null;

  const textureUnits = context.getParameter(context.MAX_TEXTURE_IMAGE_UNITS);
  return typeof textureUnits === "number" && textureUnits > 0 ? context : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export interface WindowLive2DDriverOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly onStatus?: (status: DriverStatus) => void;
}

/**
 * Mao PRO runtime scoped to one renderer DOM node. It cannot create or move a
 * native window, and it never talks to Electron main/preload APIs.
 */
export class WindowLive2DDriver {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly onStatus?: (status: DriverStatus) => void;
  private app: PixiApplication | null = null;
  private model: Live2DModel | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private paused = false;
  private invitePlaying = false;
  private lastMotionKey = "";
  private presentation: WindowLive2DPresentation = "idle";
  private voiceLevel = 0;

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed) return;
    console.warn("[WindowLive2D] WebGL context lost; using static companion fallback");
    this.onStatus?.("failed");
    this.destroy();
  };

  private readonly handleTicker = (): void => {
    if (this.disposed || this.paused || !this.model) return;
    const coreModel = this.model.internalModel?.coreModel;
    const setParameter = coreModel?.setParameterValueById;
    if (!setParameter) return;

    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    try {
      for (const { parameter, value } of parameterValuesForWindowLive2D({
        presentation: this.presentation,
        nowMs,
        voiceLevel: this.voiceLevel,
      })) {
        setParameter.call(coreModel, parameter, value);
      }
    } catch (error) {
      console.warn("[WindowLive2D] parameter update failed; using static fallback", error);
      this.onStatus?.("failed");
      this.destroy();
    }
  };

  constructor(options: WindowLive2DDriverOptions) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.onStatus = options.onStatus;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    this.onStatus?.("loading");
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);

    try {
      for (const script of WINDOW_LIVE2D_ASSETS.vendorScripts) {
        await loadBundledScript(script);
        if (this.disposed) return;
      }

      const pixi = getPixi();
      const modelFactory = pixi?.live2d?.Live2DModel;
      if (!pixi || !modelFactory || !window.Live2DCubismCore) {
        throw new Error("Live2D runtime globals unavailable");
      }

      const context = usableWebGLContext(this.canvas);
      if (!context) throw new Error("No usable WebGL context for Live2D");

      const app = new pixi.Application({
        view: this.canvas,
        resizeTo: this.container,
        context,
        autoStart: true,
        antialias: true,
        backgroundAlpha: 0,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (this.disposed) {
        app.destroy(false);
        return;
      }
      this.app = app;

      let releasedAfterDispose = false;
      const modelPromise = modelFactory.from(resolveBundledAsset(WINDOW_LIVE2D_ASSETS.model), {
        autoInteract: false,
      });
      // A timeout cannot cancel pixi-live2d's internal fetch/decode. If the
      // late promise eventually resolves after disposal, release that model.
      void modelPromise.then((lateModel) => {
        if (this.disposed && lateModel !== this.model) {
          lateModel.destroy?.();
          releasedAfterDispose = true;
        }
      }, () => undefined);
      const model = await withTimeout(
        modelPromise,
        25_000,
        "Mao PRO model load timed out",
      );
      if (this.disposed) {
        if (!releasedAfterDispose) model.destroy?.();
        return;
      }
      if (!model.internalModel?.coreModel?.setParameterValueById) {
        model.destroy?.();
        throw new Error("Live2D core parameter API unavailable");
      }

      this.model = model;
      model.anchor.set(0.5, 0.5);
      app.stage.addChild(model);
      this.fitModel();
      app.ticker?.add(this.handleTicker);
      if (this.paused) app.ticker?.stop?.();

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.fitModel());
        this.resizeObserver.observe(this.container);
      }

      this.onStatus?.("ready");
      this.applyPresentation(this.presentation);
    } catch (error) {
      if (!this.disposed) {
        console.warn("[WindowLive2D] bootstrap failed; using static fallback", error);
        this.onStatus?.("failed");
      }
      this.destroy();
    }
  }

  setPresentation(presentation: WindowLive2DPresentation): void {
    this.presentation = presentation;
    if (!this.disposed && !this.invitePlaying) this.applyPresentation(presentation);
  }

  setVoiceLevel(level: number): void {
    this.voiceLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  playInviteOnce(): void {
    if (this.disposed || !this.model || this.invitePlaying) return;
    this.invitePlaying = true;
    void Promise.resolve(
      this.model.motion?.(WINDOW_LIVE2D_INVITE_CUE.group, WINDOW_LIVE2D_INVITE_CUE.index, 2),
    )
      .catch((error: unknown) => {
        console.warn("[WindowLive2D] invite motion failed", error);
      })
      .finally(() => {
        this.invitePlaying = false;
        this.lastMotionKey = "";
        if (!this.disposed) this.applyPresentation(this.presentation);
      });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.app?.ticker?.stop?.();
    else this.app?.ticker?.start?.();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.app?.ticker?.remove(this.handleTicker);

    if (this.model) {
      this.app?.stage.removeChild?.(this.model);
      this.model.destroy?.();
      this.model = null;
    }
    this.app?.destroy(false);
    this.app = null;
  }

  private applyPresentation(presentation: WindowLive2DPresentation): void {
    if (!this.model) return;
    const cue = motionForWindowLive2D(presentation);
    const key = `${cue.group}|${cue.index}`;
    if (key === this.lastMotionKey) return;

    this.lastMotionKey = key;
    void Promise.resolve(this.model.motion?.(cue.group, cue.index, 2)).catch(
      (error: unknown) => {
        console.warn("[WindowLive2D] presentation motion failed", {
          presentation,
          error,
        });
      },
    );
  }

  private fitModel(): void {
    if (!this.model) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const modelWidth = this.model.internalModel?.originalWidth ?? 5_800;
    const modelHeight = this.model.internalModel?.originalHeight ?? 8_400;
    const scale = Math.min(width / modelWidth, height / modelHeight) * 0.98;

    this.model.scale.set(scale);
    this.model.position.set(width / 2, height - (modelHeight * scale) / 2);
  }
}
