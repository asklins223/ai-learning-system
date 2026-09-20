import {
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_BUST_HEIGHT_RATIO,
  WINDOW_LIVE2D_INVITE_CUE,
  isApprovedWindowLive2DManifest,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  parameterValuesForWindowLive2D,
  type WindowLive2DFraming,
  type WindowLive2DPresentation,
} from "./window-live2d-contract";
import {
  clampLive2DEmotionIntensity,
  Live2DEmotionController,
  type Live2DEmotionEvent,
} from "./live2d-emotion";

type DriverStatus = "loading" | "ready" | "failed";

interface PixiPoint {
  x: number;
  y: number;
  set: (x: number, y?: number) => void;
}

interface Live2DCoreModel {
  setParameterValueById?: (parameter: string, value: number, weight?: number) => void;
  getDrawableCount?: () => number;
}

interface Live2DDrawableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Live2DInternalModel {
  coreModel?: Live2DCoreModel;
  originalWidth?: number;
  originalHeight?: number;
  /** Union-able bounds of one drawable, in Cubism canvas units (y-up). */
  getDrawableBounds?: (index: number, out?: Live2DDrawableBounds) => Live2DDrawableBounds;
  /**
   * pixi-live2d-display 的 InternalModel 是 EventEmitter（2026-09-19 口型/表情修复）。
   * `beforeModelUpdate` 在 motion + 眨眼 + 物理 + 姿态全部更新完之后、
   * `coreModel.update()` 应用到绘制节点之前发出——只有挂在这里写参数，
   * 我们的口型/表情值才能**每帧确定性地赢过** motion 曲线。
   */
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
}

/** The character's real content box, as fractions of the model canvas. */
interface Live2DContentBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface Live2DModel {
  anchor: PixiPoint;
  position: PixiPoint;
  scale: PixiPoint;
  internalModel?: Live2DInternalModel;
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>;
  destroy?: () => void;
}

interface PixiApplication {
  stage: {
    addChild: (child: Live2DModel) => void;
    removeChild?: (child: Live2DModel) => void;
  };
  renderer?: {
    render: (stage: PixiApplication["stage"]) => void;
    resize?: (width: number, height: number) => void;
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
    width: number;
    height: number;
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

async function assertApprovedBundledModel(): Promise<void> {
  const response = await withTimeout(
    fetch(resolveBundledAsset(WINDOW_LIVE2D_ASSETS.manifest), {
      cache: "no-store",
      credentials: "same-origin",
    }),
    10_000,
    "Live2D model manifest load timed out",
  );
  if (!response.ok || !isApprovedWindowLive2DManifest(await response.json())) {
    throw new Error("Live2D model license approval is unavailable");
  }
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
 * Live2D runtime scoped to one renderer DOM node. It cannot create or move a
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
  private emotionMotionPlaying = false;
  private lastEmotionMotionKey = "";
  private lastEmotionMotionAt = 0;
  private lastMotionKey = "";
  private presentation: WindowLive2DPresentation = "idle";
  private framing: WindowLive2DFraming = "full";
  private contentBox: Live2DContentBox | null = null;
  private voiceLevel = 0;
  private toolAttentionAtMs: number | null = null;
  private readonly emotionController = new Live2DEmotionController();

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed) return;
    console.warn("[WindowLive2D] WebGL context lost; disabling the companion canvas");
    this.onStatus?.("failed");
    this.destroy();
  };

  /**
   * 每帧参数写入（2026-09-19 口型/表情修复）。
   *
   * 之前挂在 `app.ticker` 上——但 pixi-live2d 的模型更新跑在 `Ticker.shared`
   * （autoUpdate），两条独立 ticker 每帧互相赛跑；而模型自带的每条 motion
   * （包括常驻循环的 Idle）都带**全部 128 条参数曲线**（ParamA、嘴、眼、眉、
   * 腮红全在 motion 里）。motion 一旦后写，我们把语音振幅和情绪 FACS 写进去的
   * 值就被整批抹掉——用户看到的就是"口型和表情没有应用上"。
   *
   * 现在挂在 `beforeModelUpdate` 上：motion/物理更新完 → 我们写 → 核心更新渲染。
   * 顺序确定，不再有竞态。
   */
  private readonly handleModelUpdate = (): void => {
    if (this.disposed || this.paused || !this.model) return;
    const coreModel = this.model.internalModel?.coreModel;
    const setParameter = coreModel?.setParameterValueById;
    if (!setParameter) return;

    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    try {
      const emotion = this.emotionController.update(nowMs);
      this.playEmotionMotion(emotion.emotion, emotion.intensity, nowMs);
      for (const { parameter, value } of parameterValuesForWindowLive2D({
        presentation: this.presentation,
        nowMs,
        voiceLevel: this.voiceLevel,
        emotion,
        toolAttentionAtMs: this.toolAttentionAtMs ?? undefined,
      })) {
        setParameter.call(coreModel, parameter, value);
      }
    } catch (error) {
      console.warn("[WindowLive2D] parameter update failed; disabling the companion canvas", error);
      this.onStatus?.("failed");
      this.destroy();
    }
  };

