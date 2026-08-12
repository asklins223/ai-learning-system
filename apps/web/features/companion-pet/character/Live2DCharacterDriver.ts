"use client";

import type { CharacterPresentationStateV1 } from "@ailearn/shared/companion-character-contracts";
import { COMPANION_LIVE2D_MANIFEST } from "./companion-live2d-manifest.ts";
import {
  LIVE2D_INVITE_ONCE_CUE,
  motionForLive2DPresentation,
} from "./live2d-motion-map";
import { arbitrateLive2DParameters } from "./live2d-priority";
import { clampLive2DParameter } from "./companion-live2d-manifest";
import { parameterRequestsForLive2DFrame } from "./live2d-parameter-frames";

/**
 * P4 Live2D driver (current Mao PRO model；Owner 批准 2026-08-11)。
 *
 * Loads the PIXI + Cubism vendor scripts, mounts `mao_pro.model3.json` into a
 * transparent canvas, and drives motions from the derived presentation.
 * On any load/runtime failure the Pet surface falls back to the Sprite
 * driver (Owner character). 模型许可边界见 companion-live2d-manifest.ts；
 * 再分发仍需遵守 Live2D Free Material 条款。
 */

type PixiPoint = {
  x: number;
  y: number;
  set: (x: number, y?: number) => void;
};
type PixiBounds = { width: number; height: number };
type PixiApplicationOptions = {
  view: HTMLCanvasElement;
  resizeTo: HTMLElement;
  autoStart: boolean;
  antialias: boolean;
  backgroundAlpha: number;
  context?: WebGLRenderingContext;
  resolution?: number;
  autoDensity?: boolean;
  preserveDrawingBuffer?: boolean;
};

type Live2DModel = {
  anchor: PixiPoint;
  position: PixiPoint;
  scale: PixiPoint & { x: number; y: number };
  getLocalBounds?: () => PixiBounds;
  internalModel?: { coreModel?: Live2DCoreModel };
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>;
  destroy?: () => void;
};

type Live2DCoreModel = {
  setParameterValueById?: (parameter: string, value: number, weight?: number) => void;
};

type PixiApplication = {
  stage: { addChild: (child: Live2DModel) => void };
  screen: { width: number; height: number };
  renderer: { render: (stage: { addChild: (child: Live2DModel) => void }) => void };
  ticker?: {
    add: (cb: () => void) => void;
    remove: (cb: () => void) => void;
    stop?: () => void;
    start?: () => void;
  };
  destroy: (removeView?: boolean) => void;
};

type PixiGlobal = {
  Application: new (options: PixiApplicationOptions) => PixiApplication;
  live2d?: {
    Live2DModel?: {
      from: (modelUrl: string, options: { autoInteract: boolean }) => Promise<Live2DModel>;
    };
  };
};

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

const live2dScriptPromises = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const pending = live2dScriptPromises.get(src);
  if (pending) return pending;
  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-live2d-pet-src="${src}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const script = existing ?? document.createElement("script");
    script.dataset.live2dPetSrc = src;
    script.async = false;
    const onLoad = () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      script.dataset.loaded = "true";
      resolve();
    };
    const onError = () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (!existing) script.remove();
      reject(new Error(`Live2D vendor script failed: ${src}`));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = src;
      document.head.appendChild(script);
    }
  });
  live2dScriptPromises.set(src, promise);
  void promise.then(() => {
    if (live2dScriptPromises.get(src) === promise) live2dScriptPromises.delete(src);
  }, () => {
    if (live2dScriptPromises.get(src) === promise) live2dScriptPromises.delete(src);
  });
  return promise;
}

function getUsableWebGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const context = (canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    stencil: true,
  }) ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  if (!context) return null;
  const maxTextureUnits = context.getParameter(context.MAX_TEXTURE_IMAGE_UNITS);
  return typeof maxTextureUnits === "number" && maxTextureUnits > 0 ? context : null;
}

export type Live2DDriverStatusV1 = "loading" | "ready" | "failed";

export interface Live2DCharacterDriverOptionsV1 {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  onStatus?: (status: Live2DDriverStatusV1) => void;
}

