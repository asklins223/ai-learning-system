import { useEffect, useRef, useState } from "react";
import type { WindowState } from "../app/room-machine";
import type { SceneMotionMode, SceneMotionPhase } from "../scene/scene-motion";
import {
  createStudyNotebookScene,
  probeWebGLCapability,
  resolveStudyNotebookRendererEligibility,
  shouldPresentStudyNotebookCanvas,
  type SceneRendererCapability,
  type StudyNotebookScene,
} from "../scene/study-notebook-renderer";

type StudyNotebookCanvasProps = {
  readonly assetUrl: string | null;
  readonly compactMediaQuery: string;
  readonly motionMode: SceneMotionMode;
  readonly scenePhase: SceneMotionPhase;
  readonly windowState: WindowState;
  readonly onReady: (ready: boolean) => void;
};

type CanvasState = "fallback" | "loading" | "ready";

export function StudyNotebookCanvas({
  assetUrl,
  compactMediaQuery,
  motionMode,
  scenePhase,
  windowState,
  onReady,
}: StudyNotebookCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(compactMediaQuery).matches
  ));
  const [capability] = useState<SceneRendererCapability>(() => probeWebGLCapability());
  const [state, setState] = useState<CanvasState>("fallback");
  const [reason, setReason] = useState<string>("not-started");
  const [rendererName, setRendererName] = useState<string | null>(null);

  onReadyRef.current = onReady;

  useEffect(() => {
    const query = window.matchMedia(compactMediaQuery);
    const syncCompact = () => setCompact(query.matches);
    syncCompact();
    query.addEventListener("change", syncCompact);
    return () => query.removeEventListener("change", syncCompact);
  }, [compactMediaQuery]);

  const eligibility = resolveStudyNotebookRendererEligibility({
    assetUrl,
    compact,
    motionMode,
    windowState,
    capability,
  });
  const presentCanvas = shouldPresentStudyNotebookCanvas({
    sceneReady: state === "ready",
    scenePhase,
    compact,
    motionMode,
    windowState,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let scene: StudyNotebookScene | null = null;
    let contextLost = false;
    const abortController = new AbortController();

    const block = (nextReason: string) => {
      setState("fallback");
      setReason(nextReason);
      setRendererName(null);
      onReadyRef.current(false);
    };

    if (!eligibility.enabled || !assetUrl) {
      block(eligibility.reason);
      return () => undefined;
    }

    setState("loading");
    setReason("initializing");
    setRendererName(null);
    onReadyRef.current(false);

    const handleContextLost = () => {
      contextLost = true;
      scene?.destroy();
      scene = null;
      if (!cancelled) block("context-lost");
    };

    void createStudyNotebookScene({
      host,
      assetUrl,
      signal: abortController.signal,
      onContextLost: handleContextLost,
    })
      .then((createdScene) => {
        if (cancelled || contextLost) {
          createdScene.destroy();
          return;
        }
        scene = createdScene;
        setRendererName(createdScene.rendererName);
        setState("ready");
        setReason("ready");
        onReadyRef.current(true);
      })
      .catch(() => {
        if (!cancelled) block("initialization-failed");
      });

    return () => {
      cancelled = true;
      abortController.abort();
      scene?.destroy();
      scene = null;
      onReadyRef.current(false);
    };
  }, [assetUrl, eligibility.enabled, eligibility.reason]);

  return (
    <div
      ref={hostRef}
      className="study-notebook__canvas"
      data-scene-renderer="pixi-study-notebook-base"
      data-scene-renderer-state={state}
      data-scene-renderer-reason={reason}
      data-scene-renderer-name={rendererName ?? undefined}
      data-scene-renderer-phase={scenePhase}
      data-scene-renderer-active={presentCanvas ? "true" : "false"}
      data-scene-surface-base="true"
      aria-hidden="true"
    />
  );
}
