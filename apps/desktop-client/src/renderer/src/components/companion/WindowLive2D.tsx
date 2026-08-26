import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { WindowLive2DDriver } from "./WindowLive2DDriver";
import {
  WINDOW_LIVE2D_ASSETS,
  shouldUseWindowLive2D,
  type WindowLive2DMotionMode,
  type WindowLive2DPresentation,
  type WindowLive2DStatus,
} from "./window-live2d-contract";

export interface WindowLive2DProps {
  /** Whether the in-window companion surface is present and allowed to run. */
  readonly active: boolean;
  /** `lite` and `off` deliberately use the static orb instead of a frame loop. */
  readonly motionMode: WindowLive2DMotionMode;
  readonly presentation?: WindowLive2DPresentation;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly onStatus?: (status: WindowLive2DStatus) => void;
  /** Increment this value to request a one-shot invite motion from the parent. */
  readonly inviteTrigger?: number;
  /** Click/keyboard intent only; the parent remains owner of state transitions. */
  readonly onInviteRequest?: () => void;
  /** Optional normalized amplitude for the `speak` mouth parameter, from 0 to 1. */
  readonly voiceLevel?: number;
  readonly ariaLabel?: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function bundledAssetUrl(path: string): string {
  if (typeof document === "undefined") return path;
  return new URL(path, new URL(".", document.baseURI)).href;
}

/**
 * Window-contained companion renderer. It renders only into this React-owned
 * element; native desktop-pet windows remain an explicitly separate future
 * capability.
 */
export function WindowLive2D({
  active,
  motionMode,
  presentation = "idle",
  className,
  style,
  onStatus,
  inviteTrigger = 0,
  onInviteRequest,
  voiceLevel = 0,
  ariaLabel = "AI 伴星",
}: WindowLive2DProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<WindowLive2DDriver | null>(null);
  const lastInviteTriggerRef = useRef(inviteTrigger);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const wantsLive2D = shouldUseWindowLive2D({
    active,
    motionMode,
    prefersReducedMotion: reducedMotion,
  });
  const [status, setStatus] = useState<WindowLive2DStatus>(
    wantsLive2D ? "loading" : "fallback",
  );

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
    if (!wantsLive2D) {
      setStatus("fallback");
      return;
    }

    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) {
      setStatus("fallback");
      return;
    }

    let cancelled = false;
    const driver = new WindowLive2DDriver({
      canvas,
      container,
      onStatus: (nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus === "failed" ? "fallback" : nextStatus);
      },
    });

    driverRef.current = driver;
    setStatus("loading");
    driver.setPresentation(presentation);
    driver.setVoiceLevel(voiceLevel);
    driver.setPaused(document.hidden);
    void driver.init();

    const handleVisibility = () => driver.setPaused(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      driver.destroy();
      if (driverRef.current === driver) driverRef.current = null;
    };
  }, [wantsLive2D]);

  useEffect(() => {
    driverRef.current?.setPresentation(presentation);
  }, [presentation, status]);

  useEffect(() => {
    driverRef.current?.setVoiceLevel(voiceLevel);
  }, [voiceLevel]);

  useEffect(() => {
    if (inviteTrigger === lastInviteTriggerRef.current) return;
    if (status !== "ready") return;

    lastInviteTriggerRef.current = inviteTrigger;
    driverRef.current?.playInviteOnce();
  }, [inviteTrigger, status]);

  const showFallback = status !== "ready";
  const rootClassName = ["window-live2d", className].filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      data-companion-renderer={status === "ready" ? "live2d" : "orb"}
      data-companion-status={status}
      data-motion-mode={motionMode}
      data-presentation={presentation}
      role="group"
      aria-label={ariaLabel}
      aria-busy={active && status === "loading"}
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
        key={wantsLive2D ? "live2d" : "fallback"}
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          opacity: status === "ready" ? 1 : 0,
          pointerEvents: "none",
        }}
      />

      {showFallback ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "end center",
            pointerEvents: "none",
          }}
        >
          <img
            src={bundledAssetUrl(WINDOW_LIVE2D_ASSETS.fallbackOrb)}
            alt=""
            draggable={false}
            style={{
              display: "block",
              width: "min(46%, 116px)",
              height: "auto",
              maxHeight: "42%",
              objectFit: "contain",
              userSelect: "none",
            }}
          />
        </div>
      ) : null}

      {onInviteRequest ? (
        <button
          type="button"
          aria-label={`与${ariaLabel}互动`}
          onClick={onInviteRequest}
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
