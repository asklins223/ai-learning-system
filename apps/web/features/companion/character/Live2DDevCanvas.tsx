"use client";

import { useEffect, useRef, useState } from "react";
import { CompanionAvatar } from "@/components/learning-companion/CompanionAvatar";
import type { CompanionVisualStateV1 } from "@/lib/learning-companion/companion-visual-state";
import {
  LIVE2D_DEV_MODEL,
  motionForLive2DState,
  type Live2DDevLoadState,
} from "./live2d-dev-manifest";

type PixiPoint = {
  set: (x: number, y?: number) => void;
};

type PixiBounds = {
  width: number;
  height: number;
};

type Live2DModel = {
  anchor: PixiPoint;
  position: PixiPoint;
  scale: PixiPoint & { x: number; y: number };
  getLocalBounds?: () => PixiBounds;
  motion?: (group: string, index?: number, priority?: number) => void | Promise<unknown>;
  destroy?: () => void;
};

type PixiApplication = {
  stage: {
    addChild: (child: Live2DModel) => void;
  };
  screen: { width: number; height: number };
  destroy: (removeView?: boolean) => void;
};

type PixiGlobal = {
  Application: new (options: {
    view: HTMLCanvasElement;
    resizeTo: HTMLElement;
    autoStart: boolean;
    antialias: boolean;
    backgroundAlpha: number;
  }) => PixiApplication;
  live2d?: {
    Live2DModel?: {
      from: (modelUrl: string, options: { autoInteract: boolean }) => Promise<Live2DModel>;
    };
  };
};

declare global {
  interface Window {
    PIXI?: PixiGlobal;
    Live2DCubismCore?: unknown;
  }
}

interface Live2DDevCanvasProps {
  enabled: boolean;
  visualState?: CompanionVisualStateV1;
  onStatus?: (status: Live2DDevLoadState) => void;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-live2d-dev-src="${src}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    script.dataset.live2dDevSrc = src;
    script.async = false;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Live2D vendor script failed: ${src}`));
    if (!existing) {
      script.src = src;
      document.head.appendChild(script);
    }
  });
}

function getModelBounds(model: Live2DModel): PixiBounds {
  const bounds = model.getLocalBounds?.();
  if (bounds && bounds.width > 0 && bounds.height > 0) return bounds;
  return { width: 1, height: 1 };
}

export function Live2DDevCanvas({ enabled, visualState = "dormant", onStatus }: Live2DDevCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PixiApplication | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const [status, setStatus] = useState<Live2DDevLoadState>(enabled ? "loading" : "disabled");

  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  useEffect(() => {
    if (!enabled) {
      setStatus("disabled");
      return;
    }

    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const live2dRoot = root;
    const live2dCanvas = canvas;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    const setFallback = () => {
      if (!disposed) setStatus("fallback");
    };

    const fitModel = (model: Live2DModel, app: PixiApplication) => {
      const bounds = getModelBounds(model);
      const widthRatio = app.screen.width / Math.max(bounds.width, 1);
      const heightRatio = app.screen.height / Math.max(bounds.height, 1);
      const scale = Math.min(widthRatio, heightRatio) * 0.92;
      model.scale.set(scale);
      model.position.set(app.screen.width * 0.5, app.screen.height * 0.58);
    };

    async function mountModel() {
      setStatus("loading");
      try {
        for (const script of LIVE2D_DEV_MODEL.vendorScripts) {
          await loadScript(script);
        }

        const pixi = window.PIXI;
        const live2dModelFactory = pixi?.live2d?.Live2DModel;
        if (!pixi || !live2dModelFactory || !window.Live2DCubismCore) {
          throw new Error("Live2D runtime globals are unavailable");
        }

        const app = new pixi.Application({
          view: live2dCanvas,
          resizeTo: live2dRoot,
          autoStart: true,
          antialias: true,
          backgroundAlpha: 0,
        });
        appRef.current = app;

        const model = await live2dModelFactory.from(LIVE2D_DEV_MODEL.modelUrl, {
          autoInteract: false,
        });
        if (disposed) {
          model.destroy?.();
          app.destroy(true);
          return;
        }

        modelRef.current = model;
        model.anchor.set(0.5, 0.5);
        app.stage.addChild(model);
        fitModel(model, app);
        resizeObserver = new ResizeObserver(() => {
          if (!disposed && modelRef.current && appRef.current) {
            fitModel(modelRef.current, appRef.current);
          }
        });
        resizeObserver.observe(live2dRoot);
        setStatus("ready");
      } catch (error) {
        console.warn("[Live2D dev] fallback to Sprite", error);
        // from() 失败时 app 可能已创建（Pixi 渲染循环 + GPU 资源）：必须
        // 显式销毁，否则 fallback 后应用继续空转、资源在卸载前不释放。
        try {
          appRef.current?.destroy(true);
        } catch {
          // destroy 抛错不阻断 fallback
        }
        appRef.current = null;
        modelRef.current = null;
        setFallback();
      }
    }

    void mountModel();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      modelRef.current = null;
      appRef.current?.destroy(true);
      appRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (status !== "ready" || !modelRef.current) return;
    const cue = motionForLive2DState(visualState);
    void Promise.resolve(modelRef.current.motion?.(cue.group, cue.index, 2)).catch((error) => {
      console.warn("[Live2D dev] motion cue failed", { visualState, error });
    });
  }, [status, visualState]);

  return (
    <div
      ref={rootRef}
      className="live2d-dev-canvas-root"
      data-live2d-dev-model={LIVE2D_DEV_MODEL.id}
      data-live2d-dev-status={status}
      aria-label={status === "ready" ? "Mao PRO 临时 Live2D 角色" : "桌宠 Sprite 降级角色"}
    >
      {status === "ready" || status === "loading" ? (
        <canvas ref={canvasRef} className="live2d-dev-canvas" aria-hidden="true" />
      ) : (
        <CompanionAvatar
          state="dormant"
          size={190}
          ariaLabel="学习伴星 Sprite 降级角色"
          className="live2d-dev-fallback"
        />
      )}
      {status === "loading" ? (
        <span className="live2d-dev-loading" aria-hidden="true">加载临时 Live2D…</span>
      ) : null}
    </div>
  );
}