export class Live2DCharacterDriver {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly onStatus?: (status: Live2DDriverStatusV1) => void;
  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn("[Live2D] WebGL context lost — falling back to Sprite");
    this.onStatus?.("failed");
    // M7（审计修复）：onStatus 回调依赖 PetCharacterCanvas 的 React 卸载
    // 链路；若回调因组件卸载瞬间的 cancelled 被短路，PIXI app/ticker/GPU
    // 资源将无人释放。handler 内直接兜底 destroy（disposed 守卫幂等，
    // 后续 React cleanup 再调用是无害 no-op）。
    this.destroy();
  };
  private app: PixiApplication | null = null;
  private model: Live2DModel | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private lastCueKey = "";
  private inviteOncePlaying = false;
  private currentPresentation: CharacterPresentationStateV1 = "idle";
  private voiceLevel = 0;
  private readonly handleTicker = (): void => {
    if (this.disposed || !this.model) return;
    const core = this.model.internalModel?.coreModel;
    if (!core?.setParameterValueById) return;
    const requests = parameterRequestsForLive2DFrame({
      presentation: this.currentPresentation,
      nowMs: typeof performance === "undefined" ? Date.now() : performance.now(),
      voiceLevel: this.voiceLevel,
    });
    for (const request of arbitrateLive2DParameters(requests)) {
      const value = clampLive2DParameter(request.parameter, request.value);
      if (value === null) continue;
      try {
        core.setParameterValueById(request.parameter, value);
      } catch (error) {
        console.warn("[Live2D] parameter update failed — falling back to Sprite", error);
        this.onStatus?.("failed");
        this.destroy();
        return;
      }
    }
  };

  constructor(options: Live2DCharacterDriverOptionsV1) {
    this.canvas = options.canvas;
    this.container = options.container;
    this.onStatus = options.onStatus;
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    this.onStatus?.("loading");
    // §8.3 步骤 7：WebGL context lost → 自动回退（PetCharacterCanvas 切 Sprite）。
    this.canvas.addEventListener(
      "webglcontextlost",
      this.handleContextLost,
    );
    try {
      for (const script of COMPANION_LIVE2D_MANIFEST.vendorScripts) {
        await loadScript(script);
      }
      const pixi = (window as unknown as { PIXI?: PixiGlobal }).PIXI;
      const factory = pixi?.live2d?.Live2DModel;
      if (!pixi || !factory || !window.Live2DCubismCore) {
        throw new Error("Live2D runtime globals unavailable");
      }
      // Pixi's sprite batcher throws when the browser exposes zero usable
      // texture units (common in software/headless WebGL). Detect that before
      // constructing Pixi so the Sprite fallback stays quiet and deterministic.
      const webglContext = getUsableWebGLContext(this.canvas);
      if (!webglContext) {
        throw new Error("Live2D WebGL texture capacity unavailable");
      }
      const app = new pixi.Application({
        view: this.canvas,
        context: webglContext,
        resizeTo: this.container,
        autoStart: true,
        antialias: true,
        backgroundAlpha: 0,
        preserveDrawingBuffer: true,
        // Retina 清晰度：canvas 像素尺寸 = CSS 尺寸 × devicePixelRatio，
        // 避免 244px 画布被拉伸显示导致模糊。
        resolution: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        autoDensity: true,
      });
      if (this.disposed) {
        // React owns the canvas DOM node; PIXI must release GPU resources
        // without removing that node from the tree.
        app.destroy(false);
        return;
      }
      this.app = app;
      const model = await factory.from(COMPANION_LIVE2D_MANIFEST.modelUrl, {
        autoInteract: false,
      });
      if (this.disposed) {
        model.destroy?.();
        app.destroy(false);
        return;
      }
      if (!model.internalModel?.coreModel?.setParameterValueById) {
        model.destroy?.();
        app.destroy(false);
        throw new Error("Live2D core parameter API unavailable");
      }
      this.model = model;
      model.anchor.set(0.5, 0.5);
      app.stage.addChild(model);
      if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
        // Q1 fix：probe 仅用于开发期诊断，不得在生产暴露内部模型结构。
        (window as unknown as { __PET_LIVE2D_PROBE__?: unknown }).__PET_LIVE2D_PROBE__ = () => {
          const internal = (model as unknown as { internalModel?: Record<string, unknown> }).internalModel;
          const core = (internal?.coreModel ?? internal) as Record<string, unknown> | undefined;
          return {
            internalKeys: internal ? Object.keys(internal).slice(0, 30) : null,
            coreKeys: core ? Object.keys(core).slice(0, 30) : null,
            canvasWidth: typeof core?.getCanvasWidth === "function" ? (core as { getCanvasWidth: () => number }).getCanvasWidth() : null,
            canvasHeight: typeof core?.getCanvasHeight === "function" ? (core as { getCanvasHeight: () => number }).getCanvasHeight() : null,
            originalWidth: internal?.originalWidth ?? null,
            originalHeight: internal?.originalHeight ?? null,
            width: internal?.width ?? null,
            height: internal?.height ?? null,
            pixelsPerUnit: internal?.pixelsPerUnit ?? null,
            centeringTransform: internal?.centeringTransform ?? null,
            scale: model.scale?.x ?? null,
            position: model.position ? { x: model.position.x, y: model.position.y } : null,
          };
        };
      }
      this.fitModel();
      app.ticker?.add(this.handleTicker);
      // 动画姿势变化引起的轻微 bbox 波动在可接受范围（帽尖余量 10px）；
      // 不再每帧校正（曾与 PIXI autoStart 渲染竞争导致读数混沌发散）。
      this.resizeObserver = new ResizeObserver(() => this.fitModel());
      this.resizeObserver.observe(this.container);
      this.onStatus?.("ready");
      this.applyPresentation(this.currentPresentation);
    } catch (error) {
      if (!this.disposed) {
        console.warn("[Live2D] falling back to Sprite", error);
        this.onStatus?.("failed");
      }
      this.destroy();
    }
  }

  /** Apply a derived presentation: plays the mapped motion on change. */
  setPresentation(presentation: CharacterPresentationStateV1): void {
    this.currentPresentation = presentation;
    if (this.disposed || !this.model || this.inviteOncePlaying) return;
    this.applyPresentation(presentation);
  }

  /** Set normalized playback amplitude for the lipsync parameter layer. */
  setVoiceLevel(level: number): void {
    this.voiceLevel = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  }

  /** Character click: play the single-shot invite cue once, then idle. */
  playInviteOnce(): void {
    if (this.disposed || !this.model) return;
    this.inviteOncePlaying = true;
    void Promise.resolve(this.model.motion?.(LIVE2D_INVITE_ONCE_CUE.group, LIVE2D_INVITE_ONCE_CUE.index, 2))
      .catch((error) => console.warn("[Live2D] invite cue failed", error))
      .finally(() => {
        this.inviteOncePlaying = false;
        if (!this.disposed) this.applyPresentation(this.currentPresentation);
      });
  }

  /** Hide the model surface (presentation === hidden). */
  setHidden(hidden: boolean): void {
    if (this.canvas.parentElement) {
      this.canvas.parentElement.style.visibility = hidden ? "hidden" : "visible";
    }
    // hidden/occluded 时停 PIXI ticker：窗口被遮挡(occluded)时 rAF 不会自动
    // 暂停，参数循环与渲染继续空转 GPU/CPU。恢复时再启动。
    const ticker = this.app?.ticker;
    if (!ticker) return;
    if (hidden) {
      ticker.stop?.();
    } else {
      ticker.start?.();
    }
  }

  destroy(): void {
    this.disposed = true;
    this.inviteOncePlaying = false;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.app?.ticker?.remove(this.handleTicker);
    this.model = null;
    if (typeof window !== "undefined") {
      delete (window as unknown as { __PET_LIVE2D_PROBE__?: unknown }).__PET_LIVE2D_PROBE__;
    }
    // Never ask PIXI to remove a React-managed canvas. Doing so races React
    // unmount/key replacement and produces removeChild errors.
    this.app?.destroy(false);
    this.app = null;
  }

  private applyPresentation(presentation: CharacterPresentationStateV1): void {
    if (!this.model) return;
    const cue = motionForLive2DPresentation(presentation);
    const key = cue ? `${cue.group}|${cue.index}` : "hidden";
    if (key === this.lastCueKey) return;
    this.lastCueKey = key;
    if (!cue) return;
    void Promise.resolve(this.model.motion?.(cue.group, cue.index, 2)).catch((error) => {
      console.warn("[Live2D] presentation cue failed", { presentation, error });
    });
  }

  // ── 几何定位（重构终版） ─────────────────────────────────────────
  // 经诊断确认（probe）：pixi-live2d 的 Live2DModel 在 anchor(0.5,0.5) 下
  // position = 模型画布中心；getBounds 高 = originalHeight×scale 精确。
  // 因此直接用模型画布像素尺寸（originalWidth/Height）计算 scale 与
  // position，不再依赖 bounds 推算或 readPixels 校准（两者均被证明
  // 不可靠：centeringTransform 偏移 / PIXI 清屏色污染）。
  private static readonly TARGET_TOP = 150; // 容器内 CSS（窗口同坐标）：头顶位置
  private static readonly TARGET_BOTTOM = 504; // 合同 foot y
  private static readonly TARGET_H = Live2DCharacterDriver.TARGET_BOTTOM - Live2DCharacterDriver.TARGET_TOP;

  private fitModel(): void {
    if (!this.model || !this.app) return;
    const internal = (this.model as unknown as {
      internalModel?: { originalWidth?: number; originalHeight?: number };
    }).internalModel;
    const canvasW = internal?.originalWidth ?? 5800;
    const canvasH = internal?.originalHeight ?? 8400;
    // 画布高 → 354 CSS；画布宽按同比例
    const scale = Live2DCharacterDriver.TARGET_H / canvasH;
    this.model.scale.set(scale);
    const renderedW = canvasW * scale;
    // anchor(0.5,0.5)：position = 画布中心。
    // 垂直：画布底 = 脚底 504 → 中心 y = 504 - 354/2。
    // 水平：画布左缘贴容器左缘 → 中心 x = 画布宽/2。
    this.model.position.set(renderedW / 2, Live2DCharacterDriver.TARGET_BOTTOM - Live2DCharacterDriver.TARGET_H / 2);
  }
}
