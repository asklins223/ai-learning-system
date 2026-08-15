"use client";

import React from "react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { LIQUID_ORB_WGSL } from "./liquid-orb-shader";
import {
  buildOrbUniformValues,
  ORB_PRESET_STYLE,
  ORB_UNIFORM_FLOATS,
  resolveOrbThemeColors,
  type LiquidOrbPresetV1,
  type LiquidOrbToneV1,
} from "./liquid-orb-presets";

// 样式由使用方页面引入（项目约定页面级 CSS import，组件不内联 CSS，
// 保证 node --test 的 SSR 渲染链不被 CSS 解析阻塞）：
//   - 桌宠页：app/(pet)/companion/pet/page.tsx
//   - 学习运行页：app/styles/learning-run.css 同级引入
// 见 liquid-orb.css 顶部注释。

export interface LiquidOrbProps {
  /** 液态玻璃球的 flow program（siri 聆听 / spectrum 处理 / voice 播报 / drop 待命）。 */
  preset: LiquidOrbPresetV1;
  /** 主题色角色：running=青、warning=琥珀、action=绿。 */
  tone?: LiquidOrbToneV1;
  /** 球体 CSS 尺寸（px），默认 96。 */
  size?: number;
  /** 球体半径（相对画布短边），默认取 preset 表。 */
  radius?: number;
  /** 0..1 运动幅度：待命低幅、全幅。 */
  intensity?: number;
  /** 窗口被遮挡等场景暂停渲染（保留最后一帧）。 */
  paused?: boolean;
  /** 强制动效关闭（调用方已有 prefers-reduced-motion / animationOff 时传入）。 */
  reducedMotion?: boolean;
  /** 装饰性说明（画布 aria-hidden，状态文案由调用方负责）。 */
  label?: string;
  className?: string;
  style?: CSSProperties;
  /** WebGPU 不可用 / SSR / 初始化失败时的兜底内容（默认呼吸圆点）。 */
  fallback?: ReactNode;
}

type RenderModeV1 = "fallback" | "webgpu";

function DefaultFallback() {
  return <i className="liquid-orb-dot" aria-hidden="true" />;
}

/**
 * 语音视觉 WebGPU 液态玻璃球（模板 Liquid Orb 的 React 封装）。
 *
 * - 挂载后异步初始化 WebGPU；不可用/失败静默回退到 CSS 兜底（旧视觉），
 *   绝不让语音功能因视觉不可用而失败。
 * - 单实例常驻：preset/tone 切换只重建 uniform，不重建 device/pipeline。
 * - 遮挡（paused）、reduced-motion、页面隐藏时停帧；主题切换实时换色。
 */
