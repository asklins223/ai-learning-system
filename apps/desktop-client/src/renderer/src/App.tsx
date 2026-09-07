import { useEffect } from "react";
import { ActionRail } from "./components/ActionRail";
import { ImmersiveIsland } from "./components/ImmersiveIsland";
import { RoomStage } from "./components/RoomStage";
import { SceneStatus } from "./components/SceneStatus";
import { TaskSurface } from "./components/TaskSurface";
import { RunRecoveryNotice } from "./components/RunRecoveryNotice";
import { CompanionPresence } from "./components/companion/CompanionPresence";
import { DesktopAccessGate } from "./components/DesktopAccessGate";
import { useRoomStore } from "./app/room-store";
import { resolveSceneMotionMode } from "./scene/scene-motion";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const typingSelector = "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], [role='listbox']";
  return target.matches(typingSelector) || Boolean(target.closest(typingSelector));
}

function RoomExperience() {
  const theme = useRoomStore((state) => state.theme);
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const setInputFocused = useRoomStore((state) => state.setInputFocused);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const companionOpen = useRoomStore((state) => state.companionOpen);
  const closeCompanion = useRoomStore((state) => state.closeCompanion);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => setInputFocused(isTypingTarget(event.target));
    const onFocusOut = () => window.requestAnimationFrame(() => setInputFocused(isTypingTarget(document.activeElement)));
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [setInputFocused]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (onboardingOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (companionOpen) {
          closeCompanion();
        } else if (surface) {
          invoke("home");
        }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        invoke("continue");
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        invoke("search");
      } else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        invoke("review");
      } else if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        invoke("graph");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeCompanion, companionOpen, invoke, onboardingOpen, surface]);

  return (
    <>
      <a className="skip-link" href="#main-content" aria-hidden={onboardingOpen || undefined} inert={onboardingOpen || undefined}>跳到主要内容</a>
      <div
        className="scene-stage"
        role="region"
        aria-label={theme === "day" ? "日间理解书房场景" : "夜间理解书房场景"}
      >
        <RoomStage />
      </div>
      <CompanionPresence />
      <RunRecoveryNotice />
      <ImmersiveIsland />
      <main id="main-content" inert={onboardingOpen || undefined}>
        <h1 className="sr-only">理解书房</h1>
        <ActionRail />
        <TaskSurface />
        <SceneStatus />
      </main>
    </>
  );
}

export function App() {
  const theme = useRoomStore((state) => state.theme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const surface = useRoomStore((state) => state.surface);
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const scenePhase = useRoomStore((state) => state.scenePhase);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const resetWorkspaceScope = useRoomStore((state) => state.resetWorkspaceScope);
  const setReducedMotion = useRoomStore((state) => state.setReducedMotion);
  const setWindowState = useRoomStore((state) => state.setWindowState);
  const platform = window.ailearnDesktop?.platform ?? "unknown";

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReducedMotion(query.matches);
    syncMotion();
    query.addEventListener("change", syncMotion);
    return () => query.removeEventListener("change", syncMotion);
  }, [setReducedMotion]);

  useEffect(() => {
    const unsubscribe = window.ailearnDesktop?.onWindowState?.(setWindowState);
    const onVisibility = () => setWindowState(document.hidden ? "hidden" : "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [setWindowState]);

  useEffect(() => {
    window.ailearnDesktop?.setTitleBarTheme(theme);
  }, [theme]);

  return (
    <div
      className="desktop-app"
      data-theme={theme}
      data-platform={platform}
      data-surface-open={Boolean(surface)}
      data-onboarding-open={onboardingOpen}
      data-view-preset={viewPreset}
      data-scene-phase={scenePhase}
      data-scene-renderer="dom-2.5d"
      data-motion-mode={motionMode}
    >
      <DesktopAccessGate
        theme={theme}
        motionMode={motionMode}
        onWorkspaceBoundaryReset={resetWorkspaceScope}
      >
        <RoomExperience />
      </DesktopAccessGate>
    </div>
  );
}