  private readonly resizeToContainer = (): void => {
    if (!this.app || !this.model) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    // Resize the existing backing surface in place. Recreating the whole
    // Live2D tree on every browser zoom/viewport change produces a transparent
    // loading frame and makes an otherwise continuous move look like a flash.
    this.app.renderer?.resize?.(width, height);
    this.fitModel();
    this.renderCurrentFrame();
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
      await assertApprovedBundledModel();
      if (this.disposed) return;
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
        width: Math.max(1, this.container.clientWidth),
        height: Math.max(1, this.container.clientHeight),
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
        "Live2D model load timed out",
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
      // 参数写入挂进模型自己的更新周期（见 handleModelUpdate 的说明），
      // 不再挂 app.ticker——那会和 pixi-live2d 的 motion 更新赛跑。
      model.internalModel?.on?.("beforeModelUpdate", this.handleModelUpdate);
      this.measureContentBox();
      this.fitModel();
      // Never report ready until the backing canvas contains a real model
      // frame. This keeps the reserved seat stable until the actor is visible.
      this.renderCurrentFrame();
      if (this.paused) {
        app.ticker?.stop?.();
      }

      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(this.resizeToContainer);
        this.resizeObserver.observe(this.container);
      }
      window.addEventListener("resize", this.resizeToContainer);
      window.visualViewport?.addEventListener("resize", this.resizeToContainer);