export function LiquidOrb({
  preset,
  tone = "running",
  size = 96,
  radius,
  intensity = 1,
  paused = false,
  reducedMotion,
  label,
  className,
  style,
  fallback,
}: LiquidOrbProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<RenderModeV1>("fallback");
  const [mediaReduced, setMediaReduced] = useState(false);
  const reduced = reducedMotion ?? mediaReduced;

  // 每帧/每次 props 变化都能读到最新值（rAF 闭包不重建）。
  const runtimeRef = useRef({ paused, reduced });
  runtimeRef.current = { paused, reduced };
  // writeUniforms 读最新视觉参数（避免挂载时闭包过期）。
  const visualRef = useRef({ preset, tone, intensity, radius });
  visualRef.current = { preset, tone, intensity, radius };

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setMediaReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setMediaReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const deviceRef = useRef<GPUDevice | null>(null);
  const contextRef = useRef<GPUCanvasContext | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);
  const bindGroupRef = useRef<GPUBindGroup | null>(null);
  const uniformBufferRef = useRef<GPUBuffer | null>(null);
  const valuesRef = useRef<Float32Array>(new Float32Array(ORB_UNIFORM_FLOATS));
  const startedAtRef = useRef(0);
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const disposedRef = useRef(false);
  const writeUniformsRef = useRef<(() => void) | null>(null);
  const controlRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  // 视觉参数变化 → 重建 uniform（同一 device/pipeline，便宜）。
  useEffect(() => {
    const write = writeUniformsRef.current;
    if (mode !== "webgpu" || !write) return;
    write();
  }, [mode, preset, tone, radius, intensity]);

  // paused / reduced 变化 → 停帧或恢复。
  useEffect(() => {
    if (mode !== "webgpu") return;
    const control = controlRef.current;
    if (!control) return;
    const shouldRun = !runtimeRef.current.paused
      && !runtimeRef.current.reduced
      && document.visibilityState !== "hidden";
    if (shouldRun) control.start();
    else control.stop();
  }, [mode, paused, reduced]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    // 显式非空标注：init/frame 闭包内 TS 不保留 flow 收窄。
    const canvasEl: HTMLCanvasElement = canvas;

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        // 尺寸在下一帧由 frame() 读取 canvas.clientWidth 后写入。
      });
    resizeObserver?.observe(host);
    const themeObserver = new MutationObserver(() => {
      writeUniformsRef.current?.();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const stopLoop = () => {
      runningRef.current = false;
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };

    const shouldRun = () => !runtimeRef.current.paused
      && !runtimeRef.current.reduced
      && document.visibilityState !== "hidden";

    const frame = (now: number) => {
      if (disposedRef.current) return;
      const device = deviceRef.current;
      const context = contextRef.current;
      const pipeline = pipelineRef.current;
      const bindGroup = bindGroupRef.current;
      const uniformBuffer = uniformBufferRef.current;
      if (!device || !context || !pipeline || !bindGroup || !uniformBuffer) return;
      if (!shouldRun()) {
        runningRef.current = false;
        return;
      }
      try {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(canvasEl.clientWidth * dpr));
        const height = Math.max(1, Math.floor(canvasEl.clientHeight * dpr));
        if (canvasEl.width !== width || canvasEl.height !== height) {
          canvasEl.width = width;
          canvasEl.height = height;
        }
        const values = valuesRef.current;
        values[0] = width;
        values[1] = height;
        values[2] = startedAtRef.current ? (now - startedAtRef.current) / 1000 : 0;
        device.queue.writeBuffer(uniformBuffer, 0, values);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        rafRef.current = window.requestAnimationFrame(frame);
      } catch (error) {
        console.error("[liquid-orb] frame failed:", error);
        fallbackNow();
      }
    };

    const startLoop = () => {
      if (runningRef.current || disposedRef.current || !deviceRef.current) return;
      runningRef.current = true;
      rafRef.current = window.requestAnimationFrame(frame);
    };

    const fallbackNow = () => {
      if (disposedRef.current) return;
      stopLoop();
      deviceRef.current?.destroy();
      deviceRef.current = null;
      contextRef.current = null;
      pipelineRef.current = null;
      bindGroupRef.current = null;
      uniformBufferRef.current = null;
      setMode("fallback");
    };

    controlRef.current = { start: startLoop, stop: stopLoop };

    const onVisibility = () => {
      if (shouldRun()) startLoop();
      else stopLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let cancelled = false;
    async function init(): Promise<void> {
      try {
        if (typeof navigator === "undefined" || !navigator.gpu) return;
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
        if (!adapter || cancelled || disposedRef.current) return;
        const device = await adapter.requestDevice();
        if (cancelled || disposedRef.current) {
          device.destroy();
          return;
        }
        const context = canvasEl.getContext("webgpu") as GPUCanvasContext | null;
        if (!context) throw new Error("无法创建 WebGPU 画布上下文");
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "premultiplied" });

        const shader = device.createShaderModule({ code: LIQUID_ORB_WGSL });
        const compilation = await shader.getCompilationInfo();
        const errors = compilation.messages.filter((message) => message.type === "error");
        if (errors.length) {
          throw new Error(
            errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n"),
          );
        }

        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module: shader, entryPoint: "vs_main" },
          fragment: {
            module: shader,
            entryPoint: "fs_main",
            targets: [{ format }],
          },
          primitive: { topology: "triangle-list" },
        });
        const uniformBuffer = device.createBuffer({
          size: valuesRef.current.byteLength,
          // GPUBufferUsage.UNIFORM(64) | GPUBufferUsage.COPY_DST(8)
          usage: 64 | 8,
        });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });

        const writeUniforms = () => {
          if (!device || !uniformBuffer || disposedRef.current) return;
          const visual = visualRef.current;
          const colors = resolveOrbThemeColors(visual.tone);
          valuesRef.current = buildOrbUniformValues({
            size: { width: 1, height: 1 },
            style: ORB_PRESET_STYLE[visual.preset],
            intensity: visual.intensity,
            radius: visual.radius,
            colors,
          });
          device.queue.writeBuffer(uniformBuffer, 0, valuesRef.current);
        };

        deviceRef.current = device;
        contextRef.current = context;
        pipelineRef.current = pipeline;
        bindGroupRef.current = bindGroup;
        uniformBufferRef.current = uniformBuffer;
        writeUniformsRef.current = writeUniforms;
        startedAtRef.current = performance.now();
        writeUniforms();

        device.lost.then((info) => {
          if (disposedRef.current) return;
          console.warn(`[liquid-orb] WebGPU 设备已断开：${info.message || info.reason}`);
          fallbackNow();
        });
        device.addEventListener("uncapturederror", (event) => {
          event.preventDefault();
          if (disposedRef.current) return;
          console.warn(`[liquid-orb] WebGPU 渲染错误：${event.error.message}`);
          fallbackNow();
        });

        if (cancelled || disposedRef.current) {
          device.destroy();
          deviceRef.current = null;
          return;
        }
        setMode("webgpu");
        if (shouldRun()) startLoop();
      } catch (error) {
        console.error("[liquid-orb] WebGPU 初始化失败，回退 CSS 视觉:", error);
        if (!cancelled && !disposedRef.current) fallbackNow();
      }
    }

    void init();

    return () => {
      cancelled = true;
      disposedRef.current = true;
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      controlRef.current = null;
      writeUniformsRef.current = null;
      deviceRef.current?.destroy();
      deviceRef.current = null;
      contextRef.current = null;
      pipelineRef.current = null;
      bindGroupRef.current = null;
      uniformBufferRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span
      ref={hostRef}
      className={`liquid-orb${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, ...style }}
      data-liquid-orb={mode}
      data-liquid-orb-preset={preset}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <canvas
        ref={canvasRef}
        className="liquid-orb-canvas"
        hidden={mode === "fallback"}
        aria-hidden="true"
      />
      <span className="liquid-orb-fallback" hidden={mode === "webgpu"}>
        {fallback ?? <DefaultFallback />}
      </span>
    </span>
  );
}
