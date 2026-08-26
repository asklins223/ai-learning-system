import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore } from "../app/room-store";
import {
  mediaAssetUrl,
  useLearningRoomManifest,
  type LearningRoomManifest,
} from "../media/learning-room-manifest";
import { HotspotLayer } from "./HotspotLayer";

gsap.registerPlugin(useGSAP);

const CAMERA_PRESETS = {
  room: { scale: 1, xPercent: 0, yPercent: 0 },
  study: { scale: 1.12, xPercent: 0, yPercent: -3.5 },
  notebook: { scale: 1.13, xPercent: 1.5, yPercent: -4 },
  card: { scale: 1.15, xPercent: -2.5, yPercent: -4.5 },
  "card-generation": { scale: 1.15, xPercent: -2.5, yPercent: -4.5 },
  review: { scale: 1, xPercent: 0, yPercent: 0 },
  validation: { scale: 1.12, xPercent: 1.5, yPercent: -3.5 },
  search: { scale: 1.14, xPercent: 7, yPercent: -1 },
  graph: { scale: 1.18, xPercent: 0, yPercent: 6 },
} as const;

function motionDuration(mode: "full" | "lite" | "off", full: number, lite = full * 0.56) {
  return mode === "off" ? 0 : mode === "lite" ? lite : full;
}

