"use client";

import { useEffect, useRef, useState } from "react";
import { usePetVoiceLevel } from "../runtime/PetRuntimeProvider";
import type { DesktopPetScaleV1 } from "@ailearn/shared/desktop-pet-contracts";
import type { CharacterPresentationStateV1 } from "@ailearn/shared/companion-character-contracts";
import { loadSpriteAssetPack } from "./sprite-asset-validator";
import {
  SpriteCharacterDriver,
  type SpriteHitMaskV1,
  type SpriteLayoutV1,
} from "./SpriteCharacterDriver";
import { Live2DCharacterDriver } from "./Live2DCharacterDriver";
import { COMPANION_LIVE2D_MANIFEST } from "./companion-live2d-manifest.ts";
import { shouldLoadLive2D } from "./live2d-gate.ts";

/**
 * Character renderer: current P4 Live2D model first, Sprite (Owner
 * character) as automatic fallback. `live2dEnabled` is a server-granted
 * capability; reduced motion, animationOff, load failures and context loss
 * still force Sprite.
 */

export interface PetCharacterCanvasProps {
  presentation: CharacterPresentationStateV1;
  side: "bubble-left" | "bubble-right";
  petScale: DesktopPetScaleV1;
  reducedMotion: boolean;
  animationOff: boolean;
  mirror: boolean;
  /** Server-granted P4 Live2D capability. */
  live2dEnabled?: boolean;
  /** 2026-08-11（性能专项）：窗口被完全遮挡——暂停渲染（不中止会话/语音）。 */
  occluded?: boolean;
  /** Incrementing counter: play the single-shot invite cue on change. */
  inviteOnceTrigger?: number;
  /** Called with Sprite hit-test functions once the Sprite driver is ready. */
  onSpriteReady?: (
    hitTest: (point: { x: number; y: number }) => boolean,
    getHitMask: () => SpriteHitMaskV1 | null,
  ) => void;
  /**
   * §6.3：实际渲染模式变化（loading 期间不回调）。Live2D 失败回退 Sprite 后
   * 上层必须改用 Sprite rect + alpha mask 注册命中几何，否则 mask 错位。
   */
  onRenderModeChange?: (live2dActive: boolean) => void;
  /** Position/size in the 560×520 content coordinate space. */
  style?: React.CSSProperties;
  /** Live2D stage: full-height character column (larger than the Sprite slot). */
  live2dStageSize?: { width: number; height: number };
  className?: string;
}

export type CharacterRenderModeV1 =
  | "loading"
  | "live2d"
  | "sprite"
  | "sprite-loading"
  | "error";

