import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore } from "../app/room-store";
import { useHomeProjection } from "../app/home-projection";
import { homePresentation } from "../app/home-presentation";
import {
  mediaAssetUrl,
  useLearningRoomManifest,
  type LearningRoomManifest,
} from "../media/learning-room-manifest";
import { SceneReferenceFrame } from "../scene/SceneReferenceFrame";
import { sceneCameraPreset } from "../scene/scene-camera";
import { SCENE_DEPTH_BANDS } from "../scene/scene-depth";
import {
  resolveSceneMotionMode,
  sceneMotionDuration,
  settledScenePhase,
  shouldSettleAfterMotionPreferenceChange,
} from "../scene/scene-motion";
import { HomeRoomDepth } from "./HomeRoomDepth";
import { HomeRoomForeground } from "./HomeRoomForeground";
import { HomeRoomLife } from "./HomeRoomLife";
import { HotspotLayer } from "./HotspotLayer";
import {
  HOME_V2_CAMERA_PRESETS,
  HOME_V2_ENABLED,
  homeV2CameraDuration,
  type HomeV2Zone,
} from "./home-v2/home-v2";
import { HomeV2ObjectLayer } from "./home-v2/HomeV2ObjectLayer";
import { useHomeV2 } from "./home-v2/HomeV2Experience";
import { HomeV2Keepsakes } from "./home-v2/HomeV2Keepsakes";
import { requestHomeV2Camera } from "./home-v2/home-v2-camera";

gsap.registerPlugin(useGSAP);

function motionDuration(mode: "full" | "lite" | "off", full: number, lite = full * 0.56) {
  return mode === "off" ? 0 : mode === "lite" ? lite : full;
}

function OnboardingPendingState({ error }: { error: string | null }) {
  const finishOnboarding = useRoomStore((state) => state.finishOnboarding);
  const enterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(
      () => enterRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="onboarding-layer" data-state={error ? "error" : "loading"}>
      <section
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-pending-title"
        aria-describedby="onboarding-pending-description"
      >
        <div className="onboarding-copy">
          <h2 id="onboarding-pending-title">正在准备理解书房</h2>
          <p id="onboarding-pending-description">
            {error ? "首次引导资源暂时无法读取，你仍可以直接进入书房。" : "正在准备首次引导资源，你也可以先进入书房。"}
          </p>
        </div>
        <div className="onboarding-actions">
          <button ref={enterRef} type="button" className="guide-button guide-button--quiet" onClick={finishOnboarding}>进入书房</button>
        </div>
      </section>
    </div>
  );
}

