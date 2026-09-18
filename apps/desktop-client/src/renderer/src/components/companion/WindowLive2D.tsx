import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEventHandler,
} from "react";
import { WindowLive2DDriver } from "./WindowLive2DDriver";
import {
  WINDOW_LIVE2D_ASSETS,
  type WindowLive2DMotionMode,
  type WindowLive2DFraming,
  type WindowLive2DPresentation,
  type WindowLive2DStatus,
} from "./window-live2d-contract";
import { subscribeHomeV2VoiceLevel } from "../../app/companion-voice-level";
import type { Live2DEmotionEvent } from "./live2d-emotion";

export interface WindowLive2DProps {
  /** Whether the in-window companion surface is present and allowed to run. */
  readonly active: boolean;
  /** Keeps the current frame visible while suspending the Live2D ticker. */
  readonly paused?: boolean;
  /** `lite`, `off` and reduced motion retain the last Live2D frame but stop its ticker. */
  readonly motionMode: WindowLive2DMotionMode;
  readonly presentation?: WindowLive2DPresentation;
  /** `full` keeps the whole character visible; `bust` frames head and torso. */
  readonly framing?: WindowLive2DFraming;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly onStatus?: (status: WindowLive2DStatus) => void;
  /** Increment this value to request a one-shot invite motion from the parent. */
  readonly inviteTrigger?: number;
  /** Click/keyboard intent only; the parent remains owner of state transitions. */
  readonly onInviteRequest?: () => void;
  readonly onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerMove?: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerUp?: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerCancel?: PointerEventHandler<HTMLButtonElement>;
  readonly onLostPointerCapture?: PointerEventHandler<HTMLButtonElement>;
  /** Optional normalized amplitude for the `speak` mouth parameter, from 0 to 1. */
  readonly voiceLevel?: number;
  /** Latest semantic emotion event; the driver smooths and expires it. */
  readonly emotion?: Live2DEmotionEvent | null;
  readonly ariaLabel?: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Window-contained companion renderer. It renders only into this React-owned
 * element; native desktop-pet windows remain an explicitly separate future
 * capability.
 */
export function WindowLive2D({
  active,
  paused = false,
  motionMode,
  presentation = "idle",
  framing = "full",
  className,
  style,
  onStatus,
  inviteTrigger = 0,
  onInviteRequest,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  voiceLevel = 0,
  emotion = null,
  ariaLabel = "AI 伴星",
}: WindowLive2DProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<WindowLive2DDriver | null>(null);
  const lastInviteTriggerRef = useRef(inviteTrigger);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const runtimePaused = paused || motionMode !== "full" || reducedMotion;
  const pausedRef = useRef(runtimePaused);
  const [status, setStatus] = useState<WindowLive2DStatus>("loading");
  pausedRef.current = runtimePaused;

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) {
      setStatus("unavailable");
      return;
    }

    let cancelled = false;
    const driver = new WindowLive2DDriver({
      canvas,
      container,
      onStatus: (nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus === "failed" ? "unavailable" : nextStatus);
      },
    });

    driverRef.current = driver;
    setStatus("loading");
    driver.setPresentation(presentation);
    driver.setVoiceLevel(voiceLevel);
    const syncPaused = () => driver.setPaused(pausedRef.current || document.hidden || !document.hasFocus());
    syncPaused();
    void driver.init();

    document.addEventListener("visibilitychange", syncPaused);
    window.addEventListener("focus", syncPaused);
    window.addEventListener("blur", syncPaused);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", syncPaused);
      window.removeEventListener("focus", syncPaused);
      window.removeEventListener("blur", syncPaused);
      driver.destroy();
      if (driverRef.current === driver) driverRef.current = null;
    };
  }, []);

  useEffect(() => {
    driverRef.current?.setPaused(runtimePaused || document.hidden || !document.hasFocus());
  }, [runtimePaused, status]);

  useEffect(() => {
    driverRef.current?.setPresentation(presentation);
  }, [presentation, status]);

  useEffect(() => {
    driverRef.current?.setFraming(framing);
  }, [framing, status]);

  useEffect(() => {
    driverRef.current?.setVoiceLevel(voiceLevel);
  }, [voiceLevel]);

  useEffect(() => {
    if (!emotion) return;
    driverRef.current?.pushEmotion(emotion);
    // `inviteTrigger` is the event revision for repeated touch gestures. The
    // semantic emotion can be identical across two gestures, so depending
    // only on its primitive fields would silently drop the second event after
    // the controller's hold/decay window has expired.
  }, [emotion?.emotion, emotion?.intensity, emotion?.at, inviteTrigger, status]);

  // Speech amplitude is sampled every animation frame. Subscribe directly to
  // the tiny imperative channel so mouth motion never rerenders the room (and
  // never disturbs companion placement while a cue is playing).
  useEffect(() => subscribeHomeV2VoiceLevel((level) => {
    driverRef.current?.setVoiceLevel(level);
  }), []);

  useEffect(() => {
    if (inviteTrigger === lastInviteTriggerRef.current) return;
    if (status !== "ready") return;

    lastInviteTriggerRef.current = inviteTrigger;
    driverRef.current?.playInviteOnce();
  }, [inviteTrigger, status]);

  const effectiveStatus: WindowLive2DStatus = status;
  const rootClassName = ["window-live2d", className].filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      // 唯一形态：ready 即 Live2D；否则为"不可用"，由父组件隐藏并给说明。
      data-companion-renderer={effectiveStatus === "ready" ? "live2d" : "unavailable"}
      data-companion-status={effectiveStatus}
      data-motion-mode={motionMode}
      data-paused={runtimePaused || undefined}
      data-presentation={presentation}
      role="group"
      aria-label={ariaLabel}
      aria-busy={active && effectiveStatus === "loading"}
      aria-hidden={!active}
      style={{
        position: "relative",
        display: active ? "block" : "none",
        width: "100%",
        height: "100%",
        minWidth: 1,
        minHeight: 1,
        overflow: "hidden",
        isolation: "isolate",
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          opacity: effectiveStatus === "ready" ? 1 : 0,
          transition: motionMode === "off" || reducedMotion ? "none" : "opacity 160ms ease-out",
          pointerEvents: "none",
        }}
      />

      {(onInviteRequest || onPointerDown) ? (
        <button
          type="button"
          aria-label={onInviteRequest ? `与${ariaLabel}互动` : `拖动${ariaLabel}`}
          onClick={onInviteRequest}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostPointerCapture}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            width: "100%",
            height: "100%",
            margin: 0,
            padding: 0,
            border: 0,
            background: "transparent",
            cursor: "pointer",
          }}
        />
      ) : null}
    </div>
  );
}

export type {
  WindowLive2DMotionMode,
  WindowLive2DPresentation,
  WindowLive2DStatus,
} from "./window-live2d-contract";
