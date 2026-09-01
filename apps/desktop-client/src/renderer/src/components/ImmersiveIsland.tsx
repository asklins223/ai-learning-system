import { useEffect, useRef, useState } from "react";
import { CircleHelp, Gauge, House, Moon, Orbit, Sun, Volume2, VolumeX } from "lucide-react";
import { useRoomStore } from "../app/room-store";
import { resolveSceneMotionMode } from "../scene/scene-motion";

export function ImmersiveIsland() {
  const invoke = useRoomStore((state) => state.invoke);
  const destination = useRoomStore((state) => state.destination);
  const theme = useRoomStore((state) => state.theme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const surface = useRoomStore((state) => state.surface);
  const toggleTheme = useRoomStore((state) => state.toggleTheme);
  const cycleMotionMode = useRoomStore((state) => state.cycleMotionMode);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const toggleMasterMuted = useRoomStore((state) => state.toggleMasterMuted);
  const openOnboarding = useRoomStore((state) => state.openOnboarding);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (surface || onboardingOpen) setExpanded(false);
  }, [onboardingOpen, surface]);

  useEffect(() => {
    if (!expanded) return;

    const closeFromOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      const restoreFocus = rootRef.current?.contains(document.activeElement);
      setExpanded(false);
      if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };

    window.addEventListener("pointerdown", closeFromOutside, true);
    return () => window.removeEventListener("pointerdown", closeFromOutside, true);
  }, [expanded]);

  const collapse = () => {
    setExpanded(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  return (
    <>
      <div className="window-drag-region" aria-hidden="true" />
      <aside
        ref={rootRef}
        className={`immersive-island${expanded ? " immersive-island--expanded" : ""}`}
        aria-label="房间控制"
        inert={onboardingOpen || undefined}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !expanded) return;
          event.preventDefault();
          event.stopPropagation();
          collapse();
        }}
      >
        <button
          ref={triggerRef}
          className="island-trigger"
          type="button"
          aria-label={expanded ? "收起房间控制" : "展开房间控制"}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <Orbit size={20} strokeWidth={1.8} aria-hidden="true" />
          <span className={`island-trigger__status island-trigger__status--${motionMode}`} aria-hidden="true" />
        </button>

        <div className="island-panel" aria-hidden={!expanded} inert={!expanded}>
          <button
            className={destination === "room" ? "island-button island-button--active" : "island-button"}
            type="button"
            aria-label="返回理解书房"
            title="返回房间总览"
            onClick={() => invoke("home")}
          >
            <House size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            className="island-button"
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "day" ? "切换到夜间书房" : "切换到日间书房"}
            title={theme === "day" ? "夜间书房" : "日间书房"}
          >
            {theme === "day" ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
          </button>
          <button
            className="island-button island-motion"
            type="button"
            onClick={cycleMotionMode}
            aria-label={`当前${motionMode === "full" ? "完整" : motionMode === "lite" ? "轻量" : "关闭"}动效，切换动效模式`}
            title={`动效：${motionMode === "full" ? "完整" : motionMode === "lite" ? "轻量" : "关闭"}`}
          >
            <Gauge size={17} aria-hidden="true" />
            <span className={`motion-dot motion-dot--${motionMode}`} aria-hidden="true" />
          </button>
          <button
            className="island-button"
            type="button"
            onClick={toggleMasterMuted}
            aria-label={masterMuted ? "取消总静音" : "开启总静音"}
            title={masterMuted ? "取消总静音" : "总静音"}
          >
            {masterMuted ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
          </button>
          <button
            className="island-button"
            type="button"
            onClick={() => {
              setExpanded(false);
              openOnboarding();
            }}
            aria-label="重播首次进入引导"
            title="重播引导"
          >
            <CircleHelp size={17} aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}