function FirstEntryGuideContent({ manifest }: { manifest: LearningRoomManifest }) {
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const finishOnboarding = useRoomStore((state) => state.finishOnboarding);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [wideViewport, setWideViewport] = useState(() => window.matchMedia("(min-width: 721px)").matches);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const voiceRef = useRef<HTMLAudioElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const showVideo = motionMode === "full" && wideViewport && manifest.onboarding.reviewStatus === "approved";
  const voicePath = manifest.sound.onboardingVoice;
  const captionsPath = manifest.sound.onboardingCaptions;

  useEffect(() => {
    const query = window.matchMedia("(min-width: 721px)");
    const syncViewport = () => setWideViewport(query.matches);
    syncViewport();
    query.addEventListener("change", syncViewport);
    const frame = window.requestAnimationFrame(
      () => skipRef.current?.focus({ preventScroll: true }),
    );
    return () => {
      query.removeEventListener("change", syncViewport);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useGSAP(() => {
    if (!cardRef.current) return;
    const duration = motionDuration(motionMode, 0.7, 0.34);
    if (!duration) {
      gsap.set(cardRef.current, { clearProps: "opacity,visibility,y,rotateX", xPercent: -50 });
      if (videoRef.current) gsap.set(videoRef.current, { clearProps: "all" });
      skipRef.current?.focus({ preventScroll: true });
      return;
    }
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    if (videoRef.current) timeline.fromTo(videoRef.current, { autoAlpha: 0 }, { autoAlpha: 0.96, duration: duration * 0.6 });
    timeline.fromTo(
      cardRef.current,
      { autoAlpha: 0, xPercent: -50, y: 28, rotateX: -4, transformOrigin: "50% 100%" },
      { autoAlpha: 1, xPercent: -50, y: 0, rotateX: 0, duration },
      videoRef.current ? "-=0.2" : 0,
    );
    timeline.eventCallback("onComplete", () => skipRef.current?.focus({ preventScroll: true }));
  }, { scope: rootRef, dependencies: [motionMode, showVideo], revertOnUpdate: true });

  const toggleVoice = () => {
    const video = videoRef.current;
    const voice = voiceRef.current;
    if (!voice) return;
    if (voicePlaying) {
      voice.pause();
      setVoicePlaying(false);
      return;
    }
    if (video) {
      video.currentTime = 0;
      void video.play();
    }
    voice.currentTime = 0;
    setVoicePlaying(true);
    setPaused(false);
    void voice.play().catch(() => setVoicePlaying(false));
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPaused(false);
      void video.play();
      if (voicePlaying) void voiceRef.current?.play();
    } else {
      video.pause();
      voiceRef.current?.pause();
      setPaused(true);
    }
  };

  return (
    <div ref={rootRef} className="onboarding-layer" data-video={showVideo}>
      {showVideo ? (
        <video
          ref={videoRef}
          className="onboarding-video"
          src={mediaAssetUrl(manifest, manifest.onboarding.path)}
          autoPlay
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          onEnded={finishOnboarding}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        >
          {captionsPath ? <track kind="captions" src={mediaAssetUrl(manifest, captionsPath)} srcLang="zh-CN" label="普通话" /> : null}
        </video>
      ) : null}
      {voicePath ? (
        <audio
          ref={voiceRef}
          src={mediaAssetUrl(manifest, voicePath)}
          preload="metadata"
          aria-hidden="true"
          onEnded={() => setVoicePlaying(false)}
        />
      ) : null}
      <section
        ref={cardRef}
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-description"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          finishOnboarding();
        }}
      >
        <button ref={skipRef} className="onboarding-skip" type="button" onClick={finishOnboarding} aria-label="跳过首次引导">
          <X size={17} aria-hidden="true" />
        </button>
        <div className="onboarding-copy">
          <h2 id="onboarding-title">欢迎来到理解书房</h2>
          <p id="onboarding-description">{manifest.onboarding.caption}</p>
        </div>
        <div className="onboarding-actions">
          {showVideo ? (
            <button type="button" className="guide-button" onClick={togglePlayback}>
              {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
              {paused ? "继续画面" : "暂停画面"}
            </button>
          ) : null}
          {voicePath ? (
            <button type="button" className="guide-button guide-button--sound" onClick={toggleVoice}>
              {voicePlaying ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
              {voicePlaying ? "停止普通话引导" : "播放普通话引导"}
            </button>
          ) : null}
          <button type="button" className="guide-button guide-button--quiet" onClick={finishOnboarding}>无声进入</button>
        </div>
      </section>
    </div>
  );
}

function FirstEntryGuide({ manifest, error }: { manifest: LearningRoomManifest | null; error: string | null }) {
  return manifest ? <FirstEntryGuideContent manifest={manifest} /> : <OnboardingPendingState error={error} />;
}

export function RoomStage() {
  const { zone: homeV2Zone, sceneTime: homeSceneTime } = useHomeV2();
  const theme = useRoomStore((state) => state.theme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const surface = useRoomStore((state) => state.surface);
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const scenePhase = useRoomStore((state) => state.scenePhase);
  const windowState = useRoomStore((state) => state.windowState);
  const inputFocused = useRoomStore((state) => state.inputFocused);
  const ambientRequested = useRoomStore((state) => state.ambientRequested);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const pendingHomeCompletion = useRoomStore((state) => state.pendingHomeCompletion);
  const activeHomeCompletion = useRoomStore((state) => state.activeHomeCompletion);
  const onboardingSeen = useRoomStore((state) => state.onboardingSeen);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const openOnboarding = useRoomStore((state) => state.openOnboarding);
  const setPhase = useRoomStore((state) => state.setPhase);
  const setScenePhase = useRoomStore((state) => state.setScenePhase);
  const beginPendingHomeCompletion = useRoomStore((state) => state.beginPendingHomeCompletion);
  const markHomeCompletionStarted = useRoomStore((state) => state.markHomeCompletionStarted);
  const consumeHomeCompletion = useRoomStore((state) => state.consumeHomeCompletion);
  const presentPendingHomeCompletion = useRoomStore((state) => state.presentPendingHomeCompletion);
  const { projection, loading: homeLoading, failure: homeFailure } = useHomeProjection();
  const home = homePresentation(projection, homeLoading, homeFailure);
  const { manifest, error } = useLearningRoomManifest();
  const { notebookState, reviewState, shelfState } = home;
  useEffect(() => {
    if (HOME_V2_ENABLED || !manifest || onboardingSeen || onboardingOpen) return;
    const timer = window.setTimeout(openOnboarding, 550);
    return () => window.clearTimeout(timer);
  }, [manifest, onboardingOpen, onboardingSeen, openOnboarding]);

  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const homeDayRef = useRef<HTMLImageElement>(null);
  const homeDuskRef = useRef<HTMLImageElement>(null);
  const homeNightRef = useRef<HTMLImageElement>(null);
  const seatDayRef = useRef<HTMLImageElement>(null);
  const seatNightRef = useRef<HTMLImageElement>(null);
  const searchDayRef = useRef<HTMLImageElement>(null);
  const searchNightRef = useRef<HTMLImageElement>(null);
  const reviewDayRef = useRef<HTMLImageElement>(null);
  const reviewNightRef = useRef<HTMLImageElement>(null);
  const seatAtmosphereRef = useRef<HTMLDivElement>(null);
  const lampPoolRef = useRef<HTMLSpanElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const previousPresetRef = useRef<typeof viewPreset | null>(null);
  const previousMotionModeRef = useRef<typeof motionMode | null>(null);
  const previousHomeV2ZoneRef = useRef<HomeV2Zone | null>(null);

  const inSearchScene = viewPreset === "search";
  const inReviewScene = viewPreset === "review";
  const inSeatScene = viewPreset !== "room" && !inSearchScene;
  const inGenericSeatScene = inSeatScene && !inReviewScene;
  const roomIsQuiet = Boolean(surface) || inputFocused || windowState !== "visible" || onboardingOpen;
  const ambientPath = manifest?.sound[theme === "day" ? "ambientDay" : "ambientNight"] ?? null;
  const shouldPlayAmbient = Boolean(ambientPath) && ambientRequested && !masterMuted && !roomIsQuiet;
  useEffect(() => {
    if (
      surface
      || scenePhase !== "idle"
      || windowState !== "visible"
      || onboardingOpen
    ) return;
    if (HOME_V2_ENABLED) {
      const event = activeHomeCompletion ?? pendingHomeCompletion;
      if (event) beginPendingHomeCompletion(event.id);
      return;
    }
    if (pendingHomeCompletion) presentPendingHomeCompletion(pendingHomeCompletion.id);
  }, [
    activeHomeCompletion,
    beginPendingHomeCompletion,
    onboardingOpen,
    pendingHomeCompletion,
    presentPendingHomeCompletion,
    scenePhase,
    surface,
    windowState,
  ]);

  useEffect(() => {
    if (!HOME_V2_ENABLED || !activeHomeCompletion || roomIsQuiet || scenePhase !== "idle") return;
    markHomeCompletionStarted(activeHomeCompletion.id);
    const timer = window.setTimeout(() => consumeHomeCompletion(activeHomeCompletion.id), 1_300);
    return () => window.clearTimeout(timer);
  }, [activeHomeCompletion, consumeHomeCompletion, markHomeCompletionStarted, roomIsQuiet, scenePhase]);

  useGSAP(() => {
    if (HOME_V2_ENABLED) return;
    const lightBreath = rootRef.current?.querySelectorAll(".home-window-light__breath");
    if (!lightBreath?.length) return;
    if (motionMode !== "full" || roomIsQuiet || viewPreset !== "room" || scenePhase !== "idle") {
      gsap.set(lightBreath, { clearProps: "opacity" });
      return;
    }
    const ranges = theme === "night"
      ? [{ from: 0.012, to: 0.025 }, { from: 0.16, to: 0.23 }]
      : [{ from: 0.08, to: 0.14 }, { from: 0.14, to: 0.22 }];
    gsap.fromTo(
      lightBreath,
      { opacity: (index) => ranges[index]?.from ?? ranges[0].from },
      { opacity: (index) => ranges[index]?.to ?? ranges[0].to, duration: 8.5, repeat: -1, yoyo: true, ease: "sine.inOut" },
    );
  }, { scope: rootRef, dependencies: [theme, motionMode, roomIsQuiet, viewPreset, scenePhase], revertOnUpdate: true });

  useGSAP(() => {
    if (HOME_V2_ENABLED) return;
    const frame = rootRef.current;
    const depth = frame?.querySelector<SVGSVGElement>(".home-room-depth");
    const foreground = frame?.querySelector<HTMLElement>(".home-room-foreground");
    if (!frame || !depth || !foreground) return;

    gsap.killTweensOf([depth, foreground]);
    const enabled = motionMode === "full"
      && viewPreset === "room"
      && scenePhase === "idle"
      && !roomIsQuiet;
    if (!enabled) {
      gsap.set([depth, foreground], { x: 0, y: 0, clearProps: "willChange" });
      return;
    }

    gsap.set([depth, foreground], { willChange: "transform" });
    const moveDepthX = gsap.quickTo(depth, "x", { duration: 0.72, ease: "power3.out" });
    const moveDepthY = gsap.quickTo(depth, "y", { duration: 0.72, ease: "power3.out" });
    const moveForegroundX = gsap.quickTo(foreground, "x", { duration: 0.9, ease: "power3.out" });
    const moveForegroundY = gsap.quickTo(foreground, "y", { duration: 0.9, ease: "power3.out" });
    let bounds = frame.getBoundingClientRect();

    const settle = () => {
      moveDepthX(0);
      moveDepthY(0);
      moveForegroundX(0);
      moveForegroundY(0);
    };
    const trackPointer = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") {
        settle();
        return;
      }
      if (
        event.clientX < bounds.left
        || event.clientX > bounds.right
        || event.clientY < bounds.top
        || event.clientY > bounds.bottom
      ) {
        settle();
        return;
      }
      const x = Math.min(1, Math.max(-1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
      const y = Math.min(1, Math.max(-1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
      moveDepthX(x * 2.2);
      moveDepthY(y * 1.15);
      moveForegroundX(x * 5.2);
      moveForegroundY(y * 2.7);
    };
    const refreshBounds = () => { bounds = frame.getBoundingClientRect(); };
    const resizeObserver = new ResizeObserver(refreshBounds);
    resizeObserver.observe(frame);
    window.addEventListener("resize", refreshBounds, { passive: true });
    window.addEventListener("pointermove", trackPointer, { passive: true });
    window.addEventListener("blur", settle, { passive: true });

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", refreshBounds);
      window.removeEventListener("pointermove", trackPointer);
      window.removeEventListener("blur", settle);
      gsap.killTweensOf([depth, foreground]);
      gsap.set([depth, foreground], { x: 0, y: 0, clearProps: "willChange" });
    };
  }, { scope: rootRef, dependencies: [manifest, motionMode, roomIsQuiet, scenePhase, viewPreset], revertOnUpdate: true });

  useEffect(() => {
    if (error) setPhase("media-fallback", `${error}，已使用本地静态书房`);
    else if (manifest) setPhase("poster-ready");
  }, [error, manifest, setPhase]);

  // Keep the camera serializer outside a GSAP context. `useGSAP` correctly
  // reverts every tween in its scope when dependencies change, but that would
  // also kill a zone tween without notifying the serializer, leaving its
  // `moving` state stuck and the CSS variables at the old camera position.
  useLayoutEffect(() => {
    const camera = cameraRef.current;
    const cameraHost = rootRef.current?.closest(".desktop-app");
    if (!camera || !(cameraHost instanceof HTMLElement)) return;
    const target = HOME_V2_ENABLED && viewPreset === "room"
      ? HOME_V2_CAMERA_PRESETS[homeV2Zone] ?? HOME_V2_CAMERA_PRESETS.wide
      : sceneCameraPreset(viewPreset);
    const previousPreset = previousPresetRef.current;
    const previousMotionMode = previousMotionModeRef.current;
    const previousHomeV2Zone = previousHomeV2ZoneRef.current;
    const firstRender = previousPreset === null;
    const routeChanged = !firstRender && previousPreset !== viewPreset;
    const modeChanged = !firstRender && previousMotionMode !== motionMode;
    const zoneChanged = HOME_V2_ENABLED
      && viewPreset === "room"
      && !firstRender
      && previousHomeV2Zone !== homeV2Zone;
    previousPresetRef.current = viewPreset;
    previousMotionModeRef.current = motionMode;
    previousHomeV2ZoneRef.current = homeV2Zone;

    const targetValues = {
      "--scene-camera-scale": target.scale,
      "--scene-camera-x-percent": `${target.xPercent}%`,
      "--scene-camera-y-percent": `${target.yPercent}%`,
    };
    if (firstRender) {
      gsap.set(cameraHost, targetValues);
      // This also repairs a mount that begins from a pre-hydrated route. V2
      // must record its room baseline before any task navigation can occur.
      setScenePhase(settledScenePhase(surface));
      return;
    }

    if (!routeChanged && !modeChanged && !zoneChanged) return;
    // Home V2 owns the room camera through a single serializer: zone commands
    // (catalog, object activation, Escape) and route transitions both retarget
    // the same CSS variables, so only one of them may own the tween.
    if (HOME_V2_ENABLED && viewPreset === "room") {
      return requestHomeV2Camera({
        target: cameraHost,
        preset: target,
        duration: homeV2CameraDuration(motionMode),
        ease: "power2.inOut",
        onSettle: (reason) => {
          // A superseded or cancelled command leaves the phase to the command
          // that replaced it; only the surviving one settles the scene.
          if (reason === "complete") setScenePhase(settledScenePhase(surface));
        },
      });
    }
    gsap.killTweensOf(cameraHost);
    if (!routeChanged || motionMode === "off") {
      gsap.set(cameraHost, targetValues);
      if (
        routeChanged
        || shouldSettleAfterMotionPreferenceChange({ routeChanged, modeChanged, scenePhase })
        || (modeChanged && scenePhase === "returning")
      ) {
        setScenePhase(settledScenePhase(surface));
      }
      return;
    }

    const duration = HOME_V2_ENABLED && viewPreset === "room"
      ? homeV2CameraDuration(motionMode)
      : sceneMotionDuration(motionMode, viewPreset === "room" ? "return" : "camera");
    const finish = () => setScenePhase(settledScenePhase(surface));
    const timeline = gsap.timeline({
      defaults: { ease: viewPreset === "room" ? "power2.inOut" : "power3.inOut" },
      onComplete: finish,
    });
    timeline.addLabel(viewPreset === "room" ? "returning" : "world_depart", 0);
    timeline.to(cameraHost, { ...targetValues, duration }, viewPreset === "room" ? "returning" : "world_depart");
    timeline.addLabel("anchor_align", ">-0.08");
    timeline.addLabel("surface_reveal", ">-0.06");
    timeline.addLabel("focus_ready", ">-0.04");
    timeline.addLabel("settled", ">");
    return () => timeline.kill();
  }, [homeV2Zone, viewPreset, motionMode]);

  useGSAP(() => {
    const homeDay = homeDayRef.current;
    const homeDusk = homeDuskRef.current;
    const homeNight = homeNightRef.current;
    const seatDay = seatDayRef.current;
    const seatNight = seatNightRef.current;
    const searchDay = searchDayRef.current;
    const searchNight = searchNightRef.current;
    const reviewDay = reviewDayRef.current;
    const reviewNight = reviewNightRef.current;
    if (!homeDay || !homeNight || !seatDay || !seatNight) return;
    const duration = HOME_V2_ENABLED
      ? motionDuration(motionMode, 0.6, 0.28)
      : motionDuration(motionMode, 0.76, 0.32);
    const roomTime = HOME_V2_ENABLED ? homeSceneTime : theme;
    gsap.to(homeDay, { autoAlpha: viewPreset === "room" && roomTime === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    if (homeDusk) {
      gsap.to(homeDusk, { autoAlpha: viewPreset === "room" && roomTime === "dusk" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    gsap.to(homeNight, { autoAlpha: viewPreset === "room" && roomTime === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(seatDay, { autoAlpha: inGenericSeatScene && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(seatNight, { autoAlpha: inGenericSeatScene && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    if (searchDay) {
      gsap.to(searchDay, { autoAlpha: inSearchScene && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (searchNight) {
      gsap.to(searchNight, { autoAlpha: inSearchScene && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (reviewDay) {
      gsap.to(reviewDay, { autoAlpha: inReviewScene && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (reviewNight) {
      gsap.to(reviewNight, { autoAlpha: inReviewScene && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (seatAtmosphereRef.current) {
      gsap.to(seatAtmosphereRef.current, { autoAlpha: inGenericSeatScene && !roomIsQuiet ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (lampPoolRef.current) {
      gsap.to(lampPoolRef.current, {
        autoAlpha: inGenericSeatScene && !roomIsQuiet ? (theme === "night" ? 1 : 0.16) : 0,
        scale: theme === "night" ? 1 : 0.92,
        duration: motionDuration(motionMode, 0.82, 0.34),
        ease: "sine.inOut",
        overwrite: "auto",
      });
    }
  }, { scope: rootRef, dependencies: [theme, homeSceneTime, motionMode, manifest, viewPreset, inSearchScene, inReviewScene, inSeatScene, inGenericSeatScene, roomIsQuiet] });

  useGSAP(() => {
    if (HOME_V2_ENABLED) return;
    const dust = gsap.utils.toArray<HTMLElement>(".window-atmosphere__dust");
    if (!dust.length) return;
    gsap.killTweensOf(dust);
    if (motionMode !== "full" || !inSeatScene || surface === null || onboardingOpen || inputFocused || windowState !== "visible") {
      gsap.set(dust, { autoAlpha: 0.18, x: 0, y: 0 });
      return;
    }
    gsap.set(dust, { autoAlpha: 0.12, x: 0, y: 0 });
    gsap.to(dust, {
      x: (index) => index ? -9 : 11,
      y: (index) => index ? -14 : -10,
      autoAlpha: 0.48,
      duration: (index) => index ? 5.4 : 4.6,
      stagger: 1.3,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
    });
  }, { scope: rootRef, dependencies: [motionMode, surface, onboardingOpen, manifest, inSeatScene, inputFocused, windowState] });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    gsap.killTweensOf(audio);
    if (shouldPlayAmbient) {
      audio.volume = 0;
      void audio.play()
        .then(() => { gsap.to(audio, { volume: 0.28, duration: 0.4, ease: "sine.out", overwrite: true }); })
        .catch(() => setPhase("media-fallback", "窗外声音未能播放，画面与任务不受影响"));
    } else {
      gsap.to(audio, {
        volume: 0,
        duration: 0.55,
        ease: "sine.out",
        overwrite: true,
        onComplete: () => audio.pause(),
      });
    }
    return () => gsap.killTweensOf(audio);
  }, [setPhase, shouldPlayAmbient, theme]);

  return (
    <SceneReferenceFrame
      ref={rootRef}
      className="room-reference-frame"
      fitMode="cover"
      data-view-preset={viewPreset}
      data-motion-mode={motionMode}
      data-scene-phase={scenePhase}
      data-scene-renderer={HOME_V2_ENABLED ? "poster-live2d" : "dom-2.5d"}
      data-home-scene-time={HOME_V2_ENABLED ? homeSceneTime : undefined}
      data-scene-depth-bands={SCENE_DEPTH_BANDS.map((band) => band.id).join(",")}
      data-scene-room-layer-count={HOME_V2_ENABLED ? 0 : undefined}
      data-scene-room-canvas-active="false"
      data-home-notebook-state={notebookState}
      data-home-review-state={reviewState}
      data-home-shelf-state={shelfState}
    >
      <div ref={cameraRef} className="room-camera-rig">
        <div className="room-depth-layer" data-scene-depth-root="room" data-scene-depth-mode="dom-2.5d">
          <div className="scene-depth-band scene-depth-band--d0" data-depth-band="D0" aria-hidden="true">
            {manifest ? (
              <>
                <img ref={homeDayRef} className="room-backplate room-backplate--home-day" src={mediaAssetUrl(manifest, (HOME_V2_ENABLED ? manifest.homeV2Posters : manifest.posters).day.path)} alt="" draggable="false" />
                {HOME_V2_ENABLED ? <img ref={homeDuskRef} className="room-backplate room-backplate--home-dusk" src={mediaAssetUrl(manifest, manifest.homeV2Posters.dusk.path)} alt="" draggable="false" /> : null}
                <img ref={homeNightRef} className="room-backplate room-backplate--home-night" src={mediaAssetUrl(manifest, (HOME_V2_ENABLED ? manifest.homeV2Posters : manifest.posters).night.path)} alt="" draggable="false" />
                <img ref={seatDayRef} className="room-backplate room-backplate--seat-day" src={mediaAssetUrl(manifest, manifest.seatPosters.day.path)} alt="" draggable="false" />
                <img ref={seatNightRef} className="room-backplate room-backplate--seat-night" src={mediaAssetUrl(manifest, manifest.seatPosters.night.path)} alt="" draggable="false" />
                {inSearchScene ? (
                  <>
                    <img ref={searchDayRef} className="room-backplate room-backplate--search-day" src={mediaAssetUrl(manifest, manifest.searchPosters.day.path)} alt="" draggable="false" />
                    <img ref={searchNightRef} className="room-backplate room-backplate--search-night" src={mediaAssetUrl(manifest, manifest.searchPosters.night.path)} alt="" draggable="false" />
                  </>
                ) : null}
                {inReviewScene ? (
                  <>
                    <img ref={reviewDayRef} className="room-backplate room-backplate--review-day" src={mediaAssetUrl(manifest, manifest.reviewPosters.day.path)} alt="" draggable="false" />
                    <img ref={reviewNightRef} className="room-backplate room-backplate--review-night" src={mediaAssetUrl(manifest, manifest.reviewPosters.night.path)} alt="" draggable="false" />
                  </>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="scene-depth-band scene-depth-band--d1" data-depth-band="D1" aria-hidden="true">
            {!HOME_V2_ENABLED ? (
              <div ref={seatAtmosphereRef} className="window-atmosphere" aria-hidden="true">
                <span className="window-atmosphere__glow" />
                <span className="window-atmosphere__dust window-atmosphere__dust--one" />
                <span className="window-atmosphere__dust window-atmosphere__dust--two" />
              </div>
            ) : null}
          </div>

          <div className="scene-depth-band scene-depth-band--d2" data-depth-band="D2" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d3" data-depth-band="D3" aria-hidden="true">
            {!HOME_V2_ENABLED && manifest && viewPreset === "room" ? (
              <HomeRoomDepth
                dayPoster={mediaAssetUrl(manifest, manifest.posters.day.path)}
                nightPoster={mediaAssetUrl(manifest, manifest.posters.night.path)}
                notebookState={notebookState}
                reviewState={reviewState}
                shelfState={shelfState}
                dueCount={home.dueCount}
              />
            ) : null}
          </div>

          <div className="scene-depth-band scene-depth-band--d5" data-depth-band="D5" aria-hidden="true">
            {!HOME_V2_ENABLED && viewPreset === "room" ? <svg className="home-window-light" viewBox="0 0 1672 941" preserveAspectRatio="none">
              <defs>
                <filter id="home-light-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="12" /></filter>
                <linearGradient id="home-window-beam" x1="1" y1="0" x2="0.3" y2="1">
                  <stop offset="0" stopColor="#fff7d7" stopOpacity="0.86" />
                  <stop offset="1" stopColor="#ffd395" stopOpacity="0" />
                </linearGradient>
                <radialGradient id="home-lamp-glow">
                  <stop offset="0" stopColor="#fff1b8" stopOpacity="0.78" />
                  <stop offset="1" stopColor="#ffc773" stopOpacity="0" />
                </radialGradient>
              </defs>
              <path className="home-window-light__beam home-window-light__breath" d="M1165 85 L1458 82 L1380 690 L735 770 L1000 425 Z" fill="url(#home-window-beam)" />
              <ellipse className="home-window-light__lamp home-window-light__breath" cx="1026" cy="523" rx="188" ry="92" transform="rotate(-7 1026 523)" fill="url(#home-lamp-glow)" filter="url(#home-light-soft)" />
              <g className="home-window-light__branches" filter="url(#home-light-soft)" fill="currentColor">
                <path d="M1040 420 Q960 510 910 555 Q815 670 675 745 L705 760 Q835 677 933 561 Q1000 486 1080 432Z" />
                <ellipse cx="930" cy="560" rx="75" ry="17" transform="rotate(-34 930 560)" />
                <ellipse cx="817" cy="657" rx="58" ry="13" transform="rotate(12 817 657)" />
                <ellipse cx="705" cy="737" rx="70" ry="19" transform="rotate(-18 705 737)" />
              </g>
            </svg> : null}
            {!HOME_V2_ENABLED && viewPreset === "room" ? (
              <HomeRoomLife
                active={!roomIsQuiet && scenePhase === "idle"}
                motionMode={motionMode}
              />
            ) : null}
            {!HOME_V2_ENABLED ? <span ref={lampPoolRef} className="lamp-local-pool" /> : null}
          </div>

          <div className="scene-depth-band scene-depth-band--d4" data-depth-band="D4">
            {HOME_V2_ENABLED ? <><HomeV2Keepsakes /><HomeV2ObjectLayer /></> : <HotspotLayer />}
          </div>

          <div className="scene-depth-band scene-depth-band--d6" data-depth-band="D6" aria-hidden="true">
            {!HOME_V2_ENABLED && manifest?.objects.homeForegroundLeaves && viewPreset === "room" ? (
              <HomeRoomForeground
                assetUrl={mediaAssetUrl(manifest, manifest.objects.homeForegroundLeaves)}
                active={!roomIsQuiet && scenePhase === "idle"}
                motionMode={motionMode}
              />
            ) : null}
            <span className="room-scene-foreground" />
          </div>

          {!HOME_V2_ENABLED && manifest && ambientPath ? <audio key={`ambient-${theme}`} ref={audioRef} src={mediaAssetUrl(manifest, ambientPath)} preload="metadata" loop aria-hidden="true" /> : null}
        </div>
      </div>
      {!HOME_V2_ENABLED && onboardingOpen ? <FirstEntryGuide manifest={manifest} error={error} /> : null}
    </SceneReferenceFrame>
  );
}
