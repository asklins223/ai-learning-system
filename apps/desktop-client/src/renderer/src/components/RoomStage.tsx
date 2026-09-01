import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore } from "../app/room-store";
import {
  mediaAssetUrl,
  useLearningRoomManifest,
  type LearningRoomManifest,
} from "../media/learning-room-manifest";
import { SceneReferenceFrame } from "../scene/SceneReferenceFrame";
import { sceneCameraPreset } from "../scene/scene-camera";
import { SCENE_DEPTH_BANDS } from "../scene/scene-depth";
import { createScenePointerRuntime } from "../scene/scene-pointer-runtime";
import { scenePointerOffset } from "../scene/scene-foreground";
import {
  resolveSceneMotionMode,
  sceneMotionDuration,
  settledScenePhase,
  shouldSettleAfterMotionPreferenceChange,
} from "../scene/scene-motion";
import { HotspotLayer } from "./HotspotLayer";
import { RoomSceneCanvas } from "./RoomSceneCanvas";

gsap.registerPlugin(useGSAP);

function motionDuration(mode: "full" | "lite" | "off", full: number, lite = full * 0.56) {
  return mode === "off" ? 0 : mode === "lite" ? lite : full;
}

function OnboardingPendingState({ error }: { error: string | null }) {
  const finishOnboarding = useRoomStore((state) => state.finishOnboarding);
  const enterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focusGuide = () => window.requestAnimationFrame(() => enterRef.current?.focus({ preventScroll: true }));
    const frame = window.requestAnimationFrame(focusGuide);
    window.addEventListener("ailearn:desktop-room-entry-complete", focusGuide);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("ailearn:desktop-room-entry-complete", focusGuide);
    };
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
    const focusGuide = () => window.requestAnimationFrame(() => skipRef.current?.focus({ preventScroll: true }));
    const frame = window.requestAnimationFrame(focusGuide);
    window.addEventListener("ailearn:desktop-room-entry-complete", focusGuide);
    return () => {
      query.removeEventListener("change", syncViewport);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("ailearn:desktop-room-entry-complete", focusGuide);
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
  const onboardingSeen = useRoomStore((state) => state.onboardingSeen);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const openOnboarding = useRoomStore((state) => state.openOnboarding);
  const setPhase = useRoomStore((state) => state.setPhase);
  const setScenePhase = useRoomStore((state) => state.setScenePhase);
  const { manifest, error } = useLearningRoomManifest();

  useEffect(() => {
    if (!manifest || onboardingSeen || onboardingOpen) return;
    const timer = window.setTimeout(openOnboarding, 550);
    return () => window.clearTimeout(timer);
  }, [manifest, onboardingOpen, onboardingSeen, openOnboarding]);

  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef<HTMLDivElement>(null);
  const homeDayRef = useRef<HTMLImageElement>(null);
  const homeNightRef = useRef<HTMLImageElement>(null);
  const seatDayRef = useRef<HTMLImageElement>(null);
  const seatNightRef = useRef<HTMLImageElement>(null);
  const searchDayRef = useRef<HTMLImageElement>(null);
  const searchNightRef = useRef<HTMLImageElement>(null);
  const reviewDayRef = useRef<HTMLImageElement>(null);
  const reviewNightRef = useRef<HTMLImageElement>(null);
  const seatAtmosphereRef = useRef<HTMLDivElement>(null);
  const lampPoolRef = useRef<HTMLSpanElement>(null);
  const windowVideoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const previousPresetRef = useRef<typeof viewPreset | null>(null);
  const previousMotionModeRef = useRef<typeof motionMode | null>(null);
  const [windowVideoReady, setWindowVideoReady] = useState(false);
  const [failedWindowTheme, setFailedWindowTheme] = useState<"day" | "night" | null>(null);
  const [roomCanvasReadyKey, setRoomCanvasReadyKey] = useState<string | null>(null);

  const inSearchScene = viewPreset === "search";
  const inReviewScene = viewPreset === "review";
  const inSeatScene = viewPreset !== "room" && !inSearchScene;
  const inGenericSeatScene = inSeatScene && !inReviewScene;
  const roomIsQuiet = Boolean(surface) || inputFocused || windowState !== "visible" || onboardingOpen;
  const ambientPath = manifest?.sound[theme === "day" ? "ambientDay" : "ambientNight"] ?? null;
  const shouldPlayAmbient = Boolean(ambientPath) && ambientRequested && !masterMuted && !roomIsQuiet;
  const shouldMountWindowVideo = Boolean(manifest)
    && viewPreset === "room"
    && manifest?.window[theme].reviewStatus === "approved"
    && motionMode === "full"
    && !roomIsQuiet
    && failedWindowTheme !== theme;
  const shouldMountRoomCanvas = Boolean(manifest)
    && viewPreset === "room"
    && scenePhase === "idle"
    && motionMode === "full"
    && windowState === "visible"
    && !surface
    && !onboardingOpen;
  const roomSceneLayers = useMemo(() => {
    if (!manifest || viewPreset !== "room") return [];
    return manifest.roomLayers
      .filter((layer) => layer.theme === theme)
      .map((entry) => ({
        entry,
        url: mediaAssetUrl(manifest, entry.path),
      }));
  }, [manifest, theme, viewPreset]);
  const roomCanvasKey = `${theme}:${viewPreset}:${scenePhase}`;

  useEffect(() => {
    if (error) setPhase("media-fallback", `${error}，已使用本地静态书房`);
    else if (manifest) setPhase(shouldMountWindowVideo ? "media-loading" : "poster-ready");
  }, [error, manifest, setPhase, shouldMountWindowVideo]);

  useEffect(() => {
    setWindowVideoReady(false);
    const video = windowVideoRef.current;
    if (!video) return;
    if (shouldMountWindowVideo) {
      // A muted video can still reject play() while metadata is settling or
      // when the window is not yet foregrounded. Keep the DOM layer mounted;
      // the media error handler below is the authoritative failure boundary.
      void video.play().catch(() => {
        if (video.error) setFailedWindowTheme(theme);
      });
    }
    else video.pause();
  }, [shouldMountWindowVideo, theme]);

  useGSAP((_context, contextSafe) => {
    const camera = cameraRef.current;
    const cameraHost = rootRef.current?.closest(".desktop-app");
    if (!camera || !(cameraHost instanceof HTMLElement)) return;
    const target = sceneCameraPreset(viewPreset);
    const previousPreset = previousPresetRef.current;
    const previousMotionMode = previousMotionModeRef.current;
    const firstRender = previousPreset === null;
    const routeChanged = !firstRender && previousPreset !== viewPreset;
    const modeChanged = !firstRender && previousMotionMode !== motionMode;
    previousPresetRef.current = viewPreset;
    previousMotionModeRef.current = motionMode;

    const targetValues = {
      "--scene-camera-scale": target.scale,
      "--scene-camera-x-percent": `${target.xPercent}%`,
      "--scene-camera-y-percent": `${target.yPercent}%`,
    };
    if (firstRender) {
      gsap.set(cameraHost, targetValues);
      return;
    }

    if (!routeChanged && !modeChanged) return;
    gsap.killTweensOf(cameraHost);
    if (!routeChanged || motionMode === "off") {
      gsap.set(cameraHost, targetValues);
      if (routeChanged || shouldSettleAfterMotionPreferenceChange({ routeChanged, modeChanged, scenePhase })) {
        setScenePhase(settledScenePhase(surface));
      }
      return;
    }

    const duration = sceneMotionDuration(motionMode, viewPreset === "room" ? "return" : "camera");
    const finish = contextSafe?.(() => setScenePhase(settledScenePhase(surface)))
      ?? (() => setScenePhase(settledScenePhase(surface)));
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
  }, { scope: rootRef, dependencies: [viewPreset, motionMode], revertOnUpdate: true });

  useGSAP(() => {
    const homeDay = homeDayRef.current;
    const homeNight = homeNightRef.current;
    const seatDay = seatDayRef.current;
    const seatNight = seatNightRef.current;
    const searchDay = searchDayRef.current;
    const searchNight = searchNightRef.current;
    const reviewDay = reviewDayRef.current;
    const reviewNight = reviewNightRef.current;
    if (!homeDay || !homeNight || !seatDay || !seatNight) return;
    const duration = motionDuration(motionMode, 0.76, 0.32);
    gsap.to(homeDay, { autoAlpha: viewPreset === "room" && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(homeNight, { autoAlpha: viewPreset === "room" && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
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
  }, { scope: rootRef, dependencies: [theme, motionMode, manifest, viewPreset, inSearchScene, inReviewScene, inSeatScene, inGenericSeatScene, roomIsQuiet] });

  useGSAP(() => {
    const depth = depthRef.current;
    const frame = rootRef.current;
    if (!depth || !frame) return;
    const bands = [...depth.querySelectorAll<HTMLElement>("[data-depth-band]")];
    if (!bands.length) return;
    const resetDuration = sceneMotionDuration(motionMode, "parallax") || motionDuration(motionMode, 0.45);
    if (motionMode !== "full" || surface || onboardingOpen || inputFocused || windowState !== "visible" || viewPreset !== "room") {
      gsap.set(bands, { willChange: "auto" });
      gsap.to(bands, { x: 0, y: 0, duration: resetDuration, ease: "power2.out", overwrite: "auto" });
      return;
    }
    gsap.set(bands, { willChange: "transform" });
    const moveX = bands.map((band) => gsap.quickTo(band, "x", { duration: sceneMotionDuration("full", "parallax"), ease: "power3.out" }));
    const moveY = bands.map((band) => gsap.quickTo(band, "y", { duration: sceneMotionDuration("full", "parallax"), ease: "power3.out" }));
    const reset = () => {
      moveX.forEach((move) => move(0));
      moveY.forEach((move) => move(0));
    };
    const pointerRuntime = createScenePointerRuntime({
      target: frame,
      enabled: true,
      getFrameBounds: () => {
        const bounds = frame.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      },
      onPointer: (input) => {
        if (!input) {
          reset();
          return;
        }
        // Read the frame bounds once per scheduled pointer frame, then only
        // submit compositor-friendly x/y transforms to the registered bands.
        const { clientX, clientY, frameBounds, pointerType } = input;
        bands.forEach((band, index) => {
          const bandConfig = SCENE_DEPTH_BANDS.find((candidate) => candidate.id === band.dataset.depthBand);
          if (!bandConfig) return;
          const [x, y] = scenePointerOffset({
            clientX,
            clientY,
            pointerType,
            frameBounds,
            maxOffsetX: bandConfig.maxOffsetX,
            maxOffsetY: bandConfig.maxOffsetY,
          });
          moveX[index](x);
          moveY[index](y);
        });
      },
    });
    return () => {
      pointerRuntime.destroy();
      gsap.killTweensOf(bands);
      gsap.set(bands, { willChange: "auto" });
    };
  }, { scope: rootRef, dependencies: [motionMode, surface, onboardingOpen, inputFocused, windowState, viewPreset] });

  useGSAP(() => {
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
      data-view-preset={viewPreset}
      data-motion-mode={motionMode}
      data-scene-phase={scenePhase}
      data-scene-renderer="dom-2.5d"
      data-scene-depth-bands={SCENE_DEPTH_BANDS.map((band) => band.id).join(",")}
      data-scene-room-canvas-active={shouldMountRoomCanvas && roomCanvasReadyKey === roomCanvasKey ? "true" : "false"}
    >
      {shouldMountRoomCanvas && manifest ? (
        <RoomSceneCanvas
          assetUrl={mediaAssetUrl(manifest, manifest.posters[theme].path)}
          layers={roomSceneLayers}
          motionMode={motionMode}
          scenePhase={scenePhase}
          viewPreset={viewPreset}
          windowState={windowState}
          active={shouldMountRoomCanvas}
          onReady={(ready) => setRoomCanvasReadyKey(ready ? roomCanvasKey : null)}
        />
      ) : null}
      <div ref={cameraRef} className="room-camera-rig">
        <div ref={depthRef} className="room-depth-layer" data-scene-depth-root="room" data-scene-depth-mode="dom-2.5d">
          <div className="scene-depth-band scene-depth-band--d0" data-depth-band="D0" aria-hidden="true">
            {manifest ? (
              <>
                <img ref={homeDayRef} className="room-backplate room-backplate--home-day" src={mediaAssetUrl(manifest, manifest.posters.day.path)} alt="" draggable="false" />
                <img ref={homeNightRef} className="room-backplate room-backplate--home-night" src={mediaAssetUrl(manifest, manifest.posters.night.path)} alt="" draggable="false" />
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
            {manifest && shouldMountWindowVideo ? (
              <div
                className={`window-ambient-video${windowVideoReady ? " window-ambient-video--ready" : ""}`}
                style={{
                  left: `${manifest.window.registration.left * 100}%`,
                  top: `${manifest.window.registration.top * 100}%`,
                  width: `${manifest.window.registration.width * 100}%`,
                  height: `${manifest.window.registration.height * 100}%`,
                  maskImage: `url(${mediaAssetUrl(manifest, manifest.window.mask)})`,
                  WebkitMaskImage: `url(${mediaAssetUrl(manifest, manifest.window.mask)})`,
                }}
              >
                <video
                  key={`home-window-${theme}`}
                  ref={windowVideoRef}
                  className="window-ambient-video__media"
                  src={mediaAssetUrl(manifest, manifest.window[theme].path)}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  tabIndex={-1}
                  onCanPlay={() => { setWindowVideoReady(true); setPhase("media-ready"); }}
                  onPlaying={() => { setWindowVideoReady(true); setPhase("media-ready"); }}
                  onError={() => {
                    setFailedWindowTheme(theme);
                    setPhase("media-fallback", "首页窗景不可用，已无缝使用静态书房");
                  }}
                />
                <span className="window-glass-reflection" />
              </div>
            ) : null}
            <div ref={seatAtmosphereRef} className="window-atmosphere" aria-hidden="true">
              <span className="window-atmosphere__glow" />
              <span className="window-atmosphere__dust window-atmosphere__dust--one" />
              <span className="window-atmosphere__dust window-atmosphere__dust--two" />
            </div>
          </div>

          <div className="scene-depth-band scene-depth-band--d2" data-depth-band="D2" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d3" data-depth-band="D3" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d5" data-depth-band="D5" aria-hidden="true">
            <span ref={lampPoolRef} className="lamp-local-pool" />
          </div>

          <div className="scene-depth-band scene-depth-band--d4" data-depth-band="D4">
            <HotspotLayer ambientAvailable={Boolean(ambientPath)} />
          </div>

          <div className="scene-depth-band scene-depth-band--d6" data-depth-band="D6" aria-hidden="true">
            <span className="room-scene-foreground" />
          </div>

          {manifest && ambientPath ? <audio key={`ambient-${theme}`} ref={audioRef} src={mediaAssetUrl(manifest, ambientPath)} preload="metadata" loop aria-hidden="true" /> : null}
        </div>
      </div>
      {onboardingOpen ? <FirstEntryGuide manifest={manifest} error={error} /> : null}
    </SceneReferenceFrame>
  );
}