      this.onStatus?.("ready");
      this.applyPresentation(this.presentation);
    } catch (error) {
      if (!this.disposed) {
        console.warn("[WindowLive2D] bootstrap failed; disabling the companion canvas", error);
        this.onStatus?.("failed");
      }
      this.destroy();
    }
  }

  setPresentation(presentation: WindowLive2DPresentation): void {
    this.presentation = presentation;
    if (!this.disposed && !this.invitePlaying && !this.emotionMotionPlaying) {
      this.applyPresentation(presentation);
    }
  }

  setFraming(framing: WindowLive2DFraming): void {
    if (this.framing === framing) return;
    this.framing = framing;
    if (!this.disposed && this.model) {
      if (!this.contentBox) this.measureContentBox();
      this.fitModel();
      this.renderCurrentFrame();
    }
  }

  setVoiceLevel(level: number): void {
    this.voiceLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  pushEmotion(event: Live2DEmotionEvent): void {
    if (this.disposed) return;
    const nowMs = typeof performance === "undefined" ? Date.now() : performance.now();
    const intensity = clampLive2DEmotionIntensity(event.intensity);
    this.emotionController.push({ ...event, intensity, at: nowMs }, nowMs);
    this.playEmotionMotion(event.emotion, intensity, nowMs);
  }

  /**
   * 「看向手边」（方案 §5 第 9 项）：工具开始执行时给一次极小幅侧身。
   * 只记下起点时间，形状由 `parameterValuesForWindowLive2D` 的 `gaze` 层算，
   * 所以暂停 / 隐藏时不会留下半截参数。
   */
  pushToolAttention(): void {
    if (this.disposed) return;
    this.toolAttentionAtMs = typeof performance === "undefined" ? Date.now() : performance.now();
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
        // If an emotion motion was already running, its completion owns the
        // restore. Applying the presentation here would otherwise interrupt
        // that motion with a late invite callback.
        if (!this.disposed && !this.emotionMotionPlaying) {
          this.applyPresentation(this.presentation);
        }
      });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      // A resize/zoom can rebuild the canvas while the window is already
      // unfocused. Paint one registered frame before stopping the ticker so
      // pause keeps a visible companion instead of a transparent ready canvas.
      this.renderCurrentFrame();
      this.app?.ticker?.stop?.();
    }
    else this.app?.ticker?.start?.();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.resizeToContainer);
    window.visualViewport?.removeEventListener("resize", this.resizeToContainer);
    this.model?.internalModel?.off?.("beforeModelUpdate", this.handleModelUpdate);
    this.emotionController.reset();
    this.emotionMotionPlaying = false;

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
    const key = cue ? `${cue.group}|${cue.index}` : "hidden";
    if (key === this.lastMotionKey) return;

    this.lastMotionKey = key;
    if (!cue) return;
    void Promise.resolve(this.model.motion?.(cue.group, cue.index, 2)).catch(
      (error: unknown) => {
        console.warn("[WindowLive2D] presentation motion failed", {
          presentation,
          error,
        });
      },
    );
  }

  private playEmotionMotion(emotion: string | null, intensity: number, nowMs: number): void {
    const normalizedIntensity = clampLive2DEmotionIntensity(intensity);
    if (
      this.disposed
      || !this.model
      || this.invitePlaying
      || this.emotionMotionPlaying
      || normalizedIntensity < 0.35
    ) return;

    const cue = motionForWindowLive2DEmotion(emotion);
    if (!cue) return;
    const key = `${cue.group}|${cue.index}`;
    if (key === this.lastEmotionMotionKey && nowMs - this.lastEmotionMotionAt < 4_000) return;

    this.lastEmotionMotionKey = key;
    this.lastEmotionMotionAt = nowMs;
    this.emotionMotionPlaying = true;
    void Promise.resolve(this.model.motion?.(cue.group, cue.index, 2))
      .catch((error: unknown) => console.warn("[WindowLive2D] emotion motion failed", error))
      .finally(() => {
        this.emotionMotionPlaying = false;
        this.lastMotionKey = "";
        // An invite can start while the emotion motion is finishing. Let the
        // invite completion own the next presentation restore instead of
        // allowing this late promise callback to interrupt it.
        if (!this.disposed && !this.invitePlaying) this.applyPresentation(this.presentation);
      });
  }

  private fitModel(): void {
    if (!this.model) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const modelWidth = this.model.internalModel?.originalWidth ?? 5_800;
    const modelHeight = this.model.internalModel?.originalHeight ?? 8_400;
    // Frame the character, not the canvas: Live2D canvases carry transparent
    // padding, so canvas-fraction math leaves the model floating off-centre with
    // a gap under its feet on every page.
    const box = this.contentBox ?? { top: 0, bottom: 1, left: 0, right: 1 };
    const boxWidth = Math.max(0.05, box.right - box.left) * modelWidth;
    const boxHeight = Math.max(0.05, box.bottom - box.top) * modelHeight;
    const boxCenterX = ((box.left + box.right) / 2) * modelWidth;

    if (this.framing === "bust") {
      // Half-body framing: the top `BUST_HEIGHT_RATIO` of the character
      // (head through hands) fills the container height.
      const scale = (height / (boxHeight * WINDOW_LIVE2D_BUST_HEIGHT_RATIO)) * 0.98;
      this.model.scale.set(scale);
      this.model.position.set(
        width / 2 + (modelWidth * scale) / 2 - boxCenterX * scale,
        height * 0.02 - box.top * modelHeight * scale + (modelHeight * scale) / 2,
      );
      // 半身取景把内容盒顶边放在容器顶边之下 2%（见上面的 position）。
      this.publishInkTop(0.02);
      return;
    }

    // Full-body framing: the whole character fits, feet on the bottom edge.
    const scale = Math.min(width / boxWidth, height / boxHeight) * 0.98;
    this.model.scale.set(scale);
    this.model.position.set(
      width / 2 + (modelWidth * scale) / 2 - boxCenterX * scale,
      height * 0.98 - box.bottom * modelHeight * scale + (modelHeight * scale) / 2,
    );
    // 内容盒顶边 = (容器顶到脚底的距离) − 内容盒高度；按 min(宽比, 高比) 适配时，模型比
    // 容器瘦（宽比胜出）就会把头顶留在容器顶边之下——这段留白随缩放一起放大。
    this.publishInkTop(Math.max(0, (height * 0.98 - boxHeight * scale) / height));
  }

  /**
   * 把「角色**画出来的**顶边」按容器高度的分数写进容器（`--companion-model-ink-top`）。
   *
   * 气泡要悬在「她头顶之上 40px」，而容器顶边常常不是发际线：full 取景按
   * `min(宽比, 高比)` 适配，模型比容器瘦时头顶之下留白；用户把伴星放大（或相机变焦）时
   * 这段留白等比放大——只按容器顶定位的气泡就越飘越高，2026-09-20 用户截图："离的越来越
   * 远了"。分数而不是像素：容器被外层 gsap 缩放时，分数不变、像素会变。
   */
  private publishInkTop(ratio: number): void {
    const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    this.container.style.setProperty("--companion-model-ink-top", safe.toFixed(4));
  }

  /**
   * Measures the real content box from the model's drawables. Cubism canvases
   * reserve generous transparent margins; without this the framing maths works
   * on empty space and every page shows a small, floating character.
   */
  private measureContentBox(): void {
    this.contentBox = null;
    const internal = this.model?.internalModel;
    const count = internal?.coreModel?.getDrawableCount?.();
    if (!internal?.getDrawableBounds || typeof count !== "number" || count <= 0) return;

    const out: Live2DDrawableBounds = { x: 0, y: 0, width: 0, height: 0 };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      let bounds: Live2DDrawableBounds | undefined;
      try {
        bounds = internal.getDrawableBounds(index, out);
      } catch {
        bounds = undefined;
      }
      if (!bounds
        || !Number.isFinite(bounds.x)
        || !Number.isFinite(bounds.y)
        || !(bounds.width > 0)
        || !(bounds.height > 0)) continue;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }

    const modelWidth = internal.originalWidth ?? 0;
    const modelHeight = internal.originalHeight ?? 0;
    if (!(minX < maxX) || !(minY < maxY) || !(modelWidth > 0) || !(modelHeight > 0)) return;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    // Cubism drawable space is y-up, so the canvas top is the largest y.
    this.contentBox = {
      left: clamp01(minX / modelWidth),
      right: clamp01(maxX / modelWidth),
      top: clamp01(1 - maxY / modelHeight),
      bottom: clamp01(1 - minY / modelHeight),
    };
  }

  private renderCurrentFrame(): void {
    if (!this.app) return;
    try {
      this.app.renderer?.render(this.app.stage);
    } catch (error) {
      console.warn("[WindowLive2D] static frame render failed", error);
    }
  }
}
