import { useEffect } from "react";
import { ActionRail } from "./components/ActionRail";
import { HudRoomControl } from "./components/hud/HudRoomControl";
import { RoomStage } from "./components/RoomStage";
import { SceneStatus } from "./components/SceneStatus";
import { TaskSurface } from "./components/TaskSurface";
import { SourceIntakeHost } from "./components/SourceIntake";
import { RunRecoveryNotice } from "./components/RunRecoveryNotice";
import { CompanionPresence } from "./components/companion/CompanionPresence";
import { CompanionFeedMenu } from "./components/companion/CompanionFeedMenu";
import { DesktopAccessGate } from "./components/DesktopAccessGate";
import { CompanionChatProvider } from "./app/companion-chat-session";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import { useRoomStore } from "./app/room-store";
import { resolveSceneMotionMode } from "./scene/scene-motion";
import { HomeProjectionProvider, useHomeProjection } from "./app/home-projection";
import { homePresentation } from "./app/home-presentation";
import { HomeV2Provider } from "./components/home-v2/HomeV2Experience";
import { HOME_SCENE_VARIANT, HOME_V2_ENABLED } from "./components/home-v2/home-v2";
import type { HomeFeatureId } from "./components/home-v2/home-feature-registry";
import { CompanionHomeProjectionProvider } from "./app/companion-home-projection";
import { HomeCapabilityProjectionProvider } from "./app/home-capability-projection";
import { DirectoryRail } from "./components/DirectoryRail";
import { HudReturn } from "./components/hud/HudPage";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const typingSelector = "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], [role='listbox']";
  return target.matches(typingSelector) || Boolean(target.closest(typingSelector));
}

export function shouldIgnoreGlobalShortcut(input: {
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly onboardingOpen: boolean;
  readonly typingTarget: boolean;
  readonly modalOpen: boolean;
}): boolean {
  return input.defaultPrevented
    || input.isComposing
    || input.keyCode === 229
    || input.onboardingOpen
    || input.typingTarget
    || input.modalOpen;
}

export function homeV2ShortcutFeature(input: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): HomeFeatureId | null {
  const command = input.metaKey || input.ctrlKey;
  if (command && input.key === "Enter") return "continue";
  if (command && input.key.toLowerCase() === "k") return "global-search";
  if (!command && !input.altKey && input.key.toLowerCase() === "r") return "today-review";
  if (!command && !input.altKey && input.key.toLowerCase() === "g") return "understanding-graph";
  return null;
}

function hasOpenModal(): boolean {
  return Boolean(document.querySelector(
    "dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
  ));
}

