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
import {
  HOME_V2_CAMERA_PRESETS,
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
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const pendingHomeCompletion = useRoomStore((state) => state.pendingHomeCompletion);
  const activeHomeCompletion = useRoomStore((state) => state.activeHomeCompletion);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const setPhase = useRoomStore((state) => state.setPhase);
  const setScenePhase = useRoomStore((state) => state.setScenePhase);
  const beginPendingHomeCompletion = useRoomStore((state) => state.beginPendingHomeCompletion);
  const markHomeCompletionStarted = useRoomStore((state) => state.markHomeCompletionStarted);
  const consumeHomeCompletion = useRoomStore((state) => state.consumeHomeCompletion);
  const { projection, loading: homeLoading, failure: homeFailure } = useHomeProjection();
  const home = homePresentation(projection, homeLoading, homeFailure);
  const { manifest, error } = useLearningRoomManifest();
  const { notebookState, reviewState, shelfState } = home;
  // 首启引导由 v2 首页的入场序列负责（`HomeV2Experience`），房间这边不再自己排队
  // 弹它——原先那是 v1 首页的路径，留着就是两个地方都想开同一个模态。

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
  const previousPresetRef = useRef<typeof viewPreset | null>(null);
  const previousMotionModeRef = useRef<typeof motionMode | null>(null);
  const previousHomeV2ZoneRef = useRef<HomeV2Zone | null>(null);

  const inSearchScene = viewPreset === "search";
  const inReviewScene = viewPreset === "review";
  const inSeatScene = viewPreset !== "room" && !inSearchScene;
  const inGenericSeatScene = inSeatScene && !inReviewScene;
  const roomIsQuiet = Boolean(surface) || inputFocused || windowState !== "visible" || onboardingOpen;
  useEffect(() => {
    if (
      surface
      || scenePhase !== "idle"
      || windowState !== "visible"
      || onboardingOpen
    ) return;
    // 首页的"上一次没跑完"由 v2 的入场序列接手（beginPendingHomeCompletion）；
    // v1 那条 presentPendingHomeCompletion 的弹法随 ActionRail 一起删掉了。
    const event = activeHomeCompletion ?? pendingHomeCompletion;
    if (event) beginPendingHomeCompletion(event.id);
  }, [
    activeHomeCompletion,
    beginPendingHomeCompletion,
    onboardingOpen,
    pendingHomeCompletion,
    scenePhase,
    surface,
    windowState,
  ]);

  useEffect(() => {
    if (!activeHomeCompletion || roomIsQuiet || scenePhase !== "idle") return;
    markHomeCompletionStarted(activeHomeCompletion.id);
    const timer = window.setTimeout(() => consumeHomeCompletion(activeHomeCompletion.id), 1_300);
    return () => window.clearTimeout(timer);
  }, [activeHomeCompletion, consumeHomeCompletion, markHomeCompletionStarted, roomIsQuiet, scenePhase]);

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
    const target = viewPreset === "room"
      ? HOME_V2_CAMERA_PRESETS[homeV2Zone] ?? HOME_V2_CAMERA_PRESETS.wide
      : sceneCameraPreset(viewPreset);
    const previousPreset = previousPresetRef.current;
    const previousMotionMode = previousMotionModeRef.current;
    const previousHomeV2Zone = previousHomeV2ZoneRef.current;
    const firstRender = previousPreset === null;
    const routeChanged = !firstRender && previousPreset !== viewPreset;
    const modeChanged = !firstRender && previousMotionMode !== motionMode;
    const zoneChanged = viewPreset === "room"
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
    if (viewPreset === "room") {
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

    // 走到这里的一定不是书房（上面 `viewPreset === "room"` 已由 v2 相机序列化器接管并
    // return），所以这条时间线只剩"离开书房"的一种形状。
    const duration = sceneMotionDuration(motionMode, "camera");
    const finish = () => setScenePhase(settledScenePhase(surface));
    const timeline = gsap.timeline({
      defaults: { ease: "power3.inOut" },
      onComplete: finish,
    });
    timeline.addLabel("world_depart", 0);
    timeline.to(cameraHost, { ...targetValues, duration }, "world_depart");
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
    const duration = motionDuration(motionMode, 0.6, 0.28);
    const roomTime = homeSceneTime;
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
  }, { scope: rootRef, dependencies: [theme, homeSceneTime, motionMode, manifest, viewPreset, inSearchScene, inReviewScene, inSeatScene, inGenericSeatScene, roomIsQuiet] });


  return (
    <SceneReferenceFrame
      ref={rootRef}
      className="room-reference-frame"
      fitMode="cover"
      data-view-preset={viewPreset}
      data-motion-mode={motionMode}
      data-scene-phase={scenePhase}
      data-scene-renderer="poster-live2d"
      data-home-scene-time={homeSceneTime}
      data-scene-depth-bands={SCENE_DEPTH_BANDS.map((band) => band.id).join(",")}
      data-scene-room-layer-count={0}
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
                <img ref={homeDayRef} className="room-backplate room-backplate--home-day" src={mediaAssetUrl(manifest, manifest.homeV2Posters.day.path)} alt="" draggable="false" />
                <img ref={homeDuskRef} className="room-backplate room-backplate--home-dusk" src={mediaAssetUrl(manifest, manifest.homeV2Posters.dusk.path)} alt="" draggable="false" />
                <img ref={homeNightRef} className="room-backplate room-backplate--home-night" src={mediaAssetUrl(manifest, manifest.homeV2Posters.night.path)} alt="" draggable="false" />
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

          {/* D1/D2/D3/D5/D6 这几层是相机景深的占位骨架：v2 首页的书房里它们不装
              任何 DOM 素材（素材在 poster 与 `HomeV2ObjectLayer` 里），删掉层本身
              会改深度带的序号，所以留空层。 */}
          <div className="scene-depth-band scene-depth-band--d1" data-depth-band="D1" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d2" data-depth-band="D2" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d3" data-depth-band="D3" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d5" data-depth-band="D5" aria-hidden="true" />

          <div className="scene-depth-band scene-depth-band--d4" data-depth-band="D4">
            <HomeV2Keepsakes />
            <HomeV2ObjectLayer />
          </div>

          <div className="scene-depth-band scene-depth-band--d6" data-depth-band="D6" aria-hidden="true">
            <span className="room-scene-foreground" />
          </div>
        </div>
      </div>
    </SceneReferenceFrame>
  );
}