export function PetCharacterCanvas({
  presentation,
  side,
  petScale,
  reducedMotion,
  animationOff,
  mirror,
  live2dEnabled = false,
  occluded = false,
  inviteOnceTrigger = 0,
  onSpriteReady,
  onRenderModeChange,
  style,
  live2dStageSize,
  className,
}: PetCharacterCanvasProps) {
  // P1（性能）fix：voiceLevel 从独立 context 订阅，不再经由 props 穿透
  // PetSurface —— 电平每 100ms 变化只重渲染本画布，不触发整棵 surface。
  const voiceLevel = usePetVoiceLevel();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const spriteDriverRef = useRef<SpriteCharacterDriver | null>(null);
  const live2dDriverRef = useRef<Live2DCharacterDriver | null>(null);
  const [mode, setMode] = useState<CharacterRenderModeV1>("loading");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onSpriteReadyRef = useRef(onSpriteReady);
  onSpriteReadyRef.current = onSpriteReady;
  const onRenderModeChangeRef = useRef(onRenderModeChange);
  onRenderModeChangeRef.current = onRenderModeChange;
  const renderPropsRef = useRef({ presentation, side, petScale, reducedMotion, animationOff, mirror, voiceLevel });
  renderPropsRef.current = { presentation, side, petScale, reducedMotion, animationOff, mirror, voiceLevel };

  // §6.3：实际渲染模式变化通知上层（loading 不回调，初始状态由 live2dEnabled
  // 决定；Live2D 失败回退 Sprite 时上层必须同步切换命中几何）。
  useEffect(() => {
    if (mode === "loading") return;
    onRenderModeChangeRef.current?.(mode === "live2d");
  }, [mode]);

  // ── Renderer bootstrap: current Live2D first, Sprite fallback ──────────
  useEffect(() => {
    let cancelled = false;
    let live2d: Live2DCharacterDriver | null = null;
    let sprite: SpriteCharacterDriver | null = null;
    let spriteMountFrame: number | null = null;

    const mountSprite = async () => {
      if (cancelled || !canvasRef.current) return;
      const result = await loadSpriteAssetPack();
      if (cancelled || !canvasRef.current) return;
      if (!result.ok) {
        setMode("error");
        return;
      }
      sprite = new SpriteCharacterDriver({ canvas: canvasRef.current, pack: result.pack });
      try {
        await sprite.init();
      } catch {
        if (!cancelled) setMode("error");
        sprite?.destroy();
        return;
      }
      if (cancelled) {
        sprite.destroy();
        return;
      }
      spriteDriverRef.current = sprite;
      setMode("sprite");
      onSpriteReadyRef.current?.(
        (point) => sprite?.hitTest(point) ?? false,
        () => sprite?.getCurrentHitMask() ?? null,
      );
      const current = renderPropsRef.current;
      sprite.setLayout({
        side: current.side,
        petScale: current.petScale,
        reducedMotion: current.reducedMotion,
        animationOff: current.animationOff,
        mirror: current.mirror,
        devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      });
      sprite.setPresentation(current.presentation);
      sprite.resume();
    };

    const mountLive2d = () => {
      if (!canvasRef.current || !containerRef.current) return;
      live2d = new Live2DCharacterDriver({
        canvas: canvasRef.current,
        container: containerRef.current,
        onStatus: (status) => {
          if (cancelled) return;
          if (status === "ready") {
            setMode("live2d");
            live2d?.setVoiceLevel(renderPropsRef.current.voiceLevel);
            live2d?.setPresentation(renderPropsRef.current.presentation);
          } else if (status === "failed") {
            // A canvas that has already created a WebGL context cannot later
            // provide a 2D context. Switch the React key first so Sprite gets
            // a fresh canvas, then mount it on the next animation frame.
            live2d?.destroy();
            live2dDriverRef.current = null;
            setMode("sprite-loading");
            spriteMountFrame = window.requestAnimationFrame(() => {
              spriteMountFrame = null;
              void mountSprite();
            });
          }
        },
      });
      live2dDriverRef.current = live2d;
      void live2d.init();
    };

    setMode("loading");
    if (shouldLoadLive2D({ live2dEnabled, reducedMotion, animationOff })) {
      mountLive2d();
    } else {
      setMode("sprite-loading");
      spriteMountFrame = window.requestAnimationFrame(() => {
        spriteMountFrame = null;
        void mountSprite();
      });
    }

    return () => {
      cancelled = true;
      if (spriteMountFrame !== null) window.cancelAnimationFrame(spriteMountFrame);
      live2d?.destroy();
      live2dDriverRef.current = null;
      sprite?.destroy();
      spriteDriverRef.current = null;
    };
  }, [live2dEnabled, reducedMotion, animationOff]);

  // ── Presentation / layout changes ──────────────────────────────────────
  useEffect(() => {
    const current = modeRef.current;
    if (current === "live2d") {
      const hidden = presentation === "hidden";
      live2dDriverRef.current?.setHidden(hidden);
      if (!hidden) live2dDriverRef.current?.setPresentation(presentation);
      return;
    }
    if (current !== "sprite") return;
    const driver = spriteDriverRef.current;
    if (!driver) return;
    const layout: Partial<SpriteLayoutV1> = {
      side,
      petScale,
      reducedMotion,
      animationOff,
      mirror,
      devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    };
    driver.setLayout(layout);
    driver.setPresentation(presentation);
    if (presentation === "hidden" || occluded) {
      driver.pause();
    } else {
      driver.resume();
    }
  }, [presentation, side, petScale, reducedMotion, animationOff, mirror, mode, occluded]);

  // P1（性能）fix：voiceLevel（每 100ms 变化）只驱动 Live2D 口型/呼吸层，
  // 不再触发上方整个渲染布局 effect 重跑（sprite 模式无口型，直接跳过）。
  useEffect(() => {
    if (modeRef.current === "live2d") {
      live2dDriverRef.current?.setVoiceLevel(voiceLevel);
    }
  }, [voiceLevel]);

  // ── Character click → invite-once cue (then back to idle) ─────────────
  const lastInviteRef = useRef(inviteOnceTrigger);
  const inviteTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (inviteOnceTrigger === lastInviteRef.current) return;
    lastInviteRef.current = inviteOnceTrigger;
    if (modeRef.current === "live2d") {
      live2dDriverRef.current?.playInviteOnce();
    } else if (modeRef.current === "sprite") {
      const driver = spriteDriverRef.current;
      if (driver) {
        driver.setPresentation("invite");
        // Q2 fix：invite 回退定时器须跟踪清理，卸载/重触发时不得残留
        // 旧 timer 在已卸载组件上改 presentation。
        if (inviteTimerRef.current !== null) window.clearTimeout(inviteTimerRef.current);
        inviteTimerRef.current = window.setTimeout(() => {
          inviteTimerRef.current = null;
          if (modeRef.current === "sprite") {
            spriteDriverRef.current?.setPresentation(renderPropsRef.current.presentation);
          }
        }, 520);
      }
    }
  }, [inviteOnceTrigger]);

  // ── Cleanup ────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // Q2 fix：卸载时清理 invite 回退定时器。
      if (inviteTimerRef.current !== null) {
        window.clearTimeout(inviteTimerRef.current);
        inviteTimerRef.current = null;
      }
      live2dDriverRef.current?.destroy();
      live2dDriverRef.current = null;
      spriteDriverRef.current?.destroy();
      spriteDriverRef.current = null;
    };
  }, []);

  if (mode === "error") {
    return (
      <div className="pet-character-fallback" role="status" aria-label="角色资产不可用">
        <span>角色资产校验未通过，已停用桌面角色。</span>
      </div>
    );
  }

  const containerStyle: React.CSSProperties | undefined = live2dEnabled && live2dStageSize
    ? {
        position: "absolute",
        left: side === "bubble-left" ? 300 : 0,
        top: 0,
        width: live2dStageSize.width,
        height: live2dStageSize.height,
      }
    : style;

  return (
    <div
      ref={containerRef}
      className={`pet-character-renderer pet-character-renderer-${mode} ${className ?? ""}`}
      style={containerStyle}
      data-renderer={mode}
      data-live2d-model={mode === "live2d" ? COMPANION_LIVE2D_MANIFEST.modelId : undefined}
      aria-label={mode === "live2d" ? "Mao PRO Live2D 角色" : "学习伴星角色"}
    >
      <canvas
        key={mode === "loading" || mode === "live2d" ? "live2d-canvas" : "sprite-canvas"}
        ref={canvasRef}
        className={`pet-character-canvas ${mode === "sprite" || mode === "sprite-loading" ? "is-sprite" : ""}`}
        role="img"
        aria-hidden="true"
      />
      {mode === "sprite-loading" ? (
        <span className="pet-character-loading" aria-hidden="true">加载角色…</span>
      ) : null}
      {mode === "loading" ? (
        <span className="pet-character-loading" aria-hidden="true">加载 Live2D…</span>
      ) : null}
    </div>
  );
}