export function RoomExperience() {
  const { projection, loading, failure, reload } = useHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const theme = useRoomStore((state) => state.theme);
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setInputFocused = useRoomStore((state) => state.setInputFocused);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const returnTarget = useRoomStore((state) => state.returnTarget);

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
      if (shouldIgnoreGlobalShortcut({
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        onboardingOpen,
        typingTarget: isTypingTarget(event.target),
        modalOpen: hasOpenModal(),
      })) return;
      if (event.key === "Escape") {
        if (document.querySelector('.companion-hud:not([data-mode="closed"])')) return;
        event.preventDefault();
        if (surface) invoke("home");
        return;
      }
      if (HOME_V2_ENABLED) {
        const featureId = homeV2ShortcutFeature(event);
        if (!featureId) return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("ailearn:home-v2-run-feature", { detail: { featureId } }));
        return;
      }
      const enabledRoutes = window.ailearn?.contract.enabledRoutes ?? [];
      const showUnavailable = (title: string, detail: string) => window.dispatchEvent(new CustomEvent("ailearn:home-unavailable", { detail: { title, detail } }));
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (surface) invoke("continue");
        else if (!home.blockingLoading) {
          if (home.retry) reload();
          else if (home.primaryIntent === "open-notebook" && home.note) {
            if (enabledRoutes.includes("note.detail")) {
              setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
              invoke("open-notebook");
            } else {
              showUnavailable("研究册尚未开放", "当前桌面合同还没有签发可用的研究册路由。");
            }
          } else if (home.primaryIntent === "open-objective") {
            const objectiveId = projection?.primaryFocus.state === "data"
              ? projection.primaryFocus.data.objective.objectiveId
              : null;
            if (objectiveId) {
              setActiveObjectiveId(objectiveId);
              invoke("open-objective");
            } else {
              invoke("open-objectives");
            }
          } else if (home.primaryIntent) invoke(home.primaryIntent);
        }
      } else if (!event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        invoke("search");
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (surface || enabledRoutes.includes("review.queue")) invoke("review");
        else showUnavailable("复习台尚未开放", "入口已经保留，当前桌面合同还没有签发可用路由。");
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        invoke("graph");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [invoke, onboardingOpen, projection, surface, home.blockingLoading, home.retry, home.primaryIntent, home.note, reload, setActiveNoteRef, setActiveObjectiveId]);

  const room = (
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
      <CompanionFeedMenu />
      <DirectoryRail />
      {HOME_V2_ENABLED ? null : <RunRecoveryNotice />}
      <HudRoomControl />
      {surface
        ? <HudReturn label={returnTarget?.label ?? "返回书房"} onReturn={returnTarget?.run ?? (() => invoke("home"))} />
        : null}
      <main id="main-content" inert={onboardingOpen || undefined}>
        <h1 className="sr-only">理解书房</h1>
        {HOME_V2_ENABLED ? null : <ActionRail />}
        <TaskSurface />
        {HOME_V2_ENABLED ? null : <SceneStatus />}
        <SourceIntakeHost />
      </main>
    </>
  );

  return HOME_V2_ENABLED ? <HomeV2Provider>{room}</HomeV2Provider> : room;
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
  const windowState = useRoomStore((state) => state.windowState);
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
    const onVisibility = () => setWindowState(
      document.hidden || !document.hasFocus() ? "hidden" : "visible",
    );
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onVisibility);
    return () => {
      unsubscribe?.();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
    };
  }, [setWindowState]);

  useEffect(() => {
    window.ailearnDesktop?.setTitleBarTheme(theme);
  }, [theme]);

  return (
    <div
      className={`desktop-app hud-surface${theme === "night" ? " night" : ""}`}
      data-theme={theme}
      data-platform={platform}
      data-surface-open={Boolean(surface)}
      data-onboarding-open={onboardingOpen}
      data-view-preset={viewPreset}
      data-scene-phase={scenePhase}
      data-scene-renderer={HOME_V2_ENABLED ? "poster-live2d" : "dom-2.5d"}
      data-home-scene-variant={HOME_SCENE_VARIANT}
      data-motion-mode={motionMode}
      data-window-state={windowState}
    >
      {/*
        外壳级兜底（2026-09-20）：门禁、场景或伴星自身崩了时的最后一道。没有它，
        渲染期抛错会让 React 卸载整棵树，用户看到的只是一片黑；有了它，最坏情况下
        也有一张能读、能重试、能重载的纸。页面级兜底见 TaskSurface。
      */}
      <RenderErrorBoundary label="理解书房" shell>
        {/*
          伴星会话（CompanionChatProvider）挂在门禁**之上**：它的消费方横跨两棵互不
          包含的子树——伴星叠加层本身，以及任务面里的伴星中心（CompanionCenterSurface
          要借它打开交互台）。挂进任何一棵子树，另一棵都会在渲染时抛错并整页黑屏，
          所以这里只留一处、且是全应用唯一的一处来源。工作区选择页
          （HudFirstSpaceScene）也在门禁内部，同样由它覆盖。
        */}
        <CompanionChatProvider>
          <DesktopAccessGate
            motionMode={motionMode}
            onWorkspaceBoundaryReset={resetWorkspaceScope}
          >
            <HomeProjectionProvider>
              {HOME_V2_ENABLED
                ? (
                    <HomeCapabilityProjectionProvider>
                      <CompanionHomeProjectionProvider><RoomExperience /></CompanionHomeProjectionProvider>
                    </HomeCapabilityProjectionProvider>
                  )
                : <RoomExperience />}
            </HomeProjectionProvider>
          </DesktopAccessGate>
        </CompanionChatProvider>
      </RenderErrorBoundary>
    </div>
  );
}