function FirstEntryGuide({ manifest }: { manifest: LearningRoomManifest }) {
  const motionMode = useRoomStore((state) => state.motionMode);
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
    const frame = window.requestAnimationFrame(() => skipRef.current?.focus({ preventScroll: true }));
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
      <section ref={cardRef} className="onboarding-card" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
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

export function RoomStage() {
  const theme = useRoomStore((state) => state.theme);
  const motionMode = useRoomStore((state) => state.motionMode);
  const surface = useRoomStore((state) => state.surface);
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const windowState = useRoomStore((state) => state.windowState);
  const inputFocused = useRoomStore((state) => state.inputFocused);
  const ambientRequested = useRoomStore((state) => state.ambientRequested);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const setPhase = useRoomStore((state) => state.setPhase);
  const { manifest, error } = useLearningRoomManifest();
  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef<HTMLDivElement>(null);
  const homeDayRef = useRef<HTMLImageElement>(null);
  const homeNightRef = useRef<HTMLImageElement>(null);
  const seatDayRef = useRef<HTMLImageElement>(null);
  const seatNightRef = useRef<HTMLImageElement>(null);
  const reviewDayRef = useRef<HTMLImageElement>(null);
  const reviewNightRef = useRef<HTMLImageElement>(null);
  const seatAtmosphereRef = useRef<HTMLDivElement>(null);
  const lampPoolRef = useRef<HTMLSpanElement>(null);
  const windowVideoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [windowVideoReady, setWindowVideoReady] = useState(false);
  const [failedWindowTheme, setFailedWindowTheme] = useState<"day" | "night" | null>(null);

  const inReviewScene = viewPreset === "review";
  const inSeatScene = viewPreset !== "room";
  const inGenericSeatScene = inSeatScene && !inReviewScene;
  const roomIsQuiet = Boolean(surface) || inputFocused || windowState !== "visible" || onboardingOpen;
  const ambientPath = manifest?.sound[theme === "day" ? "ambientDay" : "ambientNight"] ?? null;
  const shouldPlayAmbient = Boolean(ambientPath) && ambientRequested && !masterMuted && !roomIsQuiet;
  const shouldMountWindowVideo = Boolean(manifest)
    && !inSeatScene
    && manifest?.window[theme].reviewStatus === "approved"
    && motionMode === "full"
    && !roomIsQuiet
    && failedWindowTheme !== theme;

  useEffect(() => {
    if (error) setPhase("media-fallback", `${error}，已使用本地静态书房`);
    else if (manifest) setPhase(shouldMountWindowVideo ? "media-loading" : "poster-ready");
  }, [error, manifest, setPhase, shouldMountWindowVideo]);

  useEffect(() => {
    setWindowVideoReady(false);
    const video = windowVideoRef.current;
    if (!video) return;
    if (shouldMountWindowVideo) void video.play().catch(() => setFailedWindowTheme(theme));
    else video.pause();
  }, [shouldMountWindowVideo, theme]);

  useGSAP(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const target = CAMERA_PRESETS[viewPreset];
    const duration = motionDuration(motionMode, 0.9, 0.48);
    gsap.to(camera, {
      ...target,
      duration,
      ease: duration ? "power3.inOut" : "none",
      overwrite: "auto",
      force3D: true,
    });
  }, { scope: rootRef, dependencies: [viewPreset, motionMode, surface] });

  useGSAP(() => {
    const homeDay = homeDayRef.current;
    const homeNight = homeNightRef.current;
    const seatDay = seatDayRef.current;
    const seatNight = seatNightRef.current;
    const reviewDay = reviewDayRef.current;
    const reviewNight = reviewNightRef.current;
    if (!homeDay || !homeNight || !seatDay || !seatNight) return;
    const duration = motionDuration(motionMode, 0.76, 0.32);
    gsap.to(homeDay, { autoAlpha: !inSeatScene && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(homeNight, { autoAlpha: !inSeatScene && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(seatDay, { autoAlpha: inGenericSeatScene && theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    gsap.to(seatNight, { autoAlpha: inGenericSeatScene && theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    if (reviewDay) {
      gsap.to(reviewDay, { autoAlpha: theme === "day" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (reviewNight) {
      gsap.to(reviewNight, { autoAlpha: theme === "night" ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (seatAtmosphereRef.current) {
      gsap.to(seatAtmosphereRef.current, { autoAlpha: inGenericSeatScene ? 1 : 0, duration, ease: "power2.inOut", overwrite: "auto" });
    }
    if (lampPoolRef.current) {
      gsap.to(lampPoolRef.current, {
        autoAlpha: inGenericSeatScene ? (theme === "night" ? 1 : 0.16) : 0,
        scale: theme === "night" ? 1 : 0.92,
        duration: motionDuration(motionMode, 0.82, 0.34),
        ease: "sine.inOut",
        overwrite: "auto",
      });
    }
  }, { scope: rootRef, dependencies: [theme, motionMode, manifest, inSeatScene, inGenericSeatScene] });

  useGSAP(() => {
    const depth = depthRef.current;
    if (!depth) return;
    if (motionMode !== "full" || surface || onboardingOpen) {
      gsap.to(depth, { x: 0, y: 0, duration: motionDuration(motionMode, 0.45), ease: "power2.out", overwrite: "auto" });
      return;
    }
    const moveX = gsap.quickTo(depth, "x", { duration: 0.8, ease: "power3.out" });
    const moveY = gsap.quickTo(depth, "y", { duration: 0.8, ease: "power3.out" });
    const onPointerMove = (event: PointerEvent) => {
      moveX(((event.clientX / window.innerWidth) - 0.5) * -7);
      moveY(((event.clientY / window.innerHeight) - 0.5) * -4);
    };
    const onPointerLeave = () => { moveX(0); moveY(0); };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onPointerLeave);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onPointerLeave);
      gsap.killTweensOf(depth);
    };
  }, { scope: rootRef, dependencies: [motionMode, surface, onboardingOpen] });

  useGSAP(() => {
    const dust = gsap.utils.toArray<HTMLElement>(".window-atmosphere__dust");
    if (!dust.length) return;
    gsap.killTweensOf(dust);
    if (motionMode !== "full" || !inSeatScene || surface === null || onboardingOpen) {
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
  }, { scope: rootRef, dependencies: [motionMode, surface, onboardingOpen, manifest, inSeatScene] });

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
    <div ref={rootRef} className="room-reference-frame" data-view-preset={viewPreset} data-motion-mode={motionMode}>
      <div ref={cameraRef} className="room-camera-rig">
        <div ref={depthRef} className="room-depth-layer">
          {manifest ? (
            <>
              <img ref={homeDayRef} className="room-backplate room-backplate--home-day" src={mediaAssetUrl(manifest, manifest.posters.day.path)} alt="" aria-hidden="true" draggable="false" />
              <img ref={homeNightRef} className="room-backplate room-backplate--home-night" src={mediaAssetUrl(manifest, manifest.posters.night.path)} alt="" aria-hidden="true" draggable="false" />
              <img ref={seatDayRef} className="room-backplate room-backplate--seat-day" src={mediaAssetUrl(manifest, manifest.seatPosters.day.path)} alt="" aria-hidden="true" draggable="false" />
              <img ref={seatNightRef} className="room-backplate room-backplate--seat-night" src={mediaAssetUrl(manifest, manifest.seatPosters.night.path)} alt="" aria-hidden="true" draggable="false" />
              {inReviewScene ? (
                <>
                  <img ref={reviewDayRef} className="room-backplate room-backplate--review-day" src={mediaAssetUrl(manifest, manifest.reviewPosters.day.path)} alt="" aria-hidden="true" draggable="false" />
                  <img ref={reviewNightRef} className="room-backplate room-backplate--review-night" src={mediaAssetUrl(manifest, manifest.reviewPosters.night.path)} alt="" aria-hidden="true" draggable="false" />
                </>
              ) : null}
              {shouldMountWindowVideo ? (
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
                  aria-hidden="true"
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
              <span ref={lampPoolRef} className="lamp-local-pool" aria-hidden="true" />
              {ambientPath ? <audio key={`ambient-${theme}`} ref={audioRef} src={mediaAssetUrl(manifest, ambientPath)} preload="metadata" loop aria-hidden="true" /> : null}
            </>
          ) : null}
          <HotspotLayer ambientAvailable={Boolean(ambientPath)} />
        </div>
      </div>
      {manifest && onboardingOpen ? <FirstEntryGuide manifest={manifest} /> : null}
    </div>
  );
}
