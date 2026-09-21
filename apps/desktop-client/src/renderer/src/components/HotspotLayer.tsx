import { BookOpenText, CalendarDays, LampDesk, Orbit, Search } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore } from "../app/room-store";
import { ROOM_SCENE_ANCHORS, sceneAnchorStyle } from "../scene/scene-depth";
import { resolveSceneMotionMode } from "../scene/scene-motion";
import { useHomeProjection } from "../app/home-projection";
import { homePresentation } from "../app/home-presentation";

gsap.registerPlugin(useGSAP);

function unavailable(title: string, detail: string) {
  window.dispatchEvent(new CustomEvent("ailearn:home-unavailable", { detail: { title, detail } }));
}

function trackObjectPointer(event: ReactPointerEvent<HTMLButtonElement>) {
  if (event.pointerType === "touch") return;
  const frame = event.currentTarget.closest<HTMLElement>(".room-reference-frame");
  if (!frame) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.min(1, Math.max(-1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
  const y = Math.min(1, Math.max(-1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
  frame.style.setProperty("--home-object-x", `${(x * 3.8).toFixed(2)}px`);
  frame.style.setProperty("--home-object-y", `${(y * 2.4).toFixed(2)}px`);
  frame.style.setProperty("--home-object-turn", `${(x * 0.8).toFixed(2)}deg`);
}

function resetObjectPointer(target: HTMLElement) {
  const frame = target.closest<HTMLElement>(".room-reference-frame");
  frame?.style.removeProperty("--home-object-x");
  frame?.style.removeProperty("--home-object-y");
  frame?.style.removeProperty("--home-object-turn");
}

const objectPointerEvents = {
  onPointerMove: trackObjectPointer,
  onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => resetObjectPointer(event.currentTarget),
};

export function HotspotLayer() {
  const { projection, loading, failure, reload } = useHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const theme = useRoomStore((state) => state.theme);
  const toggleTheme = useRoomStore((state) => state.toggleTheme);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const windowState = useRoomStore((state) => state.windowState);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const rootRef = useRef<HTMLDivElement>(null);
  const routes = new Set(window.ailearn?.contract.enabledRoutes ?? []);

  useGSAP(() => {
    const root = rootRef.current;
    if (!root) return;
    const hotspots = gsap.utils.toArray<HTMLElement>(".hotspot", root);
    const rings = gsap.utils.toArray<HTMLElement>(".hotspot__discovery-ring", root);
    gsap.killTweensOf([...hotspots, ...rings]);

    if (motionMode === "off" || windowState !== "visible") {
      gsap.set(hotspots, { clearProps: "opacity,visibility,transform" });
      gsap.set(rings, { autoAlpha: 0, scale: 0.72 });
      return;
    }

    gsap.fromTo(
      hotspots,
      { autoAlpha: 0, y: 7, scale: 0.8 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: motionMode === "lite" ? 0.24 : 0.42,
        stagger: motionMode === "lite" ? 0.04 : 0.075,
        ease: "back.out(1.7)",
        clearProps: "transform",
      },
    );

    gsap.set(rings, { autoAlpha: 0, scale: 0.72 });
    if (motionMode !== "full") return;

    const discovery = gsap.timeline({ repeat: -1, repeatDelay: 7.2 });
    rings.forEach((ring, index) => {
      const at = 2.8 + index * 0.86;
      discovery
        .fromTo(ring, { autoAlpha: 0, scale: 0.72 }, { autoAlpha: 0.34, scale: 1, duration: 0.3, ease: "power2.out" }, at)
        .to(ring, { autoAlpha: 0, scale: 1.5, duration: 0.72, ease: "power2.out" }, at + 0.16);
    });
    return () => discovery.kill();
  }, { scope: rootRef, dependencies: [motionMode, onboardingOpen, surface, viewPreset, windowState], revertOnUpdate: true });

  if (surface || viewPreset !== "room" || onboardingOpen) return null;

  const openPrimary = () => {
    if (loading) return;
    if (home.retry) {
      reload();
      return;
    }
    if (home.primaryIntent === "open-notebook" && home.note && routes.has("note.detail")) {
      setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
      invoke("open-notebook");
      return;
    }
    if (home.primaryIntent) {
      invoke(home.primaryIntent);
      return;
    }
    unavailable("书房已经准备好", "从底部的书房目录选择第一项想做的事。");
  };

  const openReview = () => {
    if (routes.has("review.queue")) invoke("review");
    else unavailable("复习台尚未开放", "入口先留着，这一版还没有接上可用的页面。");
  };

  return (
    <div ref={rootRef} className="hotspot-layer" aria-label="房间物件快捷入口" data-home-hotspots-motion={motionMode}>
      <button
        className="hotspot hotspot--lamp companion-home-anchor"
        style={sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.lamp"])}
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "day" ? "打开夜间灯光" : "切换到日间灯光"}
        aria-pressed={theme === "night"}
        data-scene-anchor="room.lamp"
        data-hotspot-state={theme === "night" ? "lit" : "daylight"}
        data-direct-object="lamp"
        {...objectPointerEvents}
      >
        <span className="hotspot__discovery-ring" aria-hidden="true" />
        <span className="hotspot__pin"><LampDesk size={15} aria-hidden="true" /></span>
        <span className="hotspot__label hotspot__label--always">灯光</span>
      </button>
      <button className="hotspot hotspot--notebook" style={sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.notebook"])} type="button" onClick={openPrimary} aria-label={`${home.primaryLabel}：${home.title}`} data-focus-return="continue" data-scene-anchor="room.notebook" data-hotspot-state={home.notebookState} data-direct-object="notebook" {...objectPointerEvents}>
        <span className="hotspot__discovery-ring" aria-hidden="true" />
        <span className="hotspot__pin"><BookOpenText size={15} aria-hidden="true" /></span>
        <span className="hotspot__label">{home.primaryLabel}</span>
      </button>
      <button className="hotspot hotspot--calendar" style={sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.review"])} type="button" onClick={openReview} aria-label={home.reviewLabel} data-focus-return="review" data-scene-anchor="room.review" data-hotspot-state={home.reviewState} data-direct-object="review" {...objectPointerEvents}>
        <span className="hotspot__discovery-ring" aria-hidden="true" />
        <span className="hotspot__pin"><CalendarDays size={15} aria-hidden="true" /></span>
        <span className="hotspot__label">{home.reviewLabel}</span>
      </button>
      <button className="hotspot hotspot--shelf" style={sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.search"])} type="button" onClick={() => invoke("search")} aria-label="在当前书房内容中查找" data-focus-return="search" data-scene-anchor="room.search" data-hotspot-state={home.shelfState} data-direct-object="shelf" {...objectPointerEvents}>
        <span className="hotspot__discovery-ring" aria-hidden="true" />
        <span className="hotspot__pin"><Search size={15} aria-hidden="true" /></span>
        <span className="hotspot__label">房内查找</span>
      </button>
      <button className="hotspot hotspot--graph" style={sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.graph"])} type="button" onClick={() => invoke("graph")} aria-label="打开理解星图" data-focus-return="graph" data-scene-anchor="room.graph" data-hotspot-state="ready" data-direct-object="window" {...objectPointerEvents}>
        <span className="hotspot__discovery-ring" aria-hidden="true" />
        <span className="hotspot__pin"><Orbit size={15} aria-hidden="true" /></span>
        <span className="hotspot__label">理解星图</span>
      </button>
    </div>
  );
}
